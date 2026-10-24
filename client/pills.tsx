import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { cacheStatusRpc, estimate, pillLabel, type CacheStatus } from "../shared/status";
import { HeartFilled, HeartOutline } from "./heart";
import { takeQueuedCommand } from "./pending";
import { CachePopover } from "./popover";

const POLL_MS = 20_000;

interface Tracked {
  workspaceId: string;
  registration: PluginButtonRegistration | null;
}

function pillTitle(status: CacheStatus): string {
  return `Prompt cache${status.ttl ? ` (${status.ttl})` : ""}`;
}

/** One composer pill per Claude agent, labelled with the cachebeat countdown. */
export function contributeCachePills(client: PluginClientContext): () => void {
  const tracked = new Map<string, Tracked>();
  const lifetime = new AbortController();

  function drop(agentId: string): void {
    tracked.get(agentId)?.registration?.remove();
    tracked.delete(agentId);
  }

  async function refresh(agentId: string): Promise<void> {
    const entry = tracked.get(agentId);
    if (!entry || lifetime.signal.aborted) return;
    let status: CacheStatus;
    try {
      status = await client.rpc(cacheStatusRpc, { agentId });
    } catch {
      return; // the next tick tries again
    }
    const now = Date.now();
    const label = pillLabel(status, estimate(status, now), now);
    if (label === null) {
      entry.registration?.remove();
      entry.registration = null;
      return;
    }
    const icon = status.beat.state === "on" ? HeartFilled : HeartOutline;
    if (entry.registration) {
      entry.registration.update({ label, title: pillTitle(status), icon });
      return;
    }
    entry.registration = client.addComposerPill({
      id: "cache",
      workspaceId: entry.workspaceId,
      agentId,
      button: {
        title: pillTitle(status),
        label,
        icon,
        behavior: { kind: "popover", Content: CachePopover },
      },
    });
  }

  /** Sends the command a user pressed mid-turn, now that the agent no longer runs. */
  async function flushQueued(agentId: string): Promise<void> {
    const text = takeQueuedCommand(agentId);
    if (text === undefined) return;
    try {
      await client.paseo.agents.ref(agentId).send(text);
      setTimeout(() => void refresh(agentId), 2500);
    } catch (error) {
      console.error("[cachebeat-pill] queued command failed", error);
    }
  }

  function track(agent: { id: string; workspaceId?: string | null; provider?: string | null }): void {
    if (!agent.workspaceId || !String(agent.provider ?? "").startsWith("claude")) return;
    if (tracked.has(agent.id)) return;
    tracked.set(agent.id, { workspaceId: agent.workspaceId, registration: null });
    void refresh(agent.id);
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) track(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") {
            track(update.agent);
            if (tracked.has(update.agent.id)) void refresh(update.agent.id);
            if (update.agent.status !== "running") void flushQueued(update.agent.id);
            return;
          }
          takeQueuedCommand(update.agentId);
          drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("[cachebeat-pill] agent observation failed", error);
    });

  const timer = setInterval(() => {
    for (const agentId of tracked.keys()) void refresh(agentId);
  }, POLL_MS);

  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const agentId of [...tracked.keys()]) drop(agentId);
  };
}
