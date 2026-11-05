import type { Database } from "bun:sqlite";
import { spawnWithStdin } from "./create";
import type { CapabilityBuildOptions } from "../../../common/types/desk-routines";
import { BuildStatusSchema, type BuildState, type RoutineDraftView } from "./routine-capability-contract";
import { runNodeCommand } from "./routine-node-command";
import type { RoutineOptions, RoutineRunner } from "./routine-command";
import type { RoutineCapabilities } from "./routine-providers";
import { retryRoutineDraft } from "./routine-drafts";
import { capabilityInstallView, latestCapabilityInstall } from "./routine-install-store";
import { routineConfigHash } from "./routine-store";
import { listRoutineDrafts } from "./routine-store";

const READ_CONCURRENCY = 4;
const MAX_REASON = 400;
const brief = (text: string): string => { const line = text.replaceAll(/\s+/g, " ").trim(); return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line; };
const unknown = (error: string): BuildState => ({ state: "unknown", error });

async function readBuildState(build: CapabilityBuildOptions, status: string[], ref: string, timeoutMs: number, run: RoutineRunner): Promise<BuildState> {
  const result = await runNodeCommand({ argv: status, ref, map: build.map, label: "status", timeoutMs, run });
  if (!result.ok) return unknown(result.error);
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); }
  catch { return unknown("the status command printed invalid JSON."); }
  const parsed = BuildStatusSchema.safeParse(raw);
  if (!parsed.success) return unknown("the status command printed a state the Desk does not know.");
  const { state, reason, pr } = parsed.data;
  return { state, ...(reason ? { reason: brief(reason) } : {}), ...(pr ? { pr } : {}) };
}

async function pooled<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const item = items[next++] as T; await work(item); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const withPresence = (build: BuildState | null, live: boolean): BuildState | null => build?.state === "merged" && live ? { ...build, state: "live" } : build;

export async function readDraftViews(db: Database, options: RoutineOptions, capabilities: RoutineCapabilities, run: RoutineRunner = spawnWithStdin, now = Date.now()): Promise<RoutineDraftView[]> {
  const build = options.capabilityBuild;
  const drafts = listRoutineDrafts(db);
  const states = new Map<string, BuildState>();
  const status = build?.status;
  if (build && status) {
    const refs = [...new Set(drafts.flatMap((draft) => Object.values(draft.draft?.nodes ?? {}).map((node) => node.ref)))];
    await pooled(refs, READ_CONCURRENCY, async (ref) => { states.set(ref, await readBuildState(build, status, ref, options.readTimeoutSeconds * 1000, run)); });
  }
  const present = capabilities();
  return drafts.map((draft) => ({
    proposalId: draft.id,
    title: draft.title,
    ...retryRoutineDraft(draft, options, () => present),
    nodes: Object.entries(draft.draft?.nodes ?? {}).map(([capability, { ref, url, notStarted }]) => {
      const install = latestCapabilityInstall(db, routineConfigHash(options), ref);
      const state = states.get(ref) ?? null;
      const live = present.has(capability);
      const buildState = live && install?.state === "installed" ? { state: "live" as const } : withPresence(state, live);
      const configured = draft.configHash === routineConfigHash(options) && Boolean(build?.install);
      return {
        capability, ref, url, ...(notStarted ? { notStarted } : {}), build: buildState,
        ...(install ? { install: capabilityInstallView(install), presenceLate: install.state === "installed" && !live && now - install.at >= 90_000 } : {}),
        canInstall: configured && buildState?.state === "merged" && (!install || install.state === "failed" || install.state === "undone"),
      };
    }),
  }));
}
