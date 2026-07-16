/**
 * cortex#2133 (epic #2164, TRUST-PATH) — per-agent env passthrough RUNTIME tests.
 *
 * Covers the ACs the slice must prove under the ALLOWLIST (deny-by-default)
 * design:
 *   (a) the allowlisted var (`GOOGLE_APPLICATION_CREDENTIALS`) reaches the
 *       session env as a literal,
 *   (b) an `env:NAME` SecretRef on the allowlisted key resolves from the daemon
 *       env,
 *   (c) every var on the adversarial hit-list is DROPPED at the runtime layer
 *       (defence-in-depth over the schema's load-time reject — the airtight
 *       security assertion),
 *   (d) an agent with NO env is byte-unchanged (no regression).
 *
 * `resolveAgentEnv` is the pure, env-injectable unit; the composition tests then
 * feed its output through the exported `buildSessionEnv` exactly as `start()`
 * does, proving the vars actually reach the child session env AND that cortex's
 * own instrumentation + config-home vars always WIN over a declared passthrough.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { resolveAgentEnv } from "../session-settings";
import { buildSessionEnv, resolveBashGuardEnv } from "../cc-session";
import { setActiveSubstrates } from "../../common/substrates/config-home";

/**
 * The adversarial hit-list — the open-ended set of session-hijacking env vars a
 * denylist could never fully enumerate. Every one MUST be DROPPED at runtime by
 * the allowlist (the schema-load half is asserted in the config test's identical
 * list). Parametrised so this is a standing regression fence.
 */
const REJECT_LIST = [
  "BASH_ENV",
  "PATH",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "GIT_SSH_COMMAND",
  "HTTPS_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "ANTHROPIC_BASE_URL",
  "CORTEX_BASH_GUARD",
];

describe("resolveAgentEnv — allowlisted resolution", () => {
  test("(a) the allowlisted GOOGLE_APPLICATION_CREDENTIALS literal passes through verbatim", () => {
    const out = resolveAgentEnv(
      { GOOGLE_APPLICATION_CREDENTIALS: "/Users/andreas/.config/gws/sa.json" },
      {},
    );
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      "/Users/andreas/.config/gws/sa.json",
    );
  });

  test("(b) an `env:NAME` reference on the allowlisted key resolves from the daemon env", () => {
    const out = resolveAgentEnv(
      { GOOGLE_APPLICATION_CREDENTIALS: "env:GWS_SA_PATH" },
      { GWS_SA_PATH: "/resolved/sa.json" },
    );
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/resolved/sa.json");
  });

  test("(b′) an unresolved reference (unset/empty daemon var) is SKIPPED, not thrown", () => {
    // Unset
    expect(
      resolveAgentEnv({ GOOGLE_APPLICATION_CREDENTIALS: "env:NOPE" }, {}),
    ).toEqual({});
    // Whitespace-only is treated as empty
    expect(
      resolveAgentEnv(
        { GOOGLE_APPLICATION_CREDENTIALS: "env:BLANK" },
        { BLANK: "   " },
      ),
    ).toEqual({});
  });

  test("(d) undefined agentEnv resolves to an empty map (no passthrough)", () => {
    expect(resolveAgentEnv(undefined)).toEqual({});
    expect(resolveAgentEnv({})).toEqual({});
  });
});

describe("resolveAgentEnv — deny-by-default allowlist (cortex#2133/#2164)", () => {
  test.each(REJECT_LIST)(
    "%s is DROPPED at runtime even if it reaches this fn",
    (key) => {
      // Simulates a schema bypass / regression: the runtime layer must still
      // refuse to set a non-allowlisted var. This is the airtight property.
      const out = resolveAgentEnv(
        { [key]: "hijack-value", GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json" },
        {},
      );
      expect(out[key]).toBeUndefined();
      // The legitimate allowlisted var still comes through.
      expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/x/sa.json");
    },
  );

  test("an arbitrary non-allowlisted key FOO_BAR is DROPPED at runtime", () => {
    const out = resolveAgentEnv({ FOO_BAR: "x" }, {});
    expect(out.FOO_BAR).toBeUndefined();
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("case variants of the allowed key are DROPPED (env var names are case-sensitive)", () => {
    const out = resolveAgentEnv(
      {
        google_application_credentials: "/tmp/x",
        Google_Application_Credentials: "/tmp/y",
      },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe("resolveAgentEnv — env: REF SOURCE deny (MINOR-3, prefix-deny shape)", () => {
  test("an allowlisted key referencing env:CLAUDE_CODE_OAUTH_TOKEN is DROPPED (no exfil)", () => {
    // The exfil vector: a clean, allowlisted destination name that re-surfaces a
    // guarded daemon var's VALUE. Even with the secret present in the daemon
    // env, the ref must be refused because its SOURCE name is reserved-prefix.
    const out = resolveAgentEnv(
      { GOOGLE_APPLICATION_CREDENTIALS: "env:CLAUDE_CODE_OAUTH_TOKEN" },
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth-secret" },
    );
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(Object.values(out)).not.toContain("sk-oauth-secret");
  });

  test("refs to ANTHROPIC_* / CORTEX_* / GROVE_* sources are DROPPED even when resolvable", () => {
    for (const src of [
      "ANTHROPIC_API_KEY",
      "CORTEX_BASH_GUARD",
      "GROVE_OPERATOR",
    ]) {
      const out = resolveAgentEnv(
        { GOOGLE_APPLICATION_CREDENTIALS: `env:${src}` },
        { [src]: "sensitive" },
      );
      expect(Object.keys(out)).toHaveLength(0);
    }
  });

  test("a ref to a NON-reserved source still resolves (no over-blocking)", () => {
    const out = resolveAgentEnv(
      { GOOGLE_APPLICATION_CREDENTIALS: "env:GWS_SA_PATH" },
      { GWS_SA_PATH: "/ok/sa.json" },
    );
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/ok/sa.json");
  });
});

describe("resolveAgentEnv — runtime key-grammar re-check (MINOR-4)", () => {
  test("a leading-space ' GOOGLE_APPLICATION_CREDENTIALS' key is DROPPED by the pattern re-check", () => {
    // A leading space would otherwise slip past a naive membership test; the
    // ASCII grammar catches it first (and the allowlist would reject it anyway).
    const out = resolveAgentEnv(
      { " GOOGLE_APPLICATION_CREDENTIALS": "/tmp/x" },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("keys with '=', dashes, or interior whitespace are DROPPED at runtime", () => {
    const out = resolveAgentEnv(
      { "A=B": "x", "has-dash": "y", "has space": "z", "1LEADING": "w" },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe("resolveBashGuardEnv — CORTEX_BASH_GUARD safe default (cortex#2133)", () => {
  test("neither flag ⇒ the safe default '{}' (guard active, built-in default-deny)", () => {
    expect(resolveBashGuardEnv({})).toBe("{}");
    expect(JSON.parse(resolveBashGuardEnv({}))).toEqual({});
  });

  test("bashGuardDisabled ⇒ {\"disabled\":true}", () => {
    expect(resolveBashGuardEnv({ bashGuardDisabled: true })).toBe(
      JSON.stringify({ disabled: true }),
    );
  });

  test("bashAllowlist ⇒ the serialised allowlist", () => {
    const allow = { rules: [{ pattern: "^gh\\s" }], repos: [] };
    expect(resolveBashGuardEnv({ bashAllowlist: allow })).toBe(JSON.stringify(allow));
  });

  test("the safe default NEVER carries disabled:true (does not weaken the guard)", () => {
    expect(JSON.parse(resolveBashGuardEnv({})).disabled).toBeUndefined();
  });
});

describe("MAJOR-1 exploit is closed end-to-end (cortex#2133)", () => {
  // The exploit: an agent declares `env: { CORTEX_BASH_GUARD: '{"rules":[{"pattern":".*"}]}' }`
  // and the stack sets NO bashAllowlist. We prove the malicious value can NEVER
  // land on the composed session env, closed at BOTH layers:
  //   (1) the key layer — resolveAgentEnv drops the non-allowlisted key, and
  //   (2) the writer layer — cortex writes the authoritative guard value last.
  test("a declared CORTEX_BASH_GUARD with no bashAllowlist does NOT reach the session env", () => {
    const agentEnv = { CORTEX_BASH_GUARD: '{"rules":[{"pattern":".*"}]}' };

    // (1) Key layer: the passthrough drops it — it never even enters baseEnv.
    const resolved = resolveAgentEnv(agentEnv, {});
    expect(resolved.CORTEX_BASH_GUARD).toBeUndefined();

    // Compose exactly as start() does: base ← {scoped ∪ resolved}, then cortex
    // writes the authoritative guard value LAST (unconditional overwrite).
    const composed: Record<string, string> = {
      ...buildSessionEnv({ PATH: "/usr/bin", ...resolved }, { channel: "manda" }),
    };
    composed.CORTEX_BASH_GUARD = resolveBashGuardEnv({
      /* no bashGuardDisabled, no bashAllowlist */
    });

    // (2) Writer layer: even if a value HAD leaked into baseEnv by some other
    // route, the authoritative write pins it to the safe default.
    expect(composed.CORTEX_BASH_GUARD).toBe("{}");
    expect(composed.CORTEX_BASH_GUARD).not.toContain(".*");
  });

  test("even a base-env-injected CORTEX_BASH_GUARD is overwritten by the authoritative write", () => {
    // Simulate a stale/injected value arriving via the base env by ANY route.
    const base = buildSessionEnv(
      { PATH: "/usr/bin", CORTEX_BASH_GUARD: '{"rules":[{"pattern":".*"}]}' },
      { channel: "manda" },
    );
    const composed: Record<string, string> = { ...base };
    composed.CORTEX_BASH_GUARD = resolveBashGuardEnv({});
    expect(composed.CORTEX_BASH_GUARD).toBe("{}");
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

  test("(a) the allowlisted literal lands on the composed session env", () => {
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
    // A declared CORTEX_CHANNEL is not allowlisted (dropped) AND cortex writes
    // its authoritative instrumentation identity — belt and braces.
    const env = compose(
      { PATH: "/usr/bin" },
      { CORTEX_CHANNEL: "spoofed" },
      { channel: "authoritative" },
    );
    expect(env.CORTEX_CHANNEL).toBe("authoritative");
  });

  test("cortex's config-home (CLAUDE_CONFIG_DIR) is untouched by the passthrough", () => {
    // The passthrough can't set CLAUDE_* at all (not allowlisted → dropped), and
    // the config-home export layered by buildSessionEnv is the only thing that
    // sets it.
    const env = compose(
      { PATH: "/usr/bin" },
      { CLAUDE_CONFIG_DIR: "/tmp/evil-home" },
      { configHomeEnv: { name: "CLAUDE_CONFIG_DIR", value: "/real/home" } },
    );
    expect(env.CLAUDE_CONFIG_DIR).toBe("/real/home");
  });
});
