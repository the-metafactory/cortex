import { migrateThreadKeys } from "./assistant-keys";
import type { GitRunner } from "./git";
import type { StudioArea } from "./view";
import type { StudioOptions } from "../types";
import { runStudioTransaction } from "./writer";

export const KEY_MIGRATION_SUBJECT = "Rename the old assistant keys to neutral names: ## Assistant's notes, trigger: Conversation, Conversation: material";

export type KeyMigration = { kind: "migrated"; commit: string; files: string[] } | { kind: "current" } | { kind: "refused"; error: string };

const NOTHING = "Nothing to rename.";

/**
 * Renames the old assistant keys in every Studio thread file, as one commit in the Studio repository. Idempotent: when no
 * file carries an old key it commits nothing. It refuses, writing nothing, when the Studio is not a clean git tree.
 */
export async function migrateStudioKeys(input: { options: StudioOptions; areas: readonly StudioArea[]; assistantName: string; now?: Date; git?: GitRunner }): Promise<KeyMigration> {
  let files: string[] = [];
  const result = await runStudioTransaction(
    { options: input.options, areas: input.areas, assistantName: input.assistantName, requestId: `assistant-keys-${(input.now ?? new Date()).getTime()}`, ...(input.now ? { now: input.now } : {}), ...(input.git ? { git: input.git } : {}) },
    (ctx) => {
      const writes = ctx.files.threads.flatMap((file) => {
        const text = migrateThreadKeys(file.text);
        return text === file.text ? [] : [{ path: file.path, text }];
      });
      files = writes.map((w) => w.path);
      return writes.length ? { writes, removes: [], subject: KEY_MIGRATION_SUBJECT, message: `Renamed the old assistant keys in ${writes.length} thread file${writes.length === 1 ? "" : "s"}.` } : { status: 200, error: NOTHING };
    },
  );
  if (result.ok) return result.replayed ? { kind: "current" } : { kind: "migrated", commit: result.commit, files };
  return result.error === NOTHING ? { kind: "current" } : { kind: "refused", error: result.error };
}

export function keyMigrationLine(result: KeyMigration): string | null {
  if (result.kind === "current") return null;
  if (result.kind === "migrated") return `desk: Studio keys renamed in ${result.files.join(", ")} (commit ${result.commit.slice(0, 12)})`;
  return `desk: Studio keys not renamed yet; the next start tries again: ${result.error}`;
}
