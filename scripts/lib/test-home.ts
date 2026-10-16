export const HERMETIC_HOME_ENV = "CORTEX_TEST_HOME";
export const HOST_HOME_OPT_IN_ENV = "CORTEX_TEST_HOST_HOME";

/** Linked into the temp home so tests that spawn a real `claude` stay logged in: the macOS keychain, or Linux's credentials file. */
export const CLAUDE_CREDENTIAL_PATHS = ["Library/Keychains", ".claude/.credentials.json"];

const HOST_INSTRUMENTATION = /^(CORTEX|GROVE)_/;
const XDG_BASE_DIRS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

export function hermeticTestEnv(host: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (value === undefined || XDG_BASE_DIRS.includes(key)) continue;
    if (HOST_INSTRUMENTATION.test(key) && key !== HOST_HOME_OPT_IN_ENV) continue;
    env[key] = value;
  }
  env.HOME = home;
  env[HERMETIC_HOME_ENV] = home;
  return env;
}

export type HomeVerdict = { ok: true } | { ok: false; reason: string };

export function checkTestHome(env: NodeJS.ProcessEnv, homedir: string): HomeVerdict {
  if (env[HOST_HOME_OPT_IN_ENV] === "1") return { ok: true };
  const hermetic = env[HERMETIC_HOME_ENV];
  if (hermetic && env.HOME === hermetic && homedir === hermetic) return { ok: true };
  return {
    ok: false,
    reason:
      `bun test is running against the real home directory (${homedir}), so tests read this machine's ` +
      "arc installs, ~/.config and CORTEX_*/GROVE_* env, and pass or fail by host (cortex#2253). " +
      "Run `bun run test [args]` instead: scripts/test.ts starts bun test under a temp HOME. " +
      `A suite that must touch the real home (systemd-e2e) sets ${HOST_HOME_OPT_IN_ENV}=1.`,
  };
}
