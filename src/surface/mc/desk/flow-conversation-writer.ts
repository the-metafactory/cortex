import { parse } from "yaml";
import { z } from "zod";
import type { FlowOptions } from "../../../common/types/config";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { studioRequestId } from "./conversation-ids";
import { spawnWithStdin, type WriterRunner } from "./create";
import { withFlowFile } from "./flow-file";

export type { FlowOptions } from "../../../common/types/config";

export interface FlowWriterDeps {
  flows: () => FlowOptions | undefined;
  run?: WriterRunner;
}

const NOTHING = "Nothing was created.";
export const SAVE_TIMEOUT_MS = 25_000;
export const SHOW_TIMEOUT_MS = 5_000;
const sentence = (text: string): string => `${text.trim().replace(/[.\s]+$/, "")}.`;
const failed = (text: string): CreateResult => ({ state: "failed", error: `${sentence(text)} ${NOTHING}` });

export const FlowSavedResponseSchema = z.object({ status: z.enum(["saved", "exists"]), name: z.string().min(1) });
export const FlowRefusedResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("conflict"), reason: z.string().min(1) }),
  z.object({ status: z.literal("invalid"), findings: z.array(z.object({ message: z.string().min(1) })).min(1) }),
]);
const Found = z.object({ name: z.string().min(1), source: z.literal("saved") });
const NotFound = z.object({ status: z.literal("not-found") });

export function definitionName(definition: string): string | undefined {
  try {
    const document: unknown = parse(definition);
    if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
    const name: unknown = (document as Record<string, unknown>).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

export function flowJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Pulse answered with output that is not JSON. Check its saved flows before retrying.");
  }
}

export function flowSaveArgs(options: FlowOptions, file: string, request: Pick<CreateRequest, "operationId" | "provenance">): string[] {
  const { provenance } = request;
  return [...options.pulse, "flow", "save", "--file", file, "--request-id", studioRequestId(request.operationId), "--conversation", provenance.conversationId, "--exchange", provenance.entryId ?? provenance.proposalId, "--json"];
}

export function flowWriter(deps: FlowWriterDeps): OwnerWriter {
  const run = deps.run ?? spawnWithStdin;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const options = deps.flows();
    if (!options) return failed("Pulse is not set up on this stack");
    const name = request.fields.name ?? "";
    const definition = request.fields.definition ?? "";
    const named = definitionName(definition);
    if (named === undefined) return failed("The flow definition is not a YAML mapping with a name");
    if (named !== name) return failed("The name and the flow definition's name differ");
    if (request.signal.aborted) throw new Error("The conversation stopped waiting before Pulse was called.");
    const result = await withFlowFile(definition.endsWith("\n") ? definition : `${definition}\n`, file => run(flowSaveArgs(options, file, request), "", SAVE_TIMEOUT_MS));
    const reply = flowJson(result.stdout);
    const saved = FlowSavedResponseSchema.safeParse(reply);
    if (result.code === 0 && saved.success) {
      if (saved.data.name !== name) throw new Error(`Pulse answered for flow ${saved.data.name} instead of ${name}.`);
      return { state: "created", canonicalId: name };
    }
    const refused = FlowRefusedResponseSchema.safeParse(reply);
    if (result.code === 1 && refused.success) {
      return failed(refused.data.status === "conflict" ? refused.data.reason : refused.data.findings.map(f => sentence(f.message)).join(" "));
    }
    throw new Error(`Pulse did not confirm the save (${result.code}). Check its saved flows before retrying.`);
  };
  const readback = async (operation: OperationRecord): Promise<ReadbackResult> => {
    const options = deps.flows();
    if (!options) return null;
    try {
      const result = await run([...options.pulse, "flow", "show", "--request-id", studioRequestId(operation.operationId), "--json"], "", SHOW_TIMEOUT_MS);
      const reply = flowJson(result.stdout);
      const found = Found.safeParse(reply);
      if (result.code === 0 && found.success) return { found: true, canonicalId: found.data.name };
      return result.code === 1 && NotFound.safeParse(reply).success ? { found: false } : null;
    } catch {
      return null;
    }
  };
  return { create, readback };
}
