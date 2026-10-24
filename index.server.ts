import type { PluginServerContext } from "@getpaseo/plugin/server";
import { cacheStatusRpc, type CacheStatus } from "./shared/status";
import { findTranscript, readCacheStatus, readDefaultOn } from "./server/transcript";

const EMPTY: Omit<CacheStatus, "supported" | "reason"> = {
  defaultOn: null,
  model: null,
  ttl: null,
  cachedTokens: null,
  lastRequestAt: null,
  beat: { state: "unknown", intervalMin: null, report: null },
};

export default function contribute(server: PluginServerContext) {
  const transcripts = new Map<string, string>();

  server.handle(cacheStatusRpc, async ({ agentId }, { paseo }): Promise<CacheStatus> => {
    let path = transcripts.get(agentId) ?? null;
    if (path === null) {
      const handle = paseo.agents.ref(agentId);
      await handle.refresh();
      const agent = handle.current();
      if (!agent || !String(agent.provider).startsWith("claude")) {
        return { supported: false, reason: "Not a Claude agent", ...EMPTY };
      }
      // runtimeInfo fills in late on a new agent, while persistence already names the session
      const sessionId = handle.runtimeInfo?.sessionId ?? agent.persistence?.sessionId ?? null;
      if (sessionId === null) return { supported: false, reason: "No session yet", ...EMPTY };
      path = await findTranscript(sessionId);
      if (path === null) return { supported: false, reason: "Transcript not found", ...EMPTY };
      transcripts.set(agentId, path);
    }
    return { supported: true, defaultOn: await readDefaultOn(), ...(await readCacheStatus(path)) };
  });

  return () => transcripts.clear();
}
