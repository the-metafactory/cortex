import { randomUUID } from "node:crypto";
import { openFlowCutoverRig } from "../../../../../conversations/domain-adapters/__tests__/fixtures/flow-cutover-fixtures";
import { flowSaveDefinition } from "../../../../../conversations/domain-adapters/__tests__/fixtures/flow-save-fixtures";
import { deskBackendFixtureSource } from "../../../../../conversations/domain-adapters/__tests__/fixtures/package-fixtures";
import { draftingState } from "../../../../../conversations/domain-adapters/drafting-fixtures";
import { flowSaveDraftingBinding } from "../../../../../conversations/domain-adapters/drafting/flow";
import { FLOW_EDITOR_ENTRY, FLOW_EDITOR_FILES, FLOW_EDITOR_VIEWS } from "../../../../../conversations/domain-adapters/flow/editor-ui";
import { flowSaveDeclaration } from "../../../../../conversations/domain-adapters/flow/save-binding";
import { writerBindingKey, writerLease } from "../../../../../conversations/domain-adapters/operations/writer-authority";
import { AdapterFrameHost } from "../../adapter-frame-host";
import { identityOf, newInstance } from "../../adapter-frame-protocol";
import { deskFlowDraftEditor } from "../../flow-draft-entry";
import { flowEditorFrameBinding } from "../../flow-editor";
import { ASSET_OWNER, openAssetRig } from "./adapter-asset-fixtures";

export const FLOW_EDITOR_VIEW_ID = "flow-editor-view";
export const FLOW_DRAFT_DEFINITION = flowSaveDefinition("F_EDITOR_DRAFT");

export function hostileFlowEditorScript(attack: "save" | "approve" | "confirm-fetch" | "throw"): string {
  return `(() => {
  if (${JSON.stringify(attack)} === "throw") throw new Error("synthetic_render_failure");
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "host:init" || event.ports.length !== 1) return;
    const init = event.data;
    const port = event.ports[0];
    let seq = 0;
    const send = (type, body) => { port.postMessage({ ...init, type, body, seq: ++seq }); };
    let attacked = false;
    port.onmessage = message => {
      if (message.data.type !== "host:draft" || attacked) return;
      attacked = true;
      const draft = message.data.body;
      console.log("FRAME_PROBE:" + ${JSON.stringify(attack)});
      if (${JSON.stringify(attack)} === "save") send("flow:save", { draftId: draft.draftId });
      if (${JSON.stringify(attack)} === "approve") send("host:approve", { draftId: draft.draftId, revision: draft.revision });
      if (${JSON.stringify(attack)} === "confirm-fetch") fetch("/api/desk/drafts/" + draft.draftId + "/confirm", { method: "POST", body: "{}" }).then(() => console.log("FRAME_PROBE:confirm-allowed"), () => console.log("FRAME_PROBE:confirm-denied"));
    };
    port.start();
    send("ui:ready", init.body);
  });
})();`;
}

export async function openFlowEditorRig(options: { script?: string } = {}) {
  const flow = await openFlowCutoverRig();
  await flow.activate();
  flow.policy.allowedAudiences = ["web", "view"];
  const declaration = flowSaveDeclaration();
  const files = { ...FLOW_EDITOR_FILES };
  if (options.script) files["ui/flow-editor.js"] = { body: options.script, mediaType: "text/javascript" };
  const backendSource = deskBackendFixtureSource({ declaration, actionCapabilityId: "flow.saved.create", writerOwner: "flow", support: flow.binding.support, query: { capabilityId: "flow.stack.destinations", page: { items: [] } } });
  const assets = await openAssetRig({ adapterId: "flow", ui: { entry: FLOW_EDITOR_ENTRY, views: [...FLOW_EDITOR_VIEWS], files }, package: { declaration, backendSource, draftingBindings: [flowSaveDraftingBinding], readBindings: [] } });
  assets.connections.set(ASSET_OWNER, [{ connectionId: flow.binding.support.connectionId, packageId: assets.packageId, state: "enabled", readCapabilityIds: ["flow.stack.destinations"], writeCapabilityIds: ["flow.saved.create"] }]);

  const state = draftingState();
  const connectionId = flow.binding.support.connectionId;
  const stack = flow.binding.writerBinding.stack;
  state.state.response = () => ({ fields: [
    { pointer: "/name", value: "F_EDITOR_DRAFT", citations: ["turn-1"] },
    { pointer: "/definition", value: FLOW_DRAFT_DEFINITION, citations: ["turn-1"] },
    { pointer: "/stack", labels: [stack], citations: ["turn-1"] },
  ] });
  const key = writerBindingKey(flow.binding.writerBinding);
  const bridge = flow.host.lifecycleBridge(flow.registry, flow.bindings, snapshot => snapshot.adapterId === "flow" && snapshot.connectionId === connectionId && snapshot.capabilityId === "flow.saved.create" ? flow.binding.support : undefined);
  const openSessions: { close(): void }[] = [];
  const sessions = new Map<string, Awaited<ReturnType<typeof flow.openSession>>>();
  const draftEditor = deskFlowDraftEditor(flow.host, { registry: flow.registry, sources: state.sources, policy: state.policy, model: state.model }, {
    connectionId, stack, audience: "local", authority: flow.authority,
    bridge: { dispatch: async (context, operationId, lease) => { await bridge.activate(flow.binding.writerBinding, lease); return bridge.dispatch(context, operationId, lease); } },
    session: async conversationId => {
      const record = await flow.host.lifecycleWriters().read(key);
      if (!record) return null;
      const opened = sessions.get(conversationId) ?? await flow.openSession(flow.actor, conversationId);
      if (!sessions.has(conversationId)) { sessions.set(conversationId, opened); openSessions.push(opened); }
      return { runner: { create: () => Promise.reject(new Error("Flow drafts run no queries.")), run: () => Promise.reject(new Error("Flow drafts run no queries.")) }, context: opened.context, sink: { kind: "web", conversationId }, lease: writerLease(record), principal: flow.actor.principal };
    },
    sourceRestrictions: () => Promise.resolve([]),
  });
  const made = await draftEditor.service.make({ conversationId: flow.id, entryId: "turn-1", capabilityId: "flow.saved.create", connectionId });
  if (made.kind !== "draft") throw new Error("Synthetic Flow draft unavailable");
  const draftId = made.view.draft.draftId;

  const viewSession = randomUUID();
  flow.sessions.set(viewSession, { principal: flow.actor.principal, stack, conversationId: flow.id, authenticatedSessionRef: viewSession, transport: "web", audience: "view", viewId: FLOW_EDITOR_VIEW_ID, expiresAt: "2026-12-01T00:00:00Z", maintenance: false });
  const context = await flow.authority.authenticate(viewSession);
  if (!context) throw new Error("Synthetic view context unavailable");
  const destination = { adapterId: "flow", connectionId, objectType: "stack", canonicalId: stack };
  const binding = flowEditorFrameBinding({
    principal: ASSET_OWNER, audience: "local", connectionId, authority: flow.authority, context,
    sink: { kind: "view", conversationId: flow.id, viewId: FLOW_EDITOR_VIEW_ID },
    scopes: [{ capabilityId: "flow.saved.create", destinations: [destination], policy: "local" }],
    service: draftEditor.service, draftId, hasOperation: draftEditor.hasOperation.bind(null, made.view),
  });
  let now = Date.now();
  const frames = new AdapterFrameHost(assets.service, () => now);
  const registered = frames.register(binding);
  const instance = newInstance();
  const opened = await frames.open(ASSET_OWNER, "local", registered.mountId, instance);
  const identity = identityOf(opened.entry, instance);
  const readDraft = async () => {
    const view = await draftEditor.service.read(draftId, "local");
    if (!view) throw new Error("Synthetic Flow draft vanished");
    return view;
  };
  return {
    flow, assets, state, draftEditor, draftId, binding, frames, registered, opened, identity, instance, readDraft, connectionId, stack,
    tick(ms: number) { now += ms; },
    send: (seq: number, type: string, body: unknown) => frames.exchange(ASSET_OWNER, "local", instance, { ...identity, seq, type, body }),
    async close() {
      registered.remove();
      for (const session of openSessions) session.close();
      await assets.close();
      await flow.close();
    },
  };
}
export type FlowEditorRig = Awaited<ReturnType<typeof openFlowEditorRig>>;
