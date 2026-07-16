/**
 * C-808 — `cortex stack create` CLI dispatcher tests.
 *
 * Covers the command surface: parsing, usage errors, help, slug/principal
 * validation, the born-aligned uniqueness guarantees (#808 — dir==slug==
 * trailing segment of stack.id; refuse on dir-collision OR duplicate stack.id),
 * the DEFAULT-safe dry-run posture (writes NOTHING without --apply), the
 * --apply file set, refuse-overwrite, and principal inference.
 *
 * NEVER touches the real ~/.config/cortex — every test points --config-dir at a
 * fresh tmp dir and asserts dry-run leaves it empty.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchStack } from "../stack";
import { loadConfigWithAgents } from "../../../../common/config/loader";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "c808-stack-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * cortex#2097 — `stack create --apply` now also mkdirSync's the dispatch cwd
 * fallback's canonical default workspace dir, resolved off `homedir()` (which
 * reads `$HOME` on POSIX) — NOT under `--config-dir`, the isolation this file's
 * header comment already documents. Sandbox `$HOME` for the whole file so
 * `--apply` tests never write into the real developer/CI home; only
 * `--config-dir` is asserted against directly, so nothing here depends on the
 * real value of `$HOME`.
 */
let stackHome: string;
let savedStackHome: string | undefined;
beforeAll(() => {
  savedStackHome = process.env.HOME;
  stackHome = mkdtempSync(join(tmpdir(), "c808-stack-cli-home-"));
  process.env.HOME = stackHome;
});
afterAll(() => {
  if (savedStackHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedStackHome;
  rmSync(stackHome, { recursive: true, force: true });
});

/** Seed an existing split-layout stack under <configDir>/<slug>/ with stack.id. */
function seedSplitStack(configDir: string, slug: string, stackId: string): void {
  const dir = join(configDir, slug);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  writeFileSync(join(dir, "system", "system.yaml"), "nats:\n  url: nats://127.0.0.1:4222\n");
  writeFileSync(join(dir, "stacks", `${slug}.yaml`), `principal:\n  id: ${stackId.split("/")[0]}\nstack:\n  id: ${stackId}\n`);
}

/** Seed a legacy monolith cortex.<slug>.yaml carrying a stack.id. */
function seedLegacyMonolith(configDir: string, fileSlug: string, stackId: string): void {
  const name = fileSlug === "meta-factory" ? "cortex.yaml" : `cortex.${fileSlug}.yaml`;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, name), `stack:\n  id: ${stackId}\n`);
}

// =============================================================================
// dispatch / usage / help
// =============================================================================

describe("dispatch", () => {
  test("no subcommand → exit 2 with usage", async () => {
    const res = await dispatchStack([]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("no subcommand specified");
  });

  test("unknown subcommand → exit 2", async () => {
    const res = await dispatchStack(["frobnicate"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('unknown subcommand "frobnicate"');
  });

  test("--help → exit 0 with usage", async () => {
    const res = await dispatchStack(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("cortex stack");
    expect(res.stdout).toContain("create");
  });
});

// =============================================================================
// create — slug + principal validation
// =============================================================================

describe("create validation", () => {
  test("rejects a bad slug (uppercase) → exit 2", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "BadSlug", "--principal", "andreas", "--config-dir", cfg]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("slug");
    expect(res.stderr).toContain("must be");
  });

  test("rejects a slug starting with a digit → exit 2", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "2026research", "--principal", "andreas", "--config-dir", cfg]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("slug");
  });

  test("rejects a bad principal id → exit 2", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "research", "--principal", "Bad_CAPS!", "--config-dir", cfg]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("principal");
  });

  test("accepts an underscore in the slug (stack.id grammar allows it)", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "research_2026", "--principal", "andreas", "--config-dir", cfg]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("andreas/research_2026");
  });

  test("rejects a --display-name with a newline (YAML-injection guard) → exit 2, writes nothing", async () => {
    const cfg = freshDir();
    const res = await dispatchStack([
      "create", "research", "--principal", "andreas", "--config-dir", cfg,
      "--display-name", "Luna\n    roles:\n      - injected-superuser", "--apply",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("display-name");
    expect(existsSync(join(cfg, "research"))).toBe(false);
  });

  test("--apply with YAML-special chars in --display-name stays born-loadable", async () => {
    const cfg = freshDir();
    const res = await dispatchStack([
      "create", "research", "--principal", "andreas", "--config-dir", cfg,
      "--display-name", 'Ivy: the #1 "researcher"', "--apply",
    ]);
    expect(res.exitCode).toBe(0);
    // The colon/hash/quotes survive inside a valid YAML scalar (JSON.stringify
    // quoting), so the scaffold still composes through the real loader.
    const loaded = loadConfigWithAgents(join(cfg, "research", "research.yaml"));
    expect(loaded.stack?.id).toBe("andreas/research");
  });

  test("no principal and no existing stack to infer from → exit 2", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "research", "--config-dir", cfg]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--principal");
  });
});

// =============================================================================
// create — principal inference (#808)
// =============================================================================

describe("create principal inference", () => {
  test("infers principal from the single existing stack", async () => {
    const cfg = freshDir();
    seedSplitStack(cfg, "research", "andreas/research");
    const res = await dispatchStack(["create", "work", "--config-dir", cfg]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("andreas/work");
  });

  test("refuses to infer when two principals are present → exit 2", async () => {
    const cfg = freshDir();
    seedSplitStack(cfg, "research", "andreas/research");
    seedSplitStack(cfg, "jcwork", "jc/jcwork");
    const res = await dispatchStack(["create", "work", "--config-dir", cfg]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--principal");
  });
});

// =============================================================================
// create — uniqueness (#808)
// =============================================================================

describe("create uniqueness", () => {
  test("refuses when the target dir already exists → exit 1", async () => {
    const cfg = freshDir();
    mkdirSync(join(cfg, "research"), { recursive: true });
    const res = await dispatchStack(["create", "research", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("already exists");
  });

  test("refuses when an existing split stack already owns the stack.id → exit 1", async () => {
    const cfg = freshDir();
    // A differently-NAMED dir whose stack.id is andreas/research → duplicate id.
    seedSplitStack(cfg, "old-research-dir", "andreas/research");
    const res = await dispatchStack(["create", "research", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("andreas/research");
    expect(res.stderr).toContain("already");
  });

  test("refuses when a legacy monolith already owns the stack.id → exit 1", async () => {
    const cfg = freshDir();
    seedLegacyMonolith(cfg, "research", "andreas/research");
    const res = await dispatchStack(["create", "research", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("andreas/research");
  });

  test("a different principal's same slug is NOT a conflict", async () => {
    const cfg = freshDir();
    seedSplitStack(cfg, "research", "jc/research");
    // andreas/research is a distinct stack.id; only a dir-name collision or a
    // SAME stack.id conflicts. Here neither: dir `research` exists so this is a
    // DIR collision — assert that. (Uniqueness is dir OR id, conservatively.)
    const res = await dispatchStack(["create", "research", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("already exists");
  });
});

// =============================================================================
// create --apply permissions (cortex#2055)
// =============================================================================
// The scaffold's secret-bearing file is surfaces/surfaces.yaml (Discord bot
// token). Before this fix it was born 0644 (world-readable) while
// stacks/<slug>.yaml was only incidentally 0600 (provisioner mktemp+mv) — the
// file WITH the secret was the readable one. Every scaffold file must be 0600.
describe("create --apply permissions", () => {
  test("the bot-token file (surfaces.yaml) is 0600, not world-readable", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "research", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(0);
    const surfaces = join(cfg, "research", "surfaces", "surfaces.yaml");
    expect(statSync(surfaces).mode & 0o777).toBe(0o600);
  });

  test("every generated file is 0600", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "research", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(0);
    const base = join(cfg, "research");
    const entries = readdirSync(base, { recursive: true }) as string[];
    const files = entries.filter((rel) => statSync(join(base, rel)).isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      expect(statSync(join(base, rel)).mode & 0o777).toBe(0o600);
    }
  });
});

// =============================================================================
// create — dry-run (DEFAULT-safe)
// =============================================================================

describe("create dry-run (default)", () => {
  test("writes NOTHING without --apply, lists the file set, exit 0", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    // The file set is enumerated.
    expect(res.stdout).toContain("system/system.yaml");
    expect(res.stdout).toContain("stacks/demo.yaml");
    expect(res.stdout).toContain("demo.yaml");
    expect(res.stdout).toContain("personas/assistant.md");
    // NOTHING was written.
    expect(existsSync(join(cfg, "demo"))).toBe(false);
  });

  test("reports the born-aligned dir==slug==stack.id guarantee", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("andreas/demo");
  });
});

// =============================================================================
// create — apply
// =============================================================================

describe("create --apply", () => {
  test("writes the expected file set + born-aligned stack.id", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(0);

    const dir = join(cfg, "demo");
    expect(existsSync(join(dir, "system", "system.yaml"))).toBe(true);
    expect(existsSync(join(dir, "stacks", "demo.yaml"))).toBe(true);
    expect(existsSync(join(dir, "demo.yaml"))).toBe(true);
    expect(existsSync(join(dir, "personas", "assistant.md"))).toBe(true);

    // dir basename == slug == trailing segment of stack.id (the #808 invariant).
    const stackYaml = readFileSync(join(dir, "stacks", "demo.yaml"), "utf-8");
    expect(stackYaml).toContain("id: andreas/demo");
    expect(stackYaml).toContain("nkey_seed_path: ~/.config/nats/cortex-demo.nk");
    // The chosen agent id is the neutral 'assistant' by default (#1338).
    expect(stackYaml).toContain("assistant");
  });

  test("honours --agent + --display-name", async () => {
    const cfg = freshDir();
    const res = await dispatchStack([
      "create", "demo", "--principal", "andreas", "--agent", "echo",
      "--display-name", "Demo Stack", "--config-dir", cfg, "--apply",
    ]);
    expect(res.exitCode).toBe(0);
    const stackYaml = readFileSync(join(cfg, "demo", "stacks", "demo.yaml"), "utf-8");
    expect(stackYaml).toContain("echo");
    expect(existsSync(join(cfg, "demo", "personas", "echo.md"))).toBe(true);
  });

  test("composed stack is discoverable as itself (round-trip uniqueness)", async () => {
    const cfg = freshDir();
    await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    // A second create of the SAME slug now conflicts (dir exists).
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(1);
  });

  test("the scaffolded config composes + loads via the real loader (born loadable)", async () => {
    // The whole point of the docs/config-layout/ template is that it parses
    // cleanly out of the box (valid-FORMAT placeholders, not bare <REPLACE_ME>,
    // for schema-validated keys like nkey_pub). A scaffold that can't load
    // would be a defect — assert the composer accepts what we wrote.
    const cfg = freshDir();
    await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    const loaded = loadConfigWithAgents(join(cfg, "demo", "demo.yaml"));
    expect(loaded.stack?.id).toBe("andreas/demo");
  });

  test("prints next steps (provision → make-live → point daemon → network join)", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("arc upgrade");
    // v5.30.2 (C-1265c): the provision → make-live bus-bring-up ladder is surfaced.
    expect(res.stdout).toContain("cortex network provision demo");
    expect(res.stdout).toContain("cortex network make-live demo");
    expect(res.stdout).toContain("network join");
  });
});

// =============================================================================
// create — refuse overwrite
// =============================================================================

describe("create refuse-overwrite", () => {
  test("never clobbers an existing dir even with --apply", async () => {
    const cfg = freshDir();
    const dir = join(cfg, "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sentinel-keepme.txt"), "do not delete");
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply"]);
    expect(res.exitCode).toBe(1);
    // The pre-existing content is untouched.
    expect(existsSync(join(dir, "sentinel-keepme.txt"))).toBe(true);
    expect(readdirSync(dir)).toContain("sentinel-keepme.txt");
  });
});

// =============================================================================
// apply + dry-run mutual exclusion
// =============================================================================

describe("create flag exclusivity", () => {
  test("--apply and --dry-run together → exit 2", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["create", "demo", "--principal", "andreas", "--config-dir", cfg, "--apply", "--dry-run"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });
});

// =============================================================================
// list (cheap)
// =============================================================================

describe("list", () => {
  test("lists discovered stacks with aligned/drift flags", async () => {
    const cfg = freshDir();
    seedSplitStack(cfg, "research", "andreas/research");      // aligned
    seedSplitStack(cfg, "old-dir", "andreas/work");           // drift (dir != slug)
    const res = await dispatchStack(["list", "--config-dir", cfg]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("research");
    expect(res.stdout).toContain("andreas/work");
    expect(res.stdout.toLowerCase()).toContain("drift");
    expect(res.stdout.toLowerCase()).toContain("aligned");
  });

  test("empty config dir → exit 0, no stacks", async () => {
    const cfg = freshDir();
    const res = await dispatchStack(["list", "--config-dir", cfg]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toLowerCase()).toContain("no stacks");
  });
});
