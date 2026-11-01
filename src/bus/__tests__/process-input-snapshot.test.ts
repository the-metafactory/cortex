import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotProcessInputs } from "../process-input-snapshot";
describe("execution input snapshot boundary", () => {
  it("refuses outside, symlinked, directory and oversized sources without retaining a partial snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-boundary-")); const allowed = join(root, "allowed"); await mkdir(allowed);
    const outside = join(root, "outside"); await writeFile(outside, "private");
    await symlink(outside, join(allowed, "link")); await writeFile(join(allowed, "large"), Buffer.alloc(1048577));
    try {
      for (const file of [outside, join(allowed, "link"), allowed, join(allowed, "large")]) await expect(snapshotProcessInputs({ input: allowed }, { input: file })).rejects.toThrow();
      await writeFile(join(allowed, "first"), "first");
      await expect(snapshotProcessInputs({ first: allowed, second: allowed }, { first: join(allowed, "first"), second: outside })).rejects.toThrow();
      expect((await readdir(allowed)).filter((name) => name.startsWith(".execution-"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
