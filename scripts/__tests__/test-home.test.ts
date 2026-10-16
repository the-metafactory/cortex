import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { checkTestHome, HERMETIC_HOME_ENV, hermeticTestEnv, HOST_HOME_OPT_IN_ENV } from "../lib/test-home";

describe("hermeticTestEnv", () => {
  const host = {
    HOME: "/Users/someone",
    PATH: "/usr/bin",
    XDG_CONFIG_HOME: "/Users/someone/.config",
    XDG_RUNTIME_DIR: "/run/user/501",
    GROVE_AGENT_ID: "ivy",
    CORTEX_CHANNEL: "jc",
    CORTEX_TEST_HOST_HOME: "1",
  };
  const env = hermeticTestEnv(host, "/tmp/home-x");

  test("points HOME and the marker at the temp home", () => {
    expect(env.HOME).toBe("/tmp/home-x");
    expect(env[HERMETIC_HOME_ENV]).toBe("/tmp/home-x");
  });

  test("drops host instrumentation and XDG base dirs, keeps the rest", () => {
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
