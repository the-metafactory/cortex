import type { MyelinEnvelope } from "@the-metafactory/myelin";
import { createRunLedgerFunnel } from "../run-ledger-funnel";

export function harness(beforePublish?: () => void) {
  const published: { envelope: MyelinEnvelope; subject: string }[] = [];
  const logs: string[] = [];
  const funnel = createRunLedgerFunnel({
    principal: "jc",
    stack: "default",
    publish: async (envelope, subject) => {
      beforePublish?.();
      published.push({ envelope, subject });
    },
    log: (line) => logs.push(line),
  });
  return { funnel, published, logs };
}
