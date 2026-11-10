// glossary-ignore: node
import { z } from "zod";
import { parseGraphNodeRef } from "../../../common/graph-ref";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { spawnWithStdin, type WriterResult } from "./create";
import { ADD_TIMEOUT_MS, graphNodeRef, provenanceLine, recordedGraphOperation, recordGraphOperation, withBodyFile, type GraphWriterDeps } from "./graph-conversation-writer";
import { GITHUB_REF_PREFIX, isGraphRepositoryAllowed } from "./graph-repositories";

const READ_TIMEOUT_MS = 20_000;
const WHOSE_CLOSE_UNKNOWN = null;
const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/;
const BARE_NODE = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;

export interface TargetNode { repository: string; id: string }

/** The node a proposal names, as soma's qualified repository and node id: `owner/name#N`, an issue URL or a qualified ref. */
export function targetNode(text: string): TargetNode | null {
  const trimmed = text.trim();
  const url = GITHUB_ISSUE_URL.exec(trimmed);
  const qualified = url ? `${GITHUB_REF_PREFIX}${url[1]}#${url[2]}` : BARE_NODE.test(trimmed) ? `${GITHUB_REF_PREFIX}${trimmed}` : trimmed;
  const ref = parseGraphNodeRef(qualified);
  if (ref?.sigil !== "#") return null;
  return { repository: `${ref.repo.forge}:${ref.repo.host}/${ref.repo.path}`, id: String(ref.iid) };
}

const NodeRead = z.object({ status: z.string(), body: z.string().optional() });

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const firstLine = (text: string): string => text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
const nodeRef = (node: TargetNode) => graphNodeRef(node.repository.replace(GITHUB_REF_PREFIX, ""), node.id);

interface UpdateVerb {
  nothing: string;
  text: (fields: Record<string, string>) => string | null;
  missing: string;
  argv: (node: TargetNode, file: string, fields: Record<string, string>) => string[];
  done: (read: z.infer<typeof NodeRead>, operationId: string) => boolean | null;
}

function updateWriter(deps: GraphWriterDeps, verb: UpdateVerb): OwnerWriter {
  const run = deps.run ?? spawnWithStdin;
  const now = deps.now ?? Date.now;
  const failed = (sentence: string): CreateResult => ({ state: "failed", error: `${sentence} ${verb.nothing}` });
  const answer = (result: WriterResult, node: TargetNode): CreateResult => {
    if (result.code === 0) return { state: "created", ...nodeRef(node) };
    const line = firstLine(result.stderr) || firstLine(result.stdout);
    return failed(/[A-Za-z]/.test(line) ? `${line.replace(/[.\s]+$/, "")}.` : `soma exited with code ${result.code} on node ${node.id}.`);
  };
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const somaBin = deps.desk()?.somaBin;
    if (!somaBin) return failed("Soma is not set up on this stack.");
    const node = targetNode(request.fields.node ?? "");
    if (!node) return failed("Name the node as owner/name#N, a qualified graph reference or its issue URL.");
    if (!isGraphRepositoryAllowed(deps.db, node.repository)) return failed(`This conversation may not write to ${node.repository}.`);
    const text = verb.text(request.fields);
    if (!text) return failed(verb.missing);
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before soma was called.");
    recordGraphOperation(deps.db, request.operationId, { repository: node.repository, parent: node.id, args: ["graph", "node", node.id, "--repo", node.repository, "--json"] }, now());
    const body = `${text}\n\n${provenanceLine(request.provenance)}`;
    const result = await withBodyFile(body, file => run([somaBin, ...verb.argv(node, file, request.fields)], "", ADD_TIMEOUT_MS));
    return answer(result, node);
  };
  const readback = async (operation: OperationRecord): Promise<ReadbackResult> => {
    const somaBin = deps.desk()?.somaBin;
    const recorded = recordedGraphOperation(deps.db, operation.operationId);
    if (!somaBin || !recorded?.parent) return null;
    try {
      const result = await run([somaBin, ...recorded.args], "", READ_TIMEOUT_MS);
      const read = NodeRead.safeParse(parsed(result.stdout));
      if (result.code !== 0 || !read.success) return null;
      const done = verb.done(read.data, operation.operationId);
      if (done === null) return null;
      return done ? { found: true, ...nodeRef({ repository: recorded.repository, id: recorded.parent }) } : { found: false };
    } catch (error) {
      process.stderr.write(`graph node readback failed for operation ${operation.operationId}: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  };
  return { create, readback };
}

const filled = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : null;
};
const gistArgs = (gist: string | undefined): string[] => {
  const line = filled(gist);
  return line ? ["--gist", line] : [];
};

/** Appends the confirmed ruling under the node's `## Rulings` with `soma graph rule`; the node stays open. */
export function graphRulingWriter(deps: GraphWriterDeps): OwnerWriter {
  return updateWriter(deps, {
    nothing: "Nothing was recorded.",
    text: fields => filled(fields.text),
    missing: "Write the ruling to record.",
    argv: (node, file) => ["graph", "rule", node.id, "--text-file", file, "--repo", node.repository, "--json"],
    done: (read, operationId) => read.body?.includes(`operation ${operationId}.`) ?? false,
  });
}

/** Closes the node with the confirmed resolution and gist through `soma graph close`, which runs the checkpoint gate. */
export function graphCloseWriter(deps: GraphWriterDeps): OwnerWriter {
  return updateWriter(deps, {
    nothing: "The node was not closed.",
    text: fields => filled(fields.resolution),
    missing: "Write the resolution the node closes with.",
    argv: (node, file, fields) => ["graph", "close", node.id, "--resolution-file", file, ...gistArgs(fields.gist), "--repo", node.repository],
    done: read => read.status === "closed" ? WHOSE_CLOSE_UNKNOWN : false,
  });
}
