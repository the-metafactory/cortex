import type { Database } from "bun:sqlite";
import { composeDesk, type DeskOptions, type DeskRuntime } from "../desk/compose";
import type { WriterResult } from "../desk/create";

export const mailDesk = (mailActions: DeskOptions["mailActions"]): DeskOptions => ({
  enabled: true, displayName: "Ada", topN: 5, rangerUrl: "", areas: [],
  sources: [{ id: "work-mail", command: ["desk-mail"], everySeconds: 300, timeoutSeconds: 30 }],
  mailActions,
});

export function queue(results: (WriterResult | Error)[] = []) {
  const calls: { argv: string[]; stdin: unknown }[] = [];
  return {
    calls,
    run: async (argv: string[], stdin: string): Promise<WriterResult> => {
      calls.push({ argv, stdin: JSON.parse(stdin) });
      const next = results.shift() ?? { code: 0, stdout: "", stderr: "" };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

export const NOW = Date.parse("2026-11-01T09:00:00.000Z");
export const MOVE_DESK: DeskOptions = mailDesk({ move: ["/opt/adapters/bin/desk-mail-move.ts"], timeoutSeconds: 20 });

export const composeWith = (db: Database, options: DeskOptions, rt: DeskRuntime, now: number) =>
  composeDesk(db, options, undefined, { now, handled: rt.ledger, ...(rt.sourceCache ? { sourceCache: rt.sourceCache } : {}) });
