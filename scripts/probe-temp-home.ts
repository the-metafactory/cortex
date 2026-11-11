import { hermeticTestEnv } from "./lib/test-home";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "desk-probe-home-"));
  const prior = process.env.HOME;
  process.env.HOME = home;
  try { await run(home); }
  finally {
    if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior;
    await rm(home, { recursive: true, force: true });
  }
}

export async function runWithTemporaryHome(path: string, probe: () => Promise<void>): Promise<void> {
  if (process.argv.includes("--isolated")) { await probe(); return; }
  const root = await mkdtemp(join(tmpdir(), "desk-probe-"));
  try {
    const home = join(root, "home");
    const tmp = join(root, "tmp");
    await mkdir(home);
    await mkdir(tmp);
    const child = Bun.spawn([process.execPath, path, "--isolated"], { env: hermeticTestEnv(process.env, { home, tmp }), stdio: ["inherit", "inherit", "inherit"] });
    process.exitCode = await child.exited;
  } finally { await rm(root, { recursive: true, force: true }); }
}
