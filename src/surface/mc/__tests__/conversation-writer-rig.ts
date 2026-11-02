import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { openConversationHost, type ConversationHost } from "../../../conversations/host";
import { answering, scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import type { ProposalView } from "../../../conversations/creation";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { HandledLedger } from "../desk/actions";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { conversationSources } from "../desk/conversation-sources";
import { WriterTimeout, type WriterResult, type WriterRunner } from "../desk/create";
import type { DeskWriterKind } from "../desk/desk-conversation-writer";
import type { GoalRunner, GoalRunResult } from "../desk/goals";
import { SCHEMA_SQL } from "../db/schema";

export type ConversationCall<T> = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;
interface RigReply { proposal: ProposalView; conversation: { id: string } }

export function conversationWriterRig(prefix: string, label: string) {
  const dirs = scratchDirs(prefix);
  const hosts: ConversationHost[] = [];
  const databases: Database[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    for (const db of databases.splice(0)) db.close();
    await dirs.clean();
  });
  const database = (): Database => {
    const db = new Database(":memory:");
    databases.push(db);
    for (const sql of SCHEMA_SQL) db.run(sql);
    return db;
  };
  const open = async <T extends RigReply>(db: Database, runtime: DeskRuntime) => {
    const lane = { provider: "test", model: "test-model" };
    const status = await openConversationHost({ dir: await dirs.make(), stack: "test", label, expectedLabel: label, lanes: { local: lane, cloud: lane }, turns: answering(() => "ok") });
    if (status.state !== "ready") throw new Error(status.reason);
    hosts.push(status.host);
    const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };
    const call: ConversationCall<T> = async (method, path, body) => {
      const res = await handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard, () => status, { db, runtime });
      return { status: res.status, body: await res.json() as T };
    };
    const start = async (title: string, policy: "local" | "cloud" = "local"): Promise<string> => (await call("POST", "/api/conversations", { title, origin: { kind: "web" }, policy })).body.conversation.id;
    const propose = async (id: string, type: string, fields: Record<string, string>): Promise<ProposalView> => (await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type, fields })).body.proposal;
    const proposalPath = (id: string, view: ProposalView, verb: "confirm" | "check"): string => `/api/conversations/${id}/proposals/${view.proposal.proposalId}/${verb}`;
    const confirm = (id: string, view: ProposalView, extra: Record<string, unknown> = {}) => call("POST", proposalPath(id, view, "confirm"), { revision: view.proposal.revision, digest: view.digest, ...extra });
    const check = (id: string, view: ProposalView) => call("POST", proposalPath(id, view, "check"));
    return { host: status.host, call, start, propose, confirm, check };
  };
  return { database, open };
}

export interface DeskWriterReply { ok: boolean; error: string; proposal: ProposalView; conversation: { id: string }; types: { type: string; status: string }[] }
export interface DeskWriterCall { argv: string[]; stdin: { kind: string; requestId: string; fields: Record<string, string> } }
interface DeskWriterSetup { prefix: string; label: string; kind: DeskWriterKind; type: string; canonicalId: string; somaBin?: string }

export function deskWriterRig(setup: DeskWriterSetup) {
  const writerRig = conversationWriterRig(setup.prefix, setup.label);
  return async (writer: string[] | null, policy: "local" | "cloud" = "cloud") => {
    const db = writerRig.database();
    const options: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], ...(setup.somaBin ? { somaBin: setup.somaBin } : {}), ...(writer ? { ask: { parser: [], timeoutSeconds: 5, writers: { [setup.kind]: writer }, taskMaps: [] } } : {}) };
    const runtime: DeskRuntime = { ledger: new HandledLedger(), options };
    const rig = await writerRig.open<DeskWriterReply>(db, runtime);
    const calls: DeskWriterCall[] = [];
    let answer = (): Promise<WriterResult> => Promise.resolve({ code: 0, stdout: JSON.stringify({ id: setup.canonicalId, message: "Added." }), stderr: "" });
    const run: WriterRunner = (argv, stdin) => {
      calls.push({ argv, stdin: JSON.parse(stdin) as DeskWriterCall["stdin"] });
      return answer();
    };
    const lists: string[][] = [];
    let listed = (): Promise<GoalRunResult> => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    const listGoals: GoalRunner = argv => {
      lists.push(argv);
      return listed();
    };
    await rig.host.attachSources(conversationSources({ db, desk: () => options, runWriter: { [setup.kind]: run }, listGoals }));
    const id = await rig.start(`Synthetic ${setup.kind}`, policy);
    const propose = (fields: Record<string, string>) => rig.propose(id, setup.type, fields);
    const confirm = (view: ProposalView) => rig.confirm(id, view);
    const check = (view: ProposalView) => rig.check(id, view);
    const capability = async () => (await rig.call("GET", "/api/conversations/capabilities")).body.types.find(t => t.type === setup.type)?.status;
    const submit = async (fields: Record<string, string>) => {
      const view = await propose(fields);
      return { view, reply: await confirm(view) };
    };
    const answerWith = (next: () => Promise<WriterResult>) => { answer = next; };
    const listWith = (next: () => Promise<GoalRunResult>) => { listed = next; };
    const timeoutThenCheck = async (fields: Record<string, string>) => {
      answerWith(() => Promise.reject(new WriterTimeout("timed out after 5 seconds")));
      const { view, reply } = await submit(fields);
      return { feedback: [reply, await check(view)].map(r => r.body.proposal.feedback), runs: calls.length };
    };
    return { id, options, calls, lists, propose, confirm, check, submit, capability, answerWith, listWith, timeoutThenCheck };
  };
}
