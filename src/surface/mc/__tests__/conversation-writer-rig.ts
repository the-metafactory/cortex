import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { openConversationHost, type ConversationHost } from "../../../conversations/host";
import { answering, scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import type { ProposalView } from "../../../conversations/creation";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import type { DeskRuntime } from "../desk/compose";
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
