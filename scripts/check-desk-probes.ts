import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
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
    file: "probe-desk-adapter-browser.ts",
    reason: "needs a browser: it verifies adapter isolation against a local attacker origin in Playwright Chromium",
  },
  {
    file: "probe-desk-adapter-diagnostics.ts",
    reason: "needs a browser: it renders connection diagnostics in Playwright Chromium",
  },
  {
    file: "probe-desk-adapter-frame.ts",
    reason: "needs browsers: it verifies isolated adapter frames in Playwright Chromium, WebKit and Firefox",
  },
  {
    file: "probe-desk-adapter-hosted.ts",
    reason: "needs a real stack: it calls the hosted route through Cloudflare Access with an operator service token, and it must never run in CI",
  },
  {
    file: "probe-desk-adapter-inline.ts",
    reason: "needs browsers: it verifies inline adapter assets in Playwright Chromium and WebKit",
  },
  {
    file: "probe-desk-adapter-timing.ts",
    reason: "pre-cutover timing baseline: it records machine-specific operator state and must not run in a CI gate",
  },
  {
    file: "probe-desk-attention.ts",
    reason: "needs a browser: it verifies Desk attention in Playwright Chromium",
  },
  {
    file: "probe-desk-balance-attention.ts",
    reason: "needs a browser: it verifies Balance attention rows and incomplete observations in Playwright Chromium",
  },
  {
    file: "probe-desk-balance-connection.ts",
    reason: "needs a browser: it configures a Balance connection in Playwright Chromium",
  },
  {
    file: "probe-desk-balance-controls.ts",
    reason: "needs a browser: it measures Balance controls in Playwright Chromium",
  },
  {
    file: "probe-desk-balance-drafting.ts",
    reason: "needs a browser: it verifies conversation-prefilled Balance drafts through the shared Playwright browser fixture",
  },
  {
    file: "probe-desk-balance-drag.ts",
    reason: "needs a browser: it verifies Balance dragging in Playwright Chromium",
  },
  {
    file: "probe-desk-balance-surfaces.ts",
    reason: "needs a browser: it verifies Balance pickers and saved cards in Playwright Chromium",
  },
  {
    file: "probe-desk-flow-cutover.ts",
    reason: "needs a browser: it approves a migrated Flow and a native note in Playwright Chromium on a disposable stack",
  },
  {
    file: "probe-desk-flow-editor.ts",
    reason: "needs a browser: it edits a Flow draft in an isolated adapter frame, approves through the host and reads the Flow back from Pulse in Playwright Chromium",
  },
  {
    file: "probe-desk-flow-tab.ts",
    reason: "needs a browser: it verifies the saved-flow tab in Playwright Chromium",
  },
  {
    file: "probe-desk-graph-drafting.ts",
    reason: "needs a browser: it verifies conversation-prefilled graph drafts through the shared Playwright browser fixture",
  },
  {
    file: "probe-desk-graph-surfaces.ts",
    reason: "needs a browser: it launches Chromium through Playwright, and the installed browser is only provisioned on the ubuntu-24.04 CI job",
  },
  {
    file: "probe-desk-make-editor.ts",
    reason: "needs a browser: it verifies the Make editor through the shared Playwright browser fixture",
  },
  {
    file: "probe-desk-parser-contract.ts",
    reason: "needs a real stack: it reads cortex-desk-adapters and ranger source checkouts passed as --adapter and --ranger",
  },
];

export const PROBE_RUNS: readonly string[] = [
  "probe-desk-adapter-assets.ts",
  "probe-desk-adapter-canary.ts",
  "probe-desk-adapter-limits.ts",
  "probe-desk-adapter-packages.ts",
  "probe-desk-adapter-registry.ts",
  "probe-desk-balance-binding.ts",
  "probe-desk-balance-observation.ts",
  "probe-desk-balance-read.ts",
  "probe-desk-balance-sync.ts",
  "probe-desk-balance-work-tools.ts",
  "probe-desk-batch-receipts.ts",
  "probe-desk-binding-fence.ts",
  "probe-desk-conformance-export.ts",
  "probe-desk-connection-setup.ts",
  "probe-desk-credential-setup.ts",
  "probe-desk-drafting.ts",
  "probe-desk-flow-binding.ts",
  "probe-desk-flow-read.ts",
  "probe-desk-flow-work-tools.ts",
  "probe-desk-graph-create.ts",
  "probe-desk-graph-node-binding.ts",
  "probe-desk-graph-observation.ts",
  "probe-desk-graph-read.ts",
  "probe-desk-graph-scope.ts",
  "probe-desk-graph-work-tools.ts",
  "probe-desk-host-authority.ts",
  "probe-desk-observations.ts",
  "probe-desk-operation-dispatch.ts",
  "probe-desk-operation-import.ts",
  "probe-desk-operation-journal.ts",
  "probe-desk-operation-reconciliation.ts",
  "probe-desk-package-backend.ts",
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

interface CheckedPlan {
  readonly problems: readonly string[];
  readonly runnable: readonly string[];
  readonly exclusions: readonly DeskProbeExclusion[];
}

function checkPlan(plan: DeskProbePlan, discovered: ReadonlySet<string>): CheckedPlan {
  const problems: string[] = [];
  const runList = new Set(plan.probes);
  const excluded = new Map(plan.exclusions.map(({ file, reason }) => [file, reason]));
  for (const name of duplicates(plan.probes)) problems.push(`${name} is in the run list twice; list each probe once.`);
  for (const name of duplicates(plan.exclusions.map(({ file }) => file))) problems.push(`${name} is in the exclusion list twice; list each exclusion once.`);
  for (const name of plan.probes) {
    if (!isProbeFile(name)) problems.push(`${name} is in the run list but is not a ${PROBE_PREFIX}*${PROBE_SUFFIX} file.`);
    if (excluded.has(name)) problems.push(`${name} is both run and excluded; remove it from one list.`);
    if (!discovered.has(name)) problems.push(`${name} is in the run list but does not exist in ${plan.dir}.`);
  }
  for (const { file, reason } of plan.exclusions) {
    if (!isProbeFile(file)) problems.push(`${file} is in the exclusion list but is not a ${PROBE_PREFIX}*${PROBE_SUFFIX} file.`);
    if (reason.trim() === "") problems.push(`${file} is excluded without a reason; say why it cannot run.`);
    if (!discovered.has(file)) problems.push(`${file} is excluded but does not exist in ${plan.dir}.`);
  }
  for (const name of discovered) {
    if (!runList.has(name) && !excluded.has(name))
      problems.push(`${name} is a ${PROBE_PREFIX} probe file in ${plan.dir} that neither the run list nor the exclusion list names; add it to one with a reason.`);
  }
  return {
    problems,
    runnable: plan.probes.filter((name) => discovered.has(name)),
    exclusions: plan.exclusions.filter(({ file }) => discovered.has(file) && !runList.has(file)),
  };
}

async function runBatched<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return results;
}

async function probeFiles(dir: string): Promise<Set<string>> {
  const entries = await readdir(dir, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isFile() && isProbeFile(entry.name)).map((entry) => entry.name));
}

async function runProbe(probe: string, plan: DeskProbePlan, root: string): Promise<DeskProbeOutcome> {
  const work = await mkdtemp(join(root, "probe-"));
  const home = join(work, "home");
  const tmp = join(work, "tmp");
  await mkdir(home);
  await mkdir(tmp);
  const env = hermeticTestEnv(process.env, { home, tmp });
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

export async function runDeskProbes(plan: DeskProbePlan): Promise<DeskProbeReport> {
  const discovered = await probeFiles(plan.dir);
  const checked = checkPlan(plan, discovered);
  const problems = checked.problems;

  const root = await mkdtemp(join(tmpdir(), "desk-probe-run-"));
  let outcomes: DeskProbeOutcome[] = [];
  try {
    outcomes = [
      ...(await runBatched(checked.runnable, availableParallelism(), (probe) => runProbe(probe, plan, root))),
      ...checked.exclusions.map(({ file, reason }) => ({ file, status: "excluded" as const, exitCode: 0, reason, stdout: "", stderr: "" })),
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const ok = problems.length === 0 && outcomes.every((outcome) => outcome.status !== "failed");
  return { ok, exitCode: ok ? 0 : 1, outcomes, problems };
}

export function printDeskProbeReport(report: DeskProbeReport, log: (line: string) => void = console.log): void {
  for (const outcome of report.outcomes) {
    if (outcome.status === "excluded") {
      log(`⏭️ ${outcome.file} — excluded: ${outcome.reason ?? ""}`);
      continue;
    }
    log(`${outcome.status === "passed" ? "✅" : "❌"} ${outcome.file} — ${outcome.status} (exit ${outcome.exitCode})`);
    if (outcome.status === "failed") {
      if (outcome.reason) log(`   ${outcome.reason}`);
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
