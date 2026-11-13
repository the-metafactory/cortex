import { BALANCE_CREATE_DEDUP_RETENTION_MS, balanceCreateSupport, balanceReference as reference, balanceCreateBindings, createBalanceBinding, createBalanceFacade, type BalanceCreateContract, type BalanceCreateBindingOptions, type BalanceCreateBinding, type BalanceCreateFacadeOptions, type BalanceCreateFacade } from "./create-binding";
import { z } from "zod";
import type { AppState, DestinationArea } from "../../../balance";
import { areaProjects, balanceDestinations, balanceProjectsByTitle, isBalanceProjectId, resolveBalanceProject, type BalanceDestination } from "../../../surface/mc/desk/balance-destinations";
import type { AdapterDeclaration, ObjectReference } from "../types";
import { ObjectReferenceSchema } from "../types";
import { BALANCE_ADAPTER_ID as ADAPTER_ID, objectSchema, ref, referenceSchema } from "./schema";
import type { ApprovedSnapshot, OwnerSupport, Provenance } from "../operations/types";
import { adapterErrorSchema } from "../schema-primitives";
import { buildApprovedSnapshot } from "../operations/owner-results";

const CAPABILITY_ID = "balance.task.create";
export const BALANCE_TASK_CREATE_SUPPORT_ID = "balance.task.create.v1";
export const BALANCE_TASK_DEDUP_RETENTION_MS = BALANCE_CREATE_DEDUP_RETENTION_MS;

const AREA_SCHEMA_REF = ref("balance.task.create.area");
const PROJECT_SCHEMA_REF = ref("balance.task.create.project");
const TASK_SCHEMA_REF = ref("balance.task.create.task");
const INPUT_SCHEMA_REF = ref("balance.task.create.input");
const OUTPUT_SCHEMA_REF = ref("balance.task.create.output");
const ERROR_SCHEMA_REF = ref("balance.task.create.error");

const INPUT_SCHEMA = objectSchema({
  area: referenceSchema("area"),
  project: referenceSchema("project"),
  title: { type: "string", minLength: 1, maxLength: 300 },
  note: { type: "string", maxLength: 10_000 },
  due: { type: "string", format: "date" },
}, ["area", "title"]);
const OUTPUT_SCHEMA = objectSchema({ ref: referenceSchema("task") }, ["ref"]);
const ERROR_SCHEMA = adapterErrorSchema(ADAPTER_ID);
const TASK_RELATIONSHIPS: AdapterDeclaration["objectTypes"][number]["relationships"] = [{ fieldPath: "/area", targetAdapterId: ADAPTER_ID, targetObjectType: "area", cardinality: "one" }, { fieldPath: "/project", targetAdapterId: ADAPTER_ID, targetObjectType: "project", cardinality: "one" }];

export const TASK_DRAFT_OBJECT_TYPE: AdapterDeclaration["objectTypes"][number] = { objectType: "task-draft", label: "Task draft", schemaRef: INPUT_SCHEMA_REF, relationships: TASK_RELATIONSHIPS };
export const BALANCE_TASK_CREATE_SCHEMAS: AdapterDeclaration["schemas"] = [
  { ...AREA_SCHEMA_REF, schema: referenceSchema("area") },
  { ...PROJECT_SCHEMA_REF, schema: referenceSchema("project") },
  { ...TASK_SCHEMA_REF, schema: INPUT_SCHEMA },
  { ...INPUT_SCHEMA_REF, schema: INPUT_SCHEMA },
  { ...OUTPUT_SCHEMA_REF, schema: OUTPUT_SCHEMA },
  { ...ERROR_SCHEMA_REF, schema: ERROR_SCHEMA },
];
export const BALANCE_TASK_CREATE_CAPABILITIES: AdapterDeclaration["capabilities"] = [
  { capabilityId: CAPABILITY_ID, label: "Create task", kind: "action", objectTypes: ["task"], inputSchemaRef: INPUT_SCHEMA_REF, outputSchemaRef: OUTPUT_SCHEMA_REF, errorSchemaRef: ERROR_SCHEMA_REF },
];

export function balanceTaskCreateDeclaration(): AdapterDeclaration {
  return {
    adapterId: ADAPTER_ID,
    label: "Balance",
    contractRange: "^1.0.0",
    schemas: [
      ...BALANCE_TASK_CREATE_SCHEMAS,
    ],
    objectTypes: [
      { objectType: "task", label: "Task", schemaRef: TASK_SCHEMA_REF, relationships: TASK_RELATIONSHIPS },
      { objectType: "area", label: "Area", schemaRef: AREA_SCHEMA_REF, relationships: [] },
      { objectType: "project", label: "Project", schemaRef: PROJECT_SCHEMA_REF, relationships: [] },
      TASK_DRAFT_OBJECT_TYPE,
    ],
    capabilities: [
      ...BALANCE_TASK_CREATE_CAPABILITIES,
    ],
  };
}

export const balanceTaskCreateBindings = balanceCreateBindings;

export function balanceTaskCreateSupport(connectionId: string, declarationId = BALANCE_TASK_CREATE_SUPPORT_ID): OwnerSupport {
  return balanceCreateSupport("task", connectionId, declarationId);
}

export const BalanceTaskCreateInputSchema = z.object({
  area: ObjectReferenceSchema,
  project: ObjectReferenceSchema.optional(),
  title: z.string().min(1).max(300),
  note: z.string().max(10_000).optional(),
  due: z.iso.date().optional(),
}).strict();
export type BalanceTaskCreateInput = z.infer<typeof BalanceTaskCreateInputSchema>;

export type BalanceTaskFields = Record<string, string>;
export type BalanceTaskReview =
  | { kind: "resolved"; input: BalanceTaskCreateInput; requiresFreshApproval: boolean; fields: BalanceTaskFields }
  | { kind: "choice"; field: "project"; options: BalanceDestination[]; reason: string; fields: BalanceTaskFields }
  | { kind: "refused"; reason: string; fields: BalanceTaskFields };

const refusedReview = (reason: string, fields: BalanceTaskFields): BalanceTaskReview => ({ kind: "refused", reason, fields: { ...fields } });

function checkedReference(raw: ObjectReference, connectionId: string, objectType: "area" | "project"): ObjectReference {
  if (raw.adapterId !== ADAPTER_ID || raw.connectionId !== connectionId || raw.objectType !== objectType) throw new Error("balance.invalid_input");
  return raw;
}

export function parseBalanceTaskInput(raw: unknown, connectionId: string): BalanceTaskCreateInput {
  const input = BalanceTaskCreateInputSchema.parse(raw);
  checkedReference(input.area, connectionId, "area");
  if (input.project) checkedReference(input.project, connectionId, "project");
  return input;
}

export function balanceTaskLegacyFields(input: BalanceTaskCreateInput): BalanceTaskFields {
  return {
    area: input.area.canonicalId,
    ...(input.project ? { project: input.project.canonicalId } : {}),
    title: input.title,
    ...(input.note ? { note: input.note } : {}),
    ...(input.due ? { due: input.due } : {}),
  };
}

const INVALID_TASK = "A Balance task takes a title of up to 300 characters, a note of up to 10,000 and a due date in the form YYYY-MM-DD.";

export function reviewBalanceTask(fields: BalanceTaskFields, state: AppState, areas: readonly DestinationArea[], connectionId: string): BalanceTaskReview {
  const areaId = fields.area ?? "";
  const area = areas.find(item => item.id === areaId);
  if (!area) return refusedReview(`${areaId} is not a configured area.`, fields);
  const title = fields.title ?? "";
  if (title.trim().length === 0) return refusedReview("A task needs a title.", fields);
  const areaRef = reference(connectionId, "area", area.id);
  const extra = { ...(fields.note ? { note: fields.note } : {}), ...(fields.due ? { due: fields.due } : {}) };
  const resolved = (input: Record<string, unknown>, requiresFreshApproval: boolean): BalanceTaskReview => {
    const parsed = BalanceTaskCreateInputSchema.safeParse(input);
    return parsed.success ? { kind: "resolved", input: parsed.data, requiresFreshApproval, fields: { ...fields } } : refusedReview(INVALID_TASK, fields);
  };
  const project = (fields.project ?? "").trim();
  if (!project) return resolved({ area: areaRef, ...extra, title }, false);
  const open = areaProjects(balanceDestinations(state.outline, areas), area.id);
  const chosen = resolveBalanceProject(open, project);
  if (chosen) return resolved({ area: areaRef, project: reference(connectionId, "project", chosen.id), ...extra, title }, chosen.id !== project);
  if (isBalanceProjectId(project)) return refusedReview(`That project is not open in ${area.label}.`, fields);
  const titled = balanceProjectsByTitle(open, project);
  if (titled.length > 1) return { kind: "choice", field: "project", options: titled, reason: `More than one open project in ${area.label} is named ${project}. Choose one.`, fields: { ...fields } };
  return refusedReview(`That project is not open in ${area.label}.`, fields);
}

export interface BalanceTaskSnapshotOptions {
  connectionId: string;
  provenance: Provenance;
  input: BalanceTaskCreateInput;
  policy?: "local" | "cloud";
}

export function balanceTaskApprovedSnapshot(options: BalanceTaskSnapshotOptions): ApprovedSnapshot {
  const input = parseBalanceTaskInput(options.input, options.connectionId);
  return buildApprovedSnapshot({
    provenance: options.provenance,
    adapterId: ADAPTER_ID,
    connectionId: options.connectionId,
    capabilityId: CAPABILITY_ID,
    inputSchemaRef: INPUT_SCHEMA_REF,
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    errorSchemaRef: ERROR_SCHEMA_REF,
    input,
    destinations: [input.area, ...(input.project ? [input.project] : [])],
    policy: options.policy ?? "local",
  });
}

export const BALANCE_TASK_CONTRACT = {
  kind: "task", owner: "balance-task", capabilityId: CAPABILITY_ID,
  declaration: balanceTaskCreateDeclaration, support: balanceTaskCreateSupport,
  parse: parseBalanceTaskInput, legacyFields: balanceTaskLegacyFields,
  review: reviewBalanceTask, refusedReview, snapshot: balanceTaskApprovedSnapshot,
} satisfies BalanceCreateContract<BalanceTaskCreateInput, BalanceTaskReview>;
export const createBalanceTaskBinding = (options: BalanceCreateBindingOptions): BalanceCreateBinding => createBalanceBinding(options, BALANCE_TASK_CONTRACT);
export const createBalanceTaskFacade = (options: BalanceCreateFacadeOptions): BalanceCreateFacade<BalanceTaskReview> => createBalanceFacade(options, BALANCE_TASK_CONTRACT);
export type BalanceTaskFacade = BalanceCreateFacade<BalanceTaskReview>;
export { balanceCreateReceiptId as balanceTaskReceiptId, balanceCreateOutcome as balanceTaskCreateOutcome, balanceCreateLegacyResult as balanceTaskLegacyResult } from "./create-binding";
export type { BalanceCreateReceipt as BalanceTaskReceipt, BalanceCreateBindingOptions as BalanceTaskBindingOptions, BalanceCreateBinding as BalanceTaskBinding, BalanceCreateOutcome as BalanceTaskCreateOutcome, BalanceCreateLifecycle as BalanceTaskLifecycle, BalanceCreateFacadeOptions as BalanceTaskFacadeOptions, BalanceCreateFacadeOutcome as BalanceTaskFacadeOutcome } from "./create-binding";
