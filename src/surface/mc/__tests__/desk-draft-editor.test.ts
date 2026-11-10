import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDraftEditorRig, shelfRef } from "./fixtures/draft-editor";
import { DESK_DRAFTS_PATH, type DraftEditorView } from "../desk/draft-editor-contract";
import { handleDeskDrafts } from "../api/desk-drafts";
import { buildAllowedHostnames } from "../api/mutation-guard";
import { startServer } from "../server";
import { initDatabase } from "../db/init";
import { DEFAULT_CONFIG } from "../config";

type Rig = Awaited<ReturnType<typeof openDraftEditorRig>>;
const withRig = async (run: (rig: Rig) => Promise<void>) => {
  const rig = await openDraftEditorRig();
  try { await run(rig); }
  finally { await rig.close(); }
};
async function made(rig: Rig): Promise<DraftEditorView> {
  const res = await rig.call("POST", DESK_DRAFTS_PATH, rig.makeInput);
  expect(res.status).toBe(200);
  return await res.json() as DraftEditorView;
}
const path = (editor: DraftEditorView) => `${DESK_DRAFTS_PATH}/${editor.view.draft.draftId}`;

describe("generic Desk Make route", () => {
  test("decodes escaped draft IDs and rejects malformed escapes", () => withRig(async rig => {
    const first = await made(rig);
    const escapedId = Array.from(first.view.draft.draftId).map(char => `%${char.charCodeAt(0).toString(16)}`).join("");
    const encoded = `${DESK_DRAFTS_PATH}/${escapedId}`;
    const res = await rig.call("GET", encoded);
    expect(res.status).toBe(200);
    expect((await res.json() as DraftEditorView).view.draft.draftId).toBe(first.view.draft.draftId);
    expect((await rig.call("GET", `${encoded}/details?pointer=%2Fshelf`)).status).toBe(200);
    for (const invalid of ["%", "%GG", "%E0%A4%A"]) expect((await rig.call("GET", `${DESK_DRAFTS_PATH}/${invalid}`)).status).toBe(400);
  }));

  test("runs through the real MC router with principal-only discovery and host.drafts", () => withRig(async rig => {
    const db = initDatabase(join(rig.root, "mc.db"));
    const ctx = startServer({ ...DEFAULT_CONFIG, hostname: "127.0.0.1", port: 0 }, db, { drafts: () => rig.editor });
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}${DESK_DRAFTS_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rig.makeInput) });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json() as DraftEditorView;
      expect(body.view.draft.adapterId).toBe("specimen");
      expect(body.fields.map(field => field.label)).toContain("Headline");
      const refused = await fetch(`http://127.0.0.1:${ctx.port}${DESK_DRAFTS_PATH}`, { headers: { "cf-access-authenticated-user-email": "other@example.invalid" } });
      expect(refused.status).toBe(403);
    } finally { await ctx.server.stop(true); db.close(); }
  }));

  test("Make, edit, clear, refresh and host reopen preserve principal fields and expose destination changes", () => withRig(async rig => {
    const first = await made(rig);
    expect(first.view.draft.fields["/shelf"]?.origin).toBe("suggested");
    expect(first.fields.find(field => field.pointer === "/shelf")?.destination).toBe(true);
    const p = path(first);
    const edit = await rig.call("PATCH", p, { revision: first.view.draft.revision, pointer: "/headline", change: { kind: "set", value: "Principal text" } });
    const edited = await edit.json() as DraftEditorView;
    const clear = await rig.call("PATCH", p, { revision: edited.view.draft.revision, pointer: "/notes", change: { kind: "omit" } });
    const cleared = await clear.json() as DraftEditorView;
    rig.state.destinations.set("Specimen shelf", { kind: "unique", ref: shelfRef("shelf-b") });
    const refresh = await rig.call("POST", `${p}/refresh`, { revision: cleared.view.draft.revision });
    const refreshed = await refresh.json() as DraftEditorView;
    expect(refreshed.destinationChanges).toEqual([{ pointer: "/shelf", before: shelfRef("shelf-a"), after: shelfRef("shelf-b") }]);
    expect(refreshed.view.draft.fields["/headline"]?.value).toBe("Principal text");
    expect(refreshed.view.draft.fields["/notes"]?.presence).toBe("absent");
    const generations = rig.state.requests.length;
    await rig.reopen();
    const reopened = await made(rig);
    expect(reopened.view.draft).toEqual(refreshed.view.draft);
    expect(rig.state.requests).toHaveLength(generations);
    expect((await rig.call("GET", p)).status).toBe(200);
  }));

  test("rejects stale and undeclared edits and invalid or unavailable destinations", () => withRig(async rig => {
    const first = await made(rig);
    const p = path(first);
    const rev = first.view.draft.revision;
    expect((await rig.call("PATCH", p, { revision: rev - 1, pointer: "/headline", change: { kind: "set", value: "Lost edit" } })).status).toBe(409);
    expect((await rig.call("PATCH", p, { revision: rev, pointer: "/invented", change: { kind: "omit" } })).status).toBe(409);
    expect((await rig.call("POST", `${p}/refresh`, { revision: rev - 1 })).status).toBe(409);
    expect((await rig.call("POST", `${p}/destination`, { revision: rev, capabilityId: "specimen.record.make", connectionId: "unavailable" })).status).toBe(403);
    expect((await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput, connectionId: "unavailable" })).status).toBe(403);
    expect((await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput, grant: true })).status).toBe(400);
    expect((await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput, conversationId: "missing-conversation" })).status).toBe(404);
    expect(rig.owner.mutations).toBe(0);
  }));

  test("shows an explicit connection change without generation or owner mutation", () => withRig(async rig => {
    const first = await made(rig);
    const generations = rig.state.requests.length;
    const res = await rig.call("POST", `${path(first)}/destination`, { revision: first.view.draft.revision, capabilityId: "specimen.record.make", connectionId: "synthetic-other" });
    const changed = await res.json() as DraftEditorView;
    expect(changed.view.outdated).toContain("destination-changed");
    expect(changed.destinationChanges).toEqual([{ pointer: "connection", before: "synthetic-local", after: "synthetic-other" }]);
    expect(changed.view.draft.fields).toEqual(first.view.draft.fields);
    expect(rig.state.requests).toHaveLength(generations);
    expect(rig.owner.mutations).toBe(0);
  }));

  test("keeps multiple saved drafts selectable and ordinary Make reopens instead of generating", () => withRig(async rig => {
    const first = await made(rig);
    const second = await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput, newDraft: true });
    const next = await second.json() as DraftEditorView;
    expect(next.view.draft.draftId).not.toBe(first.view.draft.draftId);
    const generations = rig.state.requests.length;
    const selected = await rig.call("POST", DESK_DRAFTS_PATH, rig.makeInput);
    expect(await selected.json()).toMatchObject({ kind: "select", candidates: [{ draftId: first.view.draft.draftId }, { draftId: next.view.draft.draftId }] });
    const reopened = await rig.call("POST", DESK_DRAFTS_PATH, { ...rig.makeInput, selectDraftId: first.view.draft.draftId });
    expect(await reopened.json()).toMatchObject({ kind: "draft", reopened: true, view: { draft: { draftId: first.view.draft.draftId } } });
    expect(rig.state.requests).toHaveLength(generations);
  }));

  test("policy-blocked confirmation explains the reason and never calls the owner", () => withRig(async rig => {
    const first = await made(rig);
    rig.state.localOnly.add("turn-1");
    rig.editor.audience = "cloud";
    const res = await rig.call("POST", `${path(first)}/confirm`, { revision: first.view.draft.revision });
    expect(await res.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("Policy withholds") } });
    expect(rig.owner).toEqual({ mutations: 0, admissions: 0 });
    rig.editor.audience = "local";
    rig.state.policyRevision = "changed-policy";
    const policy = await rig.call("POST", `${path(first)}/confirm`, { revision: first.view.draft.revision });
    expect(await policy.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("policy-changed") } });
    expect(rig.owner).toEqual({ mutations: 0, admissions: 0 });
    rig.state.policyRevision = "policy-1";
    rig.editor.confirm = undefined;
    const inactive = await rig.call("POST", `${path(first)}/confirm`, { revision: first.view.draft.revision });
    expect(await inactive.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("Creation is not enabled") } });
  }));

  test("the synthetic owner counter records a confirmation permitted by the route", () => withRig(async rig => {
    const first = await made(rig);
    const res = await rig.call("POST", `${path(first)}/confirm`, { revision: first.view.draft.revision });
    expect(await res.json()).toEqual({ confirmation: { kind: "accepted", operationId: "synthetic-operation" } });
    expect(rig.owner).toEqual({ mutations: 1, admissions: 1 });
  }));

  test("confirmation passes the exact validated handoff and authenticated principal to the host boundary", () => withRig(async rig => {
    const first = await made(rig);
    rig.editor.confirm = request => {
      expect(request).toMatchObject({ principal: "local-principal@loopback", transport: "web", audience: "local", handoff: { draftId: first.view.draft.draftId, draftRevision: first.view.draft.revision, adapterId: "specimen", connectionId: "synthetic-local", input: { headline: "A synthetic draft", shelf: shelfRef("shelf-a") } } });
      expect(request.handoff.digest).toMatch(/^[0-9a-f]{64}$/);
      rig.owner.admissions++;
      return Promise.resolve({ kind: "accepted", operationId: "synthetic-operation" });
    };
    const p = `${path(first)}/confirm`;
    expect((await rig.call("POST", p, { revision: first.view.draft.revision - 1 })).status).toBe(409);
    expect(rig.owner.admissions).toBe(0);
    expect(await (await rig.call("POST", p, { revision: first.view.draft.revision })).json()).toEqual({ confirmation: { kind: "accepted", operationId: "synthetic-operation" } });
    expect(rig.owner).toEqual({ mutations: 0, admissions: 1 });
  }));

  test("principal auth and rebinding guard apply to reads, details, Make and confirmation", () => withRig(async rig => {
    const first = await made(rig);
    const requests = [["GET", DESK_DRAFTS_PATH], ["GET", path(first)], ["GET", `${path(first)}/details?pointer=%2Fshelf`], ["POST", DESK_DRAFTS_PATH], ["POST", `${path(first)}/confirm`]] as const;
    for (const [method, p] of requests) expect((await rig.call(method, p, method === "POST" ? rig.makeInput : undefined, { "cf-access-authenticated-user-email": "other@example.invalid" })).status).toBe(403);
    const foreign: Record<string, string>[] = [{ host: "rebound.invalid:8767" }, { origin: "https://foreign.invalid" }];
    for (const headers of foreign) expect((await rig.call("POST", DESK_DRAFTS_PATH, rig.makeInput, headers)).status).toBe(403);
    expect(rig.owner).toEqual({ mutations: 0, admissions: 0 });
  }));

  test("all mutation responses and source details honor the host's cloud audience", () => withRig(async rig => {
    rig.state.localOnly.add("turn-1");
    const first = await made(rig);
    rig.editor.audience = "cloud";
    const p = path(first);
    const res = await rig.call("GET", p);
    const cloud = await res.json() as DraftEditorView;
    expect(cloud.view.withheld).toContain("/headline");
    expect(cloud.view.draft.fields["/headline"]).toBeUndefined();
    const details = await rig.call("GET", `${p}/details?pointer=%2Fshelf`);
    expect(await details.json()).toMatchObject({ details: { sources: [], hiddenSources: 1, alternatives: [] } });
    const refreshed = await rig.call("POST", `${p}/refresh`, { revision: first.view.draft.revision });
    expect((await refreshed.json() as DraftEditorView).view.draft.fields["/headline"]).toBeUndefined();
    const reopened = await rig.call("POST", DESK_DRAFTS_PATH, rig.makeInput);
    const view = await reopened.json() as DraftEditorView;
    expect(view.view.draft.fields["/headline"]).toBeUndefined();
    const denied = await rig.call("POST", `${p}/confirm`, { revision: view.view.draft.revision });
    expect(await denied.json()).toMatchObject({ confirmation: { kind: "blocked", reason: expect.stringContaining("Policy withholds") } });
    expect(rig.owner).toEqual({ mutations: 0, admissions: 0 });
  }));

  test("unconfigured Make discovery stays empty and mutation fails closed", async () => {
    const guard = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set<string>() };
    const url = new URL(DESK_DRAFTS_PATH, "http://127.0.0.1:8767");
    const request = (method: string) => new Request(url, { method, headers: { host: url.host } });
    expect(await (await handleDeskDrafts(request("GET"), url, guard, undefined)).json()).toEqual({ targets: [] });
    expect((await handleDeskDrafts(request("POST"), url, guard, undefined)).status).toBe(503);
  });

  test("a verified remote request cannot use the editor's local audience", () => withRig(async rig => {
    const first = await made(rig);
    rig.state.localOnly.add("turn-1");
    const url = new URL(`${path(first)}?audience=local`, "https://desk.example.invalid");
    const req = new Request(url, { headers: { host: url.host, "cf-access-jwt-assertion": "synthetic" } });
    const guard = { isLoopback: false, allowedHostnames: buildAllowedHostnames(url.hostname), listenPort: 443, principals: new Set(["principal@example.invalid"]), verifyJwt: () => Promise.resolve({ email: "principal@example.invalid" }) };
    const res = await handleDeskDrafts(req, url, guard, () => rig.editor);
    expect(res.status).toBe(200);
    const shown = await res.json() as DraftEditorView;
    expect(shown.view.withheld).toContain("/headline");
    expect(shown.view.draft.fields["/headline"]).toBeUndefined();
  }));
});
