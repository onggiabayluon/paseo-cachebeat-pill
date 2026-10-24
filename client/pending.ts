/** One command per agent that waits for the agent to go idle, because a message sent mid-turn interrupts it. */
const pending = new Map<string, string>();

export function queueCommand(agentId: string, text: string): void {
  pending.set(agentId, text);
}

export function takeQueuedCommand(agentId: string): string | undefined {
  const text = pending.get(agentId);
  pending.delete(agentId);
  return text;
}

export function queuedCommand(agentId: string): string | undefined {
  return pending.get(agentId);
}
