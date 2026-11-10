import type { DraftingBindingDocument } from "../drafting";

export const workGraphNodeDraftingBinding: DraftingBindingDocument = {
  bindingVersion: "1.0.0",
  adapterId: "work-graph",
  capabilityId: "work-graph.node.create",
  inputSchemaRef: { schemaId: "work-graph.node.create.input", version: "1.0.0" },
  guidance: { guidanceId: "work-graph.node.create", version: "1.0.0", instructions: "Draft a graph node from the supplied discussion. Resolve repository, parent and dependencies from ticked repositories, conversation links or exact references. Leave unknown or ambiguous references unresolved." },
  fieldHints: [
    { pointer: "/title", role: "title" },
    { pointer: "/body", role: "detail", widget: "long" },
    ...["repository", "parent", "dependencies"].map(key => ({ pointer: `/${key}`, role: "destination" as const, resolveWith: "work-graph.destinations" })),
  ],
};
