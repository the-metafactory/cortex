import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type ConversationHost } from "../../../../conversations/host";
import { DraftingBindings } from "../../../../conversations/domain-adapters/drafting";
import { draftingState } from "../../../../conversations/domain-adapters/drafting-fixtures";
import { objectSchema, referenceSchema } from "../../../../conversations/domain-adapters/fixtures";
import { DomainAdapterRegistry } from "../../../../conversations/domain-adapters/registry";
import type { AdapterDeclaration } from "../../../../conversations/domain-adapters/types";
import { deskDraftEditor } from "../../desk/draft-editor";
import { handleDeskDrafts } from "../../api/desk-drafts";
import { buildAllowedHostnames } from "../../api/mutation-guard";

const ADAPTER = "specimen";
const CAPABILITY = "specimen.record.make";
const ref = (schemaId: string) => ({ schemaId, version: "1.0.0" });
export const shelfRef = (id: string) => ({ adapterId: ADAPTER, connectionId: "synthetic-local", objectType: "shelf", canonicalId: id });

export async function openDraftEditorRig() {
  const root = await mkdtemp(join(tmpdir(), "desk-make-editor-"));
  const registry = new DomainAdapterRegistry();
  const input = ref(`${CAPABILITY}.input`);
  const output = ref(`${CAPABILITY}.output`);
  const error = ref("specimen.error");
  const shelf = ref("specimen.shelf");
  const declaration: AdapterDeclaration = {
    adapterId: ADAPTER, label: "Synthetic specimen", contractRange: "^1.0.0",
    schemas: [
      { ...input, schema: objectSchema({ headline: { type: "string", minLength: 1, title: "Headline" }, notes: { type: ["string", "null"], title: "Notes" }, shelf: referenceSchema(ADAPTER, "shelf"), count: { type: "integer", minimum: 0, title: "Count", default: 1 }, checked: { type: "boolean", title: "Checked", default: false }, stage: { type: "string", enum: ["new", "reviewed"], default: "new", title: "Stage" }, tags: { type: "array", items: { type: "string" }, title: "Tags" } }, ["headline", "shelf"]) as never },
      { ...output, schema: objectSchema({ ref: referenceSchema(ADAPTER, "record") }) as never },
      { ...error, schema: objectSchema({ code: { type: "string" }, message: { type: "string" } }) as never },
      { ...shelf, schema: referenceSchema(ADAPTER, "shelf") as never },
    ],
    capabilities: [{ capabilityId: CAPABILITY, label: "Specimen record", kind: "action", objectTypes: ["record"], inputSchemaRef: input, outputSchemaRef: output, errorSchemaRef: error }],
    objectTypes: [{ objectType: "record", label: "Record", schemaRef: input, relationships: [{ fieldPath: "/shelf", targetAdapterId: ADAPTER, targetObjectType: "shelf", cardinality: "one" }] }, { objectType: "shelf", label: "Shelf", schemaRef: shelf, relationships: [] }],
  };
  const action = declaration.capabilities[0];
  if (!action) throw new Error("The synthetic action is missing.");
  declaration.capabilities.push({ ...action, capabilityId: "specimen.shelf.find", kind: "query" });
  const registered = registry.register(declaration, { handlers: { "specimen.shelf.find": () => { throw new Error("The drafting resolver must not dispatch a registry handler."); } }, observations: {} });
  if (!registered.ok) throw new Error(registered.error.message);
  const bindings = new DraftingBindings(registry);
  const binding = bindings.register({ bindingVersion: "1.0.0", adapterId: ADAPTER, capabilityId: CAPABILITY, inputSchemaRef: input, guidance: { guidanceId: "specimen-guidance", version: "1.0.0", instructions: "Draft a specimen from the conversation." }, fieldHints: [{ pointer: "/headline", role: "title" }, { pointer: "/notes", role: "detail" }, { pointer: "/shelf", role: "destination", resolveWith: "specimen.shelf.find" }] });
  if (!binding.ok) throw new Error(binding.error.message);
  const fake = draftingState();
  fake.state.response = request => ({ fields: [{ pointer: "/headline", value: "A synthetic draft", citations: ["turn-1"] }, { pointer: "/notes", value: "Synthetic notes", citations: ["turn-1"] }, { pointer: "/shelf", labels: ["Specimen shelf"], citations: ["turn-1"] }].filter(field => request.targets.includes(field.pointer)) });
  fake.state.destinations.set("Specimen shelf", { kind: "unique", ref: shelfRef("shelf-a") });
  const targets = [{ capabilityId: CAPABILITY, connectionId: "synthetic-local", label: "Specimen record" }, { capabilityId: CAPABILITY, connectionId: "synthetic-other", label: "Other specimen destination" }];
  const owner = { mutations: 0, admissions: 0 };
  let host: ConversationHost;
  async function open() {
    const status = await openConversationHost({ dir: root, stack: "synthetic", label: "synthetic", expectedLabel: "synthetic", lanes: {}, turns: request => Promise.resolve({ text: "synthetic", session: request.session, resumed: false }) });
    if (status.state !== "ready") throw new Error(status.reason);
    host = status.host;
    return deskDraftEditor(host, { registry, bindings, sources: fake.sources, policy: fake.policy, model: fake.model, destinations: fake.destinations }, { targets: () => targets, audience: "local", confirm: () => {
      owner.admissions++;
      owner.mutations++;
      return Promise.resolve({ kind: "accepted", operationId: "synthetic-operation" });
    } });
  }
  let editor = await open();
  const conversation = await editor.host.create({ title: "Synthetic Make conversation", origin: { kind: "web" }, links: [], policy: "cloud" }, "local");
  const otherConversation = await editor.host.create({ title: "Another synthetic conversation", origin: { kind: "web" }, links: [], policy: "cloud" }, "local");
  const makeInput = { conversationId: conversation.id, entryId: "turn-1", capabilityId: CAPABILITY, connectionId: "synthetic-local" };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(path, "http://127.0.0.1:8767");
    return handleDeskDrafts(new Request(url, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() }, () => editor);
  };
  return { root, registry, bindings, targets, owner, ...fake, makeInput, otherConversation, call,
    get editor() { return editor; },
    async reopen() { await editor.host.close(); editor = await open(); },
    async close() { await editor.host.close(); await rm(root, { recursive: true, force: true }); },
  };
}
