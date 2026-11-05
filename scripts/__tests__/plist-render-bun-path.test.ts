import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const scratchDirs: string[] = [];

function renderedPath(bunPathUnderHome: (home: string) => string): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "plist-bun-path-"));
  scratchDirs.push(home);
  const configDir = join(home, "config");
  const launchDir = join(home, "LaunchAgents");
  mkdirSync(join(configDir, "default", "system"), { recursive: true });
  mkdirSync(launchDir);
  writeFileSync(join(configDir, "default", "system", "system.yaml"), "");
  writeFileSync(join(configDir, "default", "default.yaml"), "");
  const script = 'source scripts/lib/plist-render.sh; render_stack_plist "$PWD" "$1" "$2" default "$3"';
  const result = spawnSync("bash", ["-c", script, "render", launchDir, configDir, bunPathUnderHome(home)], {
    cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: home },
  });
  if (result.status !== 0) throw new Error(`render failed: ${result.stdout}${result.stderr}`);
  const plist = readFileSync(join(launchDir, "ai.meta-factory.cortex.default.plist"), "utf8");
  const match = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  if (!match?.[1]) throw new Error("rendered plist has no PATH");
  return { home, path: match[1] };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stack plist PATH carries the resolved bun directory (cortex#3211)", () => {
  test("a bun outside the listed directories is added once, before the system directories", () => {
    const { home, path } = renderedPath((h) => join(h, ".bun", "bin", "bun"));
    expect(path.split(":")).toEqual([
      join(home, ".local", "bin"), join(home, "bin"), join(home, ".bun", "bin"),
      "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin",
    ]);
  });

  test.each(["/opt/homebrew/bin/bun", "/usr/local/bin/bun"])("a bun at %s leaves PATH unchanged", (bunPath) => {
    const { home, path } = renderedPath(() => bunPath);
    expect(path).toBe(`${home}/.local/bin:${home}/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`);
  });

  test("a bun in a directory listed through HOME leaves PATH unchanged", () => {
    const { home, path } = renderedPath((h) => join(h, ".local", "bin", "bun"));
    expect(path).toBe(`${home}/.local/bin:${home}/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`);
  });
});
