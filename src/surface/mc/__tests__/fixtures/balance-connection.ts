import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type HostStatus } from "../../../../conversations/host";
import type { ConnectionView, PackageForm } from "../../../../conversations/connection-setup";
import { balanceReadState } from "../../../../conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { initDatabase } from "../../db/init";
import { DEFAULT_CONFIG } from "../../config";
import { startServer, type ServerContext } from "../../server";
import { saveBalanceState } from "../../desk/balance-store";
import type { DeskOptions } from "../../desk/compose";

export const BALANCE_PRINCIPAL = "principal-example";
export async function balanceConnectionStack() {
  const dir = await mkdtemp(join(tmpdir(), "desk-balance-connection-"));
  const db = initDatabase(join(dir, "desk.sqlite"));
  saveBalanceState(db, balanceReadState());
  const desk: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", sources: [], routineScope: { principal: BALANCE_PRINCIPAL, stack: "test" }, areas: [{ id: "area-example", label: "Lab", color: "#2563eb", repos: [], goals: [], policy: "local" }, { id: "area-home", label: "Home", color: "#059669", repos: [], goals: [], policy: "local" }] };
  let status: HostStatus | undefined;
  let server: ServerContext | undefined;
  const start = async () => {
    status = await openConversationHost({ dir: join(dir, "conversations"), stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "unused", session: request.session, resumed: false }) });
    if (status.state !== "ready") throw new Error(status.reason);
    server = startServer({ ...DEFAULT_CONFIG, port: 0, db: { path: join(dir, "desk.sqlite") }, governance: { localPrincipal: BALANCE_PRINCIPAL, principals: [BALANCE_PRINCIPAL] } }, db, { desk, conversations: () => status ?? null });
    await status.host.settled();
  };
  await start();
  return {
    dir, db, desk,
    get host() { if (status?.state !== "ready") throw new Error("Disposable host unavailable."); return status.host; },
    get url() { if (!server) throw new Error("Disposable server unavailable."); return `http://127.0.0.1:${server.port}`; },
    async http(path: string, body?: unknown, headers?: Record<string, string>) {
      const response = await fetch(`${this.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    },
    async enable() {
      const snapshot = await this.http("/api/desk/connections");
      if (snapshot.status !== 200) throw new Error(`Catalog HTTP ${snapshot.status}: ${JSON.stringify(snapshot.body)}`);
      const form = (snapshot.body.packages as PackageForm[])[0];
      if (!form) throw new Error("Balance catalog missing.");
      const configured = await this.http("/api/desk/connections", { packageId: form.packageId, scope: {}, readCapabilityIds: form.capabilities.map(item => item.capabilityId), writeCapabilityIds: [], readDestinations: form.destinations.slice(0, 1).map(item => item.ref), writeDestinations: [] });
      if (configured.status !== 200) throw new Error(`Configure HTTP ${configured.status}: ${JSON.stringify(configured.body)}`);
      const connection = configured.body.connection as ConnectionView;
      const enabled = await this.http(`/api/desk/connections/${connection.connectionId}/enable`, { expectedRevision: connection.revision });
      if (enabled.status !== 200) throw new Error(`Enable HTTP ${enabled.status}: ${JSON.stringify(enabled.body)}`);
      return enabled.body.connection as ConnectionView;
    },
    async reopen() {
      server?.stop(true);
      if (status?.state === "ready") await status.host.close();
      await start();
    },
    async close() {
      server?.stop(true);
      if (status?.state === "ready") await status.host.close();
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
