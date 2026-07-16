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
import { buildSessionEnv, resolveBashGuardEnv } from "../cc-session";
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

describe("resolveAgentEnv — broadened reserved-prefix deny (cortex#2133)", () => {
  test("a CORTEX_BASH_GUARD key is DROPPED at runtime (MAJOR-1 key-layer close)", () => {
    const out = resolveAgentEnv(
      {
        CORTEX_BASH_GUARD: '{"rules":[{"pattern":".*"}]}',
        GOOGLE_APPLICATION_CREDENTIALS: "/x/sa.json",
      },
      {},
    );
    expect(out.CORTEX_BASH_GUARD).toBeUndefined();
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBe("/x/sa.json");
  });

  test("ANTHROPIC_* keys are DROPPED at runtime (auth / endpoint redirect)", () => {
    const out = resolveAgentEnv(
      {
        ANTHROPIC_BASE_URL: "https://evil.example",
        ANTHROPIC_API_KEY: "sk-evil",
        ANTHROPIC_AUTH_TOKEN: "t",
      },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("GROVE_* legacy-alias control keys are DROPPED at runtime", () => {
    const out = resolveAgentEnv(
      { GROVE_CHANNEL: "spoofed", GROVE_OPERATOR: "x" },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("other CORTEX_* control keys (grants/identity) are DROPPED at runtime", () => {
    const out = resolveAgentEnv(
      {
        CORTEX_SKILL_GRANTS: "[]",
        CORTEX_MCP_GRANTS: "[]",
        CORTEX_CHANNEL: "spoofed",
      },
      {},
    );
    expect(Object.keys(out)).toHaveLength(0);
  });
});

describe("resolveAgentEnv — env: REF SOURCE deny (MINOR-3)", () => {
  test("a benign key referencing env:CLAUDE_CODE_OAUTH_TOKEN is DROPPED (no exfil)", () => {
    // The exfil vector: a clean destination name that re-surfaces a guarded
    // daemon var's VALUE. Even with the secret present in the daemon env, the
    // ref must be refused because its SOURCE name is reserved-prefix.
    const out = resolveAgentEnv(
      { GDRIVE_TOKEN: "env:CLAUDE_CODE_OAUTH_TOKEN" },
      { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth-secret" },
    );
    expect(out.GDRIVE_TOKEN).toBeUndefined();
    expect(Object.values(out)).not.toContain("sk-oauth-secret");
  });

  test("refs to ANTHROPIC_* / CORTEX_* sources are DROPPED even when resolvable", () => {
    const out = resolveAgentEnv(
      {
        A: "env:ANTHROPIC_API_KEY",
        B: "env:CORTEX_BASH_GUARD",
      },
      { ANTHROPIC_API_KEY: "sk-x", CORTEX_BASH_GUARD: '{"disabled":true}' },
    );
    expect(Object.keys(out)).toHaveLength(0);
  });

  test("a ref to a NON-reserved source still resolves (no over-blocking)", () => {
    const out = resolveAgentEnv(
      { GWS_TOKEN: "env:MANDA_GWS_TOKEN" },
      { MANDA_GWS_TOKEN: "ok" },
    );
    expect(out.GWS_TOKEN).toBe("ok");
  });
});

describe("resolveAgentEnv — runtime key-grammar re-check (MINOR-4)", () => {
  test("a leading-space ' CLAUDE_X' key is DROPPED by the pattern re-check", () => {
    // The leading space would dodge the prefix check; the ASCII grammar catches
    // it first. Proves a non-schema caller can't slip a mangled key past runtime.
    const out = resolveAgentEnv(
      { " CLAUDE_X": "/tmp/x", "GOOD_KEY": "ok" },
      {},
    );
    expect(out[" CLAUDE_X"]).toBeUndefined();
    expect(out.GOOD_KEY).toBe("ok");
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
  //   (1) the key layer — resolveAgentEnv drops the reserved-prefix key, and
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
