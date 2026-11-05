import type { Database } from "bun:sqlite";
import { z } from "zod";
import { oneLine } from "./actions";
import { listGrants } from "./autonomy";
import { spawnWithStdin } from "./create";
import { readDraftViews } from "./routine-draft-state";
import { readCapabilityInstall, latestCapabilityInstall } from "./routine-install-store";
import { runRoutineCommand, type RoutineOptions, type RoutineRunner } from "./routine-command";
import type { RoutineResult } from "./routine-action-contract";
import type { RoutineCapabilities } from "./routine-providers";
import { readRoutineProposal, routineConfigHash } from "./routine-store";

export const CAPABILITY_INSTALL = "capability.install";
export const CapabilityInstallRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal(CAPABILITY_INSTALL), requestId: z.string().regex(/^[\w-]{8,64}$/), proposalId: z.uuid(), capability: z.string().min(1).max(200) }).strict(),
  z.object({ action: z.literal("capability.uninstall"), id: z.string().regex(/^[\w-]{8,64}$/) }).strict(),
]);
export type CapabilityInstallRequest = z.infer<typeof CapabilityInstallRequestSchema>;
const refused = (error: string): RoutineResult => ({ ok: false, error });
const pending = (): RoutineResult => ({ ok: false, error: "The pack command has not confirmed its result. Check the pack before trying again.", uncertain: true });

async function packCommand(options: RoutineOptions, argv: string[], pack: string, run: RoutineRunner): Promise<RoutineResult> {
  try {
    const result = await runRoutineCommand(run, argv.map((arg) => arg.replaceAll("{pack}", pack)), options.timeoutSeconds * 1000);
    return result.code === 0 ? { ok: true, message: "Pack command completed." } : refused(oneLine(result.stderr || result.stdout, `exit code ${result.code}`));
  } catch (error) {
    return { ok: false, error: oneLine(error instanceof Error ? error.message : String(error), "The pack command did not finish."), uncertain: true };
  }
}

export async function actOnCapabilityInstall(db: Database, options: RoutineOptions, request: CapabilityInstallRequest, capabilities: RoutineCapabilities, run: RoutineRunner = spawnWithStdin, now: () => number = Date.now, automatic = false): Promise<RoutineResult> {
  const build = options.capabilityBuild;
  if (!build?.install || !build.uninstall || !build.pack) return refused("Installing capabilities is not set up on this stack.");
  const pack = build.pack;
  const hash = routineConfigHash(options);
  if (request.action === "capability.uninstall") {
    const install = readCapabilityInstall(db, request.id);
    if (install?.config_hash !== hash) return refused("The installation or its configuration changed. Check the installed pack.");
    if (install.state === "undone") return { ok: true, message: "Pack already uninstalled." };
    if (install.state !== "installed") return pending();
    const locked = db.query("UPDATE OR IGNORE desk_capability_installs SET state = 'undoing' WHERE id = ? AND state = 'installed'").run(request.id).changes;
    if (!locked) return pending();
    const result = await packCommand(options, build.uninstall, install.pack, run);
    db.transaction(() => {
      if (result.ok) {
        db.query("UPDATE desk_capability_installs SET state = 'undone', error = NULL WHERE pack = ? AND state IN ('installed', 'undoing')").run(install.pack);
        db.query("DELETE FROM desk_done WHERE action = ? AND item_key IN (SELECT id FROM desk_capability_installs WHERE pack = ? AND state = 'undone')").run(CAPABILITY_INSTALL, install.pack);
      } else db.query("UPDATE desk_capability_installs SET state = ?, error = ? WHERE id = ?").run(result.uncertain ? "undoing" : "installed", result.error, request.id);
    })();
    return result.ok ? { ok: true, message: "Pack uninstalled." } : result;
  }
  const proposal = readRoutineProposal(db, request.proposalId);
  if (!proposal?.draft || proposal.configHash !== hash) return refused("The routine draft or its configuration changed. Ask for the routine again.");
  const ref = proposal.draft.nodes[request.capability]?.ref;
  if (!ref) return refused("This draft has no build for that capability.");
  const previous = readCapabilityInstall(db, request.requestId);
  if (previous) {
    if (previous.config_hash !== hash || !z.array(z.string()).parse(JSON.parse(previous.refs)).includes(ref)) return refused("This request id belongs to a different installation.");
    if (previous.state === "installed") return { ok: true, message: "Pack installed; waiting for local presence." };
    if (previous.state === "failed") return refused(`install failed: ${previous.error}`);
    return pending();
  }
  const drafts = await readDraftViews(db, options, capabilities, run);
  const node = drafts.find((draft) => draft.proposalId === request.proposalId)?.nodes.find((entry) => entry.capability === request.capability);
  if (!node?.canInstall || node.build?.state !== "merged") return refused("This capability is no longer waiting for installation.");
  if (automatic && !listGrants(db).has(CAPABILITY_INSTALL)) return refused("The Desk will ask before installing capabilities.");
  const refs = [...new Set(drafts.filter((draft) => readRoutineProposal(db, draft.proposalId)?.configHash === hash).flatMap((draft) => draft.nodes.filter((entry) => entry.canInstall && entry.build?.state === "merged").map((entry) => entry.ref)))];
  const claimed = db.transaction(() => {
    const inserted = db.query("INSERT OR IGNORE INTO desk_capability_installs (id, config_hash, pack, refs, state, at) VALUES (?, ?, ?, ?, 'running', ?)").run(request.requestId, hash, pack, JSON.stringify(refs), now()).changes;
    if (inserted && automatic) db.query("INSERT INTO desk_done (attempt_key, action, item_key, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)").run(`capability-install:${request.requestId}`, CAPABILITY_INSTALL, request.requestId, `Install ${pack}`, now(), now());
    return inserted;
  })();
  if (!claimed) return pending();
  const result = await packCommand(options, build.install, pack, run);
  db.transaction(() => {
    db.query("UPDATE desk_capability_installs SET state = ?, error = ?, at = ? WHERE id = ?").run(result.ok ? "installed" : result.uncertain ? "running" : "failed", result.ok ? null : result.error, now(), request.requestId);
    if (automatic) db.query("UPDATE desk_done SET status = ?, message = ?, updated_at = ? WHERE attempt_key = ?").run(result.ok ? "done" : "failed", result.ok ? `Installed ${pack}; waiting for local presence.` : `install failed: ${result.error}`, now(), `capability-install:${request.requestId}`);
  })();
  return result.ok ? { ok: true, message: `Installed ${pack}; waiting for local presence.` } : { ...result, error: `install failed: ${result.error}` };
}

export async function runCapabilityInstalls(db: Database, options: RoutineOptions, capabilities: RoutineCapabilities, run: RoutineRunner = spawnWithStdin, now: () => number = Date.now): Promise<void> {
  if (!options.capabilityBuild?.install || !listGrants(db).has(CAPABILITY_INSTALL)) return;
  const hash = routineConfigHash(options);
  const drafts = await readDraftViews(db, options, capabilities, run);
  for (const draft of drafts) for (const node of draft.nodes) {
    if (!node.canInstall || latestCapabilityInstall(db, hash, node.ref)) continue;
    await actOnCapabilityInstall(db, options, { action: CAPABILITY_INSTALL, requestId: crypto.randomUUID(), proposalId: draft.proposalId, capability: node.capability }, capabilities, run, now, true);
  }
}
