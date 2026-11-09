import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CredentialSetupError } from "../desk-credential-broker";
import { brokerRig, SYNTHETIC_TOKEN, type BrokerRig } from "../desk-credential-broker-fixtures";

const rigs: BrokerRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const make = async (): Promise<BrokerRig> => { const rig = await brokerRig(); rigs.push(rig); return rig; };
const setup = { packageId: "example-package", setupSchemaId: "example-setup", version: "1.0.0" };
const inputs = { primary: { token: SYNTHETIC_TOKEN }, backup: { token: `${SYNTHETIC_TOKEN}-backup` } };
const secretFiles = (rig: BrokerRig): string[] => { try { return readdirSync(join(rig.configRoot, "secrets/cortex")); } catch (_err) { return []; } };
const provisioned = async (rig: BrokerRig) => {
  const context = await rig.session("owner");
  const begun = await rig.broker().begin(context, setup);
  await rig.broker().provision(context, begun.requestId, inputs);
  return { context, begun };
};
const code = async (run: Promise<unknown>): Promise<string> => { try { await run; return "none"; } catch (error) { return error instanceof CredentialSetupError ? error.code : "other"; } };

describe("desk credential broker", () => {
  test("provisions tokens into arc storage and publishes one active head without exposing the secret", async () => {
    const rig = await make();
    const stderr = spyOn(process.stderr, "write");
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    expect(begun.status).toBe("incomplete");
    expect(rig.published).toHaveLength(0);
    const done = await rig.broker().provision(context, begun.requestId, inputs);
    expect(done.status).toBe("active");
    expect(done.slots).toEqual([{ slot: "primary", presence: "present" }, { slot: "backup", presence: "present" }]);
    expect(rig.published).toHaveLength(1);
    expect(rig.published[0]?.previousRevision).toBeNull();
    const files = secretFiles(rig);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(statSync(join(rig.configRoot, "secrets/cortex", file)).mode & 0o777).toBe(0o600);
      expect(file).toMatch(/^DESK_[0-9A-F]{48}$/);
    }
    const everything = JSON.stringify([begun, done, rig.published, stderr.mock.calls, await rig.broker().status(context, done.connectionId)]);
    expect(everything).not.toContain(SYNTHETIC_TOKEN);
    expect(everything).not.toContain("DESK_");
    stderr.mockRestore();
  });

  test("store snapshots never contain the token", async () => {
    const rig = await make();
    await provisioned(rig);
    await rig.host().close();
    const raw = readdirSync(join(rig.dir, "host"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => readFileSync(join(entry.parentPath, entry.name)).toString("latin1")).join("");
    expect(raw).not.toContain(SYNTHETIC_TOKEN);
    await rig.reopen();
  });

  test("retries by request id are idempotent", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    const first = await rig.broker().provision(context, begun.requestId, inputs);
    const again = await rig.broker().provision(context, begun.requestId, inputs);
    expect(again).toEqual(first);
    expect(rig.published).toHaveLength(1);
    expect(secretFiles(rig)).toHaveLength(2);
  });

  test("resumes after a crash following the broker write", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    rig.hooks.writeAfter = () => undefined;
    const interrupted = await rig.broker().provision(context, begun.requestId, inputs);
    expect(interrupted).toMatchObject({ status: "incomplete", reason: "store_write_failed" });
    expect(rig.published).toHaveLength(0);
    delete rig.hooks.writeAfter;
    await rig.reopen();
    const resumed = await rig.broker().provision(await rig.session("owner"), begun.requestId, inputs);
    expect(resumed.status).toBe("active");
    expect(resumed.requestId).toBe(begun.requestId);
    expect(secretFiles(rig)).toHaveLength(2);
    expect(rig.published).toHaveLength(1);
  });

  test("an interrupted connection commit leaves no active connection and resumes the same staged revision", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    rig.hooks.publish = () => Promise.reject(new Error("synthetic commit failure"));
    const failed = await rig.broker().provision(context, begun.requestId, inputs);
    expect(failed).toMatchObject({ status: "incomplete", reason: "commit_failed" });
    expect(rig.published).toHaveLength(0);
    expect((await rig.broker().status(context, begun.connectionId))?.status).toBe("incomplete");
    delete rig.hooks.publish;
    await rig.reopen();
    const resumed = await rig.broker().provision(await rig.session("owner"), begun.requestId);
    expect(resumed).toMatchObject({ status: "active", connectionRevision: "1" });
    expect(rig.published).toHaveLength(1);
    expect(secretFiles(rig)).toHaveLength(2);
  });

  test("a new credential revision gets new handles and keeps the prior secrets and head until commit", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const first = await rig.broker().begin(context, setup);
    await rig.broker().provision(context, first.requestId, inputs);
    const filesBefore = secretFiles(rig);
    const second = await rig.broker().begin(context, setup, first.connectionId);
    expect(second.connectionRevision).toBe("2");
    expect((await rig.broker().status(context, first.connectionId))?.requestId).toBe(first.requestId);
    expect(await code(rig.broker().begin(context, { ...setup, setupSchemaId: "example-local" }, first.connectionId))).toBe("setup_in_progress");
    rig.hooks.publish = () => Promise.reject(new Error("synthetic commit failure"));
    await rig.broker().provision(context, second.requestId, inputs);
    expect(secretFiles(rig)).toHaveLength(4);
    expect(filesBefore.every(file => secretFiles(rig).includes(file))).toBe(true);
    delete rig.hooks.publish;
    const done = await rig.broker().provision(context, second.requestId, inputs);
    expect(done.status).toBe("active");
    expect(rig.published.map(head => [head.connectionRevision, head.previousRevision])).toEqual([["1", null], ["2", "1"]]);
    expect(rig.published[0]?.credentialHandle).not.toBe(rig.published[1]?.credentialHandle);
  });

  test("rejects cross-principal, cross-connection, unknown-slot and colliding-slot writes", async () => {
    const rig = await make();
    const owner = await rig.session("owner");
    const other = await rig.session("other");
    const begun = await rig.broker().begin(owner, setup);
    expect(await code(rig.broker().provision(other, begun.requestId, inputs))).toBe("cross_principal");
    expect(await code(rig.broker().begin(other, setup, begun.connectionId))).toBe("cross_principal");
    expect(await code(rig.broker().status(other, begun.connectionId))).toBe("cross_principal");
    expect(await code(rig.broker().provision(owner, begun.requestId, { ...inputs, extra: { token: "x" } }))).toBe("invalid_input");
    expect(await code(rig.broker().provision(owner, begun.requestId, { primary: inputs.primary, Primary: inputs.primary }))).toBe("slot_collision");
    expect(await code(rig.broker().provision(owner, "00000000-0000-4000-8000-000000000000", inputs))).toBe("unknown_request");
    expect(await code(rig.broker().begin(owner, { ...setup, version: "9.9.9" }))).toBe("unknown_setup");
    expect(secretFiles(rig)).toHaveLength(0);
    rig.principals.set("expired", { ...rig.principals.get("owner")!, expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(await code(rig.broker().begin((await rig.session("expired")), setup))).toBe("unauthenticated");
    expect(await rig.broker().authenticate("nobody")).toBeNull();
  });

  test("refuses to adopt an unrelated existing secret", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    rig.hooks.existingUnrelated = true;
    expect(await code(rig.broker().provision(context, begun.requestId, inputs))).toBe("unrelated_secret");
    expect(rig.published).toHaveLength(0);
  });

  test("an unavailable writable broker returns incomplete setup and never activates", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    rig.hooks.unavailable = true;
    const result = await rig.broker().provision(context, begun.requestId, inputs);
    expect(result).toMatchObject({ status: "incomplete", reason: "store_unavailable" });
    expect(rig.published).toHaveLength(0);
    expect(secretFiles(rig)).toHaveLength(0);
  });

  test("missing slot input stays incomplete", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, setup);
    expect(await rig.broker().provision(context, begun.requestId, { primary: inputs.primary })).toMatchObject({ status: "incomplete", reason: "missing_input" });
    expect(rig.published).toHaveLength(0);
  });

  test("local connections commit without credentials", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const begun = await rig.broker().begin(context, { ...setup, setupSchemaId: "example-local" });
    expect((await rig.broker().provision(context, begun.requestId)).status).toBe("active");
    expect(secretFiles(rig)).toHaveLength(0);
  });

  test("selects only explicitly authorized existing references and leaves the environment untouched", async () => {
    const rig = await make();
    const owner = await rig.session("owner");
    const other = await rig.session("other");
    const before = JSON.stringify(rig.env);
    const forOther = await rig.broker().begin(other, setup);
    expect(await code(rig.broker().provision(other, forOther.requestId, { primary: { reference: "EXAMPLE_API_KEY" } }))).toBe("reference_not_authorized");
    const begun = await rig.broker().begin(owner, setup);
    expect(await code(rig.broker().provision(owner, begun.requestId, { primary: { reference: "UNLISTED_NAME" } }))).toBe("reference_not_authorized");
    expect(await code(rig.broker().provision(owner, begun.requestId, { primary: { reference: "EXAMPLE_API_KEY" }, backup: { reference: "EXAMPLE_API_KEY" } }))).toBe("slot_collision");
    const result = await rig.broker().provision(owner, begun.requestId, { primary: { reference: "EXAMPLE_API_KEY" }, backup: { token: SYNTHETIC_TOKEN } });
    expect(result.status).toBe("active");
    expect(JSON.stringify([result, rig.published])).not.toContain("EXAMPLE_API_KEY");
    expect(JSON.stringify(rig.env)).toBe(before);
    expect(secretFiles(rig)).toHaveLength(1);
  });

  test("oauth needs an approved broker and unknown auth kinds are unavailable", async () => {
    const rig = await make();
    const context = await rig.session("owner");
    const unknownBroker = await rig.broker().begin(context, { ...setup, setupSchemaId: "example-oauth" });
    expect(unknownBroker).toMatchObject({ status: "unavailable", reason: "oauth_broker_unavailable" });
    expect(await rig.broker().provision(context, unknownBroker.requestId, { grant: { token: "x" } })).toMatchObject({ status: "unavailable" });
    expect(await rig.broker().begin(context, { ...setup, setupSchemaId: "example-saml" })).toMatchObject({ status: "unavailable", reason: "auth_kind_unavailable" });
    const approved = await rig.broker().begin(context, { ...setup, setupSchemaId: "example-approved-oauth" });
    expect(approved.status).toBe("incomplete");
    expect(approved.reason).toBeUndefined();
    expect(rig.published).toHaveLength(0);
  });

  test("a changed revision republishes the head so old admissions are revoked", async () => {
    const rig = await make();
    const { context, begun } = await provisioned(rig);
    const advanced = await rig.broker().advanceRevision(context, begun.connectionId);
    expect(advanced).toMatchObject({ status: "active", connectionRevision: "2" });
    expect(rig.published.map(head => head.connectionRevision)).toEqual(["1", "2"]);
    expect(rig.published[1]?.slotHandles).toEqual(rig.published[0]?.slotHandles);
  });
});
