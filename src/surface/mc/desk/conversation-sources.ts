import type { Database } from "bun:sqlite";
import { findNode } from "../../../balance";
import type { HostSources } from "../../../conversations/host";
import type { ObjectRef, SourceState } from "../../../conversations/types";
import { balanceInboxWriter, balanceWriter, hasBalanceState } from "./balance-conversation-writer";
import { calendarWriter } from "./calendar-conversation-writer";
import { DESK_NOTE_WITHHELD, deskNoteWriter } from "./desk-note-conversation-writer";
import { flowWriter } from "./flow-conversation-writer";
import { deskWriterArgv, type DeskWriterKind } from "./desk-conversation-writer";
import { goalWriter } from "./goal-conversation-writer";
import { graphMapWriter, graphNodeWriter } from "./graph-conversation-writer";
import type { GoalRunner } from "./goals";
import { loadBalanceState } from "./balance-store";
import type { DeskOptions } from "./compose";
import type { WriterRunner } from "./create";
import type { ListedMail, TrashLedger } from "./mail-actions";
import { mailDraftReady, mailDraftWriter } from "./mail-draft-conversation-writer";
import type { RoutineRunner } from "./routine-command";
import { reminderWriter } from "./reminder-conversation-writer";
import { routineWriter } from "./routine-conversation-writer";
import { tanaNoteReady, tanaNoteWriter } from "./tana-note-conversation-writer";
import { studioReadback, studioResponseWriter } from "./studio-conversation-writer";
import type { GitRunner } from "./studio/git";
import { readStudioFiles } from "./studio/read";
import { buildStudioView, type StudioThreadView, type StudioView } from "./studio/view";
import type { DeskItem } from "./types";

const FRESH_MS = 5_000;
const gone: SourceState = { state: "unavailable", reason: "gone" };
const unauthorized: SourceState = { state: "unavailable", reason: "unauthorized" };

export const studioNoteId = (thread: string, note: string): string => `${thread}#${note}`;
export function splitNoteId(id: string): { thread: string; note: string } | null {
  const at = id.indexOf("#");
  return at > 0 && at < id.length - 1 ? { thread: id.slice(0, at), note: id.slice(at + 1) } : null;
}
export { operationUuid, studioRequestId } from "./conversation-ids";

export function studioThreadOf(view: StudioView, slug: string): StudioThreadView | undefined {
  return [...view.active, ...view.parked, ...view.closed].find(t => t.slug === slug);
}

export interface SourceDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  git?: GitRunner;
  now?: () => number;
  deskItems?: () => Promise<DeskItem[]>;
  listedMail?: (key: string) => ListedMail | null;
  ledger?: TrashLedger;
  runMailDraft?: WriterRunner;
  runRoutine?: RoutineRunner;
  runFlow?: WriterRunner;
  runGraph?: WriterRunner;
  runWriter?: Partial<Record<DeskWriterKind, WriterRunner>>;
  listGoals?: GoalRunner;
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
  const studioWriterDeps = { db: deps.db, desk: deps.desk, ...(deps.git ? { git: deps.git } : {}), ...(deps.now ? { now: deps.now } : {}) };
  const studioCommit = studioReadback(studioWriterDeps);
  const studioResponse = studioResponseWriter(studioWriterDeps);
  const deskItems = deps.deskItems;
  const balanceWriters = { "balance-task": balanceWriter("task", deps), "balance-project": balanceWriter("project", deps), ...(deskItems ? { "balance-inbox-task": balanceInboxWriter({ ...deps, deskItems }) } : {}) };
  const routine = routineWriter({ routines: () => deps.desk()?.routines, ...(deps.runRoutine ? { run: deps.runRoutine } : {}) });
  const flow = flowWriter({ flows: () => deps.desk()?.flows, ...(deps.runFlow ? { run: deps.runFlow } : {}) });
  const graphDeps = { db: deps.db, desk: deps.desk, ...(deps.runGraph ? { run: deps.runGraph } : {}), ...(deps.now ? { now: deps.now } : {}) };
  const graphNode = graphNodeWriter(graphDeps);
  const graphMap = graphMapWriter(graphDeps);
  const writerDeps = (kind: DeskWriterKind) => {
    const run = deps.runWriter?.[kind];
    return { db: deps.db, desk: deps.desk, ...(run ? { run } : {}), ...(deps.now ? { now: deps.now } : {}) };
  };
  const calendar = calendarWriter(writerDeps("calendar"));
  const reminder = reminderWriter(writerDeps("reminder"));
  const goal = goalWriter({ ...writerDeps("goal"), ...(deps.listGoals ? { list: deps.listGoals } : {}) });
  const tanaNote = tanaNoteWriter(writerDeps("note"));
  const deskNote = deskNoteWriter(writerDeps("note"));
  const { listedMail, ledger } = deps;
  const mailDraft = listedMail && ledger ? mailDraftWriter({ desk: deps.desk, listedMail, ledger, ...(deps.runMailDraft ? { run: deps.runMailDraft } : {}), ...(deps.now ? { now: deps.now } : {}) }) : undefined;
  return {
    get writers() {
      const desk = deps.desk();
      if (!desk?.enabled) return {};
      return {
        ...(hasBalanceState(deps.db) ? balanceWriters : {}),
        ...(desk.studio ? { "studio-response": studioResponse } : {}),
        ...(desk.routines ? { routine } : {}),
        ...(desk.flows ? { flow } : {}),
        ...(desk.somaBin ? { "graph-node": graphNode, "graph-map": graphMap } : {}),
        ...(deskWriterArgv(desk, "calendar") ? { "calendar-event": calendar } : {}),
        ...(deskWriterArgv(desk, "reminder") ? { reminder } : {}),
        ...(deskWriterArgv(desk, "goal") && desk.somaBin ? { "soma-goal": goal } : {}),
        ...(tanaNoteReady(desk) ? { "tana-note": tanaNote } : {}),
        ...(deskWriterArgv(desk, "note") ? {} : { "desk-note": deskNote }),
        ...(mailDraft && mailDraftReady(desk) ? { "mail-draft": mailDraft } : {}),
      };
    },
    get withheld() {
      return deskWriterArgv(deps.desk(), "note") ? { "desk-note": DESK_NOTE_WITHHELD } : {};
    },
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
    readbacks: { "studio-note": studioCommit, "studio-thread": studioCommit },
  };
}
