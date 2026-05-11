// F-2 — agents.d fragment loader tests.
//
// Fixture-driven: each `agents.d-*` directory under `./fixtures/` exercises
// one loader scenario. The loader is `loadAgentsDirectory(dir)` from
// `../loader` — pure function, no side effects beyond reading disk.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  loadAgentsDirectory,
  FragmentLoadError,
} from "../loader";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("loadAgentsDirectory", () => {
  describe("happy path", () => {
    test("returns [] for non-existent directory (operator hasn't created it)", () => {
      const agents = loadAgentsDirectory(join(tmpdir(), `nonexistent-${Date.now()}`));
      expect(agents).toEqual([]);
    });

    test("returns [] for empty directory", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-empty-"));
      const agents = loadAgentsDirectory(dir);
      expect(agents).toEqual([]);
    });

    test("loads a single valid fragment", () => {
      const agents = loadAgentsDirectory(join(FIXTURES, "agents.d-minimal"));
      expect(agents).toHaveLength(1);
      expect(agents[0]!.id).toBe("echo");
      expect(agents[0]!.displayName).toBe("Echo");
    });

    test("loads multiple fragments in alphabetical order", () => {
      const agents = loadAgentsDirectory(join(FIXTURES, "agents.d-multi"));
      expect(agents.map((a) => a.id)).toEqual(["echo", "holly", "luna"]);
    });

    test("populates runtime block when declared", () => {
      const agents = loadAgentsDirectory(join(FIXTURES, "agents.d-multi"));
      const luna = agents.find((a) => a.id === "luna")!;
      expect(luna.runtime).toBeDefined();
      expect(luna.runtime!.substrate).toBe("codex");
      expect(luna.runtime!.mode).toBe("standalone");
      expect(luna.runtime!.capabilities).toEqual(["research"]);
    });
  });

  describe("file filtering", () => {
    test("skips non-yaml files silently", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-mixed-"));
      writeFileSync(join(dir, "README.md"), "this is documentation, not a fragment\n");
      writeFileSync(join(dir, "notes.txt"), "operator notes\n");
      // Drop one valid fragment so we know the loader still picked something up
      writeFileSync(
        join(dir, "echo.yaml"),
        validFragmentYaml("echo", "Echo", "./echo.md"),
      );
      writeFileSync(join(dir, "echo.md"), `---\ndisplayName: Echo\n---\n# Echo\n`);
      const agents = loadAgentsDirectory(dir);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.id).toBe("echo");
    });

    test("skips dotfiles silently", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-dotfiles-"));
      writeFileSync(join(dir, ".DS_Store"), "");
      writeFileSync(join(dir, ".hidden.yaml"), "id: hidden\n");
      writeFileSync(
        join(dir, "visible.yaml"),
        validFragmentYaml("visible", "Visible", "./visible.md"),
      );
      writeFileSync(join(dir, "visible.md"), `---\ndisplayName: Visible\n---\n`);
      const agents = loadAgentsDirectory(dir);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.id).toBe("visible");
    });

    test("accepts both .yaml and .yml extensions", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-ext-"));
      writeFileSync(
        join(dir, "yaml-ext.yaml"),
        validFragmentYaml("yaml-ext", "YamlExt", "./yaml-ext.md"),
      );
      writeFileSync(
        join(dir, "yml-ext.yml"),
        validFragmentYaml("yml-ext", "YmlExt", "./yml-ext.md"),
      );
      writeFileSync(join(dir, "yaml-ext.md"), `---\ndisplayName: YamlExt\n---\n`);
      writeFileSync(join(dir, "yml-ext.md"), `---\ndisplayName: YmlExt\n---\n`);
      const agents = loadAgentsDirectory(dir);
      expect(agents.map((a) => a.id).sort()).toEqual(["yaml-ext", "yml-ext"]);
    });
  });

  describe("error cases", () => {
    test("throws FragmentLoadError on malformed YAML", () => {
      expect(() => loadAgentsDirectory(join(FIXTURES, "agents.d-bad-yaml"))).toThrow(
        FragmentLoadError,
      );
    });

    test("malformed YAML error names the file", () => {
      try {
        loadAgentsDirectory(join(FIXTURES, "agents.d-bad-yaml"));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(FragmentLoadError);
        expect((err as FragmentLoadError).file).toContain("broken.yaml");
      }
    });

    test("throws FragmentLoadError on duplicate id across fragments", () => {
      expect(() => loadAgentsDirectory(join(FIXTURES, "agents.d-duplicate-id"))).toThrow(
        FragmentLoadError,
      );
    });

    test("duplicate id error names both files + the conflicting id", () => {
      try {
        loadAgentsDirectory(join(FIXTURES, "agents.d-duplicate-id"));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(FragmentLoadError);
        const msg = (err as FragmentLoadError).message;
        expect(msg).toContain("echo");
        expect(msg).toContain("echo-1.yaml");
        expect(msg).toContain("echo-2.yaml");
      }
    });

    test("throws FragmentLoadError on missing required field", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-no-id-"));
      writeFileSync(join(dir, "no-id.yaml"), "displayName: NoId\n");
      expect(() => loadAgentsDirectory(dir)).toThrow(FragmentLoadError);
    });

    test("throws FragmentLoadError when persona path resolves to nonexistent file", () => {
      expect(() => loadAgentsDirectory(join(FIXTURES, "agents.d-missing-persona"))).toThrow(
        FragmentLoadError,
      );
    });

    test("missing-persona error names the resolved path", () => {
      try {
        loadAgentsDirectory(join(FIXTURES, "agents.d-missing-persona"));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(FragmentLoadError);
        expect((err as FragmentLoadError).message).toContain("nonexistent-persona.md");
      }
    });

    test("rejects multi-document YAML (parse should be single-doc only)", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-multidoc-"));
      writeFileSync(
        join(dir, "multi.yaml"),
        `id: first\n---\nid: second\n`,
      );
      // yaml.parse() takes the FIRST doc and ignores trailing — but the first
      // doc lacks required fields, so validation should fail. The point is the
      // loader doesn't accidentally surface both docs as two agents.
      expect(() => loadAgentsDirectory(dir)).toThrow(FragmentLoadError);
    });
  });

  describe("persona path resolution", () => {
    test("resolves relative path against fragment's directory", () => {
      const agents = loadAgentsDirectory(join(FIXTURES, "agents.d-minimal"));
      expect(agents[0]!.persona).toMatch(/personas\/echo\.md$/);
    });

    test("accepts absolute persona path verbatim", () => {
      const dir = mkdtempSync(join(tmpdir(), "agents-d-abspath-"));
      const personaDir = mkdtempSync(join(tmpdir(), "personas-"));
      const personaPath = join(personaDir, "echo.md");
      writeFileSync(personaPath, `---\ndisplayName: Echo\n---\n`);
      writeFileSync(
        join(dir, "echo.yaml"),
        validFragmentYaml("echo", "Echo", personaPath),
      );
      const agents = loadAgentsDirectory(dir);
      expect(agents[0]!.persona).toBe(personaPath);
    });

    test("expands `~` in persona path to $HOME", () => {
      const home = process.env.HOME;
      if (!home) {
        // Skip when HOME is unset (e.g. some CI environments)
        return;
      }
      const dir = mkdtempSync(join(tmpdir(), "agents-d-tilde-"));
      const homeRelDir = mkdtempSync(join(home, "tilde-persona-"));
      const personaName = "echo.md";
      writeFileSync(
        join(homeRelDir, personaName),
        `---\ndisplayName: Echo\n---\n`,
      );
      // homeRelDir is e.g. /Users/x/tilde-persona-abc — strip $HOME to get the
      // tilde-relative path: ~/tilde-persona-abc/echo.md
      const tildePath = `~${homeRelDir.slice(home.length)}/${personaName}`;
      writeFileSync(
        join(dir, "echo.yaml"),
        validFragmentYaml("echo", "Echo", tildePath),
      );
      const agents = loadAgentsDirectory(dir);
      expect(agents[0]!.persona.startsWith(home)).toBe(true);
    });
  });
});

describe("FragmentLoadError", () => {
  test("carries the file path", () => {
    const err = new FragmentLoadError("/path/to/echo.yaml", "test reason");
    expect(err.file).toBe("/path/to/echo.yaml");
    expect(err.reason).toBe("test reason");
    expect(err.message).toContain("echo.yaml");
    expect(err.message).toContain("test reason");
  });

  test("preserves cause when provided", () => {
    const cause = new Error("underlying error");
    const err = new FragmentLoadError("/foo.yaml", "wrapped", cause);
    expect((err as { cause?: Error }).cause).toBe(cause);
  });

  test("instanceof Error", () => {
    const err = new FragmentLoadError("/foo.yaml", "msg");
    expect(err).toBeInstanceOf(Error);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function validFragmentYaml(id: string, displayName: string, personaPath: string): string {
  return `id: ${id}
displayName: ${displayName}
persona: ${personaPath}
roles: [agent-restricted]
presence:
  discord:
    enabled: false
    token: "t"
    guildId: "0"
    agentChannelId: "1"
    logChannelId: "2"
`;
}
