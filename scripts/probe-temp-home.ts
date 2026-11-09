import { mkdtemp, rm } from "node:fs/promises";
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
