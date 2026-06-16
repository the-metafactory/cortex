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
  cortexConfigPath,
  groveConfigPath,
  migrateGroveConfigFile,
  resolveConfigFile,
} from "../config-path";

let home: string;
const FILE = "cli.yaml";

function cortexFile() {
  return join(home, ".config", "cortex", FILE);
}
function groveFile() {
  return join(home, ".config", "grove", FILE);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gv1-home-"));
});

afterEach(() => {
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
