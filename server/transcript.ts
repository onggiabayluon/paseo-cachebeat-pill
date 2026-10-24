import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseBeatReply, type CacheStatus, type Ttl } from "../shared/status";

const TAIL_BYTES = 6 * 1024 * 1024;

function claudeRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

/** Finds `<projects>/<cwd-slug>/<sessionId>.jsonl` without needing the cwd slug. */
export async function findTranscript(sessionId: string): Promise<string | null> {
  const root = claudeRoot();
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(root, dir, `${sessionId}.jsonl`);
    try {
      await stat(path);
      return path;
    } catch {
      // not in this project directory
    }
  }
  return null;
}

async function readTail(path: string): Promise<string[]> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // the first line is cut mid-way
    return lines.filter((line) => line.length > 0);
  } finally {
    await file.close();
  }
}

/**
 * A real command-output record, not text that merely quotes one (a compaction summary and
 * api-request blobs embed old replies, and an embedded "off" would override the live state).
 */
function isCommandOutputRecord(entry: Record<string, unknown>): boolean {
  if (entry.type === "system") return entry.subtype === "local_command";
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return entry.type === "user" && typeof content === "string" && content.startsWith("<local-command-stdout>");
}

interface ReplyScan {
  offset: number;
  reply: ReturnType<typeof parseBeatReply>;
  replyAt: number | null;
  sawStateReply: boolean;
}

const SCAN_CHUNK = 4 * 1024 * 1024;
const scans = new Map<string, ReplyScan>();

/**
 * Newest genuine cachebeat reply in the whole transcript. A long session pushes its last reply far
 * out of any tail window, so the file is read once and afterwards only the bytes appended since.
 */
async function scanReplies(path: string): Promise<ReplyScan> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let scan = scans.get(path);
    if (!scan || scan.offset > size) scan = { offset: 0, reply: null, replyAt: null, sawStateReply: false };
    let carry = "";
    while (scan.offset < size) {
      const buffer = Buffer.alloc(Math.min(SCAN_CHUNK, size - scan.offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, scan.offset);
      if (bytesRead === 0) break;
      const text = carry + buffer.toString("utf8", 0, bytesRead);
      const end = text.lastIndexOf("\n");
      if (end === -1) {
        // no complete line yet: at the end of the file it is still being written, so re-read it next time
        if (scan.offset + bytesRead >= size) break;
        carry = text;
        scan.offset += bytesRead;
        continue;
      }
      for (const line of text.slice(0, end).split("\n")) {
        if (!line.includes("local-command-stdout>cachebeat:")) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!isCommandOutputRecord(entry)) continue;
        // Only the newest cachebeat output counts; an older "on" must not outlive a newer line we can't parse.
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        scan.reply = parseBeatReply(line);
        scan.replyAt = Number.isNaN(at) ? null : at;
        scan.sawStateReply = scan.reply !== null;
      }
      carry = text.slice(end + 1);
      scan.offset += bytesRead;
      // bytes of the unfinished last line are re-read next time
      scan.offset -= Buffer.byteLength(carry);
      carry = "";
      if (scan.offset >= size) break;
    }
    scans.set(path, scan);
    return scan;
  } finally {
    await file.close();
  }
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

/** Reads cache facts for one session from the tail of its Claude Code transcript. */
export async function readCacheStatus(path: string): Promise<Omit<CacheStatus, "supported" | "reason">> {
  const lines = await readTail(path);
  let model: string | null = null;
  let cachedTokens: number | null = null;
  let lastRequestAt: number | null = null;
  let ttl: Ttl | null = null;
  const { reply, replyAt, sawStateReply } = await scanReplies(path);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    if (lastRequestAt !== null && ttl !== null) break;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const message = entry.message as { usage?: Usage; model?: string } | undefined;
    if (entry.type === "assistant" && message?.usage && entry.isSidechain !== true) {
      const usage = message.usage;
      const written = usage.cache_creation;
      if (ttl === null && written) {
        if ((written.ephemeral_1h_input_tokens ?? 0) > 0) ttl = "1h";
        else if ((written.ephemeral_5m_input_tokens ?? 0) > 0) ttl = "5m";
      }
      if (lastRequestAt === null && !Number.isNaN(at)) {
        lastRequestAt = at;
        model = message.model ?? null;
        cachedTokens =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      }
    }
  }

  return {
    model,
    ttl,
    cachedTokens,
    lastRequestAt,
    beat: {
      state: reply?.state ?? "unknown",
      intervalMin: reply?.intervalMin ?? null,
      report: sawStateReply && reply && (reply.beats !== null || reply.nextIn !== null) ? { at: replyAt, beats: reply.beats, nextIn: reply.nextIn } : null,
    },
  };
}
