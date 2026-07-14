/**
 * cortex#2007 — shared AgentState script-path resolvers (EPIC cortex#1867).
 *
 * The `scaffold.ts` / `errands.ts` default paths were triplicated across the
 * agent-state consumers, each hardcoding the pre-#287
 * `~/.config/metafactory/pkg/repos`. They now route through the ONE shared
 * `defaultScaffoldScript` / `defaultErrandsScript`, which resolve arc's
 * package-repos dir via `resolveArcPackReposDir` (arc#287 layout). This suite
 * pins the resolution matrix the ACs require:
 *   - default (multi-tree) migrated box → `~/.local/share/metafactory/arc/repos/…`;
 *   - `$XDG_DATA_HOME` honoured;
 *   - legacy-only (singleTree) box → `~/.config/metafactory/pkg/repos/…`;
 *   - env override (`MF_AGENT_STATE_SCRIPT` / `MF_AGENT_STATE_ERRANDS_SCRIPT`) wins.
 *
 * Every case is hermetic: a scratch `$HOME`, an explicit `env` bag (both flow
 * through the injectable `{home, env}` seam), and all assertions land under the
 * scratch dir — zero real `~/.local`/`~/.config` access, zero `process.env`
 * mutation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultScaffoldScript,
  defaultErrandsScript,
} from "../agent-state-scripts";

let home: string;

// Canonical multi-tree tree (no $XDG_DATA_HOME): ~/.local/share/metafactory/arc/repos.
function canonicalRepos() {
  return join(home, ".local", "share", "metafactory", "arc", "repos");
}
// Legacy pre-#287 singleTree tree: ~/.config/metafactory/pkg/repos.
function legacyRepos() {
  return join(home, ".config", "metafactory", "pkg", "repos");
}
function scaffoldUnder(repos: string) {
  return join(repos, "agent-state", "skill", "scripts", "scaffold.ts");
}
function errandsUnder(repos: string) {
  return join(repos, "agent-state", "skill", "scripts", "errands.ts");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "b2007-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("defaultScaffoldScript", () => {
  test("default multi-tree box → ~/.local/share/metafactory/arc/repos/…/scaffold.ts", () => {
    mkdirSync(canonicalRepos(), { recursive: true });
    expect(defaultScaffoldScript({ home, env: {} })).toBe(
      scaffoldUnder(canonicalRepos()),
    );
  });

  test("$XDG_DATA_HOME honoured", () => {
    const xdg = join(home, "xdg-data");
    const repos = join(xdg, "metafactory", "arc", "repos");
    mkdirSync(repos, { recursive: true });
    expect(defaultScaffoldScript({ home, env: { XDG_DATA_HOME: xdg } })).toBe(
      scaffoldUnder(repos),
    );
  });

  test("legacy-only (singleTree) box → ~/.config/metafactory/pkg/repos/…/scaffold.ts", () => {
    mkdirSync(legacyRepos(), { recursive: true });
    // Canonical does NOT exist → existence-gated fall back to legacy.
    expect(defaultScaffoldScript({ home, env: {} })).toBe(
      scaffoldUnder(legacyRepos()),
    );
  });

  test("neither present (fresh host) → canonical default target", () => {
    expect(defaultScaffoldScript({ home, env: {} })).toBe(
      scaffoldUnder(canonicalRepos()),
    );
  });

  test("MF_AGENT_STATE_SCRIPT override wins over any resolved path", () => {
    mkdirSync(canonicalRepos(), { recursive: true });
    const override = join(home, "custom", "scaffold.ts");
    expect(
      defaultScaffoldScript({ home, env: { MF_AGENT_STATE_SCRIPT: override } }),
    ).toBe(override);
  });
});

describe("defaultErrandsScript", () => {
  test("default multi-tree box → ~/.local/share/metafactory/arc/repos/…/errands.ts", () => {
    mkdirSync(canonicalRepos(), { recursive: true });
    expect(defaultErrandsScript({ home, env: {} })).toBe(
      errandsUnder(canonicalRepos()),
    );
  });

  test("legacy-only (singleTree) box → ~/.config/metafactory/pkg/repos/…/errands.ts", () => {
    mkdirSync(legacyRepos(), { recursive: true });
    expect(defaultErrandsScript({ home, env: {} })).toBe(
      errandsUnder(legacyRepos()),
    );
  });

  test("neither present (fresh host) → canonical default target", () => {
    expect(defaultErrandsScript({ home, env: {} })).toBe(
      errandsUnder(canonicalRepos()),
    );
  });

  test("MF_AGENT_STATE_ERRANDS_SCRIPT override wins over any resolved path", () => {
    mkdirSync(canonicalRepos(), { recursive: true });
    const override = join(home, "custom", "errands.ts");
    expect(
      defaultErrandsScript({
        home,
        env: { MF_AGENT_STATE_ERRANDS_SCRIPT: override },
      }),
    ).toBe(override);
  });

  test("errands override does NOT leak into scaffold (independent env keys)", () => {
    mkdirSync(canonicalRepos(), { recursive: true });
    const errandsOverride = join(home, "custom", "errands.ts");
    const env = { MF_AGENT_STATE_ERRANDS_SCRIPT: errandsOverride };
    expect(defaultErrandsScript({ home, env })).toBe(errandsOverride);
    // scaffold ignores the errands override → still the canonical resolved path.
    expect(defaultScaffoldScript({ home, env })).toBe(
      scaffoldUnder(canonicalRepos()),
    );
  });
});
