import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  abandonedRunRoots,
  CLAUDE_CREDENTIAL_PATHS,
  HERMETIC_HOME_ENV,
  hermeticTestEnv,
  runRootName,
} from "./lib/test-home";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const base = existsSync("/tmp") ? realpathSync("/tmp") : tmpdir();
function removeIfOwned(path: string): void {
  try {
    if (lstatSync(path).uid !== process.getuid?.()) return;
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.error(`skipped abandoned test run root ${path}: ${(error as Error).message}`);
  }
}

for (const name of abandonedRunRoots(readdirSync(base), isAlive)) removeIfOwned(join(base, name));

const root = mkdtempSync(join(base, runRootName(process.pid)));
const home = join(root, "home");
const tmp = join(root, "tmp");
mkdirSync(home);
mkdirSync(tmp);
for (const relative of CLAUDE_CREDENTIAL_PATHS) {
  const source = join(homedir(), relative);
  if (!existsSync(source)) continue;
  mkdirSync(dirname(join(home, relative)), { recursive: true });
  symlinkSync(source, join(home, relative));
}

const child = Bun.spawn(["bun", "test", ...process.argv.slice(2)], {
  env: hermeticTestEnv(process.env, { home, tmp }),
  stdio: ["inherit", "inherit", "inherit"],
});

function removeRoot(): void {
  rmSync(root, { recursive: true, force: true });
}

const SIGNAL_NUMBERS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
for (const signal of Object.keys(SIGNAL_NUMBERS) as (keyof typeof SIGNAL_NUMBERS)[]) {
  process.on(signal, () => {
    child.kill(signal);
    void child.exited.then(() => {
      removeRoot();
      process.exit(128 + SIGNAL_NUMBERS[signal]);
    });
  });
}

const exitCode = await child.exited;
removeRoot();
if (exitCode !== 0) console.error(`bun test exited ${exitCode} under ${HERMETIC_HOME_ENV}=${home}`);
process.exit(exitCode);
