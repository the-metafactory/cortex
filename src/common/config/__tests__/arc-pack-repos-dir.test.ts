/**
 * cortex#1988 — arc package-repos dir resolver tests (EPIC cortex#1867).
 *
 * cortex boots exec-brain packs from `{brainPackBaseDir}/{agentId}`, where the
 * DEFAULT base must MIRROR arc's own `dataRoot/repos` resolution (arc#287), not
 * the moved pre-#287 legacy path. The resolver must:
 *   - resolve the XDG-canonical `~/.local/share/metafactory/arc/repos` on a
 *     default (multi-tree) migrated box;
 *   - honor `$XDG_DATA_HOME` (→ `<base>/metafactory/arc/repos`);
 *   - fall back to legacy `~/.config/metafactory/pkg/repos` ONLY if it exists
 *     (singleTree / `ARC_CONFIG_ROOT` install — existence-gated);
 *   - target the canonical path (fresh host / default) when neither exists.
 *
 * Every case is hermetic: a scratch `$HOME`, an explicit `env` bag, and all
 * assertions land under the scratch dir — zero real `~/.local`/`~/.config`
 * access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  arcCanonicalPackReposDir,
  arcPackScriptPath,
  legacyArcPackReposDir,
  resolveArcPackReposDir,
} from "../arc-pack-repos-dir";

let home: string;

// Canonical multi-tree (no $XDG_DATA_HOME): ~/.local/share/metafactory/arc/repos.
function canonicalDefault() {
  return join(home, ".local", "share", "metafactory", "arc", "repos");
}
// Legacy pre-#287 singleTree tree: ~/.config/metafactory/pkg/repos.
function legacyDir() {
  return join(home, ".config", "metafactory", "pkg", "repos");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "b1988-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("arcCanonicalPackReposDir (pure computation, no fs)", () => {
  test("no $XDG_DATA_HOME → ~/.local/share/metafactory/arc/repos", () => {
    expect(arcCanonicalPackReposDir({ home, env: {} })).toBe(canonicalDefault());
  });

  test("$XDG_DATA_HOME set → <base>/metafactory/arc/repos", () => {
    const xdg = join(home, "xdg-data");
    expect(arcCanonicalPackReposDir({ home, env: { XDG_DATA_HOME: xdg } })).toBe(
      join(xdg, "metafactory", "arc", "repos"),
    );
  });

  test("$XDG_DATA_HOME with a leading ~ is home-expanded", () => {
    expect(
      arcCanonicalPackReposDir({ home, env: { XDG_DATA_HOME: "~/custom-data" } }),
    ).toBe(join(home, "custom-data", "metafactory", "arc", "repos"));
  });

  test("blank / whitespace-only $XDG_DATA_HOME reads as unset (never a relative dir)", () => {
    expect(arcCanonicalPackReposDir({ home, env: { XDG_DATA_HOME: "   " } })).toBe(
      canonicalDefault(),
    );
  });

  test("a trailing separator on $XDG_DATA_HOME is normalized away", () => {
    const xdg = join(home, "xdg-data");
    expect(
      arcCanonicalPackReposDir({ home, env: { XDG_DATA_HOME: `${xdg}/` } }),
    ).toBe(join(xdg, "metafactory", "arc", "repos"));
  });
});

describe("legacyArcPackReposDir", () => {
  test("is ~/.config/metafactory/pkg/repos", () => {
    expect(legacyArcPackReposDir({ home, env: {} })).toBe(legacyDir());
  });
});

describe("resolveArcPackReposDir (existence-gated, mirrors arc dataRoot/repos)", () => {
  // AC1 — default (multi-tree) migrated box: canonical tree present → canonical.
  test("default multi-tree box → ~/.local/share/metafactory/arc/repos", () => {
    mkdirSync(canonicalDefault(), { recursive: true });
    expect(resolveArcPackReposDir({ home, env: {} })).toBe(canonicalDefault());
  });

  // AC2 — $XDG_DATA_HOME set → resolves under that base.
  test("$XDG_DATA_HOME set → resolves under that base", () => {
    const xdg = join(home, "xdg-data");
    const expected = join(xdg, "metafactory", "arc", "repos");
    mkdirSync(expected, { recursive: true });
    expect(resolveArcPackReposDir({ home, env: { XDG_DATA_HOME: xdg } })).toBe(
      expected,
    );
  });

  // AC3 — only legacy present (singleTree / ARC_CONFIG_ROOT install) → legacy.
  test("only legacy ~/.config/metafactory/pkg/repos present → legacy (existence-gated)", () => {
    mkdirSync(legacyDir(), { recursive: true });
    // Canonical does NOT exist.
    expect(existsSync(canonicalDefault())).toBe(false);
    expect(resolveArcPackReposDir({ home, env: {} })).toBe(legacyDir());
  });

  // Canonical wins over legacy when BOTH exist (canonical is authoritative).
  test("both present → canonical wins over legacy", () => {
    mkdirSync(canonicalDefault(), { recursive: true });
    mkdirSync(legacyDir(), { recursive: true });
    expect(resolveArcPackReposDir({ home, env: {} })).toBe(canonicalDefault());
  });

  // Fresh host — neither tree exists → canonical (the default write/read target).
  test("neither present (fresh host) → canonical default", () => {
    expect(existsSync(canonicalDefault())).toBe(false);
    expect(existsSync(legacyDir())).toBe(false);
    expect(resolveArcPackReposDir({ home, env: {} })).toBe(canonicalDefault());
  });

  // $XDG_DATA_HOME base takes precedence even when the legacy tree also exists,
  // as long as the XDG-canonical tree exists (mirrors arc's multi-tree layout).
  test("$XDG_DATA_HOME canonical present wins over legacy", () => {
    const xdg = join(home, "xdg-data");
    const expected = join(xdg, "metafactory", "arc", "repos");
    mkdirSync(expected, { recursive: true });
    mkdirSync(legacyDir(), { recursive: true });
    expect(resolveArcPackReposDir({ home, env: { XDG_DATA_HOME: xdg } })).toBe(
      expected,
    );
  });
});

describe("consumer parity — brain-consumer-boot join shape", () => {
  // brain-consumer-boot.ts:280 → join(opts.brainPackBaseDir, agent.id). Confirm
  // the resolved base composes into the exact pack dir cortex boots from.
  test("resolved base + agentId → the pack dir arc installed", () => {
    mkdirSync(canonicalDefault(), { recursive: true });
    const base = resolveArcPackReposDir({ home, env: {} });
    expect(join(base, "my-exec-brain")).toBe(
      join(canonicalDefault(), "my-exec-brain"),
    );
  });
});

describe("arcPackScriptPath (cortex#2007 — single arc-pack path construction site)", () => {
  // Multi-tree box: pack path roots at the canonical XDG data tree.
  test("default multi-tree box → <canonical>/<pack>/<segments>", () => {
    mkdirSync(canonicalDefault(), { recursive: true });
    expect(
      arcPackScriptPath(
        "agent-state",
        ["skill", "scripts", "scaffold.ts"],
        { home, env: {} },
      ),
    ).toBe(join(canonicalDefault(), "agent-state", "skill", "scripts", "scaffold.ts"));
  });

  // Legacy-only (singleTree) box: existence-gated fall back to the legacy tree.
  test("legacy-only box → <legacy>/<pack>/<segments>", () => {
    mkdirSync(legacyDir(), { recursive: true });
    expect(
      arcPackScriptPath("agent-state", ["skill", "scripts", "errands.ts"], {
        home,
        env: {},
      }),
    ).toBe(join(legacyDir(), "agent-state", "skill", "scripts", "errands.ts"));
  });

  // The deploy confidentiality-scan engine path (scan-deploy-surface.ts
  // DEFAULT_ENGINE_PATH) resolves through the SAME helper — pin its shape on
  // both a multi-tree and a legacy box.
  test("scan engine path (metafactory-actions) → canonical on a multi-tree box", () => {
    mkdirSync(canonicalDefault(), { recursive: true });
    expect(
      arcPackScriptPath(
        "metafactory-actions",
        ["scan", "confidentiality-scan.ts"],
        { home, env: {} },
      ),
    ).toBe(
      join(canonicalDefault(), "metafactory-actions", "scan", "confidentiality-scan.ts"),
    );
  });

  test("scan engine path (metafactory-actions) → legacy on a singleTree box", () => {
    mkdirSync(legacyDir(), { recursive: true });
    expect(
      arcPackScriptPath(
        "metafactory-actions",
        ["scan", "confidentiality-scan.ts"],
        { home, env: {} },
      ),
    ).toBe(
      join(legacyDir(), "metafactory-actions", "scan", "confidentiality-scan.ts"),
    );
  });

  test("$XDG_DATA_HOME flows through the seam to the pack path", () => {
    const xdg = join(home, "xdg-data");
    const repos = join(xdg, "metafactory", "arc", "repos");
    mkdirSync(repos, { recursive: true });
    expect(
      arcPackScriptPath("agent-state", ["skill", "scripts", "scaffold.ts"], {
        home,
        env: { XDG_DATA_HOME: xdg },
      }),
    ).toBe(join(repos, "agent-state", "skill", "scripts", "scaffold.ts"));
  });
});
