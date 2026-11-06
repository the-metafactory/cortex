import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  abandonedRunRoots,
  bunSpawnSyncHangWarning,
  checkTestHome,
  checkTestTmp,
  HERMETIC_HOME_ENV,
  hermeticTestEnv,
  HOST_HOME_OPT_IN_ENV,
  RUN_TMP_ENV,
  runRootName,
  TEST_TIMEOUT_MS,
} from "../lib/test-home";

describe("hermeticTestEnv", () => {
  const host = {
    HOME: "/Users/someone",
    SOMA_HOME: "/Users/someone/.soma",
    PATH: "/usr/bin",
    XDG_CONFIG_HOME: "/Users/someone/.config",
    XDG_RUNTIME_DIR: "/run/user/501",
    GROVE_AGENT_ID: "ivy",
    CORTEX_CHANNEL: "jc",
    CORTEX_TEST_HOST_HOME: "1",
  };
  const env = hermeticTestEnv({ ...host, TMPDIR: "/var/folders/x/T/" }, { home: "/tmp/home-x", tmp: "/tmp/tmp-x" });

  test("points HOME and the marker at the temp home", () => {
    expect(env.HOME).toBe("/tmp/home-x");
    expect(env[HERMETIC_HOME_ENV]).toBe("/tmp/home-x");
  });

  test("points TMPDIR, TMP, TEMP and the marker at the run's temp dir", () => {
    expect(env.TMPDIR).toBe("/tmp/tmp-x");
    expect(env.TMP).toBe("/tmp/tmp-x");
    expect(env.TEMP).toBe("/tmp/tmp-x");
    expect(env[RUN_TMP_ENV]).toBe("/tmp/tmp-x");
  });

  test("drops host instrumentation and XDG base dirs, keeps the rest", () => {
    expect(env.SOMA_HOME).toBeUndefined();
    expect(env.GROVE_AGENT_ID).toBeUndefined();
    expect(env.CORTEX_CHANNEL).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/501");
    expect(env.PATH).toBe("/usr/bin");
    expect(env[HOST_HOME_OPT_IN_ENV]).toBe("1");
  });
});

describe("checkTestHome", () => {
  test("accepts the runner's temp home", () => {
    expect(checkTestHome({ HOME: "/tmp/h", [HERMETIC_HOME_ENV]: "/tmp/h" }, "/tmp/h").ok).toBe(true);
  });

  test("refuses a bare bun test on the real home and names the command to run", () => {
    const verdict = checkTestHome({ HOME: "/Users/someone" }, "/Users/someone");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("bun run test");
  });

  test("refuses when HOME was rewritten after start, since os.homedir() keeps the real one", () => {
    expect(checkTestHome({ HOME: "/tmp/h", [HERMETIC_HOME_ENV]: "/tmp/h" }, "/Users/someone").ok).toBe(false);
  });

  test("accepts an explicit host-home opt-in", () => {
    expect(checkTestHome({ [HOST_HOME_OPT_IN_ENV]: "1" }, "/Users/someone").ok).toBe(true);
  });

  test("this process runs under the runner's temp home", () => {
    expect(checkTestHome(process.env, homedir()).ok).toBe(true);
  });
});

describe("checkTestTmp", () => {
  test("accepts the run's temp dir", () => {
    expect(checkTestTmp({ TMPDIR: "/r/tmp", [RUN_TMP_ENV]: "/r/tmp" }, "/r/tmp").ok).toBe(true);
  });

  test("refuses the host temp dir and names the command to run", () => {
    const verdict = checkTestTmp({ TMPDIR: "/var/folders/x/T/" }, "/var/folders/x/T");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("bun run test");
  });

  test("refuses when os.tmpdir() disagrees with the marker", () => {
    expect(checkTestTmp({ TMPDIR: "/r/tmp", [RUN_TMP_ENV]: "/r/tmp" }, "/var/folders/x/T").ok).toBe(false);
  });

  test("this process writes temp files inside the run's temp dir", () => {
    expect(checkTestTmp(process.env, tmpdir()).ok).toBe(true);
  });
});

describe("abandonedRunRoots", () => {
  const live = new Set([100]);
  const isAlive = (pid: number) => live.has(pid);

  test("returns roots whose runner is gone and keeps live ones", () => {
    expect(abandonedRunRoots([`${runRootName(100)}aB3dE9`, `${runRootName(200)}Zz09yy`], isAlive)).toEqual([
      `${runRootName(200)}Zz09yy`,
    ]);
  });

  test("ignores names that are not run roots", () => {
    expect(abandonedRunRoots(["ctr-notapid-aB3dE9", "cortex-test-home-aB3dE9", "ctr-200-short"], isAlive)).toEqual([]);
  });
});

describe("bunSpawnSyncHangWarning", () => {
  test("warns on a Bun with the spawnSync hang and names the upstream fix and the remedy", () => {
    const warning = bunSpawnSyncHangWarning("1.4.2");
    expect(warning).toContain("oven-sh/bun#44581");
    expect(warning).toContain("bun upgrade");
  });

  test("stays quiet from the first fixed Bun on", () => {
    expect(bunSpawnSyncHangWarning("1.4.3")).toBeNull();
    expect(bunSpawnSyncHangWarning("1.5.0")).toBeNull();
  });
});

describe("the runner's per-test limit", () => {
  const BUN_DEFAULT_TIMEOUT_MS = 5000;
  const SLOW_TEST_MS = BUN_DEFAULT_TIMEOUT_MS + 500;

  test.each([[[]], [["--parallel"]]] as string[][][])(
    "a test slower than Bun's default still passes with runner args %j",
    async (args) => {
      expect(SLOW_TEST_MS).toBeLessThan(TEST_TIMEOUT_MS);
      const dir = mkdtempSync(join(tmpdir(), "runner-timeout-"));
      try {
        const slow = join(dir, "slow.test.ts");
        writeFileSync(slow, `import { test } from "bun:test";\ntest("slow", () => Bun.sleep(${SLOW_TEST_MS}));\n`);
        const run = Bun.spawn(["bun", "scripts/test.ts", ...args, slow], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
        expect({ exitCode, output: `${stdout}${stderr}` }).toMatchObject({ exitCode: 0, output: expect.stringContaining("1 pass") });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
