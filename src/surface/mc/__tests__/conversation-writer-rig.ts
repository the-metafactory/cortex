import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { openConversationHost, type ConversationHost } from "../../../conversations/host";
import { answering, scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import type { DeskRuntime } from "../desk/compose";
import { SCHEMA_SQL } from "../db/schema";

export type ConversationCall<T> = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;

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
  const open = async <T>(db: Database, runtime: DeskRuntime) => {
    const lane = { provider: "test", model: "test-model" };
    const status = await openConversationHost({ dir: await dirs.make(), stack: "test", label, expectedLabel: label, lanes: { local: lane, cloud: lane }, turns: answering(() => "ok") });
    if (status.state !== "ready") throw new Error(status.reason);
    hosts.push(status.host);
    const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };
    const call: ConversationCall<T> = async (method, path, body) => {
      const res = await handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard, () => status, { db, runtime });
      return { status: res.status, body: await res.json() as T };
    };
    return { host: status.host, call };
  };
  return { database, open };
}
