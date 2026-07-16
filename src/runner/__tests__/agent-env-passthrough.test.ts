/**
 * cortex#2133 (epic #2164, TRUST-PATH) — per-agent env passthrough RUNTIME tests.
 *
 * Covers the four ACs the slice must prove:
 *   (a) a declared NON-SECRET env var reaches the session env,
 *   (b) a `env:NAME` SecretRef value resolves from the daemon env,
 *   (c) a CLAUDE_* key is DROPPED at the runtime layer (defence-in-depth over
 *       the schema's load-time reject — the airtight security assertion),
 *   (d) an agent with NO env is byte-unchanged (no regression).
 *
 * `resolveAgentEnv` is the pure, env-injectable unit; the composition tests then
 * feed its output through the exported `buildSessionEnv` exactly as `start()`
 * does, proving the vars actually reach the child session env AND that cortex's
 * own instrumentation + config-home vars always WIN over a declared passthrough.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { resolveAgentEnv } from "../session-settings";
import { buildSessionEnv } from "../cc-session";
import { setActiveSubstrates } from "../../common/substrates/config-home";

describe("resolveAgentEnv — resolution + CLAUDE_* runtime deny", () => {
  test("(a) a declared non-secret literal passes through verbatim", () => {
    const out = resolveAgentEnv(
      { GOOGLE_APPLICATION_CREDENTIALS: "/Users/andreas/.config/gws/sa.json" },
      {},
    );
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      "/Users/andreas/.config/gws/sa.json",
    );
  });

  test("(b) an `env:NAME` reference resolves from the (injected) daemon env", () => {
    const out = resolveAgentEnv(
      { GWS_TOKEN: "env:MANDA_GWS_TOKEN" },
      { MANDA_GWS_TOKEN: "resolved-secret-value" },
    );
    expect(out.GWS_TOKEN).toBe("resolved-secret-value");
  });

  test("(b′) an unresolved reference (unset/empty daemon var) is SKIPPED, not thrown", () => {
    // Unset
    expect(resolveAgentEnv({ X: "env:NOPE" }, {})).toEqual({});
    // Whitespace-only is treated as empty
    expect(resolveAgentEnv({ X: "env:BLANK" }, { BLANK: "   " })).toEqual({});
  });

  test("(c) a CLAUDE_* key is DROPPED at runtime even if it reaches this fn", () => {
    // Simulates a schema bypass / regression: the runtime layer must still
    // refuse to set a CLAUDE_* var. This is the airtight security property.
    const out = resolveAgentEnv(
      {
        CLAUDE_CONFIG_DIR: "/tmp/evil-home",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-evil",
        GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json",
      },
      {},
    );
    expect(out.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // The legitimate non-CLAUDE var still comes through.
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/x/sa.json");
  });

  test("(c′) the CLAUDE_* runtime deny is case-insensitive", () => {
    const out = resolveAgentEnv(
      { claude_config_dir: "/tmp/x", Claude_Code_Oauth_Token: "y" },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("(d) undefined agentEnv resolves to an empty map (no passthrough)", () => {
    expect(resolveAgentEnv(undefined)).toEqual({});
    expect(resolveAgentEnv({})).toEqual({});
  });
});

describe("agent env reaches the session env via buildSessionEnv (start() composition)", () => {
  afterEach(() => setActiveSubstrates(undefined));

  // Mirror start(): env = buildSessionEnv({ ...baseEnv, ...resolveAgentEnv(...) }, opts)
  const compose = (
    baseEnv: Record<string, string>,
    agentEnv: Record<string, string> | undefined,
    opts: Parameters<typeof buildSessionEnv>[1],
    daemonEnv: Record<string, string | undefined> = {},
  ) => buildSessionEnv({ ...baseEnv, ...resolveAgentEnv(agentEnv, daemonEnv) }, opts);

  test("(a) a declared literal lands on the composed session env", () => {
    const env = compose(
      { PATH: "/usr/bin" },
      { GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json" },
      { channel: "manda" },
    );
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/x/sa.json");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.CORTEX_CHANNEL).toBe("manda");
  });

  test("(d) no agentEnv ⇒ session env byte-identical to the no-passthrough build", () => {
    const opts = { channel: "manda", agentId: "luna" } as const;
    const withNone = compose({ PATH: "/usr/bin" }, undefined, opts);
    const baseline = buildSessionEnv({ PATH: "/usr/bin" }, opts);
    expect(withNone).toEqual(baseline);
  });

  test("cortex's own CORTEX_* pipeline var WINS over a same-named passthrough", () => {
    // A declared var may not shadow cortex's instrumentation identity.
    const env = compose(
      { PATH: "/usr/bin" },
      { CORTEX_CHANNEL: "spoofed" },
      { channel: "authoritative" },
    );
    expect(env.CORTEX_CHANNEL).toBe("authoritative");
  });

  test("cortex's config-home (CLAUDE_CONFIG_DIR) is untouched by the passthrough", () => {
    // The passthrough can't set CLAUDE_* at all (dropped), and the config-home
    // export layered by buildSessionEnv is the only thing that sets it.
    const env = compose(
      { PATH: "/usr/bin" },
      { CLAUDE_CONFIG_DIR: "/tmp/evil-home" },
      { configHomeEnv: { name: "CLAUDE_CONFIG_DIR", value: "/real/home" } },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/real/home");
  });
});
