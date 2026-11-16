import type { Database } from "bun:sqlite";
import { DESK_SEARCH_KINDS, DESK_SEARCH_OPEN_ROUTES, type DeskSearchHit, type DeskSearchKind, type DeskSearchResponse } from "../../../desk-api/wire/search";
import type { WorkKind, WorkObject } from "../../../conversations/tools/work-context";
import type { DeskOptions } from "./compose";
import { listOpenNotes } from "./notes";
import { captureEntries } from "./search-captures";
import { readStudioFiles } from "./studio/read";
import { buildStudioView } from "./studio/view";
import { assistantNameOf } from "./assistant-name";
import { matchesQuery, readBalanceNode, workReaders } from "./work-readers";
import type { DeskItem } from "./types";

export const SEARCH_MAX_QUERY = 200;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_MAX_OFFSET = 500;
export const SEARCH_DEFAULT_LIMIT = 10;
const SNIPPET_LENGTH = 300;
const TITLE_LENGTH = 80;
const STUDIO_KINDS: readonly DeskSearchKind[] = ["studio-capture", "studio-thread"];
const WORK_KINDS = ["balance-task", "balance-project", "desk-item"] as const satisfies readonly WorkKind[];

interface Candidate {
  kind: DeskSearchKind;
  id: string;
  title: string;
  text: string;
  at: number | null;
  query: Record<string, string>;
}

export interface SearchRequest {
  q: string;
  kinds: readonly DeskSearchKind[];
  limit: number;
  offset: number;
}

interface SearchDeps {
  db: Database;
  desk: DeskOptions;
  deskItems: () => Promise<DeskItem[]>;
  now: number;
}

const firstLine = (text: string): string => (text.split("\n", 1)[0] ?? "").trim().slice(0, TITLE_LENGTH);
const timeOf = (iso: string): number | null => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

const snippetOf = (query: string, candidate: Candidate): string => {
  if (!candidate.text) return candidate.title.slice(0, SNIPPET_LENGTH);
  return (matchesQuery(query, candidate.text) ? candidate.text : `${candidate.title}\n${candidate.text}`).slice(0, SNIPPET_LENGTH);
};

function noteCandidates(db: Database): Candidate[] {
  return listOpenNotes(db).map((note) => ({ kind: note.kind === "reminder" ? "desk-reminder" : "desk-note", id: String(note.id), title: firstLine(note.text), text: note.text, at: note.createdAt, query: {} }));
}

async function studioCandidates(desk: DeskOptions): Promise<Candidate[]> {
  if (!desk.studio) return [];
  const { files, problems } = await readStudioFiles(desk.studio.dir);
  const view = buildStudioView(files, desk.studio, desk.areas, problems, assistantNameOf(desk));
  const inbox = view.inbox.map((capture): Candidate => ({
    kind: "studio-capture", id: capture.id.startsWith("capture-") ? capture.id : capture.path, title: firstLine(capture.text), text: capture.text, at: timeOf(capture.at), query: {},
  }));
  const filed = files.threads.flatMap((file) => captureEntries(file.text)).map((entry): Candidate => ({ kind: "studio-capture", id: entry.id, title: firstLine(entry.text), text: entry.text, at: null, query: {} }));
  const threads = [...view.active, ...view.parked, ...view.closed].map((thread): Candidate => ({
    kind: "studio-thread", id: thread.slug, title: thread.question, text: [`Where I stand: ${thread.stand}`, thread.outcomeText].filter(Boolean).join("\n"), at: timeOf(thread.closed ?? thread.opened), query: { thread: thread.slug },
  }));
  return [...inbox, ...filed, ...threads];
}

async function workCandidates(deps: SearchDeps, kinds: readonly DeskSearchKind[], query: string): Promise<Candidate[]> {
  const wanted = WORK_KINDS.filter((kind) => kinds.includes(kind));
  if (wanted.length === 0) return [];
  const readers = workReaders({ db: deps.db, desk: () => deps.desk, studioView: () => null, deskItems: deps.deskItems, now: () => deps.now });
  const found = await Promise.all(wanted.map(async (kind) => (await readers[kind]?.search(query, Number.MAX_SAFE_INTEGER, 0))?.items ?? []));
  return found.flat().map((object: WorkObject): Candidate => {
    const kind = object.kind as (typeof WORK_KINDS)[number];
    return { kind, id: object.id, title: object.title, text: object.summary, at: null, query: {} };
  });
}

function openQuery(deps: SearchDeps, candidate: Candidate): Record<string, string> {
  if (candidate.kind !== "balance-task" && candidate.kind !== "balance-project") return candidate.query;
  const read = readBalanceNode(deps.db, deps.desk, candidate.kind, candidate.id);
  return read.state === "available" ? { ref: candidate.id, area: read.area.id } : { ref: candidate.id };
}

const newestFirst = (candidates: Candidate[]): Candidate[] =>
  candidates
    .map((candidate, order) => ({ candidate, order }))
    .sort((a, b) => (a.candidate.at === null ? 1 : 0) - (b.candidate.at === null ? 1 : 0) || (b.candidate.at ?? 0) - (a.candidate.at ?? 0) || a.order - b.order)
    .map(({ candidate }) => candidate);

const nextPageQuery = (request: SearchRequest, offset: number): string => {
  const params = new URLSearchParams({ q: request.q, kinds: request.kinds.join(","), limit: String(request.limit), offset: String(offset) });
  return `/api/desk/search?${params.toString()}`;
};

export async function searchDesk(deps: SearchDeps, request: SearchRequest): Promise<DeskSearchResponse> {
  const unavailableKinds = deps.desk.studio ? [] : request.kinds.filter((kind) => STUDIO_KINDS.includes(kind));
  const collected: Candidate[] = [
    ...noteCandidates(deps.db),
    ...(unavailableKinds.length ? [] : await studioCandidates(deps.desk)),
    ...(await workCandidates(deps, request.kinds, request.q)),
  ];
  const matched = newestFirst(collected.filter((candidate) => request.kinds.includes(candidate.kind) && matchesQuery(request.q, `${candidate.title}\n${candidate.text}`)));
  const page = matched.slice(request.offset, request.offset + request.limit);
  const after = request.offset + request.limit;
  const hits = page.map((candidate): DeskSearchHit => ({
    kind: candidate.kind, id: candidate.id, title: candidate.title, snippet: snippetOf(request.q, candidate),
    at: candidate.at === null ? null : new Date(candidate.at).toISOString(),
    open: { ...DESK_SEARCH_OPEN_ROUTES[candidate.kind], query: openQuery(deps, candidate) },
  }));
  return { status: hits.length === 0 ? "empty" : "ok", hits, next: matched.length > after && after <= SEARCH_MAX_OFFSET ? nextPageQuery(request, after) : null, unavailableKinds };
}

export const isSearchKind = (value: string): value is DeskSearchKind => (DESK_SEARCH_KINDS as readonly string[]).includes(value);
