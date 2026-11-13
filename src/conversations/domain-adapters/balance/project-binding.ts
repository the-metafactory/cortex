import { z } from "zod";
import type { AdapterDeclaration } from "../types";
import { ObjectReferenceSchema } from "../types";
import { adapterErrorSchema } from "../schema-primitives";
import { buildApprovedSnapshot } from "../operations/owner-results";
import type { OwnerSupport } from "../operations/types";
import { BALANCE_ADAPTER_ID, objectSchema, ref, referenceSchema } from "./schema";
import { balanceCreateSupport, balanceCreateBindings, balanceReference, createBalanceBinding, createBalanceFacade, type BalanceCreateBindingOptions, type BalanceCreateContract, type BalanceCreateFacadeOptions, type BalanceCreateFields, type BalanceCreateReview } from "./create-binding";

const CAPABILITY_ID = "balance.project.create";
export const BALANCE_PROJECT_CREATE_SUPPORT_ID = "balance.project.create.v1";
const AREA = ref(`${CAPABILITY_ID}.area`);
const PROJECT = ref(`${CAPABILITY_ID}.project`);
const INPUT = ref(`${CAPABILITY_ID}.input`);
const OUTPUT = ref(`${CAPABILITY_ID}.output`);
const ERROR = ref(`${CAPABILITY_ID}.error`);
const INPUT_SCHEMA = objectSchema({ area: referenceSchema("area"), title: { type: "string", minLength: 1, maxLength: 300 }, note: { type: "string", maxLength: 10_000 } }, ["area", "title"]);

export const BALANCE_PROJECT_CREATE_SCHEMAS: AdapterDeclaration["schemas"] = [
  { ...AREA, schema: referenceSchema("area") },
  { ...PROJECT, schema: referenceSchema("project") },
  { ...INPUT, schema: INPUT_SCHEMA },
  { ...OUTPUT, schema: objectSchema({ ref: referenceSchema("project") }, ["ref"]) },
  { ...ERROR, schema: adapterErrorSchema(BALANCE_ADAPTER_ID) },
];
export const BALANCE_PROJECT_CREATE_CAPABILITIES: AdapterDeclaration["capabilities"] = [{ capabilityId: CAPABILITY_ID, label: "Create project", kind: "action", objectTypes: ["project"], inputSchemaRef: INPUT, outputSchemaRef: OUTPUT, errorSchemaRef: ERROR }];
export const PROJECT_DRAFT_OBJECT_TYPE: AdapterDeclaration["objectTypes"][number] = { objectType: "project-draft", label: "Project draft", schemaRef: INPUT, relationships: [{ fieldPath: "/area", targetAdapterId: BALANCE_ADAPTER_ID, targetObjectType: "area", cardinality: "one" }] };

export function balanceProjectCreateDeclaration(): AdapterDeclaration {
  return {
    adapterId: BALANCE_ADAPTER_ID, label: "Balance", contractRange: "^1.0.0",
    schemas: BALANCE_PROJECT_CREATE_SCHEMAS,
    objectTypes: [
      { objectType: "area", label: "Area", schemaRef: AREA, relationships: [] },
      { objectType: "project", label: "Project", schemaRef: PROJECT, relationships: [] },
      PROJECT_DRAFT_OBJECT_TYPE,
    ],
    capabilities: BALANCE_PROJECT_CREATE_CAPABILITIES,
  };
}
export const balanceProjectCreateBindings = balanceCreateBindings;
export function balanceProjectCreateSupport(connectionId: string, declarationId = BALANCE_PROJECT_CREATE_SUPPORT_ID): OwnerSupport {
  return balanceCreateSupport("project", connectionId, declarationId);
}
export const BalanceProjectCreateInputSchema = z.object({ area: ObjectReferenceSchema, title: z.string().min(1).max(300), note: z.string().max(10_000).optional() }).strict();
export type BalanceProjectCreateInput = z.infer<typeof BalanceProjectCreateInputSchema>;
export type BalanceProjectReview = Exclude<BalanceCreateReview<BalanceProjectCreateInput>, { kind: "choice" }>;
const refusedReview = (reason: string, fields: BalanceCreateFields): BalanceProjectReview => ({ kind: "refused", reason, fields: { ...fields } });
export function parseBalanceProjectInput(raw: unknown, connectionId: string): BalanceProjectCreateInput {
  const input = BalanceProjectCreateInputSchema.parse(raw);
  if (input.area.adapterId !== BALANCE_ADAPTER_ID || input.area.connectionId !== connectionId || input.area.objectType !== "area") throw new Error("balance.invalid_input");
  return input;
}
export const BALANCE_PROJECT_CONTRACT: BalanceCreateContract<BalanceProjectCreateInput, BalanceProjectReview> = {
  kind: "project", owner: "balance-project", capabilityId: CAPABILITY_ID,
  declaration: balanceProjectCreateDeclaration, support: balanceProjectCreateSupport,
  parse: parseBalanceProjectInput,
  legacyFields: input => ({ area: input.area.canonicalId, title: input.title, ...(input.note ? { note: input.note } : {}) }),
  refusedReview,
  review(fields, _state, areas, connectionId) {
    const area = areas.find(item => item.id === fields.area);
    if (!area) return refusedReview(`${fields.area ?? ""} is not a configured area.`, fields);
    if (!fields.title?.trim()) return refusedReview("A project needs a title.", fields);
    const parsed = BalanceProjectCreateInputSchema.safeParse({ area: balanceReference(connectionId, "area", area.id), title: fields.title, ...(fields.note ? { note: fields.note } : {}) });
    return parsed.success ? { kind: "resolved", input: parsed.data, requiresFreshApproval: false, fields: { ...fields } } : refusedReview("A Balance project takes a title of up to 300 characters and a note of up to 10,000.", fields);
  },
  snapshot(options) {
    const input = parseBalanceProjectInput(options.input, options.connectionId);
    return buildApprovedSnapshot({ provenance: options.provenance, adapterId: BALANCE_ADAPTER_ID, connectionId: options.connectionId, capabilityId: CAPABILITY_ID, inputSchemaRef: INPUT, outputSchemaRef: OUTPUT, errorSchemaRef: ERROR, input, destinations: [input.area], policy: options.policy ?? "local" });
  },
};
export const balanceProjectApprovedSnapshot = BALANCE_PROJECT_CONTRACT.snapshot;
export const reviewBalanceProject = BALANCE_PROJECT_CONTRACT.review;
export const createBalanceProjectBinding = (options: BalanceCreateBindingOptions) => createBalanceBinding(options, BALANCE_PROJECT_CONTRACT);
export const createBalanceProjectFacade = (options: BalanceCreateFacadeOptions) => createBalanceFacade(options, BALANCE_PROJECT_CONTRACT);
export type BalanceProjectBinding = ReturnType<typeof createBalanceProjectBinding>;
export type BalanceProjectFacade = ReturnType<typeof createBalanceProjectFacade>;
