import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DESK_UI_MAX_MESSAGE_BYTES, InboundGate, type Identity } from "../adapter-frame-protocol";
import { FrameEntrySchema, frameEntryUrl } from "../adapter-frame-contract";
import { ASSET_OWNER } from "./fixtures/adapter-asset-fixtures";
import { openFrameRig } from "./fixtures/adapter-frame-fixtures";

const identity: Identity = { protocol: "desk-ui", version: "1.0.0", instance: "a".repeat(32), adapterId: "balance", connectionId: "connection-example", generationId: "g-1", releaseDigest: "b".repeat(64) };
const mount = { objectType: "task", view: "result" as const };
const ready = { ...identity, seq: 1, type: "ui:ready", body: { mount } };
const resize = { ...identity, seq: 2, type: "ui:resize", body: { height: 240 } };

describe("Desk UI 1.0.0 terminal gate", () => {
  const attacks: Record<string, unknown> = {
    "unknown field": { ...resize, callback: "execute" },
    "unknown body": { ...resize, body: { height: 2, url: "https://example.invalid" } },
    "unknown version": { ...resize, version: "1.0.0-prototype" },
    "wrong adapter": { ...resize, adapterId: "other" },
    "wrong connection": { ...resize, connectionId: "other" },
    "wrong generation": { ...resize, generationId: "old" },
    "wrong release": { ...resize, releaseDigest: "c".repeat(64) },
    "wrong instance": { ...resize, instance: "d".repeat(32) },
    "replayed sequence": { ...resize, seq: 1 },
    "oversized": { ...resize, text: "a".repeat(DESK_UI_MAX_MESSAGE_BYTES) },
    "nonfinite": { ...resize, body: { height: Infinity } },
    "nonplain": new Map(),
    "poison key": JSON.parse('{"__proto__":{}}') as unknown,
    "wrong mount": { ...ready, seq: 2, body: { mount: { objectType: "other", view: "result" } } },
    "editor request in result": { ...identity, seq: 2, type: "action:propose", body: { draftId: "draft-1", revision: 1 } },
    "URL navigation": { ...identity, seq: 2, type: "ui:navigate", body: { target: { kind: "url", url: "https://example.invalid" } } },
    "cross connection navigation": { ...identity, seq: 2, type: "ui:navigate", body: { target: { kind: "object", ref: { adapterId: "balance", connectionId: "other", objectType: "task", canonicalId: "x" } } } },
    "height bound": { ...resize, body: { height: 4001 } },
  };
  for (const [name, attack] of Object.entries(attacks)) test(`${name} closes admission permanently`, () => {
    const gate = new InboundGate(identity, mount);
    expect(gate.admit(ready).ok).toBe(true);
    expect(gate.admit(attack).ok).toBe(false);
    expect(gate.admit({ ...resize, seq: 3 }).ok).toBe(false);
  });
  test("readiness is first and exact", () => {
    expect(new InboundGate(identity, mount).admit(resize).ok).toBe(false);
    expect(new InboundGate(identity, mount).admit({ ...ready, body: { mount: { ...mount, view: "editor" } } }).ok).toBe(false);
  });
  test("editor set/null/omit vocabulary and bounds", () => {
    const editor = { ...mount, view: "editor" as const };
    const gate = new InboundGate(identity, editor);
    expect(gate.admit({ ...ready, body: { mount: editor } }).ok).toBe(true);
    expect(gate.admit({ ...identity, seq: 2, type: "draft:change", body: { draftId: "draft", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "Edited" } }, { pointer: "/notes", change: { kind: "null" } }, { pointer: "/optional", change: { kind: "omit" } }] } }).ok).toBe(true);
  });
});

describe("current-policy frame host with real durable state", () => {
  test("release uses parsed projection output, preserving schema redaction", async () => {
    const rig = await openFrameRig();
    try {
      rig.binding.schema = z.object({ title: z.string() });
      rig.state.projection = () => Promise.resolve({ projectionId: "safe", revision: 1, object: { title: "Allowed", credential: "MUST-NOT-LEAK" } });
      const reply = await rig.ready();
      expect(JSON.stringify(reply)).toContain("Allowed");
      expect(JSON.stringify(reply)).not.toContain("MUST-NOT-LEAK");
      const evidence = await rig.authority.service.inspectHostRecords();
      expect(JSON.stringify(evidence.evidence)).not.toContain("MUST-NOT-LEAK");
    } finally { await rig.close(); }
  });
  test("editor changes persist, stale revisions do not edit, propose grants no confirmation or owner effect", async () => {
    const rig = await openFrameRig({ editor: true });
    try {
      const reply = await rig.ready();
      const draft = reply.messages.find(message => message.type === "host:draft");
      if (draft?.type !== "host:draft") throw new Error("Missing host draft");
      const exchange = (seq: number, type: string, body: unknown) => rig.service.exchange(ASSET_OWNER, "local", rig.identity.instance, { ...rig.identity, seq, type, body });
      const edited = await exchange(2, "draft:change", { draftId: draft.body.draftId, baseRevision: draft.body.revision, changes: [{ pointer: "/title", change: { kind: "set", value: "Principal edit" } }, { pointer: "/note", change: { kind: "omit" } }] });
      const updated = edited.messages.find(message => message.type === "host:draft");
      if (updated?.type !== "host:draft") throw new Error("Missing updated draft");
      expect(updated.body.values["/title"]).toBe("Principal edit");
      expect(updated.body.values).not.toHaveProperty("/note");
      const stale = await exchange(3, "draft:change", { draftId: draft.body.draftId, baseRevision: draft.body.revision, changes: [{ pointer: "/title", change: { kind: "set", value: "Stale edit" } }] });
      expect(stale.messages[0]).toMatchObject({ type: "host:reply", body: { outcome: "stale" } });
      expect((await exchange(4, "action:propose", { draftId: draft.body.draftId, revision: updated.body.revision })).messages.at(-1)).toMatchObject({ type: "host:reply", body: { outcome: "accepted" } });
      expect((await rig.binding.editor!.service.read(draft.body.draftId))?.draft.fields["/title"]?.value).toBe("Principal edit");
      expect((await rig.authority.service.inspectHostRecords()).confirmations).toHaveLength(0);
      expect(rig.authority.calls.dispatch + rig.authority.calls.cancel).toBe(0);
      rig.authority.policy.releaseAllowed = false;
      await expect(exchange(5, "action:propose", { draftId: draft.body.draftId, revision: updated.body.revision })).rejects.toThrow();
    } finally { await rig.close(); }
  });
  test("releases only after ready and rejects instance reuse, foreign principals and cached entry URLs", async () => {
    const rig = await openFrameRig();
    try {
      expect(rig.reads).toBe(0);
      expect((await rig.ready()).messages[0]?.type).toBe("host:projection");
      expect(rig.releases).toHaveLength(1);
      await expect(rig.service.open(ASSET_OWNER, "local", rig.registered.mountId, rig.identity.instance)).rejects.toThrow();
      await expect(rig.service.exchange("foreign", "local", rig.identity.instance)).rejects.toThrow();
      const entry = rig.opened.entry;
      expect(FrameEntrySchema.safeParse({ ...entry, uiProtocolVersion: "2.0.0" }).success).toBe(false);
      expect(frameEntryUrl(entry, "https://desk.test")).toContain(entry.releaseDigest);
      for (const url of ["https://evil.test/x", "data:text/html,x", "blob:https://desk.test/x", "/api/desk/adapters/assets/wrong/x", entry.files[0]!.url + "?redirect=x"]) {
        expect(frameEntryUrl({ ...entry, files: entry.files.map(file => file.path === entry.entry ? { ...file, url } : file) }, "https://desk.test")).toBeNull();
      }
      expect(rig.authority.calls.dispatch + rig.authority.calls.cancel).toBe(0);
    } finally { await rig.close(); }
  });
  test("policy revocation before a late projection returns protects the fact", async () => {
    const rig = await openFrameRig();
    try {
      const started = Promise.withResolvers<undefined>();
      const late = Promise.withResolvers<undefined>();
      rig.state.projection = async () => { started.resolve(undefined); await late.promise; return { projectionId: "late", revision: 1, object: { title: "LATE-PRIVATE-CANARY" } }; };
      const pending = rig.ready();
      await started.promise;
      rig.authority.policy.releaseAllowed = false;
      late.resolve(undefined);
      await expect(pending).rejects.toThrow();
      expect(rig.releases).toHaveLength(0);
      expect(rig.authority.calls.dispatch).toBe(0);
    } finally { await rig.close(); }
  });
  test("disable, unknown messages, handshake expiry and removed mounts fail closed", async () => {
    for (const action of ["disable", "protocol", "timeout", "remove"] as const) {
      const rig = await openFrameRig();
      try {
        if (action === "disable") rig.assets.connections.set(ASSET_OWNER, []);
        if (action === "timeout") rig.tick(3001);
        if (action === "remove") rig.registered.remove();
        const message = action === "protocol" ? { ...rig.identity, seq: 1, type: "host:navigate", body: {} } : { ...rig.identity, seq: 1, type: "ui:ready", body: { mount } };
        await expect(rig.service.exchange(ASSET_OWNER, "local", rig.identity.instance, message)).rejects.toThrow();
        await expect(rig.ready()).rejects.toThrow();
        expect(rig.reads).toBe(0);
        expect(rig.authority.calls.dispatch + rig.authority.calls.cancel).toBe(0);
      } finally { await rig.close(); }
    }
  });
  test("cloud UI assets do not authorize local-only data", async () => {
    const rig = await openFrameRig({ audience: "cloud" });
    try {
      rig.binding.scopes[0]!.policy = "local";
      await expect(rig.ready()).rejects.toThrow();
      expect(rig.reads).toBe(0);
      expect(rig.releases).toHaveLength(0);
    } finally { await rig.close(); }
  });
  test("generation change and invalid projected schema preserve evidence without release", async () => {
    for (const change of ["generation", "schema"] as const) {
      const rig = await openFrameRig();
      try {
        if (change === "generation") {
          rig.assets.writePackage({ packageVersion: "9.0.0" });
          expect((await rig.assets.loader.activate(rig.assets.packageId)).ok).toBe(true);
        } else rig.state.projection = () => Promise.resolve({ projectionId: "invalid", revision: 1, object: { credential: "NEVER-RELEASE" } });
        await expect(rig.ready()).rejects.toThrow();
        expect(rig.releases).toHaveLength(0);
        expect(rig.authority.calls.dispatch).toBe(0);
      } finally { await rig.close(); }
    }
  });
  test("mount removal while open awaits the catalog cannot create a new session", async () => {
    const rig = await openFrameRig();
    try {
      const catalog = rig.assets.service.catalog.bind(rig.assets.service);
      const started = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      rig.assets.service.catalog = async (...args) => { started.resolve(undefined); await finish.promise; return catalog(...args); };
      const instance = "e".repeat(32);
      const pending = rig.service.open(ASSET_OWNER, "local", rig.registered.mountId, instance);
      await started.promise;
      rig.registered.remove();
      finish.resolve(undefined);
      await expect(pending).rejects.toThrow();
      await expect(rig.service.exchange(ASSET_OWNER, "local", instance)).rejects.toThrow();
      expect(rig.releases).toHaveLength(0);
    } finally { await rig.close(); }
  });
  test("generation change during projection keeps the late fact out of every frame sink", async () => {
    const rig = await openFrameRig();
    try {
      const started = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      rig.state.projection = async () => { started.resolve(undefined); await finish.promise; return { projectionId: "late", revision: 1, object: { title: "LATE-FACT" } }; };
      const pending = rig.ready();
      await started.promise;
      rig.assets.writePackage({ packageVersion: "9.0.0" });
      expect((await rig.assets.loader.activate(rig.assets.packageId)).ok).toBe(true);
      finish.resolve(undefined);
      await expect(pending).rejects.toThrow();
      expect(rig.releases).toHaveLength(0);
      expect(rig.authority.calls.sends).toHaveLength(0);
      expect(rig.authority.calls.dispatch).toBe(0);
    } finally { await rig.close(); }
  });
});
