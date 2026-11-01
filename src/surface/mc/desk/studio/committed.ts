import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawnGit } from "./git";
import { STUDIO_MAX_FILE_BYTES } from "./read";
import { COMMITTED_BATCH_BYTES, COMMITTED_BATCH_FILES, readCommittedBatch, type CommittedObject } from "./committed-batch";
import type { StudioFile, StudioFiles } from "./view";

interface CommittedEntry extends CommittedObject { path: string }

async function git(dir: string, args: string[]): Promise<string> {
  const result = await spawnGit(args, dir);
  if (result.code !== 0) throw new Error("Studio committed source lookup failed; overseer deferred");
  return result.stdout;
}

function parseEntry(text: string): CommittedEntry {
  const parsed = /^(\d+) (\w+) ([a-f0-9]{40}|[a-f0-9]{64}) +(-|\d+)\t([^\0]+)$/.exec(text);
  const [, mode, kind, oid, length, path] = parsed ?? [];
  if (!mode || !kind || !oid || !length || !path) throw new Error("Studio committed tree entry is incomplete");
  if (kind !== "blob" || !/^100(?:644|755)$/.test(mode)) throw new Error(`Studio committed input ${path} must be a regular file`);
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size < 0 || size > STUDIO_MAX_FILE_BYTES) throw new Error(`Studio committed input ${path} exceeds the file limit`);
  return { path, oid, size };
}

async function workingBytes(dir: string, entry: CommittedEntry): Promise<Buffer> {
  const target = join(dir, entry.path);
  const info = await lstat(target);
  if (!info.isFile() || await realpath(target) !== target) throw new Error(`Studio committed input ${entry.path} must remain a regular file inside Studio`);
  if (info.size > STUDIO_MAX_FILE_BYTES) throw new Error(`Studio committed input ${entry.path} exceeds the file limit`);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("Studio committed input must remain a regular file");
    const bytes = Buffer.alloc(entry.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await file.read(bytes, length, bytes.length - length, length);
      if (next.bytesRead === 0) break;
      length += next.bytesRead;
    }
    const value = bytes.subarray(0, length);
    const hash = createHash(entry.oid.length === 40 ? "sha1" : "sha256").update(`blob ${length}\0`).update(value).digest("hex");
    if (length !== entry.size || hash !== entry.oid) throw new Error(`Studio input ${entry.path} differs from its committed source; overseer deferred`);
    return value;
  } finally { await file.close(); }
}

async function readEntries(dir: string, entries: CommittedEntry[]): Promise<StudioFile[]> {
  const files: StudioFile[] = [];
  let pending: CommittedEntry[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (!pending.length) return;
    const batch = pending;
    pending = []; bytes = 0;
    const blobs = await readCommittedBatch(dir, batch);
    for (const [index, entry] of batch.entries()) {
      const blob = blobs[index];
      if (!blob || !(await workingBytes(dir, entry)).equals(blob)) throw new Error("Studio committed content differs from its snapshot");
      files.push({ path: entry.path, text: blob.toString("utf8") });
    }
  };
  for (const entry of entries) {
    if (pending.length === COMMITTED_BATCH_FILES || bytes + entry.size > COMMITTED_BATCH_BYTES) await flush();
    pending.push(entry); bytes += entry.size;
  }
  await flush();
  return files;
}

export async function readCommittedStudioFile(dir: string, head: string, path: string): Promise<StudioFile | null> {
  const tree = await git(dir, ["ls-tree", "-lz", "--full-tree", head, "--", path]);
  if (!tree) return null;
  const entries = tree.split("\0").filter(Boolean).map(parseEntry);
  if (entries.length !== 1 || entries[0]?.path !== path) throw new Error("Studio committed source lookup is ambiguous");
  const [file] = await readEntries(dir, entries);
  return file ?? null;
}

export async function readCommittedStudioFiles(dir: string, head: string): Promise<StudioFiles> {
  const files: StudioFiles = { threads: [], inbox: [], proposals: [] };
  const tree = await git(dir, ["ls-tree", "-rlz", "--full-tree", head, "--", "threads", "inbox", "proposals"]);
  const entries = tree.split("\0").filter(entry => /\t(threads|inbox|proposals)\/[^/]+\.md$/.test(entry)).map(parseEntry);
  for (const file of await readEntries(dir, entries)) {
    if (file.path.startsWith("threads/")) files.threads.push(file);
    else if (file.path.startsWith("inbox/")) files.inbox.push(file);
    else files.proposals.push(file);
  }
  if ((await git(dir, ["rev-parse", "HEAD"])).trim() !== head) throw new Error("Studio committed HEAD changed during source lookup; overseer deferred");
  return files;
}
