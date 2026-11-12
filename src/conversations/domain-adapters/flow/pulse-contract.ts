import { z } from "zod";
import type { FlowOptions } from "../../../common/types/config";
import type { CreateRequest } from "../../types";
import { studioRequestId } from "../../conversation-ids";
import type { WriterRunner } from "../../../surface/mc/desk/create";
import { withFlowFile } from "../../../surface/mc/desk/flow-file";
import { definitionName } from "./definition";

export const SAVE_TIMEOUT_MS = 25_000;
export const SHOW_TIMEOUT_MS = 5_000;
export const sentence = (text: string): string => `${text.trim().replace(/[.\s]+$/, "")}.`;

export const FlowSavedResponseSchema = z.object({ status: z.enum(["saved", "exists"]), name: z.string().min(1) }).loose();
const FlowRefusedResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("conflict"), reason: z.string().min(1) }),
  z.object({ status: z.literal("invalid"), findings: z.array(z.object({ message: z.string().min(1) })).min(1) }),
]);

export function flowJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Pulse answered with output that is not JSON. Check its saved flows before retrying.");
  }
}

function flowSaveArgs(options: FlowOptions, file: string, request: Pick<CreateRequest, "operationId" | "provenance">): string[] {
  const { provenance } = request;
  return [...options.pulse, "flow", "save", "--file", file, "--request-id", studioRequestId(request.operationId), "--conversation", provenance.conversationId, "--exchange", provenance.entryId ?? provenance.proposalId, "--json"];
}

type FlowSaveOutcome = { kind: "saved"; value: z.infer<typeof FlowSavedResponseSchema> } | { kind: "refused"; reason: string } | { kind: "unconfirmed"; error: Error };

export async function runFlowSave(run: WriterRunner, flows: FlowOptions, input: { name: string; definition: string }, request: Pick<CreateRequest, "operationId" | "provenance"> & { signal?: AbortSignal }): Promise<FlowSaveOutcome> {
  const named = definitionName(input.definition);
  if (named === undefined) return { kind: "refused", reason: "The flow definition is not a YAML mapping with a name." };
  if (named !== input.name) return { kind: "refused", reason: "The name and the flow definition's name differ." };
  try {
    if (request.signal?.aborted) throw new Error("The conversation stopped waiting before Pulse was called.");
    const result = await withFlowFile(input.definition.endsWith("\n") ? input.definition : `${input.definition}\n`, file => run(flowSaveArgs(flows, file, request), "", SAVE_TIMEOUT_MS));
    const reply = flowJson(result.stdout);
    const saved = FlowSavedResponseSchema.safeParse(reply);
    if (result.code === 0 && saved.success) {
      if (saved.data.name !== input.name) throw new Error(`Pulse answered for flow ${saved.data.name} instead of ${input.name}.`);
      return { kind: "saved", value: saved.data };
    }
    const refused = FlowRefusedResponseSchema.safeParse(reply);
    if (result.code === 1 && refused.success) return { kind: "refused", reason: refused.data.status === "conflict" ? sentence(refused.data.reason) : refused.data.findings.map(finding => sentence(finding.message)).join(" ") };
    throw new Error(`Pulse did not confirm the save (${result.code}). Check its saved flows before retrying.`);
  } catch (error) {
    return { kind: "unconfirmed", error: error instanceof Error ? error : new Error("Pulse failed without a result.", { cause: error }) };
  }
}
