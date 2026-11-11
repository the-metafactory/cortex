import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { OBSERVATION_LIMITS } from "../src/conversations/domain-adapters/reads/observation-types";
import { initDatabase } from "../src/surface/mc/db/init";
import { composeDesk } from "../src/surface/mc/desk/compose";
import { ATTENTION_DESK, attentionRig } from "../src/surface/mc/desk/fixtures/adapter-attention-fixtures";

export const PROJECTED_OBJECTS = 1000;
export const BASELINE_RUNS = 20;
export const OVER_BASELINE_FACTOR = 2;
const BINDINGS = ["fixture"] as const;

export interface TimingEnvironment { readonly machine: string; readonly bun: string }
export interface TimingBaseline extends TimingEnvironment { readonly medianMs: number; readonly runs: number }
export type TimingVerdict =
  | { readonly kind: "no-baseline" }
  | { readonly kind: "refused"; readonly reason: "machine" | "bun" }
  | { readonly kind: "within-baseline"; readonly ratio: number }
  | { readonly kind: "over-baseline"; readonly level: "notify"; readonly ratio: number };

export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("A median needs at least one sample.");
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const low = sorted[middle - 1] ?? 0;
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : (low + high) / 2;
}

export function compare(baseline: TimingBaseline | undefined, current: TimingEnvironment & { readonly medianMs: number }): TimingVerdict {
  if (baseline === undefined) return { kind: "no-baseline" };
  if (baseline.machine !== current.machine) return { kind: "refused", reason: "machine" };
  if (baseline.bun !== current.bun) return { kind: "refused", reason: "bun" };
  const ratio = current.medianMs / baseline.medianMs;
  return current.medianMs > OVER_BASELINE_FACTOR * baseline.medianMs ? { kind: "over-baseline", level: "notify", ratio } : { kind: "within-baseline", ratio };
}

export const currentEnvironment = (): TimingEnvironment => ({ machine: `${hostname()}/${platform()}-${arch()}`, bun: Bun.version });

export const defaultBaselineFile = (): string =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "metafactory", "cortex", "desk-adapter-timing.json");

type BaselineStore = Record<string, TimingBaseline>;

async function readStore(file: string): Promise<BaselineStore> {
  try { return JSON.parse(await readFile(file, "utf8")) as BaselineStore; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function measureFixture(runs: number): Promise<{ samples: number[]; cards: number; providerCalls: number }> {
  const item = await attentionRig();
  const db = initDatabase(":memory:");
  try {
    for (let offset = 0; offset < PROJECTED_OBJECTS; offset += OBSERVATION_LIMITS.batchItems) {
      const objects = Array.from({ length: OBSERVATION_LIMITS.batchItems }, (_unused, index) => item.value(0, `Synthetic review ${String(offset + index)}`));
      const ingested = await item.ingest(0, objects, offset === 0 ? "resync" : "poll", offset);
      if (ingested.status !== "ok") throw new Error(`Ingesting projected objects ${String(offset)} to ${String(offset + objects.length)} returned ${ingested.status}.`);
    }
    const fetched = item.fetches;
    const compose = () => composeDesk(db, ATTENTION_DESK, undefined, { now: item.time.clock.now(), adapterAttention: item.feature });
    await compose();
    const samples: number[] = [];
    let cards = 0;
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      const view = await compose();
      samples.push(performance.now() - started);
      cards = view.items.length;
    }
    if (cards === 0) throw new Error("Day composed no cards, so the timed work did not run.");
    return { samples, cards, providerCalls: item.fetches - fetched };
  } finally {
    db.close();
    await item.rig.close();
  }
}

const optionValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

export async function main(argv: readonly string[]): Promise<number> {
  const binding = optionValue(argv, "--binding");
  if (binding === undefined || !(BINDINGS as readonly string[]).includes(binding)) {
    console.error(`usage: bun scripts/probe-desk-adapter-timing.ts --binding <${BINDINGS.join("|")}> [--baseline-file <path>] [--rebaseline]`);
    return 2;
  }
  const file = optionValue(argv, "--baseline-file") ?? defaultBaselineFile();
  const store = await readStore(file);
  const measured = await measureFixture(BASELINE_RUNS);
  const environment = currentEnvironment();
  const current = { ...environment, medianMs: median(measured.samples) };
  const existing = argv.includes("--rebaseline") ? undefined : store[binding];
  const verdict = compare(existing, current);
  const range = `${Math.min(...measured.samples).toFixed(2)} to ${Math.max(...measured.samples).toFixed(2)} ms`;
  console.log(`binding: ${binding}, ${String(PROJECTED_OBJECTS)} projected objects, ${String(measured.cards)} cards composed, ${String(measured.providerCalls)} provider calls`);
  console.log(`median: ${current.medianMs.toFixed(2)} ms of ${String(BASELINE_RUNS)} runs, range ${range}, ${environment.machine}, bun ${environment.bun}`);
  if (verdict.kind === "no-baseline") {
    const baseline: TimingBaseline = { ...environment, medianMs: current.medianMs, runs: BASELINE_RUNS };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ ...store, [binding]: baseline }, null, 2)}\n`);
    console.log(`baseline: none recorded, so this median of ${String(BASELINE_RUNS)} runs is now the baseline (${file})`);
    console.log("verdict: baseline-recorded");
  } else if (verdict.kind === "refused" && existing) {
    console.log(`baseline: ${existing.medianMs.toFixed(2)} ms from ${existing.machine}, bun ${existing.bun}`);
    console.log(`verdict: refused, the baseline is from a different ${verdict.reason}; rerun with --rebaseline to record a new baseline`);
  } else if (existing) {
    console.log(`baseline: ${existing.medianMs.toFixed(2)} ms`);
    console.log(`verdict: ${verdict.kind === "over-baseline" ? `NOTIFY over-baseline, ${verdict.ratio.toFixed(2)}x the baseline (limit ${String(OVER_BASELINE_FACTOR)}x)` : `within-baseline, ${(verdict.kind === "within-baseline" ? verdict.ratio : 0).toFixed(2)}x the baseline`}`);
  }
  return 0;
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
