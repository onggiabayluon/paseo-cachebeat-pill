import type { PluginClientContext } from "@getpaseo/plugin/client";
import { hideCachebeatRows } from "./client/hide-rows";
import { contributeCachePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  const stopPills = contributeCachePills(client);
  try {
    hideCachebeatRows(client);
  } catch (error) {
    console.error("[cachebeat-pill] cannot hide the cachebeat rows", error);
  }
  return stopPills;
}
