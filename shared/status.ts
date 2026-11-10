import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Cache lifetime in minutes for each TTL class. */
export const TTL_MIN = { "1h": 60, "5m": 5 } as const;
/** Interval cachebeat picks by itself for each TTL class. */
export const AUTO_BEAT_MIN = { "1h": 50, "5m": 4 } as const;
/** cachebeat's default "stop after idle". */
export const STOP_AFTER_HOURS = 8;

export type Ttl = keyof typeof TTL_MIN;

export const cacheStatusSchema = z.object({
  /** True for a Claude agent whose transcript could be read. */
  supported: z.boolean(),
  reason: z.string().optional(),
  model: z.string().nullable(),
  ttl: z.enum(["1h", "5m"]).nullable(),
  /** Tokens in the conversation prefix after the last real request. */
  cachedTokens: z.number().nullable(),
  /** Epoch ms of the last real request (beats never appear in the transcript). */
  lastRequestAt: z.number().nullable(),
  /**
   * True when the transcript shows cachebeat loaded in this session (its MCP tools are listed, or it
   * replied). Only then is a background `/cachebeat` sent, so sessions started without plugins
   * (a minimal provider) never receive a command they cannot run.
   */
  cachebeatLoaded: z.boolean(),
  /** cachebeat's `defaultOn` setting; null when cachebeat's store was not found. */
  defaultOn: z.boolean().nullable(),
  /** cachebeat stopped itself in this session's folder (it records `stops` in its store); null when it did not. */
  stop: z.object({ at: z.number(), why: z.string() }).nullable(),
  beat: z.object({
    state: z.enum(["on", "off", "unknown"]),
    intervalMin: z.number().nullable(),
    /** Epoch ms of the `/cachebeat` reply that told the state; null when none or untimed. */
    at: z.number().nullable(),
    /** Exact numbers from the last `/cachebeat` status line, when one exists. */
    report: z
      .object({ at: z.number().nullable(), beats: z.number().nullable(), nextIn: z.string().nullable() })
      .nullable(),
  }),
});
export type CacheStatus = z.infer<typeof cacheStatusSchema>;

/** An "on" reply older than this may have been overtaken by something cachebeat did not report. */
export const STALE_REPLY_MS = 60 * 60_000;

/** The entry cachebeat's store holds for a folder under `stops`, or null when absent or malformed. */
export function stopFromStore(store: unknown, cwd: string): { at: number; why: string } | null {
  const stops = (store as { stops?: unknown } | null)?.stops;
  if (typeof stops !== "object" || stops === null) return null;
  const entry = (stops as Record<string, unknown>)[cwd] as { at?: unknown; why?: unknown } | undefined;
  return typeof entry?.at === "number" && typeof entry.why === "string" ? { at: entry.at, why: entry.why } : null;
}

/**
 * What the pill may claim about beating. "stopped": cachebeat recorded stopping itself, after the latest
 * `/cachebeat` reply. "on" only from a reply that is not stale. With no usable reply, a default of off is
 * "off"; a loaded cachebeat whose default is on is "default-on" (labelled as a default, never as a confirmed
 * "on"); anything else is "unknown": the pill never assumes on.
 */
export function effectiveBeat(s: CacheStatus, now: number): "on" | "off" | "unknown" | "stopped" | "default-on" {
  if (s.stop !== null && (s.beat.at === null || s.stop.at > s.beat.at)) return "stopped";
  if (s.beat.state === "off") return "off";
  if (s.beat.state === "on" && s.beat.at !== null && now - s.beat.at <= STALE_REPLY_MS) return "on";
  // No trusted reply: no reply, a stale or untimed "on".
  if (s.beat.state === "unknown" && s.defaultOn === false) return "off";
  return s.cachebeatLoaded && s.defaultOn === true ? "default-on" : "unknown";
}

export const cacheStatusRpc = defineRpc({
  name: "cachebeat-pill.status",
  input: z.object({ agentId: z.string() }),
  output: cacheStatusSchema,
});

export interface Estimate {
  phase: "warm" | "cold" | "unknown";
  /** When the cache lapses if nothing touches it; null while beats keep it warm. */
  expiresAt: number | null;
  nextBeatAt: number | null;
  beatsStopAt: number | null;
  intervalMin: number | null;
}

/** Estimates the cache and beat timeline from the last real request. Beats themselves are not observable. */
export function estimate(s: CacheStatus, now: number): Estimate {
  const unknown: Estimate = { phase: "unknown", expiresAt: null, nextBeatAt: null, beatsStopAt: null, intervalMin: null };
  if (!s.supported || s.ttl === null || s.lastRequestAt === null) return unknown;
  const ttlMs = TTL_MIN[s.ttl] * 60_000;
  const last = s.lastRequestAt;
  const intervalMin = s.beat.intervalMin ?? AUTO_BEAT_MIN[s.ttl];
  if (effectiveBeat(s, now) !== "on") {
    const expiresAt = last + ttlMs;
    return { phase: now < expiresAt ? "warm" : "cold", expiresAt, nextBeatAt: null, beatsStopAt: null, intervalMin: null };
  }
  const stopAt = last + STOP_AFTER_HOURS * 3_600_000;
  if (now >= stopAt) {
    const expiresAt = stopAt + ttlMs;
    return { phase: now < expiresAt ? "warm" : "cold", expiresAt, nextBeatAt: null, beatsStopAt: stopAt, intervalMin };
  }
  const step = intervalMin * 60_000;
  const nextBeatAt = last + step * (Math.floor((now - last) / step) + 1);
  return { phase: "warm", expiresAt: null, nextBeatAt, beatsStopAt: stopAt, intervalMin };
}

interface Price {
  match: RegExp;
  input: number;
  read: number;
}
// API list prices in $/MTok (cache write is 1.25x input for 5m, 2x for 1h). Subscription quota is not priced this way.
const PRICES: readonly Price[] = [
  { match: /fable-5/, input: 10, read: 0.25 },
  { match: /opus-5-5/, input: 4, read: 0.2 },
  { match: /opus-/, input: 5, read: 0.5 },
  { match: /sonnet-5/, input: 2, read: 0.2 },
  { match: /sonnet-/, input: 3, read: 0.3 },
  { match: /haiku-5/, input: 0.1, read: 0.01 },
  { match: /haiku-/, input: 1, read: 0.1 },
];

export function costs(s: CacheStatus): { beat: number; miss: number } | null {
  if (s.model === null || s.cachedTokens === null || s.ttl === null) return null;
  const price = PRICES.find((p) => p.match.test(s.model as string));
  if (!price) return null;
  const mtok = s.cachedTokens / 1_000_000;
  return { beat: mtok * price.read, miss: mtok * price.input * (s.ttl === "1h" ? 2 : 1.25) };
}

export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return String(n);
}

export function formatMoney(usd: number): string {
  return usd < 0.01 ? "<$0.01" : `~$${usd.toFixed(usd < 1 ? 2 : 1)}`;
}

/** The short text on the pill; null hides the pill. */
export function pillLabel(s: CacheStatus, est: Estimate, now: number): string | null {
  const label = cacheLabel(s, est, now);
  if (label === null) return null;
  const beat = effectiveBeat(s, now);
  // Neither a /cachebeat reply nor a known default: the pill cannot tell on from off.
  if (beat === "unknown") return `${label} \u00b7 beat ?`;
  return beat === "default-on" ? `${label} \u00b7 beat (default)` : label;
}

function cacheLabel(s: CacheStatus, est: Estimate, now: number): string | null {
  if (!s.supported) return null;
  if (est.phase === "unknown") return "cache ?";
  if (effectiveBeat(s, now) === "stopped") {
    return est.phase === "warm" ? `beats stopped \u00b7 ${formatDuration((est.expiresAt ?? now) - now)}` : "cache cold";
  }
  if (effectiveBeat(s, now) === "on") {
    if (est.nextBeatAt !== null) return formatDuration(est.nextBeatAt - now);
    return est.phase === "warm" ? "beats stopped" : "cache cold";
  }
  if (est.phase === "cold") return "cache cold";
  return `${s.ttl} \u00b7 ${formatDuration((est.expiresAt ?? now) - now)}`;
}

/** Parses cachebeat's own reply to `/cachebeat on|off|<n>|` from a transcript line. */
export function parseBeatReply(text: string): { state: "on" | "off"; intervalMin: number | null; beats: number | null; nextIn: string | null } | null {
  const m = /cachebeat: (?:(?:this session|this folder|all folders): )?(?:already )?(on|off)(?:, every (\d+)m)?/.exec(text);
  if (!m) return null;
  const beats = /(\d+) beats?\b/.exec(text);
  const next = /next beat in ([0-9a-z ]+?)(?: ?[\u00b7<"\\]|$)/.exec(text);
  return {
    state: m[1] as "on" | "off",
    intervalMin: m[2] ? Number(m[2]) : null,
    beats: beats ? Number(beats[1]) : null,
    nextIn: next ? next[1].trim() : null,
  };
}
