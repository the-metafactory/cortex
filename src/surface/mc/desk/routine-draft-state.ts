import type { Database } from "bun:sqlite";
import { oneLine } from "./actions";
import { spawnWithStdin } from "./create";
import { BuildStatusSchema, type BuildState, type DraftNodeView, type RoutineDraftView } from "./routine-capability-contract";
import { expandNodeCommand } from "./routine-node-command";
import { runRoutineCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import type { RoutineCapabilities } from "./routine-providers";
import { listFiledDrafts } from "./routine-store";

const READ_CONCURRENCY = 4;
const MAX_REASON = 400;
const brief = (text: string): string => { const line = text.replaceAll(/\s+/g, " ").trim(); return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line; };
const unknown = (error: string): BuildState => ({ state: "unknown", error });

async function readBuildState(options: RoutineOptions, capability: string, ref: string, capabilities: RoutineCapabilities, run: RoutineRunner): Promise<BuildState | null> {
  const build = options.capabilityBuild;
  if (!build?.status) return null;
  const argv = expandNodeCommand(build.status, ref, build.map);
  if (!argv) return unknown(`the node reference ${ref} cannot be passed to the status command.`);
  let result;
  try {
    result = await runRoutineCommand(run, argv, options.readTimeoutSeconds * 1000);
  } catch (error) {
    return unknown(`the status command did not finish: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.code !== 0) return unknown(oneLine(result.stderr || result.stdout, `the status command exited with code ${result.code}.`));
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); }
  catch { return unknown("the status command printed invalid JSON."); }
  const parsed = BuildStatusSchema.safeParse(raw);
  if (!parsed.success) return unknown("the status command printed a state the Desk does not know.");
  const { state, reason, pr } = parsed.data;
  return { state: state === "merged" && capabilities().has(capability) ? "live" : state, ...(reason ? { reason: brief(reason) } : {}), ...(pr ? { pr } : {}) };
}

export async function readDraftViews(db: Database, options: RoutineOptions, capabilities: RoutineCapabilities, run: RoutineRunner = spawnWithStdin): Promise<RoutineDraftView[]> {
  if (!options.capabilityBuild) return [];
  const drafts = listFiledDrafts(db);
  const jobs = drafts.flatMap((draft) => Object.entries(draft.draft?.nodes ?? {}).map(([capability, node]) => ({ proposalId: draft.id, capability, node })));
  const views = new Map<string, DraftNodeView>();
  for (let offset = 0; offset < jobs.length; offset += READ_CONCURRENCY) {
    await Promise.all(jobs.slice(offset, offset + READ_CONCURRENCY).map(async ({ proposalId, capability, node }) => {
      const { ref, url, notStarted } = node;
      views.set(`${proposalId}:${capability}`, { capability, ref, url, ...(notStarted ? { notStarted } : {}), build: await readBuildState(options, capability, ref, capabilities, run) });
    }));
  }
  return drafts.map((draft) => ({
    proposalId: draft.id,
    title: draft.title,
    nodes: Object.keys(draft.draft?.nodes ?? {}).flatMap((capability) => views.get(`${draft.id}:${capability}`) ?? []),
  }));
}
