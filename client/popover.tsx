import { type PluginButtonContentProps, useAgent, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { queueCommand } from "./pending";
import {
  cacheStatusRpc,
  costs,
  effectiveBeat,
  estimate,
  formatClock,
  formatDuration,
  formatMoney,
  formatTokens,
  type CacheStatus,
} from "../shared/status";

const PRESETS = [10, 30, 50] as const;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

export function CachePopover(props: PluginButtonContentProps) {
  const { theme, layout } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const paseo = usePaseo();
  const getStatus = useRpc(cacheStatusRpc);
  const query = useQuery({
    queryKey: ["cachebeat-pill", agentId],
    queryFn: () => getStatus({ agentId: agentId as string }),
    enabled: agentId !== null,
    refetchInterval: 10_000,
  });
  // A message sent while a turn runs interrupts it, so a command pressed meanwhile waits for the agent to go idle.
  const running = useAgent(agentId ?? "", (agent) => agent.status === "running") ?? false;
  const now = useNow(15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const styles = useMemo(
    () => ({
      root: { minWidth: layout.compact ? 260 : 300, padding: 14, gap: 10 },
      head: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      row: { flexDirection: "row" as const, justifyContent: "space-between" as const, gap: 12 },
      key: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1, textAlign: "right" as const },
      rule: { height: 1, backgroundColor: theme.colors.border },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      button: {
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      primary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontSize: 12 },
      primaryText: { color: theme.colors.accentForeground, fontSize: 12 },
      hint: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, layout.compact],
  );

  const status: CacheStatus | undefined = query.data;
  if (status === undefined) {
    return (
      <View style={styles.root}>
        <Text style={styles.key}>{query.isError ? "Could not read the cache status." : "Reading the cache status..."}</Text>
      </View>
    );
  }
  if (!status.supported) {
    return (
      <View style={styles.root}>
        <Text style={styles.key}>{status.reason ?? "Cache status is not available for this agent."}</Text>
      </View>
    );
  }

  const est = estimate(status, now);
  const cost = costs(status);
  const on = effectiveBeat(status) === "on";
  const phaseColor =
    est.phase === "warm" ? theme.colors.statusSuccess : est.phase === "cold" ? theme.colors.statusDanger : theme.colors.statusWarning;
  const phaseText = est.phase === "warm" ? "Warm" : est.phase === "cold" ? "Cold" : "Unknown";

  async function send(label: string, text: string) {
    if (agentId === null) return;
    if (running) {
      queueCommand(agentId, text);
      setNote(`Queued ${text}. It is sent when the agent goes idle, so the running turn is not interrupted.`);
      return;
    }
    setBusy(label);
    setNote(null);
    try {
      await paseo.agents.ref(agentId).send(text);
      setNote(`Sent ${text}. The status refreshes in a few seconds.`);
      setTimeout(() => void query.refetch(), 2500);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Could not send the command.");
    } finally {
      setBusy(null);
    }
  }

  function Row({ k, v }: { k: string; v: string }) {
    return (
      <View style={styles.row}>
        <Text style={styles.key}>{k}</Text>
        <Text style={styles.value}>{v}</Text>
      </View>
    );
  }

  function Action({ id, label, text, primary }: { id: string; label: string; text: string; primary?: boolean }) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={busy !== null}
        onPress={() => void send(id, text)}
        style={[styles.button, primary ? styles.primary : null, busy !== null ? { opacity: 0.5 } : null]}
      >
        <Text style={primary ? styles.primaryText : styles.buttonText}>{busy === id ? "..." : label}</Text>
      </Pressable>
    );
  }

  const last = status.lastRequestAt;
  const report = status.beat.report;
  const reportAge = report?.at != null ? formatDuration(now - report.at) : null;

  return (
    <View style={styles.root}>
      <View style={styles.head}>
        <Text style={styles.title}>Prompt cache</Text>
        <Text style={{ color: phaseColor, fontSize: 12, fontWeight: "600" }}>{phaseText}</Text>
      </View>
      <View style={styles.rule} />
      <Row k="Model" v={status.model ?? "unknown"} />
      <Row k="Cache lifetime" v={status.ttl ?? "unknown"} />
      <Row k="Cached context" v={status.cachedTokens === null ? "unknown" : `${formatTokens(status.cachedTokens)} tokens`} />
      <Row k="Last request" v={last === null ? "none yet" : `${formatDuration(now - last)} ago (${formatClock(last)})`} />
      <View style={styles.rule} />
      <Row
        k="Cachebeat"
        v={
          status.beat.state === "unknown" && !on && status.defaultOn === null
            ? "unknown, press Sync exact state"
            : on
              ? `on, every ${est.intervalMin ?? status.beat.intervalMin ?? "?"}m${status.beat.state === "unknown" ? " (default)" : ""}`
              : `off${status.beat.state === "unknown" ? " (default)" : ""}`
        }
      />
      {est.nextBeatAt !== null ? (
        <Row k="Next beat (est.)" v={`in ${formatDuration(est.nextBeatAt - now)} (${formatClock(est.nextBeatAt)})`} />
      ) : null}
      {est.beatsStopAt !== null ? <Row k="Beats stop (est.)" v={`${formatClock(est.beatsStopAt)} if idle`} /> : null}
      {est.expiresAt !== null ? (
        <Row k={on ? "Cache lapses (est.)" : "Cache lapses at"} v={`${formatClock(est.expiresAt)} (${est.phase === "cold" ? "gone" : `in ${formatDuration(est.expiresAt - now)}`})`} />
      ) : null}
      {report ? (
        <Row k="Last /cachebeat report" v={`${report.beats ?? "?"} beats${report.nextIn ? `, next in ${report.nextIn}` : ""}${reportAge ? ` (${reportAge} ago)` : ""}`} />
      ) : null}
      {cost ? (
        <>
          <View style={styles.rule} />
          <Row k="One beat costs" v={`${formatMoney(cost.beat)} (cache read)`} />
          <Row k="A cold restart costs" v={`${formatMoney(cost.miss)} (cache write)`} />
        </>
      ) : null}
      <View style={styles.rule} />
      <View style={styles.actions}>
        <Action id="toggle" label={on ? "Turn off" : "Turn on"} text={on ? "/cachebeat off" : "/cachebeat on"} primary={!on} />
        <Action id="now" label="Beat now" text="/cachebeat now" />
        <Action id="sync" label="Sync exact state" text="/cachebeat" />
      </View>
      <View style={styles.actions}>
        {PRESETS.map((minutes) => (
          <Action key={minutes} id={`i${minutes}`} label={`${minutes}m`} text={`/cachebeat ${minutes}`} />
        ))}
      </View>
      <Text style={styles.hint}>Times are estimates; Sync exact state asks cachebeat. API list prices.</Text>
      {note ? <Text style={styles.hint}>{note}</Text> : null}
    </View>
  );
}
