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
  let reply: ReturnType<typeof parseBeatReply> = null;
  let replyAt: number | null = null;
  let sawStateReply = false;
  let sawLocalOutput = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const isLocalOutput = line.includes("local-command-stdout>cachebeat:");
    const mayHaveUsage = line.includes('"usage"');
    if (!isLocalOutput && !mayHaveUsage) continue;
    if (sawLocalOutput && lastRequestAt !== null && ttl !== null) break;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (isLocalOutput && !sawLocalOutput) {
      // Only the newest cachebeat output counts; an older "on" must not outlive a newer line we can't parse.
      sawLocalOutput = true;
      reply = parseBeatReply(line);
      replyAt = Number.isNaN(at) ? null : at;
      sawStateReply = reply !== null;
    }
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
