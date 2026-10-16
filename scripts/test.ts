import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_CREDENTIAL_PATHS, HERMETIC_HOME_ENV, hermeticTestEnv } from "./lib/test-home";

const home = mkdtempSync(join(tmpdir(), "cortex-test-home-"));
for (const relative of CLAUDE_CREDENTIAL_PATHS) {
  const source = join(homedir(), relative);
  if (!existsSync(source)) continue;
  mkdirSync(dirname(join(home, relative)), { recursive: true });
  symlinkSync(source, join(home, relative));
}

const run = Bun.spawnSync(["bun", "test", ...process.argv.slice(2)], {
  env: hermeticTestEnv(process.env, home),
  stdio: ["inherit", "inherit", "inherit"],
});
rmSync(home, { recursive: true, force: true });
if (run.exitCode !== 0) console.error(`bun test exited ${run.exitCode} under ${HERMETIC_HOME_ENV}=${home}`);
process.exit(run.exitCode ?? 1);
