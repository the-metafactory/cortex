import { z } from "zod";
import type { AdapterDeclaration, ObjectReference } from "../types";
import { adapterErrorSchema } from "../schema-primitives";
import { buildApprovedSnapshot } from "../operations/owner-results";
import type { OwnerSupport } from "../operations/types";
import { balanceInboxWriter } from "../../../surface/mc/desk/balance-conversation-writer";
import { BALANCE_ADAPTER_ID, objectSchema, ref, referenceSchema } from "./schema";
import { balanceCreateSupport, balanceReference, type BalanceCreateContract, type BalanceCreateFields, type BalanceCreateReview } from "./create-binding";

const CAPABILITY_ID = "balance.inbox-task.create";
const BALANCE_INBOX_TASK_CREATE_SUPPORT_ID = "balance.inbox-task.create.v1";
const BALANCE_INBOX_DESTINATION_ID = "inbox";
const INBOX = ref(`${CAPABILITY_ID}.inbox`);
const TASK = ref(`${CAPABILITY_ID}.task`);
const INPUT = ref(`${CAPABILITY_ID}.input`);
const OUTPUT = ref(`${CAPABILITY_ID}.output`);
const ERROR = ref(`${CAPABILITY_ID}.error`);
const ITEM_KEY_MAX = 500;
const INPUT_SCHEMA = objectSchema({ item: { type: "string", minLength: 1, maxLength: ITEM_KEY_MAX }, title: { type: "string", minLength: 1, maxLength: 300 } }, ["item", "title"]);

export const BALANCE_INBOX_TASK_CREATE_SCHEMAS: AdapterDeclaration["schemas"] = [
  { ...INBOX, schema: referenceSchema("inbox") },
  { ...TASK, schema: referenceSchema("task") },
  { ...INPUT, schema: INPUT_SCHEMA },
  { ...OUTPUT, schema: objectSchema({ ref: referenceSchema("task") }, ["ref"]) },
  { ...ERROR, schema: adapterErrorSchema(BALANCE_ADAPTER_ID) },
];
export const BALANCE_INBOX_TASK_CREATE_CAPABILITIES: AdapterDeclaration["capabilities"] = [{ capabilityId: CAPABILITY_ID, label: "Create Inbox task from a Day item", kind: "action", objectTypes: ["task"], inputSchemaRef: INPUT, outputSchemaRef: OUTPUT, errorSchemaRef: ERROR }];
export const INBOX_OBJECT_TYPE: AdapterDeclaration["objectTypes"][number] = { objectType: "inbox", label: "Inbox", schemaRef: INBOX, relationships: [] };
export const INBOX_TASK_DRAFT_OBJECT_TYPE: AdapterDeclaration["objectTypes"][number] = { objectType: "inbox-task-draft", label: "Inbox task draft", schemaRef: INPUT, relationships: [] };

function balanceInboxTaskCreateDeclaration(): AdapterDeclaration {
  return {
    adapterId: BALANCE_ADAPTER_ID, label: "Balance", contractRange: "^1.0.0",
    schemas: BALANCE_INBOX_TASK_CREATE_SCHEMAS,
    objectTypes: [INBOX_OBJECT_TYPE, { objectType: "task", label: "Task", schemaRef: TASK, relationships: [] }, INBOX_TASK_DRAFT_OBJECT_TYPE],
    capabilities: BALANCE_INBOX_TASK_CREATE_CAPABILITIES,
  };
}
function balanceInboxTaskCreateSupport(connectionId: string, declarationId = BALANCE_INBOX_TASK_CREATE_SUPPORT_ID): OwnerSupport {
  return balanceCreateSupport(CAPABILITY_ID, connectionId, declarationId);
}
export const BalanceInboxTaskCreateInputSchema = z.object({ item: z.string().min(1).max(ITEM_KEY_MAX), title: z.string().min(1).max(300) }).strict();
export type BalanceInboxTaskCreateInput = z.infer<typeof BalanceInboxTaskCreateInputSchema>;
export type BalanceInboxTaskReview = Exclude<BalanceCreateReview<BalanceInboxTaskCreateInput>, { kind: "choice" }>;
const refusedReview = (reason: string, fields: BalanceCreateFields): BalanceInboxTaskReview => ({ kind: "refused", reason, fields: { ...fields } });
const parseBalanceInboxTaskInput = (raw: unknown, _connectionId: string): BalanceInboxTaskCreateInput => BalanceInboxTaskCreateInputSchema.parse(raw);
const inboxDestinations = (_input: BalanceInboxTaskCreateInput, connectionId: string): ObjectReference[] => [balanceReference(connectionId, "inbox", BALANCE_INBOX_DESTINATION_ID)];

export const BALANCE_INBOX_TASK_CONTRACT: BalanceCreateContract<BalanceInboxTaskCreateInput, BalanceInboxTaskReview> = {
  kind: "task", owner: "balance-inbox-task", capabilityId: CAPABILITY_ID,
  declaration: balanceInboxTaskCreateDeclaration, support: balanceInboxTaskCreateSupport,
  parse: parseBalanceInboxTaskInput,
  destinations: inboxDestinations,
  legacyFields: input => ({ item: input.item, title: input.title }),
  refusedReview,
  review(fields, _state, _areas, _connectionId) {
    if (!fields.item?.trim()) return refusedReview("An Inbox task needs a Day item.", fields);
    if (!fields.title?.trim()) return refusedReview("An Inbox task needs a title.", fields);
    const parsed = BalanceInboxTaskCreateInputSchema.safeParse({ item: fields.item, title: fields.title });
    return parsed.success ? { kind: "resolved", input: parsed.data, requiresFreshApproval: false, fields: { ...fields } } : refusedReview("An Inbox task takes a Day item key of up to 500 characters and a title of up to 300.", fields);
  },
  snapshot(options) {
    const input = parseBalanceInboxTaskInput(options.input, options.connectionId);
    return buildApprovedSnapshot({ provenance: options.provenance, adapterId: BALANCE_ADAPTER_ID, connectionId: options.connectionId, capabilityId: CAPABILITY_ID, inputSchemaRef: INPUT, outputSchemaRef: OUTPUT, errorSchemaRef: ERROR, input, destinations: inboxDestinations(input, options.connectionId), policy: options.policy ?? "local" });
  },
  ownerWriter(options) {
    if (!options.deskItems) throw new Error("balance.inbox_items_missing");
    return balanceInboxWriter({ db: options.db, desk: options.desk, deskItems: options.deskItems, ...(options.listedMail ? { listedMail: options.listedMail } : {}), ...(options.now ? { now: options.now } : {}) });
  },
};
