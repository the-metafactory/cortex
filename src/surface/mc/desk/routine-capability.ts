import type { Database } from "bun:sqlite";
import { oneLine } from "./actions";
import type { HandledLedger } from "./actions";
import { spawnWithStdin } from "./create";
import { CapabilityNodeSchema, FILEABLE_CAPABILITY, type BuiltNode, type CapabilityBuildRequest, type CapabilityBuildResult, type CapabilityNode, type MissingCapability } from "./routine-capability-contract";
import { runNodeCommand } from "./routine-node-command";
import { runRoutineCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import { readRoutineProposal, recordDraftNode, routineConfigHash } from "./routine-store";

const NOT_SET_UP = "Building capabilities is not set up on this stack.";
const NO_DRAFT = "This routine draft is no longer available. Ask for the routine again.";
const CHECK_BEFORE_RETRY = "The writer may have filed it anyway: check the map for a node marked with this capability before retrying.";

const failed = (error: string): CapabilityBuildResult => ({ ok: false, message: error, built: [], failed: [] });
const ledgerKey = (requestId: string, capability: string): string => `capability-build:${requestId}:${capability}`;

async function fileCapability(options: RoutineOptions, writer: string[], input: Record<string, unknown>, run: RoutineRunner): Promise<{ ok: true; node: CapabilityNode } | { ok: false; error: string }> {
  let result;
  try {
    result = await runRoutineCommand(run, writer, options.timeoutSeconds * 1000, JSON.stringify(input));
  } catch (error) {
    return { ok: false, error: `the writer did not finish: ${error instanceof Error ? error.message : String(error)}. ${CHECK_BEFORE_RETRY}` };
  }
  if (result.code !== 0) return { ok: false, error: oneLine(result.stderr || result.stdout, `the writer exited with code ${result.code}.`) };
  try {
    return { ok: true, node: CapabilityNodeSchema.parse(JSON.parse(result.stdout)) };
  } catch {
    return { ok: false, error: `the writer answered in a form the Desk cannot read. ${CHECK_BEFORE_RETRY}` };
  }
}

async function startBuild(options: RoutineOptions, start: string[], map: string, node: CapabilityNode, run: RoutineRunner): Promise<string | undefined> {
  const result = await runNodeCommand({ argv: start, ref: node.ref, map, label: "start", timeoutMs: options.timeoutSeconds * 1000, run });
  return result.ok ? undefined : result.error;
}

function summary(built: CapabilityBuildResult["built"], problems: CapabilityBuildResult["failed"]): string {
  const filed = built.map((b) => `${b.capability}: ${b.existing ? "already filed as" : "filed as"} ${b.ref}${b.notStarted ? `, not started: ${b.notStarted}` : ""}`);
  const refused = problems.map((p) => `${p.capability} failed: ${p.error}`);
  return [...filed, ...refused].join(" ");
}

export async function buildRoutineCapabilities(db: Database, options: RoutineOptions, ledger: Pick<HandledLedger, "claim" | "release">, request: CapabilityBuildRequest, run: RoutineRunner = spawnWithStdin): Promise<CapabilityBuildResult> {
  const build = options.capabilityBuild;
  if (!build) return failed(NOT_SET_UP);
  const proposal = readRoutineProposal(db, request.proposalId);
  const draft = proposal?.draft;
  if (!proposal || !draft) return failed(NO_DRAFT);
  if (proposal.configHash !== routineConfigHash(options)) return failed("The Desk configuration changed. Ask for the routine again.");
  const built: CapabilityBuildResult["built"] = [];
  const problems: CapabilityBuildResult["failed"] = [];
  const attempt = async (missing: MissingCapability): Promise<void> => {
    const { capability } = missing;
    const recorded = readRoutineProposal(db, request.proposalId)?.draft?.nodes[capability];
    if (recorded) { built.push({ capability, ...recorded }); return; }
    if (!FILEABLE_CAPABILITY.test(capability)) { problems.push({ capability, error: "its name cannot be used to mark a build node." }); return; }
    const key = ledgerKey(request.requestId, capability);
    if (!ledger.claim(key)) { problems.push({ capability, error: "it is already being filed. Check again in a moment." }); return; }
    try {
      const filed = await fileCapability(options, build.writer, {
        requestId: request.requestId, capability, steps: missing.steps, request: draft.text, yaml: proposal.yaml, map: build.map, budget: build.budget,
        ...(build.template ? { template: build.template } : {}),
      }, run);
      if (!filed.ok) { problems.push({ capability, error: filed.error }); return; }
      const notStarted = build.start && !filed.node.existing ? await startBuild(options, build.start, build.map, filed.node, run) : undefined;
      const node: BuiltNode = notStarted ? { ...filed.node, notStarted } : filed.node;
      recordDraftNode(db, request.proposalId, capability, node);
      built.push({ capability, ...node });
    } finally {
      ledger.release(key);
    }
  };
  for (const missing of draft.missing) await attempt(missing);
  return { ok: problems.length === 0, message: summary(built, problems), built, failed: problems };
}
