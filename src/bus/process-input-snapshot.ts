import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
export async function snapshotProcessInputs(inputs: Record<string, string> | undefined, payload: Record<string, unknown>) {
  const snapshots: string[] = [];
  const cleanup = async (): Promise<void> => {
    await Promise.all(snapshots.map(async (path) => {
      try { await rm(path, { recursive: true, force: true }); }
      catch (error) { process.stderr.write(`${JSON.stringify({ event: "process.input-snapshot-cleanup-failed", path, reason: error instanceof Error ? error.message : String(error) })}\n`); }
    }));
  };
  const result = { ...payload };
  try {
    for (const [parameter, directory] of Object.entries(inputs ?? {})) {
      const file = payload[parameter];
      if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Snapshot input must be an absolute file path");
      const root = await realpath(directory); const path = await realpath(file); const child = relative(root, path);
      if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || path !== resolve(root, relative(resolve(directory), resolve(file))) || !(await lstat(path)).isFile()) throw new Error("Snapshot input must be a regular file inside its declared directory");
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1048576) throw new Error("Snapshot input exceeds the regular file size limit");
        bytes = await handle.readFile();
        if (bytes.byteLength > 1048576) throw new Error("Snapshot input exceeds its byte limit");
      } finally { await handle.close(); }
      const temporary = await mkdtemp(join(root, ".execution-")); snapshots.push(temporary);
      const snapshot = join(temporary, basename(path));
      await writeFile(snapshot, bytes, { mode: 0o600, flag: "wx" });
      result[parameter] = snapshot;
    }
    return { payload: result, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
