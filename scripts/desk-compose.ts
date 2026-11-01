import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { composeFlow, chatModelLLM, OpenAICompatibleChatModel, type CatalogEntry } from "pulse";
import { spawnWithStdin, type WriterRunner } from "../src/surface/mc/desk/create";
import { RoutineDetailSchema, RoutineEditProposalSchema } from "../src/surface/mc/desk/routine-editor-contract";

const inventorySchema = z.object({ packages: z.array(z.object({ name: z.string(), type: z.string(), status: z.string(), installPath: z.string() })) });
const field = z.looseObject({ type: z.string(), required: z.boolean().optional() });
const actionSchema = z.object({ name: z.string(), description: z.string(), input: z.record(z.string(), field).default({}), output: z.record(z.string(), field).default({}), requires: z.array(z.string()).optional(), tags: z.array(z.string()).optional() });

export async function loadDeskRoutineCatalog(file: string): Promise<CatalogEntry[]> {
  if (!isAbsolute(file)) throw new Error("The trusted catalog snapshot path must be absolute.");
  const inventory = inventorySchema.parse(JSON.parse(await readFile(file, "utf8")));
  const catalog = new Map<string, CatalogEntry>();
  for (const action of inventory.packages.filter((p) => p.type === "action" && p.status === "active")) {
    if (!isAbsolute(action.installPath)) throw new Error("Trusted catalog install paths must be absolute.");
    const entry = actionSchema.parse(JSON.parse(await readFile(join(action.installPath, "action.json"), "utf8")));
    if (entry.name !== action.name) throw new Error("Trusted catalog action identity mismatch.");
    const prior = catalog.get(entry.name);
    if (prior && JSON.stringify(prior) !== JSON.stringify(entry)) throw new Error("Ambiguous trusted catalog entry.");
    catalog.set(entry.name, entry);
  }
  return [...catalog.values()].filter((entry) => !entry.requires?.includes("llm") && !entry.requires?.includes("agent"));
}

export async function forwardRoutineEdit(options: { pulseBin: string; modelUrl: string; model: string; apiKeyEnv: string; request: string; routineEdit: string }, run: WriterRunner = spawnWithStdin) {
  if (options.routineEdit.length > 262144 || options.request.length > 2000) throw new Error("The routine edit request exceeds its size limit.");
  const view = RoutineDetailSchema.shape.flow.unwrap().parse(JSON.parse(options.routineEdit));
  const result = await run([options.pulseBin, "compose", "--request", options.request, "--routine-edit", JSON.stringify(view), "--model-url", options.modelUrl, "--model", options.model, "--api-key-env", options.apiKeyEnv, "--json"], "", 120000);
  if (result.code !== 0) throw new Error("The configured routine model could not prepare a valid edit.");
  if (result.stdout.length > 65536) throw new Error("The routine model proposal exceeds its size limit.");
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); }
  catch { throw new Error("The routine model returned an invalid parameter proposal."); }
  const reply = RoutineEditProposalSchema.safeParse(raw);
  if (!reply.success) throw new Error("The routine model returned an invalid parameter proposal.");
  return reply.data;
}

if (import.meta.main) {
  const program = new Command("desk-compose")
    .requiredOption("--catalog-file <path>")
    .requiredOption("--model-url <url>")
    .requiredOption("--model <name>")
    .requiredOption("--api-key-env <name>")
    .requiredOption("--request <text>")
    .option("--routine-edit <json>")
    .option("--pulse-bin <executable>", "Pulse CLI executable for routine proposals", "pulse")
    .option("--json");
  const options = program.parse().opts<{ catalogFile: string; modelUrl: string; model: string; apiKeyEnv: string; request: string; routineEdit?: string; pulseBin: string }>();
  try {
    if (options.routineEdit) {
      const result = await forwardRoutineEdit({ ...options, routineEdit: options.routineEdit });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = 0;
    } else {
    const catalog = await loadDeskRoutineCatalog(options.catalogFile);
    if (catalog.length === 0) throw new Error("The trusted snapshot contains no executable actions.");
    const llm = chatModelLLM(new OpenAICompatibleChatModel({ baseUrl: options.modelUrl, model: options.model, apiKeyEnv: options.apiKeyEnv, label: "desk-compose" }));
    const result = await composeFlow(options.request, { catalog, llm });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== "complete") process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "invalid", findings: [{ message: error instanceof Error ? error.message : String(error) }] })}\n`);
    process.exitCode = 1;
  }
}
