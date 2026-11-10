import { z } from "zod";
import type { FlowOptions } from "../../../common/types/config";
import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { studioRequestId } from "./conversation-ids";
import { spawnWithStdin, type WriterRunner } from "./create";
import { flowJson, runFlowSave, sentence, SHOW_TIMEOUT_MS } from "../../../conversations/domain-adapters/flow/pulse-contract";

export type { FlowOptions } from "../../../common/types/config";

export interface FlowWriterDeps {
  flows: () => FlowOptions | undefined;
  run?: WriterRunner;
}

const NOTHING = "Nothing was created.";
const failed = (text: string): CreateResult => ({ state: "failed", error: `${sentence(text)} ${NOTHING}` });

const Found = z.object({ name: z.string().min(1), source: z.literal("saved") });
const NotFound = z.object({ status: z.literal("not-found") });

export function flowWriter(deps: FlowWriterDeps): OwnerWriter {
  const run = deps.run ?? spawnWithStdin;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const options = deps.flows();
    if (!options) return failed("Pulse is not set up on this stack");
    const outcome = await runFlowSave(run, options, { name: request.fields.name ?? "", definition: request.fields.definition ?? "" }, request);
    if (outcome.kind === "saved") return { state: "created", canonicalId: outcome.value.name };
    if (outcome.kind === "refused") return failed(outcome.reason);
    throw outcome.error;
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
