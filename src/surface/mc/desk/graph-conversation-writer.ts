// glossary-ignore: node
import type { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { GRAPH_AUTONOMIES, GRAPH_KINDS } from "../../../conversations/catalog";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, Provenance, ReadbackResult } from "../../../conversations/types";
import type { DeskOptions } from "./compose";
import { studioRequestId } from "./conversation-ids";
import { spawnWithStdin, type WriterResult, type WriterRunner } from "./create";
import { GITHUB_REF_PREFIX, isGraphRepositoryAllowed } from "./graph-repositories";

export const GRAPH_LABEL = "ivy:conversation";

const NOTHING = "Nothing was created.";
const ADD_TIMEOUT_MS = 28_000;
const READBACK_TIMEOUT_MS = 20_000;

export interface GraphWriterDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  run?: WriterRunner;
  now?: () => number;
}

export const graphFailed = (sentence: string): CreateResult => ({ state: "failed", error: `${sentence} ${NOTHING}` });

export const graphMarker = (operationId: string): string => `<!-- conversation-operation ${studioRequestId(operationId)} -->`;

export const provenanceLine = (provenance: Provenance): string => `Filed from Ivy conversation ${provenance.conversationId}, operation ${provenance.operationId}.`;

export const graphBody = (body: string | undefined, provenance: Provenance): string => [body?.trim(), provenanceLine(provenance)].filter(Boolean).join("\n\n");

/** The refusal when the repository is not ticked in Desk Settings, or null when the conversation may file there. */
export function repositoryRefusal(db: Database, repository: string): CreateResult | null {
  return isGraphRepositoryAllowed(db, repository) ? null : graphFailed(`This conversation may not file to ${repository}.`);
}

export async function withBodyFile<T>(body: string, use: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "desk-graph-"));
  try {
    const file = join(dir, "body.md");
    await writeFile(file, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600, flag: "wx" });
    return await use(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const Filed = z.object({ repo: z.string().min(1), node: z.string().min(1) });
const Unattached = z.object({ node: z.string().min(1), attached: z.literal(false) });
const Report = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), repo: z.string().min(1), node: z.string().min(1), parent: z.string().nullable() }),
  z.object({ found: z.literal(false) }),
]);

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The node soma names as `<repo>#<node>`, with the issue URL where the repo is on GitHub (as the Desk task writer reads it). */
export function graphNodeRef(repo: string, node: string): { canonicalId: string; url?: string } {
  if (!/^\d+$/.test(node)) return { canonicalId: node };
  const canonicalId = `${repo}#${node}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return { canonicalId, url: `https://github.com/${repo}/issues/${node}` };
  const gh = /^github:([\w.-]+)\/(.+)$/.exec(repo);
  return gh ? { canonicalId, url: `https://${gh[1]}/${gh[2]}/issues/${node}` } : { canonicalId };
}

const lastLine = (text: string): string => text.trimEnd().split(/\r?\n/).at(-1)?.trim() ?? "";

/**
 * Read a `soma graph add|chart --once … --json` answer. A node soma made but left unattached throws, so the
 * operation stays uncertain; any other refusal is a failure with soma's last stderr line.
 */
export function graphAnswer(result: WriterResult, verb: "add" | "chart"): CreateResult {
  if (result.code === 0) {
    const filed = Filed.safeParse(parsed(result.stdout));
    if (!filed.success) throw new Error(`soma graph ${verb} answered without a node. Check the graph before retrying.`);
    return { state: "created", ...graphNodeRef(filed.data.repo, filed.data.node) };
  }
  const unattached = Unattached.safeParse(parsed(result.stderr));
  if (unattached.success) throw new Error(`soma made node ${unattached.data.node} but did not attach it. Finish it with soma graph link.`);
  const line = lastLine(result.stderr);
  const reason = /[A-Za-z]/.test(line) ? line.replace(/[.\s]+$/, "") : `soma graph ${verb} exited with code ${result.code}`;
  return graphFailed(`${reason}.`);
}

interface Recorded { repository: string; parent: string | null; args: string[] }

/** Keep the destination and argv of an operation before soma runs, so Check can ask soma about it after a restart. */
export function recordGraphOperation(db: Database, operationId: string, recorded: Recorded, now: number): void {
  db.query("INSERT OR REPLACE INTO desk_graph_operations (operation_id, repository, parent, args, at) VALUES (?, ?, ?, ?, ?)")
    .run(operationId, recorded.repository, recorded.parent, JSON.stringify(recorded.args), now);
}

export function recordedGraphOperation(db: Database, operationId: string): Recorded | null {
  const row = db.query<{ repository: string; parent: string | null; args: string }, [string]>("SELECT repository, parent, args FROM desk_graph_operations WHERE operation_id = ?").get(operationId);
  if (!row) return null;
  const args: unknown = parsed(row.args);
  return Array.isArray(args) && args.every(a => typeof a === "string") ? { repository: row.repository, parent: row.parent, args } : null;
}

function sameNodeIgnoringRepoPrefix(repository: string, a: string, b: string): boolean {
  const prefixes = [`${repository}#`, ...(repository.startsWith(GITHUB_REF_PREFIX) ? [`${repository.slice(GITHUB_REF_PREFIX.length)}#`] : []), "#"];
  const bare = (id: string): string => prefixes.reduce((v, p) => (v.startsWith(p) ? v.slice(p.length) : v), id.trim());
  return bare(a) === bare(b);
}

/**
 * Ask soma, without filing, for the node filed under this operation's marker. Found under the parent the operation
 * asked for (or anywhere, for a map root with no parent) is found; found elsewhere, or a soma failure, cannot tell.
 */
export function graphReadback(deps: GraphWriterDeps): (operation: OperationRecord) => Promise<ReadbackResult> {
  const run = deps.run ?? spawnWithStdin;
  return async operation => {
    const somaBin = deps.desk()?.somaBin;
    const recorded = recordedGraphOperation(deps.db, operation.operationId);
    if (!somaBin || !recorded) return null;
    try {
      const result = await run([somaBin, ...recorded.args, "--dry-run"], "", READBACK_TIMEOUT_MS);
      const report = Report.safeParse(parsed(result.stdout));
      if (result.code !== 0 || !report.success) return null;
      if (!report.data.found) return { found: false };
      const { repo, node, parent } = report.data;
      if (recorded.parent !== null && (parent === null || !sameNodeIgnoringRepoPrefix(recorded.repository, parent, recorded.parent))) return null;
      return { found: true, ...graphNodeRef(repo, node) };
    } catch {
      return null;
    }
  };
}

const list = (value: string | undefined): string[] => (value ?? "").split(/[\s,]+/).filter(Boolean);
const flagShaped = (value: string): boolean => value.startsWith("-");
const oneOf = <T extends string>(values: readonly T[], value: string | undefined, fallback: T): T | null => {
  const chosen = value ?? fallback;
  return (values as readonly string[]).includes(chosen) ? (chosen as T) : null;
};

interface GraphCall { verb: "add" | "chart"; parent: string | null; before: string[]; tail: string[] }
interface Destination { repository: string; autonomy: (typeof GRAPH_AUTONOMIES)[number]; marker: string }
type GraphPlan = (fields: Record<string, string>, destination: Destination) => GraphCall | CreateResult;

function graphWriter(deps: GraphWriterDeps, plan: GraphPlan): OwnerWriter {
  const run = deps.run ?? spawnWithStdin;
  const now = deps.now ?? Date.now;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const somaBin = deps.desk()?.somaBin;
    if (!somaBin) return graphFailed("Soma is not set up on this stack.");
    const repository = request.fields.repository ?? "";
    const refused = repositoryRefusal(deps.db, repository);
    if (refused) return refused;
    const autonomy = oneOf(GRAPH_AUTONOMIES, request.fields.autonomy, "approve");
    if (!autonomy) return graphFailed("A conversation may file only approve or propose nodes.");
    const call = plan(request.fields, { repository, autonomy, marker: graphMarker(request.operationId) });
    if ("state" in call) return call;
    const head = ["graph", call.verb, ...call.before];
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before soma was called.");
    recordGraphOperation(deps.db, request.operationId, { repository, parent: call.parent, args: [...head, ...call.tail] }, now());
    const result = await withBodyFile(graphBody(request.fields.body, request.provenance), file => run([somaBin, ...head, "--body-file", file, ...call.tail], "", ADD_TIMEOUT_MS));
    return graphAnswer(result, call.verb);
  };
  return { create, readback: graphReadback(deps) };
}

/** Files the proposal under the confirmed parent with `soma graph add --once`; it never claims or closes what it files. */
export function graphNodeWriter(deps: GraphWriterDeps): OwnerWriter {
  return graphWriter(deps, (fields, { repository, autonomy, marker }) => {
    const { parent = "", title = "", checkpoint = "" } = fields;
    const kind = oneOf(GRAPH_KINDS, fields.kind, "grilling");
    if (!kind) return graphFailed("A conversation may file only research, grilling, prototype, task or build nodes.");
    const dependencies = list(fields.dependencies);
    if ([parent, ...dependencies].some(flagShaped)) return graphFailed("The parent and the dependencies must be node references, not options.");
    return {
      verb: "add",
      parent,
      before: [parent, "--repo", repository, "--title", title, "--autonomy", autonomy, "--kind", kind, "--label", GRAPH_LABEL, "--checkpoint", checkpoint],
      tail: [...dependencies.flatMap(d => ["--blocked-by", d]), "--once", marker, "--json"],
    };
  });
}

const GITLAB_PROJECT = /^gitlab:[^/]+\/(.+)$/;
const GOAL = /^G\d+$/;

/** Charts a map root in the confirmed repository with `soma graph chart --once`; on GitLab the project itself is the home project. */
export function graphMapWriter(deps: GraphWriterDeps): OwnerWriter {
  return graphWriter(deps, (fields, { repository, autonomy, marker }) => {
    const { title = "", checkpoint = "", serves } = fields;
    if (serves !== undefined && !GOAL.test(serves)) return graphFailed("A map may serve only a goal written as G<n>, such as G5.");
    const home = GITLAB_PROJECT.exec(repository)?.[1];
    return {
      verb: "chart",
      parent: null,
      before: [
        "--repo", repository, ...(home ? ["--home-project", home] : []), "--title", title, "--autonomy", autonomy, "--checkpoint", checkpoint, "--label", GRAPH_LABEL,
        ...(serves ? ["--serves", serves] : []),
      ],
      tail: ["--once", marker, "--json"],
    };
  });
}
