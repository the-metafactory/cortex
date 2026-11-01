import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const OwnerSchema = z.object({ pid: z.number().int().positive(), label: z.string(), stack: z.string(), at: z.string() });
export type LockOwner = z.infer<typeof OwnerSchema>;

export interface LockOptions {
  dir: string;
  stack: string;
  label: string;
  expectedLabel: string;
  pid?: number;
  alive?: (pid: number) => boolean;
  now?: () => Date;
}

export type LockResult =
  | { held: true; owner: LockOwner; tookOver: LockOwner | null; release: () => Promise<void> }
  | { held: false; reason: string };

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

const heldHere = new Set<string>();
const errorCode = (error: unknown): unknown => error instanceof Error && "code" in error ? error.code : undefined;

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = OwnerSchema.safeParse(JSON.parse(await readFile(join(path, "owner.json"), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function acquireHostLock(options: LockOptions): Promise<LockResult> {
  const path = join(options.dir, "host.lock");
  const alive = options.alive ?? processAlive;
  const owner: LockOwner = { pid: options.pid ?? process.pid, label: options.label, stack: options.stack, at: (options.now?.() ?? new Date()).toISOString() };
  await mkdir(options.dir, { recursive: true });
  let tookOver: LockOwner | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const staged = `${path}.${owner.pid}-${crypto.randomUUID()}`;
    await mkdir(staged);
    await writeFile(join(staged, "owner.json"), JSON.stringify(owner));
    try {
      await rename(staged, path);
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      if (!["EEXIST", "ENOTEMPTY"].includes(String(errorCode(error)))) throw error;
      const holder = await readOwner(path);
      if (!holder) return { held: false, reason: `store held by an unreadable lock at ${path}` };
      const who = `${holder.pid}/${holder.label || "no launchd label"}`;
      const ours = holder.pid === owner.pid && heldHere.has(path);
      if (ours || (holder.pid !== owner.pid && alive(holder.pid))) return { held: false, reason: `store held by ${who}` };
      if (holder.label !== options.expectedLabel || holder.stack !== options.stack) return { held: false, reason: `store held by ${who}; its label does not match ${options.expectedLabel}, so it is not taken over (lock ${path})` };
      const stale = `${path}.stale-${holder.pid}-${owner.pid}`;
      await rename(path, stale);
      await rm(stale, { recursive: true, force: true });
      tookOver = holder;
      continue;
    }
    heldHere.add(path);
    const release = async (): Promise<void> => {
      const current = await readOwner(path);
      if (current?.pid === owner.pid && current.at === owner.at) await rm(path, { recursive: true, force: true });
      heldHere.delete(path);
    };
    return { held: true, owner, tookOver, release };
  }
  return { held: false, reason: `store lock at ${path} changed during takeover` };
}
