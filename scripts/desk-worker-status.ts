import { readWorkerReport, rangerRunner } from "./desk-capability-status";

if (import.meta.main) {
  try {
    const ref = process.argv[2];
    if (!ref || process.argv.length > 3) throw new Error("usage: desk-worker-status.ts <owner/repo#node>");
    process.stdout.write(`${JSON.stringify(await readWorkerReport(ref, rangerRunner()))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
