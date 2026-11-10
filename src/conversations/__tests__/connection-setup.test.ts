import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { handleDeskConnections } from "../../surface/mc/api/desk-connections";
import { CATALOG, connectionSetupRig, OTHER, OWNER, SELECTION, SYNTHETIC_TOKEN, type ConnectionSetupRig } from "../connection-setup-fixtures";

type Mode = "local" | "hosted";
const PATH = "/api/desk/connections";
const tokens = { primary: { token: SYNTHETIC_TOKEN }, backup: { token: `${SYNTHETIC_TOKEN}-backup` } };
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key];

describe.each<Mode>(["local", "hosted"])("Desk connection setup (%s)", mode => {
  let rig: ConnectionSetupRig;
  beforeEach(async () => { rig = await connectionSetupRig(); });
  afterEach(async () => { await rig.close(); });
  const configure = (extra: object = {}, as?: string) => rig.http(mode, "POST", PATH, { packageId: "example-package", ...SELECTION, inputs: tokens, ...extra }, as);
  const view = (res: { body: Record<string, unknown> }) => field(res.body, "connection") as { connectionId: string; revision: number; state: string; reason?: string };

  it("shows registered packages as discovered and enables nothing", async () => {
    const res = await rig.http(mode, "GET", PATH, undefined);
    expect(res.status).toBe(200);
    expect((field(res.body, "packages") as { packageId: string }[]).map(item => item.packageId)).toEqual(CATALOG.map(item => item.packageId));
    expect(field(res.body, "connections")).toEqual([]);
    expect(rig.counts).toMatchObject({ secretWrites: 0, headUpdates: 0, ownerMutations: 0 });
  });

  it("configures a token connection to disabled, then enables and disables it explicitly", async () => {
    const made = await configure();
    expect(made.status).toBe(200);
    const created = view(made);
    expect(created.state).toBe("disabled");
    expect(rig.counts).toMatchObject({ secretWrites: 2, headUpdates: 1, authorityPublishes: 0 });
    expect(made.text).not.toContain(SYNTHETIC_TOKEN);

    const enabled = view(await rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: created.revision }));
    expect(enabled.state).toBe("enabled");
    expect(rig.counts.authorityPublishes).toBe(1);
    const again = view(await rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: enabled.revision }));
    expect(again.state).toBe("enabled");
    expect(rig.counts.authorityPublishes).toBe(1);

    const disabled = view(await rig.http(mode, "POST", `${PATH}/${created.connectionId}/disable`, { expectedRevision: again.revision }));
    expect(disabled.state).toBe("disabled");
    expect(rig.counts.bridgesClosed).toEqual([created.connectionId]);
    expect(rig.counts.secretWrites).toBe(2);
    expect(rig.counts.ownerMutations).toBe(0);

    await rig.reopen();
    const listed = field((await rig.http(mode, "GET", PATH, undefined)).body, "connections") as { state: string; slots: { presence: string }[] }[];
    expect(listed.map(item => item.state)).toEqual(["disabled"]);
    expect(listed[0]?.slots.every(slot => slot.presence === "present")).toBe(true);
  });

  it("configures a local connection without secrets", async () => {
    const res = await rig.http(mode, "POST", PATH, { packageId: "example-local-package", ...SELECTION });
    expect(view(res).state).toBe("disabled");
    expect(rig.counts.secretWrites).toBe(0);
  });

  it("refuses another principal, unverified callers and forged requests with no provisioning", async () => {
    const created = view(await configure());
    const before = { ...rig.counts };
    const attempts = [
      configure({}, OTHER),
      rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: created.revision }, OTHER),
      configure({ scope: { ...SELECTION.scope, extra: "x" } }),
      configure({ readDestinations: [{ ...SELECTION.readDestinations[0], canonicalId: "forged" }] }),
      configure({ writeCapabilityIds: ["example.object.create"] }),
      configure({ readCapabilityIds: [], writeCapabilityIds: ["example.object.read"], readDestinations: [], writeDestinations: SELECTION.readDestinations }),
      configure({ packageId: "not-registered" }),
      configure({ principalRef: "00000000-0000-4000-8000-000000000000" }),
      configure({ connectionId: created.connectionId, expectedRevision: created.revision + 5 }),
      rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: created.revision + 5 }),
    ];
    for (const attempt of attempts) {
      const { status } = await attempt;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
    expect(rig.counts).toEqual(before);
    expect((await rig.http(mode, "GET", PATH, undefined, OTHER)).status).toBe(403);
  });

  it("keeps a partial failure incomplete and resumes it after reopen without rewriting secrets", async () => {
    rig.hooks.publishFails = true;
    const failed = view(await configure());
    expect(failed.state).toBe("incomplete");
    expect(rig.counts.headUpdates).toBe(0);
    const early = await rig.http(mode, "POST", `${PATH}/${failed.connectionId}/enable`, { expectedRevision: failed.revision });
    expect(early.status).toBe(409);
    expect(rig.counts.authorityPublishes).toBe(0);

    rig.hooks.publishFails = false;
    await rig.reopen();
    const resumed = view(await rig.http(mode, "POST", `${PATH}/${failed.connectionId}/provision`, { expectedRevision: failed.revision, inputs: tokens }));
    expect(resumed.state).toBe("disabled");
    expect(rig.counts).toMatchObject({ secretWrites: 2, headUpdates: 1 });
  });

  it("shows an unavailable store as incomplete and retries once it returns", async () => {
    rig.hooks.storeUnavailable = true;
    const failed = view(await configure());
    expect(failed).toMatchObject({ state: "incomplete", reason: "store_unavailable" });
    rig.hooks.storeUnavailable = false;
    const retried = view(await rig.http(mode, "POST", `${PATH}/${failed.connectionId}/provision`, { expectedRevision: failed.revision, inputs: tokens }));
    expect(retried.state).toBe("disabled");
  });

  it("fences an enabled connection when its scope changes and requires explicit re-enable", async () => {
    const created = view(await configure());
    const enabled = view(await rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: created.revision }));
    const changed = view(await configure({ connectionId: created.connectionId, expectedRevision: enabled.revision, inputs: undefined, scope: { account: "synthetic-account", resource: "area-second" } }));
    expect(changed.state).toBe("disabled");
    expect(rig.counts.bridgesClosed).toEqual([created.connectionId]);
    expect(rig.counts.secretWrites).toBe(2);
    expect((await rig.service().list(OWNER))[0]?.publishedRevision).toBe("2");
    const reenabled = view(await rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: changed.revision }));
    expect(reenabled.state).toBe("enabled");
  });

  it("offers env references read-only and refuses names it did not offer", async () => {
    const forms = field((await rig.http(mode, "GET", PATH, undefined)).body, "packages") as { references: string[] }[];
    expect(forms[0]?.references).toEqual(["EXAMPLE_API_KEY"]);
    const res = await configure({ inputs: { primary: { reference: "EXAMPLE_API_KEY" }, backup: { reference: "NOT_OFFERED" } } });
    expect(res.status).toBe(403);
    expect(rig.counts.secretWrites).toBe(0);
  });

  it("reports unsupported mechanisms and a missing package safely", async () => {
    const oauth = await rig.http(mode, "POST", PATH, { packageId: "example-oauth-package", ...SELECTION, inputs: { grant: { token: SYNTHETIC_TOKEN } } });
    expect(view(oauth)).toMatchObject({ state: "unavailable", reason: "oauth_broker_unavailable" });
    expect((await rig.http(mode, "GET", PATH, undefined)).text).not.toContain(SYNTHETIC_TOKEN);

    const created = view(await configure());
    rig.catalog.splice(0, 1);
    const listed = field((await rig.http(mode, "GET", PATH, undefined)).body, "connections") as { packageId: string; state: string; reason?: string }[];
    expect(listed.find(item => item.packageId === "example-package")).toMatchObject({ state: "unavailable", reason: "package_missing" });
    const enable = await rig.http(mode, "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: created.revision });
    expect(enable.status).toBe(404);
  });
});

describe("Desk connection setup routes", () => {
  it("is unavailable, never weaker, when the service is absent, the caller unverified or the host foreign", async () => {
    const rig = await connectionSetupRig();
    try {
      expect((await rig.http("hosted", "GET", PATH, undefined, "nobody")).status).toBe(403);
      const guard = { isLoopback: true, allowedHostnames: new Set(["127.0.0.1"]), listenPort: 8767, principals: new Set<string>(), localPrincipal: OWNER };
      const req = new Request("http://127.0.0.1:8767/api/desk/connections", { headers: { host: "127.0.0.1:8767" } });
      expect((await handleDeskConnections(req, new URL(req.url), guard, () => null)).status).toBe(503);
      const foreign = new Request("http://127.0.0.1:8767/api/desk/connections", { method: "POST", headers: { host: "evil.example", origin: "https://evil.example" }, body: "{}" });
      expect((await handleDeskConnections(foreign, new URL(foreign.url), guard, () => rig.service())).status).toBe(403);
      const hostedGuard = { ...guard, isLoopback: false };
      const hosted = new Request("http://127.0.0.1:8767/api/desk/connections", { headers: { host: "127.0.0.1:8767" } });
      expect((await handleDeskConnections(hosted, new URL(hosted.url), hostedGuard, () => rig.service())).status).toBe(503);
    } finally { await rig.close(); }
  });
});
