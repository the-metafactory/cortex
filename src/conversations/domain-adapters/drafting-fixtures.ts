import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type ConversationHost } from "../host";
import { DraftingBindings, type DestinationMatch, type DraftingBindingDocument, type DraftModel, type DraftPolicy, type DraftService, type DraftSources, type Lane, type ModelOutput, type ModelRequest, type SourceItem } from "./drafting";
import { balanceDeclaration, graphDeclaration, objectRef } from "./fixtures";
import { DomainAdapterRegistry } from "./registry";
import type { AdapterDeclaration } from "./types";

export const E1_TEXT = "The importer can lose acceptance receipts on restart. Compare the persisted receipt with owner lookup, document the crash cases and propose a regression test. File a research node under the lifecycle map in example/project, and put a review task in the Reliability project.";
export const FRIDAY = "2026-11-13";
export const MONDAY = "2026-11-16";
const AT = "2026-11-08T10:00:00.000Z";

export const balanceBinding = (): DraftingBindingDocument => ({
  bindingVersion: "1.0.0", adapterId: "balance", capabilityId: "balance.task.create", inputSchemaRef: { schemaId: "balance.task.create.input", version: "1.0.0" },
  guidance: { guidanceId: "balance-task-guidance", version: "1.0.0", instructions: "Draft a review task: concise title, note summarising the discussion." },
  fieldHints: [{ pointer: "/title", role: "title" }, { pointer: "/note", role: "detail", widget: "long" }, { pointer: "/area", role: "destination", resolveWith: "balance.area.find" }, { pointer: "/project", role: "destination", resolveWith: "balance.area.find" }],
});
export const graphBinding = (): DraftingBindingDocument => ({
  bindingVersion: "1.0.0", adapterId: "work-graph", capabilityId: "work-graph.node.create", inputSchemaRef: { schemaId: "work-graph.node.create.input", version: "1.0.0" },
  guidance: { guidanceId: "graph-node-guidance", version: "1.0.0", instructions: "Draft a research node: title, body with problem and deliverable." },
  fieldHints: [{ pointer: "/title", role: "title" }, { pointer: "/body", role: "detail", widget: "long" }, { pointer: "/parent", role: "destination", resolveWith: "work-graph.node.find" }, { pointer: "/dependencies", role: "destination", resolveWith: "work-graph.node.find" }],
});

function withFinder(declaration: AdapterDeclaration, finderId: string): AdapterDeclaration {
  const creation = declaration.capabilities[0];
  if (!creation) throw new Error("Fixture declaration has no capability.");
  declaration.capabilities.push({ ...creation, capabilityId: finderId, kind: "query" });
  return declaration;
}

export function draftingRegistry() {
  const owner = { mutations: 0, queries: 0 };
  const registry = new DomainAdapterRegistry();
  for (const [declaration, finder] of [[balanceDeclaration(), "balance.area.find"], [graphDeclaration(), "work-graph.node.find"]] as const) {
    const full = withFinder(declaration, finder);
    const handlers = Object.fromEntries(full.capabilities.map(capability => [capability.capabilityId, () => { owner[capability.kind === "action" ? "mutations" : "queries"]++; throw new Error("Synthetic owners must not execute."); }]));
    const registered = registry.register(full, { handlers, observations: {} });
    if (!registered.ok) throw new Error(registered.error.code);
  }
  return { registry, owner };
}

export function draftingState() {
  const state = {
    items: [
      { id: "turn-1", kind: "turn", revision: "1", digest: "d1", restriction: "cloud", text: E1_TEXT, at: AT },
      { id: "outcome-1", kind: "outcome", revision: "1", digest: "d2", restriction: "cloud", text: "Outcome: persist receipts before acknowledging.", at: AT },
    ] as SourceItem[],
    head: "1", unavailable: 0, policyRevision: "policy-1", denied: new Set<string>(), localOnly: new Set<string>(),
    lanes: ["local", "cloud"] as Lane[], requests: [] as ModelRequest[], modelFails: false, onGenerate: undefined as undefined | (() => Promise<void>),
    response: (_request: ModelRequest): unknown => ({ fields: [] }),
    destinations: new Map<string, DestinationMatch>(),
  };
  const sources: DraftSources = {
    capture: ({ entryId }) => Promise.resolve({ boundary: { entryId, revision: state.head }, items: structuredClone(state.items), unavailable: state.unavailable }),
    head: () => Promise.resolve(state.head),
  };
  const policy: DraftPolicy = {
    revision: () => Promise.resolve(state.policyRevision),
    readable: id => Promise.resolve(!state.denied.has(id)),
    releasable: (ids, lane) => Promise.resolve(lane === "local" || ids.every(id => !state.localOnly.has(id))),
  };
  const model: DraftModel = {
    lanes: () => Promise.resolve(state.lanes),
    generate: async request => {
      state.requests.push(request);
      await state.onGenerate?.();
      if (state.modelFails) throw new Error("synthetic model failure");
      return { modelId: "synthetic-model", output: state.response(request) };
    },
  };
  const destinations = { resolve: ({ label }: { label: string }) => Promise.resolve(state.destinations.get(label) ?? { kind: "none" as const }) };
  state.destinations.set("Reliability area", { kind: "unique", ref: objectRef("balance", "area", "area-example") });
  state.destinations.set("Reliability project", { kind: "unique", ref: objectRef("balance", "project", "project-example") });
  return { state, sources, policy, model, destinations };
}

export async function openDraftingRig(dir?: string, contextChars?: number) {
  const root = dir ?? await mkdtemp(join(tmpdir(), "desk-drafting-"));
  const { registry, owner } = draftingRegistry();
  const bindings = new DraftingBindings(registry);
  for (const binding of [balanceBinding(), graphBinding()]) {
    const registered = bindings.register(binding);
    if (!registered.ok) throw new Error(registered.error.code);
  }
  const fake = draftingState();
  let host: ConversationHost | undefined;
  async function open(): Promise<DraftService> {
    const status = await openConversationHost({ dir: root, stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "synthetic", session: request.session, resumed: false }), now: () => new Date(AT) });
    if (status.state !== "ready") throw new Error(status.reason);
    host = status.host;
    return host.drafts({ registry, bindings, sources: fake.sources, policy: fake.policy, model: fake.model, destinations: fake.destinations, now: () => new Date(AT), ...(contextChars ? { contextChars } : {}) });
  }
  let service = await open();
  return {
    root, registry, bindings, owner, ...fake,
    get service() { return service; },
    async reopen() { await host?.close(); service = await open(); return service; },
    async close() { await host?.close(); },
  };
}
export type DraftingRig = Awaited<ReturnType<typeof openDraftingRig>>;

export function balanceResponse(overrides: { title?: string; due?: unknown } = {}): ModelOutput {
  return { fields: [
    { pointer: "/title", value: overrides.title ?? "Review receipt persistence across restart", citations: ["turn-1"] },
    { pointer: "/note", value: "Compare the persisted receipt with owner lookup; document crash cases; propose a regression test.", citations: ["turn-1", "outcome-1"] },
    { pointer: "/area", labels: ["Reliability area"], citations: ["turn-1"] },
    { pointer: "/project", labels: ["Reliability project"], citations: ["turn-1"] },
    ...(overrides.due ? [overrides.due as ModelOutput["fields"][number]] : []),
  ] };
}
