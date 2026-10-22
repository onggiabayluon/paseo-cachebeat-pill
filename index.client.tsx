import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeCachePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  return contributeCachePills(client);
}
