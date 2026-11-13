import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CAPABILITY_MARKER_LABEL, CapabilityStepSchema, FILEABLE_CAPABILITY, capabilityMarker, type CapabilityStep } from "../src/surface/mc/desk/routine-capability-contract";
import { runCommand } from "../src/surface/mc/common/spawn";
import { CapabilityBuildSchema } from "../src/common/types/desk-routines";

const WriterInputSchema = z.object({
  requestId: z.string().min(1),
  capability: z.string().regex(FILEABLE_CAPABILITY),
  steps: z.array(CapabilityStepSchema).min(1),
  request: z.string(),
  yaml: z.string(),
  map: CapabilityBuildSchema.shape.map,
  budget: CapabilityBuildSchema.shape.budget,
  template: z.string().min(1).optional(),
});
export type WriterInput = z.infer<typeof WriterInputSchema>;

export interface SomaResult { code: number; stdout: string; stderr: string }
export type SomaRunner = (argv: string[]) => Promise<SomaResult>;
export interface WriterAnswer { ref: string; url: string; existing: boolean }

const DEFAULT_TEMPLATE = join(dirname(import.meta.path), "desk-capability-template.md");
const SOMA_TIMEOUT_MS = 60_000;
const DEFAULT_FORGE = "github:github.com/";

const FoundSchema = z.object({ found: z.literal(true), node: z.union([z.string(), z.number()]).transform(String) });
const NotFoundSchema = z.object({ found: z.literal(false) });
const AmbiguousSchema = z.object({ error: z.literal("once-ambiguous"), nodes: z.array(z.union([z.string(), z.number()]).transform(String)) });
const NodeSchema = z.looseObject({ repo: z.string(), status: z.string(), url: z.string(), parent: z.looseObject({ id: z.union([z.string(), z.number()]) }).nullish() });
const CreatedSchema = z.looseObject({ node: z.union([z.string(), z.number()]).transform(String) });

export const somaRunner = (bin = process.env.SOMA_BIN ?? "soma"): SomaRunner => async (argv) => {
  const { code, stdout, stderr } = await runCommand([bin, ...argv], SOMA_TIMEOUT_MS);
  return { code, stdout, stderr };
};

export function parseMap(map: string): { repo: string; root: string } {
  const at = map.lastIndexOf("#");
  const path = map.slice(0, at);
  return { repo: /^(?:github|gitlab):/.test(path) ? path : `${DEFAULT_FORGE}${path}`, root: map.slice(at + 1) };
}

const oneLine = (text: string): string => text.replaceAll(/\s+/g, " ").trim();
const quote = (text: string): string => JSON.stringify(oneLine(text));

function sovereigntyCriterion(step: CapabilityStep): string {
  const { model_class, frontier_ok, data_residency } = step.sovereignty;
  return `model class ${model_class ?? "not set"}, frontier model allowed ${frontier_ok === undefined ? "not set" : frontier_ok ? "yes" : "no"}, data residency ${data_residency ?? "not set"}`;
}

export function renderCriteria(steps: CapabilityStep[]): string {
  return steps.map((step) => `- Given the routine step ${quote(step.label)}, when the capability receives the prompt ${quote(step.prompt)}, then it answers within these sovereignty limits, which bind: ${sovereigntyCriterion(step)}.`).join("\n");
}

export function renderBrief(template: string, input: WriterInput): string {
  const values: Record<string, string> = {
    capability: input.capability,
    request: oneLine(input.request),
    criteria: renderCriteria(input.steps),
    flow: input.yaml.trimEnd(),
  };
  return template.replaceAll(/\{\{(capability|request|criteria|flow)\}\}/g, (_match, key: string) => values[key] ?? "").trim();
}

export const capabilitySlug = (capability: string): string => capability.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

export function renderProbes(patterns: string[], capability: string): string[] {
  if (patterns.length === 0) throw new Error("pass at least one --probe <json>: soma files an auto build node only with a machine-checkable probe");
  return patterns.map((pattern) => {
    const probe = pattern.replaceAll("{capability}", capability).replaceAll("{slug}", capabilitySlug(capability));
    try { JSON.parse(probe); }
    catch { throw new Error(`--probe is not JSON once filled in: ${oneLine(probe)}`); }
    return probe;
  });
}

function addArguments(input: WriterInput, bodyFile: string, probes: string[], once: boolean, dryRun: boolean): string[] {
  const { repo, root } = parseMap(input.map);
  return [
    "graph", "add", root, "--repo", repo,
    "--title", `Build capability ${input.capability}`,
    "--kind", "build", "--autonomy", "auto",
    "--checkpoint", `desk-capability-${capabilitySlug(input.capability)}`,
    "--label", CAPABILITY_MARKER_LABEL,
    "--body-file", bodyFile,
    ...probes.flatMap((probe) => ["--probe", probe]),
    "--budget-tokens", String(input.budget.tokens), "--budget-invocations", String(input.budget.invocations), "--budget-minutes", String(input.budget.minutes),
    ...(once ? ["--once", capabilityMarker(input.capability)] : []),
    ...(dryRun ? ["--dry-run"] : []),
    "--json",
  ];
}

const soma = async (run: SomaRunner, argv: string[]): Promise<SomaResult> => {
  const result = await run(argv);
  if (result.code === 0) return result;
  throw new Error(oneLine(result.stderr || result.stdout) || `soma ${argv.slice(0, 2).join(" ")} exited with code ${result.code}`);
};

async function candidates(run: SomaRunner, input: WriterInput, bodyFile: string, probes: string[]): Promise<string[]> {
  const result = await run(addArguments(input, bodyFile, probes, true, true));
  const text = result.stdout.trim() || result.stderr.trim();
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error(oneLine(text) || "soma did not report whether a node carries the marker"); }
  const found = FoundSchema.safeParse(raw);
  if (found.success) return [found.data.node];
  if (NotFoundSchema.safeParse(raw).success) return [];
  const ambiguous = AmbiguousSchema.safeParse(raw);
  if (ambiguous.success) return ambiguous.data.nodes;
  throw new Error(oneLine(text));
}

async function readNode(run: SomaRunner, input: WriterInput, id: string): Promise<z.infer<typeof NodeSchema>> {
  const { repo } = parseMap(input.map);
  return NodeSchema.parse(JSON.parse((await soma(run, ["graph", "node", id, "--repo", repo, "--json"])).stdout));
}

export async function fileCapabilityNode(input: WriterInput, template: string, run: SomaRunner, probePatterns: string[]): Promise<WriterAnswer> {
  const probes = renderProbes(probePatterns, input.capability);
  const directory = await mkdtemp(join(tmpdir(), "desk-capability-"));
  try {
    const marker = capabilityMarker(input.capability);
    const bodyFile = join(directory, "brief.md");
    await writeFile(bodyFile, `${renderBrief(template, input)}\n`, { mode: 0o600 });
    const hits = await candidates(run, input, bodyFile, probes);
    const nodes = await Promise.all(hits.map(async (id) => ({ id, node: await readNode(run, input, id) })));
    const open = nodes.filter(({ node }) => node.status === "open");
    if (open.length > 1) throw new Error(`nodes ${open.map(({ id }) => `#${id}`).join(", ")} are all open under ${marker}; close the duplicates and retry`);
    const reused = open[0];
    if (reused && reused.node.parent) return { ref: `${reused.node.repo}#${reused.id}`, url: reused.node.url, existing: true };
    if (reused && hits.length > 1) throw new Error(`node #${reused.id} carries ${marker} but has no parent, and other nodes carry it too; attach it by hand`);
    const reusing = reused !== undefined;
    if (!reusing && hits.length > 0) await writeFile(bodyFile, `${renderBrief(template, input)}\n\n${marker}\n`, { mode: 0o600 });
    const created = CreatedSchema.parse(JSON.parse((await soma(run, addArguments(input, bodyFile, probes, reusing || hits.length === 0, false))).stdout));
    const node = await readNode(run, input, created.node);
    return { ref: `${node.repo}#${created.node}`, url: node.url, existing: reusing };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface WriterFlags { template?: string; probes: string[] }

export function parseWriterFlags(argv: string[]): WriterFlags {
  const flags: WriterFlags = { probes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] !== "--template" && argv[i] !== "--probe") throw new Error(`unknown argument ${argv[i]}`);
    if (value === undefined) throw new Error(`${argv[i]} needs a value`);
    if (argv[i] === "--template") flags.template = value;
    else flags.probes.push(value);
    i += 1;
  }
  return flags;
}

export async function runWriter(stdin: string, flags: WriterFlags, run: SomaRunner = somaRunner()): Promise<WriterAnswer> {
  const input = WriterInputSchema.parse(JSON.parse(stdin));
  const template = await readFile(flags.template ?? input.template ?? DEFAULT_TEMPLATE, "utf8");
  return fileCapabilityNode(input, template, run, flags.probes);
}

if (import.meta.main) {
  try {
    const answer = await runWriter(await Bun.stdin.text(), parseWriterFlags(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
