import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DeskStudioDraftSnapshot, DeskStudioDraftSnapshotMetadata } from "../../../../desk-api";
import { type ActContext, type ActPlan, type ActRefusal, isRefusal } from "./acts";
import { optionalStudioFile, readStudioDraftUnlocked, readStudioDraftThread, type DraftInput } from "./draft-read";
import { STUDIO_DRAFT_MAX_BYTES } from "./draft-format";
import { errnoIs } from "./file-error";
import { parseThreadFile, STUDIO_SLUG } from "./format";
import type { StudioFile } from "./view";

export const STUDIO_SNAPSHOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const SnapshotSchema = z.object({
  id: z.string().regex(STUDIO_SNAPSHOT_ID),
  revision: z.union([z.uuid(), z.string().regex(/^[a-f0-9]{64}$/)]),
  transition: z.enum(["park", "close"]),
  at: z.iso.datetime(),
  text: z.string().refine(text => Buffer.byteLength(text, "utf8") <= STUDIO_DRAFT_MAX_BYTES),
}).strict();
const SNAPSHOT_MAX_BYTES = STUDIO_DRAFT_MAX_BYTES * 6 + 1024;
const SNAPSHOT_ROOT = "draft-snapshots";
const ATTRIBUTES = "*.json -text -diff -ident -filter -working-tree-encoding\n";
const snapshotPath = (thread: string, id: string): string => `${SNAPSHOT_ROOT}/${thread}/${id}.json`;
const metadata = ({ id, revision, transition, at }: DeskStudioDraftSnapshot): DeskStudioDraftSnapshotMetadata => ({ id, revision, transition, at });

async function snapshotDirectory(dir: string, thread: string): Promise<string | null> {
  for (const path of [SNAPSHOT_ROOT, `${SNAPSHOT_ROOT}/${thread}`]) {
    try {
      const info = await lstat(join(dir, path));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("A Studio snapshot directory is not a regular directory.");
    } catch (error) {
      if (errnoIs(error, "ENOENT")) return null;
      throw error;
    }
  }
  return join(dir, SNAPSHOT_ROOT, thread);
}

export function validateSnapshotWrite(file: StudioFile): string | null {
  const invalid = "The Studio snapshot plan is invalid; nothing was written.";
  if (file.path === `${SNAPSHOT_ROOT}/.gitattributes`) return file.text === ATTRIBUTES ? null : invalid;
  const match = /^draft-snapshots\/([^/]+)\/([^/]+)\.json$/.exec(file.path);
  if (!match?.[1] || !match[2] || !STUDIO_SLUG.test(match[1]) || !STUDIO_SNAPSHOT_ID.test(match[2])) return invalid;
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(file.text));
    return parsed.success && parsed.data.id === match[2] ? null : invalid;
  } catch { return invalid; }
}

export async function preserveStudioDrafts(input: Omit<DraftInput, "thread">, ctx: ActContext, plan: ActPlan | ActRefusal): Promise<ActPlan | ActRefusal> {
  if (isRefusal(plan)) return plan;
  const snapshots: StudioFile[] = [];
  for (const file of plan.writes) {
    const previous = [...ctx.view.active, ...ctx.view.parked].find(thread => thread.path === file.path);
    if (!previous) continue;
    const next = parseThreadFile(file.path, file.text, input.assistantName);
    if (!next.ok) continue;
    const transition = next.value.state === "closed" ? "close" : previous.state === "active" && next.value.state === "parked" ? "park" : null;
    if (!transition) continue;
    const current = await readStudioDraftUnlocked({ ...input, thread: previous.slug });
    if (!current.ok) return current;
    const expected = plan.draftPrecondition?.thread === previous.slug ? plan.draftPrecondition.revision : undefined;
    if ((!current.legacy || expected !== undefined) && expected !== current.draft.revision) {
      return { status: 409, error: "The Studio draft changed or needs approval. Read it and supply draftRevision before closing or parking.", ...current.draft };
    }
    if (transition === "close" && next.value.outcome === "shipped" && !current.draft.text.trim()) {
      return { status: 400, error: "A shipped outcome needs nonblank draft text." };
    }
    await snapshotDirectory(input.options.dir, previous.slug);
    const snapshot: DeskStudioDraftSnapshot = { id: randomUUID(), revision: current.draft.revision, transition, at: ctx.now.toISOString(), text: current.draft.text };
    const path = snapshotPath(previous.slug, snapshot.id);
    if (await optionalStudioFile(join(input.options.dir, path), SNAPSHOT_MAX_BYTES) !== null) throw new Error("The Studio snapshot already exists.");
    snapshots.push({ path, text: `${JSON.stringify(snapshot)}\n` });
  }
  if (!snapshots.length) return plan;
  const path = `${SNAPSHOT_ROOT}/.gitattributes`;
  const attributes = await optionalStudioFile(join(input.options.dir, path), 1024);
  if (attributes !== null && attributes !== ATTRIBUTES) throw new Error("The Studio snapshot attributes are invalid.");
  return { ...plan, writes: [...plan.writes, ...(attributes === null ? [{ path, text: ATTRIBUTES }] : []), ...snapshots] };
}

export async function readStudioSnapshots(input: DraftInput, id?: string) {
  const current = await readStudioDraftThread(input);
  if (!current.ok) return current;
  const directory = await snapshotDirectory(input.options.dir, input.thread);
  const read = async (snapshotId: string): Promise<DeskStudioDraftSnapshot | null> => {
    const source = directory === null ? null : await optionalStudioFile(join(directory, `${snapshotId}.json`), SNAPSHOT_MAX_BYTES);
    if (source === null) return null;
    const snapshot = SnapshotSchema.parse(JSON.parse(source));
    if (snapshot.id !== snapshotId) throw new Error("Studio snapshot identity does not match its file.");
    return snapshot;
  };
  if (id !== undefined) {
    const snapshot = await read(id);
    return snapshot === null ? { ok: false as const, status: 404, error: "No such Studio draft snapshot." } : { ok: true as const, body: snapshot };
  }
  const snapshots: DeskStudioDraftSnapshotMetadata[] = [];
  for (const file of directory === null ? [] : await readdir(directory)) {
    if (!file.endsWith(".json") || !STUDIO_SNAPSHOT_ID.test(file.slice(0, -5))) throw new Error("Invalid Studio snapshot filename.");
    const snapshot = await read(file.slice(0, -5));
    if (snapshot === null) throw new Error("A Studio snapshot disappeared.");
    snapshots.push(metadata(snapshot));
  }
  snapshots.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { ok: true as const, body: { snapshots } };
}
