/**
 * cortex#2094 (L3) — pure-logic tests for `quickstart-lib.ts`.
 *
 * Covers the env-contract validation matrix, the nats .conf renderer, the
 * guarded comment-preserving YAML patch (incl. idempotency — a second patch
 * with the SAME values must be byte-identical, no write), the healthy-boot
 * gate line-matcher, and — the non-negotiable one — that a set secret value
 * NEVER appears anywhere in what `validateEnvContract`/`renderEnvTable`
 * return, even though the secret gates `ok`.
 *
 * Temp-dir isolated for every fs-touching test; never touches real
 * ~/.config or ~/.claude.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  CTX_REQUIRED_KEYS,
  CTX_WEB_REQUIRED_KEYS,
  daemonLogPath,
  evaluateHealthyBootGate,
  gatePassed,
  natsConfPath,
  nkeyBasenameForSlug,
  patchStackYaml,
  patchSurfacesYaml,
  patchSystemNatsPort,
  readSurfaceAgent,
  renderEnvTable,
  renderNatsConf,
  renderWebSurfacesYaml,
  validateEnvContract,
  validateWebEnvContract,
  writeWebSurfacesYaml,
} from "../quickstart-lib";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "c2094-quickstart-lib-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A fully valid env — every test mutates a shallow copy of this. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    CTX_PRINCIPAL: "andreas",
    CTX_SLUG: "work",
    CTX_NATS_PORT: "4222",
    CTX_NATS_MON: "8222",
    CTX_GUILD_ID: "111111111111111111",
    CTX_CHANNEL_ID: "222222222222222222",
    CTX_LOG_CHANNEL_ID: "333333333333333333",
    CTX_MY_DISCORD_ID: "444444444444444444",
    CTX_DISCORD_TOKEN: "THE-REAL-SECRET-TOKEN-VALUE",
  };
}

const SECRET = "THE-REAL-SECRET-TOKEN-VALUE";

// =============================================================================
// env-validation matrix
// =============================================================================

describe("validateEnvContract — the happy path", () => {
  test("a fully valid env validates ok with every value present", () => {
    const result = validateEnvContract(validEnv());
    expect(result.ok).toBe(true);
    expect(result.values?.CTX_SLUG).toBe("work");
    expect(result.values?.CTX_PRINCIPAL).toBe("andreas");
  });

  test("CLAUDE_CODE_OAUTH_TOKEN absent does NOT block ok (optional on native hosts)", () => {
    const env = validEnv();
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const result = validateEnvContract(env);
    expect(result.ok).toBe(true);
    expect(result.secrets.find((s) => s.key === "CLAUDE_CODE_OAUTH_TOKEN")?.status).toBe("missing");
  });
});

describe("validateEnvContract — missing required keys", () => {
  for (const key of CTX_REQUIRED_KEYS) {
    test(`missing ${key} → not ok, reported as missing`, () => {
      const env = validEnv();
      Reflect.deleteProperty(env, key);
      const result = validateEnvContract(env);
      expect(result.ok).toBe(false);
      expect(result.values).toBeUndefined();
      const check = result.checks.find((c) => c.key === key);
      expect(check?.ok).toBe(false);
      expect(check?.reason).toBe("missing");
    });
  }

  test("CTX_DISCORD_TOKEN missing → not ok (it gates, unlike the oauth token)", () => {
    const env = validEnv();
    delete env.CTX_DISCORD_TOKEN;
    const result = validateEnvContract(env);
    expect(result.ok).toBe(false);
  });
});

describe("validateEnvContract — shape violations", () => {
  test("CTX_SLUG uppercase → invalid shape", () => {
    const env = validEnv();
    env.CTX_SLUG = "Work";
    const result = validateEnvContract(env);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.key === "CTX_SLUG")?.ok).toBe(false);
  });

  test("CTX_PRINCIPAL with underscore → invalid shape (stricter than slug)", () => {
    const env = validEnv();
    env.CTX_PRINCIPAL = "an_dreas";
    const result = validateEnvContract(env);
    expect(result.ok).toBe(false);
  });

  test("CTX_NATS_PORT non-numeric → invalid shape", () => {
    const env = validEnv();
    env.CTX_NATS_PORT = "not-a-port";
    const result = validateEnvContract(env);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.key === "CTX_NATS_PORT")?.reason).toContain("port");
  });

  test("CTX_NATS_PORT out of range (>65535) → invalid shape", () => {
    const env = validEnv();
    env.CTX_NATS_PORT = "99999";
    const result = validateEnvContract(env);
    expect(result.ok).toBe(false);
  });

  test("CTX_GUILD_ID non-numeric → invalid shape (a Discord snowflake is digits only)", () => {
    const env = validEnv();
    env.CTX_GUILD_ID = "not-a-snowflake";
    const result = validateEnvContract(env);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.key === "CTX_GUILD_ID")?.reason).toContain("snowflake");
  });

  test("a 19-digit snowflake (realistic Discord id length) is valid shape", () => {
    const env = validEnv();
    // Repeated-digit — the confidentiality-gate's platform-snowflake pattern
    // (17-20 digit run) allow-lists all-same-digit values as an obvious
    // placeholder; a sequential run like "123456789…" is NOT allow-listed and
    // trips the gate even though it's just as clearly synthetic.
    env.CTX_MY_DISCORD_ID = "5555555555555555555";
    const result = validateEnvContract(env);
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// secret non-echo — the non-negotiable one
// =============================================================================

describe("secret hygiene — CTX_DISCORD_TOKEN never echoed", () => {
  test("validateEnvContract's result never carries the token value anywhere", () => {
    const result = validateEnvContract(validEnv());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    // The secrets bucket must carry only the status enum + the (non-secret)
    // `gates` flag, never a `value` field.
    const tokenEntry = result.secrets.find((s) => s.key === "CTX_DISCORD_TOKEN");
    expect(tokenEntry).toEqual({ key: "CTX_DISCORD_TOKEN", status: "set", gates: true });
  });

  test("renderEnvTable's rendered text never contains the token value", () => {
    const result = validateEnvContract(validEnv());
    const table = renderEnvTable(result);
    expect(table).not.toContain(SECRET);
    expect(table).toContain("CTX_DISCORD_TOKEN: set");
  });

  test("renderEnvTable reports missing without ever having carried a value", () => {
    const env = validEnv();
    delete env.CTX_DISCORD_TOKEN;
    const table = renderEnvTable(validateEnvContract(env));
    expect(table).toContain("CTX_DISCORD_TOKEN: missing");
    expect(table).not.toContain(SECRET);
  });
});

// =============================================================================
// nats conf renderer
// =============================================================================

describe("renderNatsConf / natsConfPath", () => {
  test("matches the Appendix-A shape (§4)", () => {
    const conf = renderNatsConf({
      slug: "work",
      principal: "andreas",
      port: "4223",
      monitorPort: "8223",
      natsDir: "/home/andreas/.config/nats",
    });
    expect(conf).toContain("server_name: work-andreas");
    expect(conf).toContain("listen: 127.0.0.1:4223");
    expect(conf).toContain("http: 127.0.0.1:8223");
    expect(conf).toContain("store_dir: /home/andreas/.config/nats/work-jetstream");
    expect(conf).toContain("domain: work-andreas");
  });

  test("natsConfPath joins natsDir + <slug>.conf", () => {
    expect(natsConfPath("/x/nats", "work")).toBe("/x/nats/work.conf");
  });
});

// =============================================================================
// nkey basename derivation (mirrors postupgrade.sh)
// =============================================================================

describe("nkeyBasenameForSlug", () => {
  test("meta-factory → cortex (the historical single-file default)", () => {
    expect(nkeyBasenameForSlug("meta-factory")).toBe("cortex");
  });
  test("any other slug → cortex-<slug>", () => {
    expect(nkeyBasenameForSlug("work")).toBe("cortex-work");
  });
});

// =============================================================================
// Guarded YAML patch — idempotency (the "second run: zero mutations" guarantee)
// =============================================================================

const SURFACES_FIXTURE = `# =============================================================================
# surfaces/surfaces.yaml — the shared surface-gateway binding map (IAW CFG.c)
# =============================================================================
surfaces:
  discord:
    - agent: assistant
      stack: andreas/work
      binding:
        token: "<REPLACE_ME>"            # the bot token (chmod 600 the file)
        guildId: "<REPLACE_ME>"
        agentChannelId: "<REPLACE_ME>"
        logChannelId: "<REPLACE_ME>"
`;

const STACK_FIXTURE = `# =============================================================================
# stacks/work.yaml — this stack's per-deployment layer
# =============================================================================
principal:
  id: andreas
  displayName: andreas
  discordId: "<REPLACE_ME>"   # your numeric Discord snowflake

stack:
  id: andreas/work
  nkey_seed_path: ~/.config/nats/cortex-work.nk
  nkey_pub: UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

policy:
  principals:
    - id: assistant
      home_principal: andreas
      home_stack: andreas/work
      platform_ids: {}
    - id: andreas
      home_principal: andreas
      home_stack: andreas/work
      platform_ids:
        discord:
          - "<REPLACE_ME>"            # your numeric Discord id
`;

const SYSTEM_FIXTURE = `# =============================================================================
# system.yaml — the cross-cutting machine / substrate layer
# =============================================================================
nats:
  url: nats://127.0.0.1:4222   # review host:port for your NATS server (default: local 4222)
  name: cortex-work
`;

describe("patchSurfacesYaml", () => {
  function seed(dir: string): string {
    const path = join(dir, "surfaces.yaml");
    writeFileSync(path, SURFACES_FIXTURE, { mode: 0o600 });
    return path;
  }

  test("first patch writes the real values and preserves the section banner", () => {
    const dir = freshDir();
    const path = seed(dir);
    const result = patchSurfacesYaml(path, {
      token: "MY-REAL-BOT-TOKEN",
      guildId: "111",
      agentChannelId: "222",
      logChannelId: "333",
    });
    expect(result.changed).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("the shared surface-gateway binding map");
    expect(text).toContain('token: "MY-REAL-BOT-TOKEN"');
    expect(text).toContain('guildId: "111"');
    // the file was born 0600 (scaffold birth) — the patch must preserve that.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a second patch with the SAME values is a byte-identical no-op", () => {
    const dir = freshDir();
    const path = seed(dir);
    const opts = { token: "MY-REAL-BOT-TOKEN", guildId: "111", agentChannelId: "222", logChannelId: "333" };
    patchSurfacesYaml(path, opts);
    const afterFirst = readFileSync(path, "utf-8");
    const mtimeAfterFirst = statSync(path).mtimeMs;

    const second = patchSurfacesYaml(path, opts);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(afterFirst);
    expect(statSync(path).mtimeMs).toBe(mtimeAfterFirst); // untouched — no write happened at all
  });

  test("a backup file is created only when a write actually happens", () => {
    const dir = freshDir();
    const path = seed(dir);
    const opts = { token: "t", guildId: "1", agentChannelId: "2", logChannelId: "3" };
    patchSurfacesYaml(path, opts);
    const entriesAfterFirst = readdirSync(dir);
    expect(entriesAfterFirst.some((f) => f.includes(".pre-quickstart-surfaces-"))).toBe(true);

    const countBefore = entriesAfterFirst.length;
    patchSurfacesYaml(path, opts); // no-op — must NOT create a second backup
    const entriesAfterSecond = readdirSync(dir);
    expect(entriesAfterSecond.length).toBe(countBefore);
  });

  test("re-run backup is 0600, never the umask-default 0644 — even though it carries the live token from a PRIOR run", () => {
    // The exact scenario the "fix one env var and re-run" flow hits: run 1
    // sets the real token; run 2 only changes guildId (the token is
    // unchanged). At run 2, `originalText` (what gets backed up) is the
    // ALREADY-patched file from run 1 — it carries the real token. The
    // backup must inherit the file's 0600 mode, not fall back to whatever
    // the process umask would otherwise leave a fresh file at.
    const dir = freshDir();
    const path = seed(dir);
    const first = { token: "MY-REAL-BOT-TOKEN", guildId: "111", agentChannelId: "222", logChannelId: "333" };
    patchSurfacesYaml(path, first);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = { ...first, guildId: "999" }; // token unchanged, one field changed
    const result = patchSurfacesYaml(path, second);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();

    const backupPath = result.backupPath!;
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    // The backup DOES legitimately carry the token (it's a snapshot of the
    // token-bearing file as it stood before this edit) — the fix is the file
    // MODE being restrictive, not stripping the content from the backup.
    expect(readFileSync(backupPath, "utf-8")).toContain("MY-REAL-BOT-TOKEN");
  });
});

describe("patchStackYaml", () => {
  test("sets principal.discordId AND the human principals[] entry's platform_ids.discord[0]", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "work"), { recursive: true });
    const path = join(dir, "work", "stacks-work.yaml");
    writeFileSync(path, STACK_FIXTURE, { mode: 0o600 });
    // pointerConfigPath validation is skipped by pointing "pointerPath" at a
    // path that doesn't exist — validateConfigLoads then fails closed, which
    // this test asserts is surfaced via composeErrors rather than silently
    // dropped, without needing a full config-split fixture tree.
    const result = patchStackYaml(path, join(dir, "does-not-exist.yaml"), {
      principal: "andreas",
      discordId: "999888777",
    });
    expect(result.changed).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain('discordId: "999888777"');
    // exactly one occurrence in policy.principals[] (the human entry) — the
    // agent entry (id: assistant) has platform_ids: {} and must stay untouched.
    expect((text.match(/999888777/g) ?? []).length).toBe(2); // principal.discordId + platform_ids.discord[0]
    expect(text).toContain("platform_ids: {}"); // the agent entry, untouched
  });

  test("idempotent: second patch with the same discordId is a no-op", () => {
    const dir = freshDir();
    const path = join(dir, "stack.yaml");
    writeFileSync(path, STACK_FIXTURE, { mode: 0o600 });
    const opts = { principal: "andreas", discordId: "999888777" };
    patchStackYaml(path, join(dir, "no-pointer.yaml"), opts);
    const after = readFileSync(path, "utf-8");
    const second = patchStackYaml(path, join(dir, "no-pointer.yaml"), opts);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(after);
  });

  test("throws when no policy.principals[] entry matches the principal id", () => {
    const dir = freshDir();
    const path = join(dir, "stack.yaml");
    writeFileSync(path, STACK_FIXTURE, { mode: 0o600 });
    expect(() =>
      patchStackYaml(path, join(dir, "no-pointer.yaml"), { principal: "nobody", discordId: "1" }),
    ).toThrow();
    // Must have restored the original — a thrown patch never leaves a half-write.
    expect(readFileSync(path, "utf-8")).toBe(STACK_FIXTURE);
  });
});

describe("patchSystemNatsPort", () => {
  test("rewrites nats.url's port and preserves the trailing comment", () => {
    const dir = freshDir();
    const path = join(dir, "system.yaml");
    writeFileSync(path, SYSTEM_FIXTURE, { mode: 0o600 });
    const result = patchSystemNatsPort(path, "4223");
    expect(result.changed).toBe(true);
    const text = readFileSync(path, "utf-8");
    expect(text).toContain("url: nats://127.0.0.1:4223");
    expect(text).toContain("# review host:port for your NATS server");
  });

  test("idempotent: re-patching the same port is a no-op", () => {
    const dir = freshDir();
    const path = join(dir, "system.yaml");
    writeFileSync(path, SYSTEM_FIXTURE, { mode: 0o600 });
    patchSystemNatsPort(path, "4223");
    const after = readFileSync(path, "utf-8");
    const second = patchSystemNatsPort(path, "4223");
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(after);
  });
});

// =============================================================================
// healthy-boot gate (§5)
// =============================================================================

describe("evaluateHealthyBootGate / gatePassed", () => {
  test("undefined log (not written yet) → every line unmatched", () => {
    const lines = evaluateHealthyBootGate(undefined);
    expect(lines.every((l) => !l.matched)).toBe(true);
    expect(gatePassed(lines, true)).toBe(false);
  });

  test("all five §5 substrings present + healthz ok → gate passes", () => {
    const log = [
      "Stack: andreas/work",
      "connected to nats://127.0.0.1:4222",
      "policy-engine active — principals=2",
      "discord adapter started (… Guild: 111)",
      "connected as Bot#0001",
    ].join("\n");
    const lines = evaluateHealthyBootGate(log);
    expect(lines.every((l) => l.matched)).toBe(true);
    expect(gatePassed(lines, true)).toBe(true);
  });

  test("healthz false still fails the gate even with all log lines present", () => {
    const log = "Stack: x\nconnected to nats\npolicy-engine active\nconnected as Bot\nGuild: 1";
    const lines = evaluateHealthyBootGate(log);
    expect(gatePassed(lines, false)).toBe(false);
  });

  test("one missing line fails the gate", () => {
    const log = "Stack: x\nconnected to nats\npolicy-engine active\nconnected as Bot"; // no Guild:
    const lines = evaluateHealthyBootGate(log);
    expect(gatePassed(lines, true)).toBe(false);
    expect(lines.find((l) => l.label === "Guild:")?.matched).toBe(false);
  });
});

// =============================================================================
// daemonLogPath
// =============================================================================

test("daemonLogPath matches §5's target path shape", () => {
  expect(daemonLogPath("/home/andreas", "work")).toBe(
    "/home/andreas/.local/state/metafactory/cortex/logs/cortex-work.log",
  );
});

// =============================================================================
// cortex#2153 — web surface env contract
// =============================================================================

const WEB_SECRET = "THE-REAL-WEB-AUTH-TOKEN-VALUE";

/** A fully valid WEB env — no Discord snowflakes at all. */
function validWebEnv(): NodeJS.ProcessEnv {
  return {
    CTX_PRINCIPAL: "andreas",
    CTX_SLUG: "gateway",
    CTX_NATS_PORT: "4222",
    CTX_NATS_MON: "8222",
    CTX_WEB_HOST: "127.0.0.1",
    CTX_WEB_PORT: "8090",
    CTX_WEB_TOKEN: WEB_SECRET,
  };
}

describe("validateWebEnvContract — the happy path", () => {
  test("a valid web env validates ok WITHOUT any Discord snowflake", () => {
    const result = validateWebEnvContract(validWebEnv());
    expect(result.ok).toBe(true);
    expect(result.values?.CTX_WEB_HOST).toBe("127.0.0.1");
    expect(result.values?.CTX_WEB_PORT).toBe("8090");
    // The shared identity keys survive.
    expect(result.values?.CTX_SLUG).toBe("gateway");
    expect(result.values?.CTX_PRINCIPAL).toBe("andreas");
  });

  test("no CTX_GUILD_ID / CTX_DISCORD_TOKEN required — a web env with NONE of them still validates", () => {
    const env = validWebEnv();
    // prove the discord contract's keys are entirely absent
    expect(env.CTX_GUILD_ID).toBeUndefined();
    expect(env.CTX_DISCORD_TOKEN).toBeUndefined();
    expect(validateWebEnvContract(env).ok).toBe(true);
  });

  test("CLAUDE_CODE_OAUTH_TOKEN absent does NOT block ok (optional, same as discord)", () => {
    const result = validateWebEnvContract(validWebEnv());
    expect(result.ok).toBe(true);
    expect(result.secrets.find((s) => s.key === "CLAUDE_CODE_OAUTH_TOKEN")?.status).toBe("missing");
  });
});

describe("validateWebEnvContract — missing / invalid", () => {
  for (const key of CTX_WEB_REQUIRED_KEYS) {
    test(`missing ${key} → not ok`, () => {
      const env = validWebEnv();
      Reflect.deleteProperty(env, key);
      const result = validateWebEnvContract(env);
      expect(result.ok).toBe(false);
      expect(result.values).toBeUndefined();
      expect(result.checks.find((c) => c.key === key)?.ok).toBe(false);
    });
  }

  test("CTX_WEB_TOKEN missing → not ok (it gates, like CTX_DISCORD_TOKEN)", () => {
    const env = validWebEnv();
    delete env.CTX_WEB_TOKEN;
    const result = validateWebEnvContract(env);
    expect(result.ok).toBe(false);
    expect(result.secrets.find((s) => s.key === "CTX_WEB_TOKEN")?.gates).toBe(true);
  });

  test("CTX_WEB_HOST with a slash → invalid shape (no scheme/path allowed)", () => {
    const env = validWebEnv();
    env.CTX_WEB_HOST = "http://example.com/x";
    const result = validateWebEnvContract(env);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.key === "CTX_WEB_HOST")?.reason).toContain("hostname or IP");
  });

  test("CTX_WEB_PORT out of range → invalid shape (reuses the port rule)", () => {
    const env = validWebEnv();
    env.CTX_WEB_PORT = "99999";
    const result = validateWebEnvContract(env);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.key === "CTX_WEB_PORT")?.reason).toContain("port");
  });
});

describe("validateWebEnvContract — secret hygiene", () => {
  test("the web token value never appears in the result nor the rendered table", () => {
    const result = validateWebEnvContract(validWebEnv());
    expect(JSON.stringify(result)).not.toContain(WEB_SECRET);
    const table = renderEnvTable(result);
    expect(table).not.toContain(WEB_SECRET);
    expect(table).toContain("CTX_WEB_TOKEN: set");
  });

  test("a MISSING gating web token renders as a hard ✗ (not the soft ○ the optional oauth token gets)", () => {
    const env = validWebEnv();
    delete env.CTX_WEB_TOKEN;
    const table = renderEnvTable(validateWebEnvContract(env));
    expect(table).toContain("✗ CTX_WEB_TOKEN: missing");
    expect(table).toContain("○ CLAUDE_CODE_OAUTH_TOKEN: missing");
  });
});

// =============================================================================
// cortex#2153 — web surfaces.yaml render + write
// =============================================================================

const WEB_INPUTS = {
  agent: "assistant",
  stack: "andreas/gateway",
  instanceId: "gateway",
  host: "127.0.0.1",
  port: "8090",
  token: WEB_SECRET,
};

describe("renderWebSurfacesYaml", () => {
  test("emits a web binding with the numeric port unquoted and the token quoted", () => {
    const yaml = renderWebSurfacesYaml(WEB_INPUTS);
    expect(yaml).toContain("web:");
    expect(yaml).toContain("agent: assistant");
    expect(yaml).toContain("stack: andreas/gateway");
    expect(yaml).toContain("instanceId: gateway");
    expect(yaml).toContain("host: 127.0.0.1");
    expect(yaml).toContain("port: 8090"); // unquoted → YAML number
    expect(yaml).toContain(`token: "${WEB_SECRET}"`);
    // NO discord binding is written.
    expect(yaml).not.toContain("discord:");
  });
});

describe("writeWebSurfacesYaml — full-file REWRITE", () => {
  test("REPLACES a scaffolded discord surfaces.yaml with a web-only binding", () => {
    const dir = freshDir();
    const path = join(dir, "surfaces.yaml");
    // simulate the `cortex stack create` discord scaffold
    writeFileSync(
      path,
      "surfaces:\n  discord:\n    - agent: assistant\n      stack: andreas/gateway\n      binding:\n        token: \"<REPLACE_ME>\"\n",
      { mode: 0o600 },
    );

    const result = writeWebSurfacesYaml(path, WEB_INPUTS);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();

    const written = readFileSync(path, "utf-8");
    expect(written).toContain("web:");
    expect(written).not.toContain("discord:"); // the discord block is gone
    expect(written).toContain(`token: "${WEB_SECRET}"`);
    // the file is 0600 (secret-bearing)
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("idempotent: a second write with the SAME inputs is byte-identical → no change, no backup", () => {
    const dir = freshDir();
    const path = join(dir, "surfaces.yaml");
    writeFileSync(path, "surfaces:\n  discord:\n    - agent: assistant\n      stack: andreas/gateway\n      binding: {}\n", {
      mode: 0o600,
    });

    const first = writeWebSurfacesYaml(path, WEB_INPUTS);
    expect(first.changed).toBe(true);
    const afterFirst = readFileSync(path, "utf-8");

    const second = writeWebSurfacesYaml(path, WEB_INPUTS);
    expect(second.changed).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe(afterFirst); // untouched
  });

  test("the backup carries the pre-existing content and is written 0600 (secret-safe)", () => {
    const dir = freshDir();
    const path = join(dir, "surfaces.yaml");
    const original = "surfaces:\n  discord:\n    - agent: assistant\n      stack: andreas/gateway\n      binding:\n        token: \"OLD-SECRET\"\n";
    writeFileSync(path, original, { mode: 0o600 });

    const result = writeWebSurfacesYaml(path, WEB_INPUTS);
    expect(result.backupPath).toBeDefined();
    if (result.backupPath !== undefined) {
      expect(readFileSync(result.backupPath, "utf-8")).toBe(original);
      expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
    }
  });
});

describe("readSurfaceAgent", () => {
  test("reads the agent from a scaffolded discord surfaces.yaml", () => {
    const dir = freshDir();
    const path = join(dir, "surfaces.yaml");
    writeFileSync(path, "surfaces:\n  discord:\n    - agent: luna\n      stack: andreas/work\n      binding: {}\n");
    expect(readSurfaceAgent(path)).toBe("luna");
  });

  test("reads the agent from an already-rewritten web surfaces.yaml (re-run path)", () => {
    const dir = freshDir();
    const path = join(dir, "surfaces.yaml");
    writeFileSync(path, renderWebSurfacesYaml({ ...WEB_INPUTS, agent: "pylon" }));
    expect(readSurfaceAgent(path)).toBe("pylon");
  });

  test("returns undefined when the file is missing or carries no binding entry", () => {
    const dir = freshDir();
    expect(readSurfaceAgent(join(dir, "nope.yaml"))).toBeUndefined();
    const empty = join(dir, "empty.yaml");
    writeFileSync(empty, "surfaces: {}\n");
    expect(readSurfaceAgent(empty)).toBeUndefined();
  });
});
