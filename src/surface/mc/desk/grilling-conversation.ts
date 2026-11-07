import type { ObjectRef, SourceState } from "../../../conversations/types";
import type { DeskOptions } from "./compose";
import { repoIsCloud } from "./rank";
import { readRangerState, type RangerFetch } from "./sources/ranger";
import { canonicalTaskRef, readWaitingTask, type WaitingTask } from "./sources/waiting";

export interface GrillingReads {
  fetch?: RangerFetch;
  task?: (ref: string) => Promise<WaitingTask>;
}

export async function grillingSource(desk: DeskOptions | undefined, ref: ObjectRef, reads: GrillingReads = {}): Promise<SourceState> {
  if (!desk?.enabled || !desk.rangerUrl) return { state: "unavailable", reason: "unauthorized" };
  try {
    const state = await readRangerState(desk.rangerUrl, reads.fetch);
    const map = state.maps.find(map => map.grillings?.some(node => canonicalTaskRef(`${map.repo}#${node.id}`) === ref.id));
    if (!map) return { state: "unavailable", reason: "gone" };
    const task = await (reads.task ?? readWaitingTask)(ref.id);
    if (task.kind === "unavailable") return { state: "unavailable", reason: "unreadable" };
    if (task.kind === "closed") return { state: "unavailable", reason: "gone" };
    if (task.body === undefined) return { state: "unavailable", reason: "unreadable" };
    return { state: "available", title: task.title, context: `${task.body}\n\nSource: ${task.url}`, url: task.url, policy: repoIsCloud(desk.areas, map.repo) ? "cloud" : "local" };
  } catch (error) {
    console.warn("Ranger grilling source could not be read:", error);
    return { state: "unavailable", reason: "unreadable" };
  }
}
