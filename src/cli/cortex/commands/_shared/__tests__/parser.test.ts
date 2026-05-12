// cortex#66 — parseSubcommandArgs tests.

import { describe, expect, test } from "bun:test";

import { parseSubcommandArgs, type SubcommandSpec } from "../parser";
import { CliArgsError } from "../arg-error";

// Mini grammar used across tests — reflects shapes both `agents` and
// `creds` CLIs use today.
const spec: SubcommandSpec<"list" | "issue" | "revoke"> = {
  cliName: "test-cli",
  subcommands: {
    list: { flags: { "--creds-dir": "value" } },
    issue: { positionals: ["agent-id"], flags: { "--config": "value" } },
    revoke: { positionals: ["agent-id"], flags: { "--config": "value" } },
  },
  universal: { "--help": "bool", "-h": "bool", "--json": "bool" },
};

describe("parseSubcommandArgs — subcommand selection", () => {
  test("recognizes 'list'", () => {
    const r = parseSubcommandArgs(spec, ["list"]);
    expect(r.subcommand).toBe("list");
    expect(r.rawSubcommand).toBe("list");
  });

  test("recognizes 'issue' with required positional", () => {
    const r = parseSubcommandArgs(spec, ["issue", "echo"]);
    expect(r.subcommand).toBe("issue");
    expect(r.positionals["agent-id"]).toBe("echo");
  });

  test("recognizes 'revoke' with positional", () => {
    const r = parseSubcommandArgs(spec, ["revoke", "echo"]);
    expect(r.subcommand).toBe("revoke");
    expect(r.positionals["agent-id"]).toBe("echo");
  });

  test("--help with no subcommand yields subcommand:help", () => {
    expect(parseSubcommandArgs(spec, ["--help"]).subcommand).toBe("help");
    expect(parseSubcommandArgs(spec, ["-h"]).subcommand).toBe("help");
  });

  test("empty argv yields subcommand:unknown", () => {
    expect(parseSubcommandArgs(spec, []).subcommand).toBe("unknown");
  });

  test("unknown subcommand yields rawSubcommand + subcommand:unknown", () => {
    const r = parseSubcommandArgs(spec, ["status"]);
    expect(r.subcommand).toBe("unknown");
    expect(r.rawSubcommand).toBe("status");
  });

  test("--help AFTER subcommand sets help:true (not subcommand:help)", () => {
    const r = parseSubcommandArgs(spec, ["list", "--help"]);
    expect(r.subcommand).toBe("list");
    expect(r.help).toBe(true);
  });
});

describe("parseSubcommandArgs — universal flags", () => {
  test("--json is accepted on every subcommand", () => {
    expect(parseSubcommandArgs(spec, ["list", "--json"]).flags["--json"]).toBe(true);
    expect(parseSubcommandArgs(spec, ["issue", "echo", "--json"]).flags["--json"]).toBe(true);
    expect(parseSubcommandArgs(spec, ["revoke", "echo", "--json"]).flags["--json"]).toBe(true);
  });

  test("absent --json defaults to undefined (not false)", () => {
    expect(parseSubcommandArgs(spec, ["list"]).flags["--json"]).toBeUndefined();
  });
});

describe("parseSubcommandArgs — flag scoping", () => {
  test("--creds-dir accepted on 'list'", () => {
    const r = parseSubcommandArgs(spec, ["list", "--creds-dir", "/tmp"]);
    expect(r.flags["--creds-dir"]).toBe("/tmp");
  });

  test("--creds-dir REJECTED on 'issue'", () => {
    expect(() =>
      parseSubcommandArgs(spec, ["issue", "echo", "--creds-dir", "/tmp"]),
    ).toThrow(CliArgsError);
  });

  test("--config accepted on 'issue'", () => {
    const r = parseSubcommandArgs(spec, ["issue", "echo", "--config", "/c.yaml"]);
    expect(r.flags["--config"]).toBe("/c.yaml");
  });

  test("--config REJECTED on 'list'", () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--config", "/c.yaml"])).toThrow(
      CliArgsError,
    );
  });

  test("unknown flag rejected", () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--verbose"])).toThrow(CliArgsError);
  });
});

describe("parseSubcommandArgs — flag values", () => {
  test("value-flag without value throws", () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--creds-dir"])).toThrow(CliArgsError);
  });

  test("value-flag followed by another flag throws", () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--creds-dir", "--json"])).toThrow(
      CliArgsError,
    );
  });

  test("value-flag captures the literal next argv entry", () => {
    const r = parseSubcommandArgs(spec, ["list", "--creds-dir", "/path with spaces"]);
    expect(r.flags["--creds-dir"]).toBe("/path with spaces");
  });
});

describe("parseSubcommandArgs — positionals", () => {
  test("missing required positional throws", () => {
    expect(() => parseSubcommandArgs(spec, ["issue"])).toThrow(CliArgsError);
  });

  test("error message names the missing positional", () => {
    try {
      parseSubcommandArgs(spec, ["issue"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliArgsError);
      expect((err as CliArgsError).message).toContain("agent-id");
    }
  });

  test("extra positional beyond declared list throws", () => {
    expect(() => parseSubcommandArgs(spec, ["issue", "echo", "extra"])).toThrow(
      CliArgsError,
    );
  });

  test("extra positional on a no-positional subcommand throws", () => {
    expect(() => parseSubcommandArgs(spec, ["list", "extra"])).toThrow(CliArgsError);
  });

  test("subcommands without `positionals` accept no extra positionals", () => {
    // list has flags but no positionals — passing one is an error
    expect(() => parseSubcommandArgs(spec, ["list", "x"])).toThrow(CliArgsError);
  });
});

describe("parseSubcommandArgs — flag order independence", () => {
  test("flags before subcommand still resolve to that subcommand's allowlist", () => {
    // --creds-dir BEFORE 'list' should still parse cleanly: the first pass
    // identifies 'list' from the positional, then the flag check applies
    // the list-subcommand allowlist.
    const r = parseSubcommandArgs(spec, ["--creds-dir", "/tmp", "list"]);
    expect(r.subcommand).toBe("list");
    expect(r.flags["--creds-dir"]).toBe("/tmp");
  });

  test("flags after positionals work", () => {
    const r = parseSubcommandArgs(spec, ["issue", "echo", "--config", "/c.yaml", "--json"]);
    expect(r.positionals["agent-id"]).toBe("echo");
    expect(r.flags["--config"]).toBe("/c.yaml");
    expect(r.flags["--json"]).toBe(true);
  });

  test("multiple flags + positionals in mixed order", () => {
    const r = parseSubcommandArgs(spec, [
      "issue",
      "--json",
      "echo",
      "--config",
      "/c.yaml",
    ]);
    expect(r.subcommand).toBe("issue");
    expect(r.positionals["agent-id"]).toBe("echo");
    expect(r.flags["--json"]).toBe(true);
    expect(r.flags["--config"]).toBe("/c.yaml");
  });
});

describe("parseSubcommandArgs — CliArgsError carries cliName", () => {
  test("cliName propagates from spec to thrown error", () => {
    try {
      parseSubcommandArgs(spec, ["list", "--verbose"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliArgsError);
      expect((err as CliArgsError).cliName).toBe("test-cli");
    }
  });
});
