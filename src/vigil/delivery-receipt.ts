import { z } from "zod";
import { buildBaseEnvelope } from "../bus/envelope-builder";
import type { MyelinRuntime } from "../bus/myelin/runtime";
import { buildSource, defaultSystemSovereignty } from "../bus/system-events";

export const VIGIL_TEXT_SENT_TYPE = "system.vigil.text-sent";

export function vigilSystemPattern(principal: string, stack: string): string {
  return `local.${principal}.${stack}.system.vigil.>`;
}

export const textSentReceiptSchema = z.strictObject({
  event_id: z.string().min(1),
  subject_key: z.string().min(1),
  budget_day: z.iso.date(),
});

export type VigilTextReceipt = z.infer<typeof textSentReceiptSchema>;

export async function publishTextSentReceipt(
  receipt: VigilTextReceipt,
  principal: string,
  publish: MyelinRuntime["publish"],
): Promise<void> {
  const source = { principal, agent: "cortex", instance: "local" };
  await publish(buildBaseEnvelope({
    type: VIGIL_TEXT_SENT_TYPE,
    source: buildSource(source),
    sovereignty: defaultSystemSovereignty(source),
    payload: textSentReceiptSchema.parse(receipt),
  }));
}
