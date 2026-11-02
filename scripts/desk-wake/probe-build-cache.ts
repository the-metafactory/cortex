import { chmod, mkdtemp, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const root = join(import.meta.dir, "../..");
const temp = await mkdtemp(join(tmpdir(), "desk-wake-cache-probe-"));
const asset = join(root, "dist/dashboard-v2/wake/path.LICENSE");
const original = new Uint8Array(await Bun.file(asset).arrayBuffer());
try {
  const tar = join(temp, "tar");
  await Bun.write(tar, "#!/bin/sh\nexit 73\n");
  await chmod(tar, 0o700);
  const run = () => Bun.spawnSync([process.execPath, join(root, "scripts/build-desk-wake.ts")], { cwd: root, env: { ...process.env, PATH: [temp, process.env.PATH ?? ""].join(delimiter) }, stdout: "pipe", stderr: "pipe" });
  const warm = run();
  if (warm.exitCode !== 0) throw new Error(`A valid warm bundle required archive extraction:\n${new TextDecoder().decode(warm.stderr)}`);
  const manifest = z.object({ sources: z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{64}$/) })) }).parse(await Bun.file(join(root, "dist/dashboard-v2/wake/manifest.json")).json());
  const archivesPresent = (await Promise.all(manifest.sources.map(source => Bun.file(join(root, "node_modules/.cache/desk-wake", source.sha)).exists()))).every(Boolean);
  if (archivesPresent) {
    try {
      await Bun.write(asset, "corrupted cache probe");
      const corrupt = run();
      if (corrupt.exitCode === 0 || !new TextDecoder().decode(corrupt.stderr).includes("Wake archive extraction failed: runtime")) throw new Error("A changed output was incorrectly reused or did not require rebuilding");
    } finally { await Bun.write(asset, original); }
  }
  if (run().exitCode !== 0) throw new Error("The restored bundle was not reusable");
  process.stdout.write(archivesPresent ? "Wake build cache: warm reuse without extraction, corrupt-output refusal, and restoration passed.\n" : "Wake build cache: warm reuse passed; corrupt-output check SKIPPED because source archives are absent.\n");
} finally { await rm(temp, { recursive: true, force: true }); }
