// F-4 — cortex creds CLI tests.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  parseCredsArgs,
  runCredsList,
  runCredsIssue,
  runCredsRevoke,
  runCredsRotate,
  dispatchCreds,
  DEFERRED_SUBCOMMAND_MESSAGE,
} from "../creds";
import { CliArgsError } from "../_shared/arg-error";

// =============================================================================
// parseCredsArgs
// =============================================================================

describe("parseCredsArgs", () => {
  test("parses 'list' subcommand", () => {
    expect(parseCredsArgs(["list"]).subcommand).toBe("list");
  });

  test("parses 'issue <id>' subcommand", () => {
    const args = parseCredsArgs(["issue", "echo"]);
    expect(args.subcommand).toBe("issue");
    expect(args.agentId).toBe("echo");
  });

  test("parses 'revoke <id>' subcommand", () => {
    const args = parseCredsArgs(["revoke", "echo"]);
    expect(args.subcommand).toBe("revoke");
    expect(args.agentId).toBe("echo");
  });

  test("parses 'rotate <id>' subcommand", () => {
    const args = parseCredsArgs(["rotate", "echo"]);
    expect(args.subcommand).toBe("rotate");
    expect(args.agentId).toBe("echo");
  });

  test("--help yields subcommand=help", () => {
    expect(parseCredsArgs(["--help"]).subcommand).toBe("help");
    expect(parseCredsArgs(["-h"]).subcommand).toBe("help");
  });

  test("no args → unknown", () => {
    expect(parseCredsArgs([]).subcommand).toBe("unknown");
  });

  test("unknown subcommand → unknown", () => {
    expect(parseCredsArgs(["status"]).subcommand).toBe("unknown");
    expect(parseCredsArgs(["status"]).rawSubcommand).toBe("status");
  });

  test("parses --creds-dir flag", () => {
    const args = parseCredsArgs(["list", "--creds-dir", "/tmp/foo"]);
    expect(args.credsDir).toBe("/tmp/foo");
  });

  test("parses --json flag", () => {
    expect(parseCredsArgs(["list", "--json"]).json).toBe(true);
  });

  test("parses --config flag", () => {
    const args = parseCredsArgs(["issue", "echo", "--config", "/tmp/cortex.yaml"]);
    expect(args.config).toBe("/tmp/cortex.yaml");
  });

  describe("CliArgsError throws", () => {
    test("throws when --creds-dir is missing its value", () => {
      expect(() => parseCredsArgs(["list", "--creds-dir"])).toThrow(CliArgsError);
    });

    test("throws when --config is missing its value", () => {
      expect(() => parseCredsArgs(["issue", "echo", "--config"])).toThrow(CliArgsError);
    });

    test("throws on unknown flag", () => {
      expect(() => parseCredsArgs(["list", "--verbose"])).toThrow(CliArgsError);
    });

    test("throws on extra positional argument for list", () => {
      expect(() => parseCredsArgs(["list", "extra"])).toThrow(CliArgsError);
    });

    test("throws on extra positional for issue beyond <id>", () => {
      expect(() => parseCredsArgs(["issue", "echo", "extra"])).toThrow(CliArgsError);
    });
  });

  // Echo M3 on cortex#64 — per-subcommand flag allowlist.
  describe("per-subcommand flag scoping (Echo M3)", () => {
    test("--creds-dir is rejected on issue", () => {
      expect(() => parseCredsArgs(["issue", "echo", "--creds-dir", "/tmp"])).toThrow(
        CliArgsError,
      );
    });

    test("--creds-dir is rejected on revoke", () => {
      expect(() => parseCredsArgs(["revoke", "echo", "--creds-dir", "/tmp"])).toThrow(
        CliArgsError,
      );
    });

    test("--creds-dir is rejected on rotate", () => {
      expect(() => parseCredsArgs(["rotate", "echo", "--creds-dir", "/tmp"])).toThrow(
        CliArgsError,
      );
    });

    test("--config is rejected on list", () => {
      expect(() => parseCredsArgs(["list", "--config", "/tmp/c.yaml"])).toThrow(
        CliArgsError,
      );
    });

    test("--json is universal", () => {
      // Should not throw for any subcommand
      expect(parseCredsArgs(["list", "--json"]).json).toBe(true);
      expect(parseCredsArgs(["issue", "echo", "--json"]).json).toBe(true);
    });
  });
});

// =============================================================================
// runCredsList
// =============================================================================

describe("runCredsList", () => {
  test("lists creds files in a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-list-"));
    writeFileSync(join(dir, "echo.creds"), "-----BEGIN NATS USER JWT-----\n...\n");
    writeFileSync(join(dir, "holly.creds"), "-----BEGIN NATS USER JWT-----\n...\n");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
    expect(r.stdout).toContain("holly");
  });

  test("output is sorted alphabetically by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-sort-"));
    writeFileSync(join(dir, "zeta.creds"), "x");
    writeFileSync(join(dir, "alpha.creds"), "x");
    writeFileSync(join(dir, "mike.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    const lines = r.stdout.trim().split("\n");
    // First three lines should be the alphabetical order
    expect(lines[0]).toContain("alpha");
    expect(lines[1]).toContain("mike");
    expect(lines[2]).toContain("zeta");
  });

  test("empty dir → exit 0 with friendly message", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-empty-"));
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/0 creds/);
  });

  test("nonexistent dir → exit 0 with 'no creds dir' message", () => {
    const r = runCredsList(
      parseCredsArgs(["list", "--creds-dir", "/tmp/nonexistent-f4-xyz"]),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/0 creds/);
  });

  test("skips dotfiles silently", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-dotfiles-"));
    writeFileSync(join(dir, ".DS_Store"), "");
    writeFileSync(join(dir, "echo.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.stdout).toContain("echo");
    expect(r.stdout).not.toContain("DS_Store");
  });

  test("--json emits envelope with creds array", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-list-json-"));
    writeFileSync(join(dir, "echo.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir, "--json"]));
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("ok");
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items[0].id).toBe("echo");
    expect(parsed.items[0].path).toContain("echo.creds");
    expect(parsed.items[0].issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("--json on empty dir emits envelope with creds: []", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-empty-json-"));
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir, "--json"]));
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("ok");
    expect(parsed.items).toEqual([]);
  });

  test("strips multiple extensions (e.g. echo.creds.json → echo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-multi-ext-"));
    writeFileSync(join(dir, "echo.creds"), "x");
    writeFileSync(join(dir, "holly.nats.creds"), "x");
    const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
    expect(r.stdout).toContain("echo");
  });

  // Echo M1 on cortex#64 — id derivation now validates against agent-id
  // regex and detects collisions.
  describe("filesystem id hygiene (Echo M1)", () => {
    test("skips files whose stem doesn't match /^[a-z0-9-]+$/", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-bad-stem-"));
      writeFileSync(join(dir, "Echo!.creds"), "x"); // uppercase + special char
      writeFileSync(join(dir, "ok-agent.creds"), "x");
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok-agent");
      expect(r.stdout).not.toContain("Echo!");
      // Warning on stderr names the skipped file
      expect(r.stderr).toContain("Echo!.creds");
      expect(r.stderr).toMatch(/doesn't match agent-id regex/);
    });

    test("skips id collisions and warns naming both files", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-collide-"));
      writeFileSync(join(dir, "echo.creds"), "first");
      writeFileSync(join(dir, "echo.nats.creds"), "second");
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(0);
      // Only one "echo" in output (the first one alphabetically) — collision warned
      const lines = r.stdout.trim().split("\n").filter((l) => l.startsWith("echo"));
      expect(lines).toHaveLength(1);
      expect(r.stderr).toContain("echo.creds");
      expect(r.stderr).toContain("echo.nats.creds");
      expect(r.stderr).toMatch(/already taken/);
    });

    test("malformed stems are reported in JSON mode via stderr (not envelope)", () => {
      // JSON envelope is for machine-readable success/items shape; warnings
      // are diagnostic information for humans + log scrapers. They live on
      // stderr regardless of --json.
      const dir = mkdtempSync(join(tmpdir(), "f4-bad-stem-json-"));
      writeFileSync(join(dir, "BadName.creds"), "x");
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir, "--json"]));
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.items).toEqual([]);
      expect(r.stderr).toContain("BadName.creds");
    });
  });

  // cortex#65 — Echo round-2 H1 nit on cortex#64: cap was enforced in
  // code but not exercised by a test. Closes the regression risk if
  // someone flips `>` to `>=`.
  describe("hardening cap (Echo H1)", () => {
    test("refuses to enumerate when directory has > 10_000 entries", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-h1-cap-"));
      for (let i = 0; i < 10_001; i++) {
        writeFileSync(join(dir, `agent-${i}.creds`), "x");
      }
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch(/refusing to enumerate/);
      expect(r.stderr).toContain("10001");
      expect(r.stderr).toContain("10000");
    });

    test("accepts exactly 10_000 entries (boundary)", () => {
      const dir = mkdtempSync(join(tmpdir(), "f4-h1-boundary-"));
      for (let i = 0; i < 10_000; i++) {
        writeFileSync(join(dir, `agent-${i}.creds`), "x");
      }
      const r = runCredsList(parseCredsArgs(["list", "--creds-dir", dir]));
      expect(r.exitCode).toBe(0);
    });
  });
});

// =============================================================================
// Deferred subcommands (issue / revoke / rotate)
// =============================================================================

describe("deferred subcommands", () => {
  test("runCredsIssue returns exit 2 with deferred message", () => {
    const r = runCredsIssue(parseCredsArgs(["issue", "echo"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(DEFERRED_SUBCOMMAND_MESSAGE);
  });

  test("runCredsRevoke returns exit 2 with deferred message", () => {
    const r = runCredsRevoke(parseCredsArgs(["revoke", "echo"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(DEFERRED_SUBCOMMAND_MESSAGE);
  });

  test("runCredsRotate returns exit 2 with deferred message", () => {
    const r = runCredsRotate(parseCredsArgs(["rotate", "echo"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(DEFERRED_SUBCOMMAND_MESSAGE);
  });

  test("issue rejects invalid agent id (not lowercase alphanumeric)", () => {
    const r = runCredsIssue(parseCredsArgs(["issue", "Echo!"]));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/agent id/i);
  });

  test("issue rejects empty agent id", () => {
    const r = runCredsIssue({
      ...parseCredsArgs(["issue", "x"]),
      agentId: "",
    });
    expect(r.exitCode).toBe(2);
  });

  test("--json on deferred subcommand emits envelope", () => {
    const r = runCredsIssue(parseCredsArgs(["issue", "echo", "--json"]));
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.status).toBe("error");
    expect(parsed.items).toEqual([]);
    expect(parsed.error.reason).toContain(DEFERRED_SUBCOMMAND_MESSAGE);
    // Echo M2 + M4 round 1 — error context lives under `error.context.<key>`
    // in the shared envelope shape.
    expect(parsed.error.context.subcommand).toBe("issue");
    expect(parsed.error.context.agentId).toBe("echo");
  });
});

// =============================================================================
// dispatchCreds
// =============================================================================

describe("dispatchCreds", () => {
  test("routes 'list' to runCredsList", () => {
    const dir = mkdtempSync(join(tmpdir(), "f4-dispatch-list-"));
    writeFileSync(join(dir, "echo.creds"), "x");
    const r = dispatchCreds(["list", "--creds-dir", dir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
  });

  test("routes 'issue' to runCredsIssue (deferred)", () => {
    const r = dispatchCreds(["issue", "echo"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain(DEFERRED_SUBCOMMAND_MESSAGE);
  });

  test("--help prints top-level help", () => {
    const r = dispatchCreds(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cortex creds");
    expect(r.stdout).toContain("issue");
    expect(r.stdout).toContain("revoke");
    expect(r.stdout).toContain("rotate");
    expect(r.stdout).toContain("list");
  });

  test("unknown subcommand → exit 2", () => {
    const r = dispatchCreds(["status"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown");
    expect(r.stderr).toContain("status");
  });

  test("no subcommand → exit 2 with help", () => {
    const r = dispatchCreds([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("usage");
  });

  test("CliArgsError → exit 2 with named flag", () => {
    const r = dispatchCreds(["list", "--verbose"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--verbose");
  });

  test("issue without <id> arg → exit 2 usage error", () => {
    const r = dispatchCreds(["issue"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/missing.*agent id|requires.*id/i);
  });
});
