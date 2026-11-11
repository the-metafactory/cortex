import { parse } from "yaml";
import { validateSteps } from "pulse";
import { z } from "zod";
import type { AuthorityMediator, HostContext, ReadScope } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { DraftService, Lane } from "../../../conversations/domain-adapters/drafting";
import { flowName } from "../../../conversations/domain-adapters/flow/schema";
import type { FrameBinding } from "./adapter-frame-host";
import { routineStepLabels } from "./routine-steps";

export const FLOW_EDITOR_MOUNT = { objectType: "saved-draft", view: "editor" } as const;
const MAX_FINDINGS = 20;
const MAX_FINDING_CHARS = 300;
const MAX_STEPS = 100;

export const FlowEditorProjectionSchema = z.object({
  name: z.string().max(256),
  yaml: z.string().max(40_000),
  steps: z.array(z.string().max(MAX_FINDING_CHARS)).max(MAX_STEPS),
  findings: z.array(z.object({ message: z.string().max(MAX_FINDING_CHARS) }).strict()).max(MAX_FINDINGS),
}).strict();
export type FlowEditorProjection = z.infer<typeof FlowEditorProjectionSchema>;

const sentence = (text: string): string => text.trim().slice(0, MAX_FINDING_CHARS);
const messageOf = (error: unknown): string => sentence(error instanceof Error ? error.message : "The definition could not be checked.");

export function flowEditorProjection(name: string, yaml: string): FlowEditorProjection {
  const findings: string[] = [];
  let steps: string[] = [];
  if (!flowName.safeParse(name).success) findings.push("The name must start with F_ and use capitals, digits and underscores.");
  let document: unknown;
  try { document = parse(yaml); }
  catch (error) { findings.push(`The definition is not valid YAML: ${messageOf(error)}`); }
  if (document !== undefined) {
    if (typeof document !== "object" || document === null || Array.isArray(document)) findings.push("The definition must be a YAML mapping.");
    else {
      const record = document as Record<string, unknown>;
      if (record.name !== name) findings.push("The name and the definition's name differ.");
      if (!Array.isArray(record.actions) || record.actions.length === 0) findings.push("The definition needs a non-empty actions list.");
      else {
        try { steps = routineStepLabels(validateSteps(record.actions)); }
        catch (error) { findings.push(messageOf(error)); }
      }
    }
  }
  return { name: name.slice(0, 256), yaml, steps: steps.slice(0, MAX_STEPS), findings: findings.slice(0, MAX_FINDINGS).map(message => ({ message })) };
}

export interface FlowEditorMountOptions {
  principal: string;
  audience: Lane;
  connectionId: string;
  authority: AuthorityMediator;
  context: HostContext;
  sink: Extract<ReleaseSink, { kind: "view" }>;
  scopes: ReadScope[];
  service: DraftService;
  draftId: string;
  hasOperation(): Promise<boolean>;
}

export function flowEditorFrameBinding(options: FlowEditorMountOptions): FrameBinding {
  return {
    principal: options.principal, audience: options.audience, adapterId: "flow", connectionId: options.connectionId, mount: { ...FLOW_EDITOR_MOUNT },
    authority: options.authority, context: options.context, sink: options.sink, scopes: options.scopes, schema: FlowEditorProjectionSchema,
    editor: { service: options.service, draftId: options.draftId, hasOperation: () => options.hasOperation() },
    async projection() {
      const view = await options.service.read(options.draftId, options.audience);
      if (!view) throw new Error("The Flow draft is unavailable.");
      const text = (pointer: string): string => {
        const field = view.draft.fields[pointer];
        return typeof field?.value === "string" && field.presence === "present" ? field.value : "";
      };
      return { projectionId: `flow-draft-${options.draftId}`, revision: view.draft.revision, object: flowEditorProjection(text("/name"), text("/definition")) };
    },
  };
}
