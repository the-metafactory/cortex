import type { ConversationHost } from "../../../conversations/host";
import type { DraftServiceDeps, DraftView, Lane } from "../../../conversations/domain-adapters/drafting";
import type { DraftConfirmation, DraftConfirmationRequest, DraftReceipt, DraftEditorView, DraftTarget } from "./draft-editor-contract";

export function deskDraftEditor(host: ConversationHost, deps: DraftServiceDeps, options: {
  targets: () => readonly DraftTarget[];
  audience: Lane;
  hasOperation?: (view: DraftView) => Promise<boolean>;
  receipt?: (view: DraftView) => Promise<DraftReceipt | null>;
  confirm?: (request: DraftConfirmationRequest) => Promise<DraftConfirmation>;
}) {
  const service = host.drafts(deps);
  async function present(view: DraftView, before?: DraftView): Promise<DraftEditorView> {
    const schema = deps.registry.draftingView(view.draft.capabilityId);
    const binding = deps.bindings.lookup(view.draft.adapterId, view.draft.capabilityId, view.draft.schemaRef);
    const pinned = schema?.inputSchemaRef.schemaId === view.draft.schemaRef.schemaId && schema.inputSchemaRef.version === view.draft.schemaRef.version;
    const fields = pinned ? Object.keys(schema.root.properties ?? {}).map(key => {
      const pointer = `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      const node = schema.field(pointer) ?? {};
      return { pointer, label: typeof node.title === "string" ? node.title : key, schema: node, required: Array.isArray(schema.root.required) && schema.root.required.includes(key), destination: schema.relationships.some(relation => relation.fieldPath === pointer), long: binding?.fieldHints.some(hint => hint.pointer === pointer && hint.widget === "long") ?? false };
    }) : [];
    const destinationChanges = before ? fields.filter(field => field.destination).flatMap(field => {
      const old = before.draft.fields[field.pointer]?.value ?? null;
      const next = view.draft.fields[field.pointer]?.value ?? null;
      return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ pointer: field.pointer, before: old, after: next }];
    }) : [];
    if (before && before.draft.connectionId !== view.draft.connectionId) destinationChanges.push({ pointer: "connection", before: before.draft.connectionId, after: view.draft.connectionId });
    return { view, fields, destinationChanges, receipt: await options.receipt?.(view) ?? null };
  }
  const hasOperation = options.hasOperation ?? (async (view: DraftView) => Boolean(await options.receipt?.(view)));
  return { host, service, targets: options.targets, audience: options.audience, confirm: options.confirm, hasOperation, present };
}

export type DeskDraftEditor = ReturnType<typeof deskDraftEditor>;
export type DeskDraftAccess = () => DeskDraftEditor | null;
