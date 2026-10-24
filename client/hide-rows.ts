import type { PluginClientContext } from "@getpaseo/plugin/client";

/** Any /cachebeat command, and the reply cachebeat prints for it. The pill shows the outcome instead. */
const COMMAND = /^\s*\/cachebeat(?:\s.*)?$/s;
const REPLY = /^\s*(?:<local-command-stdout>)?\s*cachebeat: /;

/**
 * Keeps cachebeat commands and replies out of the chat. The pill sends them, and what a user
 * typed by hand is hidden too, because the two cannot be told apart.
 */
export function hideCachebeatRows(client: PluginClientContext): void {
  const hide = (text: string, pattern: RegExp) => (pattern.test(text) ? { items: [] } : undefined);
  client.addTimelineTransformer({ id: "hide-cachebeat-command", query: { itemType: "user_message" }, transform: ({ item }) => hide(item.text, COMMAND) });
  client.addTimelineTransformer({ id: "hide-cachebeat-reply-user", query: { itemType: "user_message" }, transform: ({ item }) => hide(item.text, REPLY) });
  client.addTimelineTransformer({ id: "hide-cachebeat-reply-assistant", query: { itemType: "assistant_message" }, transform: ({ item }) => hide(item.text, REPLY) });
  client.addTimelineTransformer({ id: "hide-cachebeat-reply-notification", query: { itemType: "notification" }, transform: ({ item }) => hide(item.message, REPLY) });
}
