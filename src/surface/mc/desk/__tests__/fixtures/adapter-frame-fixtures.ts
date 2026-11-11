import { z } from "zod";
import { deskDraftEditor, type DeskDraftEditor } from "../../draft-editor";
import { DraftingBindings } from "../../../../../conversations/domain-adapters/drafting";
import { balanceBinding, balanceResponse, draftingRegistry, draftingState } from "../../../../../conversations/domain-adapters/drafting-fixtures";
import { authorityRig } from "../../../../../conversations/authority-fixtures";
import { AdapterFrameHost, type FrameBinding } from "../../adapter-frame-host";
import { identityOf, newInstance } from "../../adapter-frame-protocol";
import { ASSET_OWNER, inlineUiFixture, openAssetRig } from "./adapter-asset-fixtures";

export async function openFrameRig(options: { audience?: "local" | "cloud"; script?: string; editor?: boolean } = {}) {
  const audience = options.audience ?? "local";
  const ui = inlineUiFixture();
  if (options.editor) ui.views = [{ objectType: "task", view: "editor" }];
  if (options.script) ui.files["ui/app.js"] = { body: options.script, mediaType: "text/javascript" };
  const assets = await openAssetRig({ ui });
  const authority = await authorityRig({}, audience);
  const authenticate = authority.bindings.authenticate;
  authority.bindings.authenticate = async session => {
    const bound = await authenticate(session);
    return bound ? { ...bound, audience: "view", viewId: "fixture-view" } : null;
  };
  const context = await authority.service.authenticate("authenticated-session");
  if (!context) throw new Error("Synthetic frame context unavailable");
  const sink = { kind: "view" as const, conversationId: authority.approval.snapshot.provenance.conversationId, viewId: "fixture-view" };
  const releases: unknown[] = [];
  let reads = 0;
  const state: { projection?: FrameBinding["projection"] } = {};
  const binding: FrameBinding = {
    principal: ASSET_OWNER, audience, adapterId: "balance", connectionId: "connection-example", mount: { objectType: "task", view: "result" },
    authority: authority.service, context, sink,
    scopes: [{ capabilityId: "balance.task.create", destinations: authority.approval.snapshot.destinations, policy: audience }],
    schema: z.object({ title: z.string() }).strict(),
    projection: () => { reads++; return state.projection ? state.projection() : Promise.resolve({ projectionId: "fixture-projection", revision: 1, object: { title: "SYNTHETIC-PRIVATE-CANARY" } }); },
  };
  const draftState = draftingState();
  let draftEditor: DeskDraftEditor | undefined;
  if (options.editor) {
    const { registry } = draftingRegistry();
    const bindings = new DraftingBindings(registry);
    if (!bindings.register(balanceBinding()).ok) throw new Error("Synthetic draft binding unavailable");
    draftState.state.response = () => balanceResponse();
    draftEditor = deskDraftEditor(authority.host, { registry, bindings, sources: draftState.sources, policy: draftState.policy, model: draftState.model, destinations: draftState.destinations }, { targets: () => [{ capabilityId: "balance.task.create", connectionId: binding.connectionId, label: "Synthetic task" }], audience });
    const drafts = draftEditor.service;
    const made = await drafts.make({ conversationId: sink.conversationId, entryId: "turn-1", capabilityId: "balance.task.create", connectionId: binding.connectionId });
    if (made.kind !== "draft") throw new Error("Synthetic editor unavailable");
    binding.mount = { objectType: "task", view: "editor" };
    binding.editor = { service: drafts, draftId: made.view.draft.draftId, hasOperation: () => Promise.resolve(false) };
  }
  let now = Date.now();
  const service = new AdapterFrameHost(assets.service, () => now);
  const registered = service.register(binding);
  const instance = newInstance();
  const opened = await service.open(ASSET_OWNER, audience, registered.mountId, instance);
  const identity = identityOf(opened.entry, instance);
  return {
    assets, authority, service, binding, registered, opened, identity, state, releases, draftState, draftEditor,
    get reads() { return reads; },
    tick(ms: number) { now += ms; },
    ready: async () => {
      const reply = await service.exchange(ASSET_OWNER, audience, instance, { ...identity, seq: 1, type: "ui:ready", body: { mount: binding.mount } });
      releases.push(...reply.messages.filter(message => message.type === "host:projection"));
      return reply;
    },
    async close() { registered.remove(); await authority.close(); await assets.close(); },
  };
}
