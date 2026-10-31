import { mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { runPipeline, validatePipeline, validateSteps, type PipelineStep, type StepRunnerOptions } from "pulse";

const actionName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const inventorySchema = z.object({ packages: z.array(z.object({
  name: z.string(), type: z.string(), status: z.string(), installPath: z.string(),
})) });
const fieldSchema = z.looseObject({ type: z.string(), required: z.boolean().optional() });
const manifestSchema = z.object({
  name: actionName, description: z.string(),
  input: z.record(z.string(), fieldSchema).default({}),
  output: z.record(z.string(), fieldSchema).default({}),
  requires: z.array(z.string()).optional(), tags: z.array(z.string()).optional(),
});
const documentSchema = z.object({
  name: z.string().min(1), actions: z.array(z.unknown()).min(1),
  input: z.record(z.string(), z.unknown()).default({ scenario: "", text: "" }),
});

export async function readRoutineFlow(flowsDir: string, flow: string): Promise<string> {
  if (!isAbsolute(flowsDir) || !isAbsolute(flow)) throw new Error("flow and flows-dir must be absolute paths");
  const root = await realpath(flowsDir);
  const path = await realpath(flow);
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("flow must be inside the configured flows directory");
  }
  if (!(await stat(path)).isFile()) throw new Error("flow must be a regular file");
  return readFile(path, "utf8");
}

export async function installedActionInventory(): Promise<unknown> {
  const child = Bun.spawn(["arc", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Arc inventory failed (${code}): ${stderr.slice(0, 200)}`);
  return JSON.parse(stdout);
}

export function requireFlowProviders(steps: PipelineStep[], runtime: Omit<StepRunnerOptions, "actionDirs">, names = new Set<string>()): Set<string> {
  for (const step of steps) {
    if (typeof step === "string") {
      names.add(step);
      continue;
    }
    if ("agent" in step || "tribunal" in step) {
      if (!runtime.agentProvider) throw new Error("flow requires a configured agent provider");
    } else if ("gate" in step) {
      if (!runtime.gateProvider) throw new Error("flow requires a configured gate provider");
    } else if ("research" in step) {
      if (!runtime.models?.[step.research.model]) throw new Error("flow requires a configured research model");
      for (const tool of step.research.tools) names.add(tool);
    } else if ("governed" in step) {
      if (step.governed.tribunal && !runtime.agentProvider) throw new Error("flow requires a configured agent provider");
      if (step.governed.gate && !runtime.gateProvider) throw new Error("flow requires a configured gate provider");
    } else if ("parallel" in step) {
      for (const branch of Object.values(step.parallel.branches)) requireFlowProviders(branch.actions, runtime, names);
    } else if ("map" in step) requireFlowProviders(step.map.actions, runtime, names);
    else if ("filter" in step) requireFlowProviders(step.filter.actions, runtime, names);
    else if ("reduce" in step) requireFlowProviders(step.reduce.actions, runtime, names);
    else if ("retry" in step) requireFlowProviders(step.retry.actions, runtime, names);
    else {
      const exhaustive: never = step;
      throw new Error(`unsupported flow step: ${String(exhaustive)}`);
    }
  }
  return names;
}

export async function executeRoutineFlow(options: {
  flowsDir: string;
  flow: string;
  inventory?: () => Promise<unknown>;
  runtime?: Omit<StepRunnerOptions, "actionDirs">;
}): Promise<void> {
  const yaml = await readRoutineFlow(options.flowsDir, options.flow);
  const document = documentSchema.parse(parseYaml(yaml));
  const actions = validateSteps(document.actions);
  const runtime = options.runtime ?? {};
  const names = requireFlowProviders(actions, runtime);
  const inventory = inventorySchema.parse(await (options.inventory ?? installedActionInventory)());
  const projection = await mkdtemp(join(tmpdir(), "cortex-pulse-flow-"));
  try {
    const catalog: z.infer<typeof manifestSchema>[] = [];
    const selected = new Map<string, string>();
    for (const entry of inventory.packages) {
      if (entry.type !== "action" || entry.status !== "active") continue;
      actionName.parse(entry.name);
      if (!isAbsolute(entry.installPath)) throw new Error("installed action path must be absolute");
      const path = await realpath(entry.installPath);
      const previous = selected.get(entry.name);
      if (previous === path) continue;
      if (previous) throw new Error(`ambiguous installed action: ${entry.name}`);
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(path, "action.json"), "utf8")));
      if (manifest.name !== entry.name) throw new Error(`installed action name mismatch: ${entry.name}`);
      if (names.has(entry.name)) {
        if (manifest.requires?.includes("agent") && !runtime.agentProvider) throw new Error(`action ${entry.name} requires a configured agent provider`);
        if (manifest.requires?.includes("llm") && !runtime.llmModel) throw new Error(`action ${entry.name} requires a configured LLM model`);
      }
      await symlink(path, join(projection, entry.name), "dir");
      selected.set(entry.name, path);
      catalog.push(manifest);
    }
    const validation = validatePipeline(yaml, catalog, { initialFields: Object.keys(document.input) });
    if (!validation.valid) throw new Error(validation.findings.map((finding) => finding.message).join("; "));
    const result = await runPipeline({ name: document.name, actions }, document.input, { ...runtime, actionDirs: [projection] });
    if (!result.success) throw new Error(result.error ?? "Pulse flow failed");
  } finally {
    await rm(projection, { recursive: true, force: true });
  }
}
