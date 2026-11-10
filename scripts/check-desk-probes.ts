import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermeticTestEnv } from "./lib/test-home";

export const PROBE_PREFIX = "probe-desk-";
export const PROBE_SUFFIX = ".ts";
export const PROBE_TIMEOUT_MS = 120_000;

export interface DeskProbeExclusion {
  readonly file: string;
  readonly reason: string;
}

export interface DeskProbePlan {
  readonly dir: string;
  readonly probes: readonly string[];
  readonly exclusions: readonly DeskProbeExclusion[];
}

export interface DeskProbeOutcome {
  readonly file: string;
  readonly status: "passed" | "failed" | "excluded";
  readonly exitCode: number;
  readonly reason?: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeskProbeReport {
  readonly ok: boolean;
  readonly exitCode: 0 | 1;
  readonly outcomes: readonly DeskProbeOutcome[];
  readonly problems: readonly string[];
}

export const PROBE_EXCLUSIONS: readonly DeskProbeExclusion[] = [
  {
    file: "probe-desk-graph-surfaces.ts",
    reason: "needs a browser: it launches Chromium through Playwright, and the installed browser is only provisioned on the ubuntu-24.04 CI job",
  },
  {
    file: "probe-desk-parser-contract.ts",
    reason: "needs a real stack: it reads cortex-desk-adapters and ranger source checkouts passed as --adapter and --ranger",
  },
];

export const PROBE_RUNS: readonly string[] = [
  "probe-desk-adapter-assets.ts",
  "probe-desk-adapter-packages.ts",
  "probe-desk-adapter-registry.ts",
  "probe-desk-balance-binding.ts",
  "probe-desk-balance-read.ts",
  "probe-desk-balance-sync.ts",
  "probe-desk-balance-work-tools.ts",
  "probe-desk-batch-receipts.ts",
  "probe-desk-binding-fence.ts",
  "probe-desk-connection-setup.ts",
  "probe-desk-credential-setup.ts",
  "probe-desk-drafting.ts",
  "probe-desk-flow-read.ts",
  "probe-desk-flow-work-tools.ts",
  "probe-desk-graph-node-binding.ts",
  "probe-desk-graph-read.ts",
  "probe-desk-graph-scope.ts",
  "probe-desk-graph-work-tools.ts",
  "probe-desk-host-authority.ts",
  "probe-desk-operation-dispatch.ts",
  "probe-desk-operation-import.ts",
  "probe-desk-operation-journal.ts",
  "probe-desk-operation-reconciliation.ts",
  "probe-desk-query.ts",
  "probe-desk-read-admission.ts",
  "probe-desk-writer-fence.ts",
];

function isProbeFile(name: string): boolean {
  return name.startsWith(PROBE_PREFIX) && name.endsWith(PROBE_SUFFIX);
}

function duplicates(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const name of names) {
    if (seen.has(name)) repeated.push(name);
    else seen.add(name);
  }
  return repeated;
}

function validatePlan(plan: DeskProbePlan): string[] {
  const problems: string[] = [];
  const excluded = new Map(plan.exclusions.map(({ file, reason }) => [file, reason]));
  for (const name of duplicates(plan.probes)) problems.push(`${name} is in the run list twice; list each probe once.`);
  for (const name of duplicates(plan.exclusions.map(({ file }) => file))) problems.push(`${name} is in the exclusion list twice; list each exclusion once.`);
  for (const name of plan.probes) {
    if (!isProbeFile(name)) problems.push(`${name} is in the run list but is not a ${PROBE_PREFIX}*${PROBE_SUFFIX} file.`);
    if (excluded.has(name)) problems.push(`${name} is both run and excluded; remove it from one list.`);
  }
  for (const { file, reason } of plan.exclusions) {
    if (!isProbeFile(file)) problems.push(`${file} is in the exclusion list but is not a ${PROBE_PREFIX}*${PROBE_SUFFIX} file.`);
    if (reason.trim() === "") problems.push(`${file} is excluded without a reason; say why it cannot run.`);
  }
  return problems;
}

async function probeFiles(dir: string): Promise<Set<string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isFile() && isProbeFile(entry.name)).map((entry) => entry.name));
}

async function runProbe(probe: string, plan: DeskProbePlan, env: Record<string, string>): Promise<DeskProbeOutcome> {
  const child = Bun.spawn([process.execPath, join(plan.dir, probe)], {
    cwd: plan.dir,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const failed = exitCode !== 0;
    return {
      file: probe,
      status: failed ? "failed" : "passed",
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      ...(failed && exitCode === 137 ? { reason: `killed after the ${PROBE_TIMEOUT_MS} ms probe timeout` } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the plan's probes and report every probe's result, refusing a probe file that neither list names. */
export async function runDeskProbes(plan: DeskProbePlan): Promise<DeskProbeReport> {
  const problems = validatePlan(plan);
  const runList = new Set(plan.probes);
  const excluded = new Map(plan.exclusions.map(({ file, reason }) => [file, reason]));
  const discovered = await probeFiles(plan.dir);

  for (const name of runList) if (!discovered.has(name)) problems.push(`${name} is in the run list but does not exist in ${plan.dir}.`);
  for (const name of excluded.keys()) if (!discovered.has(name)) problems.push(`${name} is excluded but does not exist in ${plan.dir}.`);
  for (const name of discovered) if (!runList.has(name) && !excluded.has(name)) problems.push(`${name} is a ${PROBE_PREFIX} probe file in ${plan.dir} that neither the run list nor the exclusion list names; add it to one with a reason.`);

  const root = await mkdtemp(join(tmpdir(), "desk-probe-run-"));
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  await mkdir(home);
  await mkdir(tmp);
  const env = hermeticTestEnv(process.env, { home, tmp });
  const outcomes: DeskProbeOutcome[] = [];
  try {
    for (const probe of runList) {
      if (!discovered.has(probe)) continue;
      outcomes.push(await runProbe(probe, plan, env));
    }
    for (const [file, reason] of excluded) {
      if (!discovered.has(file) || runList.has(file)) continue;
      outcomes.push({ file, status: "excluded", exitCode: 0, reason, stdout: "", stderr: "" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const ok = problems.length === 0 && outcomes.every((outcome) => outcome.status !== "failed");
  return { ok, exitCode: ok ? 0 : 1, outcomes, problems };
}

/** Print each outcome and any plan problem so a run says which probe passed, failed or was excluded. */
export function printDeskProbeReport(report: DeskProbeReport, log: (line: string) => void = console.log): void {
  for (const outcome of report.outcomes) {
    if (outcome.status === "excluded") {
      log(`⏭️ ${outcome.file} — excluded: ${outcome.reason ?? ""}`);
      continue;
    }
    log(`${outcome.status === "passed" ? "✅" : "❌"} ${outcome.file} — ${outcome.status} (exit ${outcome.exitCode})`);
    if (outcome.status === "failed") {
      for (const line of `${outcome.stdout}\n${outcome.stderr}`.split("\n").filter((line) => line !== "")) log(`   ${line}`);
    }
  }
  for (const problem of report.problems) log(`❌ ${problem}`);
  const passed = report.outcomes.filter((outcome) => outcome.status === "passed").length;
  const excluded = report.outcomes.filter((outcome) => outcome.status === "excluded").length;
  const failed = report.outcomes.filter((outcome) => outcome.status === "failed").length;
  log(report.ok ? `desk probes: ${passed} passed, ${excluded} excluded` : `desk probes: ${failed} failed, ${report.problems.length} plan problem(s)`);
}

if (import.meta.main) {
  const report = await runDeskProbes({ dir: import.meta.dir, probes: PROBE_RUNS, exclusions: PROBE_EXCLUSIONS });
  printDeskProbeReport(report);
  process.exit(report.exitCode);
}
