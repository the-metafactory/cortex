/**
 * GV-1 (cortex#1076) — config-path resolver tests.
 *
 * The resolver is cortex-first with a grove fallback during the
 * ~/.config/grove → ~/.config/cortex transition (EPIC cortex#1075). It must:
 *   - resolve ~/.config/cortex/<file> when it exists
 *   - fall back to ~/.config/grove/<file> when only the grove copy exists
 *   - target the cortex path (for writes / defaults) when neither exists
 *   - auto-migrate a grove-only file to cortex preserving the file mode
 *     (cloud-credentials.txt is a secret, chmod 600 — never widen it)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  cortexConfigDir,
  cortexConfigDirOverride,
  cortexConfigPath,
  groveConfigPath,
  migrateGroveConfigFile,
  resolveConfigFile,
} from "../config-path";

let home: string;
let savedConfigDirEnv: string | undefined;
const FILE = "cli.yaml";

function cortexFile() {
  return join(home, ".config", "cortex", FILE);
}
function groveFile() {
  return join(home, ".config", "grove", FILE);
}

beforeEach(() => {
  // Isolate the default-behavior tests from an ambient `CORTEX_CONFIG_DIR`
  // (cortex#1908): the issue's own verification command exports it globally
  // (`CORTEX_CONFIG_DIR=/tmp/x bun test src/common/config`), which would
  // otherwise redirect these home-injected assertions off `~/.config/cortex`.
  savedConfigDirEnv = process.env.CORTEX_CONFIG_DIR;
  delete process.env.CORTEX_CONFIG_DIR;
  home = mkdtempSync(join(tmpdir(), "gv1-home-"));
});

afterEach(() => {
  if (savedConfigDirEnv === undefined) delete process.env.CORTEX_CONFIG_DIR;
  else process.env.CORTEX_CONFIG_DIR = savedConfigDirEnv;
  rmSync(home, { recursive: true, force: true });
});

describe("path builders", () => {
  test("cortexConfigPath builds ~/.config/cortex/<file>", () => {
    expect(cortexConfigPath(FILE, home)).toBe(cortexFile());
  });
  test("groveConfigPath builds ~/.config/grove/<file>", () => {
    expect(groveConfigPath(FILE, home)).toBe(groveFile());
  });
});

describe("resolveConfigFile — cortex-first, grove-fallback", () => {
  test("returns cortex path + source=cortex when cortex file exists", () => {
    mkdirSync(join(home, ".config", "cortex"), { recursive: true });
    writeFileSync(cortexFile(), "from-cortex");
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(cortexFile());
    expect(r.source).toBe("cortex");
  });

  test("falls back to grove path + source=grove when only grove exists", () => {
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveFile(), "from-grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(groveFile());
    expect(r.source).toBe("grove");
  });

  test("cortex wins when BOTH exist (cortex-first precedence)", () => {
    mkdirSync(join(home, ".config", "cortex"), { recursive: true });
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(cortexFile(), "from-cortex");
    writeFileSync(groveFile(), "from-grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(cortexFile());
    expect(r.source).toBe("cortex");
  });

  test("targets cortex path + source=default when neither exists (write target)", () => {
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(cortexFile());
    expect(r.source).toBe("default");
  });
});

describe("migrateGroveConfigFile — auto-migrate preserving mode", () => {
  test("copies grove → cortex when only grove exists, preserving 0o600", () => {
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveFile(), "secret-bytes", { mode: 0o600 });
    chmodSync(groveFile(), 0o600); // umask-proof the fixture

    const migrated = migrateGroveConfigFile(FILE, home);

    expect(migrated).toBe(true);
    expect(existsSync(cortexFile())).toBe(true);
    expect(readFileSync(cortexFile(), "utf-8")).toBe("secret-bytes");
    const mode = statSync(cortexFile()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("preserves a non-secret 0o644 mode too", () => {
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveFile(), "plain", { mode: 0o644 });
    chmodSync(groveFile(), 0o644);

    migrateGroveConfigFile(FILE, home);

    const mode = statSync(cortexFile()).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  // The secret-at-rest contract, named explicitly: cloud-credentials.txt MUST
  // land 0o600 on the cortex side — copyFileSync applies the umask, so the
  // chmod re-assertion is what keeps the secret from being widened on migrate.
  test("cloud-credentials.txt (a secret) stays 0o600 across the grove→cortex migrate", () => {
    const SECRET = "cloud-credentials.txt";
    const groveSecret = join(home, ".config", "grove", SECRET);
    const cortexSecret = join(home, ".config", "cortex", SECRET);
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveSecret, "TOKEN=redacted", { mode: 0o600 });
    chmodSync(groveSecret, 0o600); // umask-proof the fixture

    migrateGroveConfigFile(SECRET, home);

    expect(existsSync(cortexSecret)).toBe(true);
    expect(statSync(cortexSecret).mode & 0o777).toBe(0o600);
  });

  test("no-op (returns false) when cortex already exists — never clobbers", () => {
    mkdirSync(join(home, ".config", "cortex"), { recursive: true });
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(cortexFile(), "cortex-canonical");
    writeFileSync(groveFile(), "grove-stale");

    const migrated = migrateGroveConfigFile(FILE, home);

    expect(migrated).toBe(false);
    expect(readFileSync(cortexFile(), "utf-8")).toBe("cortex-canonical");
  });

  test("no-op (returns false) when neither exists", () => {
    expect(migrateGroveConfigFile(FILE, home)).toBe(false);
    expect(existsSync(cortexFile())).toBe(false);
  });
});

// XDG wave-1 (cortex#1908, EPIC cortex#1867 X-03) — CORTEX_CONFIG_DIR env seam.
// When set it relocates the whole config tree; when unset, everything above
// this block already proves byte-identical `~/.config/{cortex,grove}` behavior.
describe("CORTEX_CONFIG_DIR override (XDG wave-1 cortex#1908)", () => {
  let scratch: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CORTEX_CONFIG_DIR;
    delete process.env.CORTEX_CONFIG_DIR; // start from a known-unset baseline
    scratch = mkdtempSync(join(tmpdir(), "x1908-cfg-"));
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CORTEX_CONFIG_DIR;
    else process.env.CORTEX_CONFIG_DIR = savedEnv;
    rmSync(scratch, { recursive: true, force: true });
  });

  test("unset ⇒ default dir is ~/.config/cortex (byte-identical) and override is undefined", () => {
    expect(cortexConfigDirOverride()).toBeUndefined();
    expect(cortexConfigDir(home)).toBe(join(home, ".config", "cortex"));
    expect(cortexConfigPath(FILE, home)).toBe(cortexFile());
  });

  test("set ⇒ config dir is the override verbatim, ignoring home", () => {
    process.env.CORTEX_CONFIG_DIR = scratch;
    expect(cortexConfigDirOverride()).toBe(scratch);
    expect(cortexConfigDir(home)).toBe(scratch);
    expect(cortexConfigPath(FILE, home)).toBe(join(scratch, FILE));
  });

  test("empty CORTEX_CONFIG_DIR is treated as unset (not '/')", () => {
    process.env.CORTEX_CONFIG_DIR = "";
    expect(cortexConfigDirOverride()).toBeUndefined();
    expect(cortexConfigDir(home)).toBe(join(home, ".config", "cortex"));
  });

  test("resolveConfigFile returns the in-override file when it exists", () => {
    process.env.CORTEX_CONFIG_DIR = scratch;
    writeFileSync(join(scratch, FILE), "from-override");
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(join(scratch, FILE));
    expect(r.source).toBe("cortex");
    expect(r.path.startsWith(scratch)).toBe(true);
  });

  // The acceptance criterion: with the override set, resolution lands ENTIRELY
  // inside it with ZERO real-home access. A grove copy under the (fake) home is
  // planted precisely to prove the legacy fallback is NOT probed.
  test("hermetic: absent file ⇒ default target inside override, grove/home never probed", () => {
    process.env.CORTEX_CONFIG_DIR = scratch;
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveFile(), "from-grove"); // MUST be ignored under the override
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(join(scratch, FILE));
    expect(r.source).toBe("default"); // grove skipped → default, never "grove"
    expect(r.path.startsWith(scratch)).toBe(true);
  });

  test("migrateGroveConfigFile is a no-op under the override (never reads real grove)", () => {
    process.env.CORTEX_CONFIG_DIR = scratch;
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveFile(), "from-grove");
    expect(migrateGroveConfigFile(FILE, home)).toBe(false);
    expect(existsSync(join(scratch, FILE))).toBe(false);
  });

  test("unset restores the grove read-fallback (regression guard for the skip)", () => {
    // env already deleted in beforeEach
    mkdirSync(join(home, ".config", "grove"), { recursive: true });
    writeFileSync(groveFile(), "from-grove");
    const r = resolveConfigFile(FILE, home);
    expect(r.path).toBe(groveFile());
    expect(r.source).toBe("grove");
  });
});
