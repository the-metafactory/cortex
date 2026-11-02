import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { findNode } from "../../../balance";
import type { HostSources } from "../../../conversations/host";
import type { ObjectRef, OperationRecord, SourceState } from "../../../conversations/types";
import { loadBalanceState } from "./balance-store";
import type { DeskOptions } from "./compose";
import { REQUEST_TRAILER, spawnGit, type GitRunner } from "./studio/git";
import { readStudioFiles } from "./studio/read";
import { buildStudioView, type StudioThreadView, type StudioView } from "./studio/view";

const FRESH_MS = 5_000;
const gone: SourceState = { state: "unavailable", reason: "gone" };
const unauthorized: SourceState = { state: "unavailable", reason: "unauthorized" };

export const studioNoteId = (thread: string, note: string): string => `${thread}#${note}`;
export function splitNoteId(id: string): { thread: string; note: string } | null {
  const at = id.indexOf("#");
  return at > 0 && at < id.length - 1 ? { thread: id.slice(0, at), note: id.slice(at + 1) } : null;
}
export const studioRequestId = (operationId: string): string => `conv-${createHash("sha256").update(operationId).digest("hex").slice(0, 56)}`;

export function studioThreadOf(view: StudioView, slug: string): StudioThreadView | undefined {
  return [...view.active, ...view.parked, ...view.closed].find(t => t.slug === slug);
}

export interface SourceDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  git?: GitRunner;
  now?: () => number;
}

export function conversationSources(deps: SourceDeps): HostSources {
  let cached: { at: number; dir: string; view: Promise<StudioView> } | null = null;
  const now = deps.now ?? Date.now;
  const studioView = (desk: DeskOptions): Promise<StudioView> | null => {
    const studio = desk.studio;
    if (!desk.enabled || !studio) return null;
    if (cached?.dir === studio.dir && now() - cached.at < FRESH_MS) return cached.view;
    const view = readStudioFiles(studio.dir).then(({ files, problems }) => buildStudioView(files, studio, desk.areas, problems));
    cached = { at: now(), dir: studio.dir, view };
    view.catch(() => { if (cached?.view === view) cached = null; });
    return view;
  };
  const thread = async (slug: string): Promise<{ found: StudioThreadView } | { missing: SourceState }> => {
    const desk = deps.desk();
    const view = desk ? studioView(desk) : null;
    if (!view) return { missing: unauthorized };
    const found = studioThreadOf(await view, slug);
    return found ? { found } : { missing: gone };
  };
  const balance = (ref: ObjectRef): SourceState => {
    const desk = deps.desk();
    if (!desk?.enabled) return unauthorized;
    const state = loadBalanceState(deps.db);
    if (!state) return gone;
    for (const area of state.outline.children) {
      const configured = desk.areas.find(a => area.id === `area:${a.id}`);
      const node = findNode(area, ref.id);
      if (!node || node === area) continue;
      if (!configured) return unauthorized;
      const facts = [node.note, node.dueDate ? `Due ${node.dueDate}` : "", node.done ? "Done" : "", `${node.children.length ? "Project" : "Task"} in ${configured.label}`].filter(Boolean);
      return { state: "available", policy: configured.policy ?? "cloud", title: node.title, context: facts.join("\n") };
    }
    return gone;
  };
  const studioReadback = async (operation: OperationRecord): Promise<{ found: true; canonicalId: string } | { found: false } | null> => {
    const dir = deps.desk()?.studio?.dir;
    if (!dir) return null;
    const r = await (deps.git ?? spawnGit)(["log", "-n", "1", `--grep=^${REQUEST_TRAILER}: ${studioRequestId(operation.operationId)}$`, "--format=%H"], dir);
    if (r.code !== 0) return null;
    const sha = r.stdout.trim();
    return sha ? { found: true, canonicalId: sha } : { found: false };
  };
  return {
    resolvers: {
      "studio-thread": async ref => {
        const read = await thread(ref.id);
        if ("missing" in read) return read.missing;
        const { found } = read;
        return { state: "available", policy: found.policy, title: found.question, context: [`Where I stand: ${found.stand}`, `Thread is ${found.state}`].join("\n") };
      },
      "studio-note": async ref => {
        const id = splitNoteId(ref.id);
        if (!id) return gone;
        const read = await thread(id.thread);
        if ("missing" in read) return read.missing;
        const { found } = read;
        const note = found.notes.find(n => n.at === id.note);
        if (!note) return gone;
        return { state: "available", policy: found.policy, title: note.text, context: [`${note.kind} in "${found.question}"`, `Status: ${note.status}`].join("\n") };
      },
      "balance-task": ref => Promise.resolve(balance(ref)),
      "balance-project": ref => Promise.resolve(balance(ref)),
    },
    readbacks: { "studio-note": studioReadback, "studio-thread": studioReadback },
  };
}
