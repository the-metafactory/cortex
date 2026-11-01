import type { DeskOptions } from "../desk/compose";
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
