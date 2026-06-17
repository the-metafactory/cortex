// cortex#66 — parseSubcommandArgs tests.

import { describe, expect, test } from "bun:test";

import { parseSubcommandArgs, type SubcommandSpec } from "../parser";
import { boolFlag, listFlag, valueFlag } from "../hydrate";
import {
  CliArgsError,
  MissingPositionalError,
  UnknownFlagError,
} from "../arg-error";

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

  // Echo cortex#66 round-1 M4 + round-3 architecture carry-over.
  // The pre-cortex#66 legacy parsers in agents.ts / creds.ts had a quirk
  // where `--help` BEFORE the subcommand got overwritten by the
  // subcommand-set step, yielding `subcommand: "list", help: false`. The
  // new generic parser correctly sets `help: true` whenever `--help`
  // appears anywhere once a subcommand is identifiable. These two tests
  // pin both orderings explicitly so the deliberate behavior correction
  // is contract-enforced.
  test("--help BEFORE subcommand → subcommand:'list', help:true (post-cortex#66 correction)", () => {
    const r = parseSubcommandArgs(spec, ["--help", "list"]);
    expect(r.subcommand).toBe("list");
    expect(r.help).toBe(true);
  });

  test("--help AFTER subcommand → subcommand:'list', help:true (same outcome — order-independent)", () => {
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

// Echo cortex#66 round-1 M1 — typed error subclasses replace regex-on-message.
describe("typed error subclasses", () => {
  test("missing-positional throws MissingPositionalError with positionalName", () => {
    try {
      parseSubcommandArgs(spec, ["issue"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingPositionalError);
      expect(err).toBeInstanceOf(CliArgsError); // still a CliArgsError
      expect((err as MissingPositionalError).positionalName).toBe("agent-id");
      expect((err as MissingPositionalError).cliName).toBe("test-cli");
    }
  });

  test("unknown-flag throws UnknownFlagError with flag", () => {
    try {
      parseSubcommandArgs(spec, ["list", "--verbose"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFlagError);
      expect((err as UnknownFlagError).flag).toBe("--verbose");
    }
  });

  test("flag-scoping violation throws UnknownFlagError (legacy wording, Echo M3)", () => {
    try {
      parseSubcommandArgs(spec, ["issue", "echo", "--creds-dir", "/tmp"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFlagError);
      // Echo M3 — the message uses "unknown flag: --creds-dir" (legacy
      // wording) regardless of whether the cause is "flag not in any
      // allowlist" or "flag not in this subcommand's allowlist."
      expect((err as Error).message).toBe("unknown flag: --creds-dir");
    }
  });
});

// Echo cortex#66 round-1 N5 — same-kind invariant on flags across subcommands.
describe("spec invariant: same-kind across subcommands", () => {
  test("throws when same flag declared with conflicting kinds", () => {
    const badSpec: SubcommandSpec<"a" | "b"> = {
      cliName: "bad",
      subcommands: {
        a: { flags: { "--mode": "value" } },
        b: { flags: { "--mode": "bool" } },
      },
      universal: {},
    };
    // Trigger the first-pass scan which walks the spec for flag kinds.
    expect(() => parseSubcommandArgs(badSpec, ["--mode", "x", "a"])).toThrow(
      /spec invariant violated.*--mode/,
    );
  });
});

// Echo cortex#66 round-1 M2 — kind-safe hydration helpers.
describe("hydrate helpers (valueFlag / boolFlag)", () => {
  test("valueFlag returns string when set", () => {
    const r = parseSubcommandArgs(spec, ["list", "--creds-dir", "/tmp"]);
    expect(valueFlag(r.flags, "--creds-dir")).toBe("/tmp");
  });

  test("valueFlag returns undefined when absent", () => {
    const r = parseSubcommandArgs(spec, ["list"]);
    expect(valueFlag(r.flags, "--creds-dir")).toBeUndefined();
  });

  test("valueFlag throws if flag was bool-typed and accessed as value", () => {
    const r = parseSubcommandArgs(spec, ["list", "--json"]);
    expect(() => valueFlag(r.flags, "--json")).toThrow(/declared as bool/);
  });

  test("boolFlag returns true when set, false when absent", () => {
    const r1 = parseSubcommandArgs(spec, ["list", "--json"]);
    expect(boolFlag(r1.flags, "--json")).toBe(true);
    const r2 = parseSubcommandArgs(spec, ["list"]);
    expect(boolFlag(r2.flags, "--json")).toBe(false);
  });

  test("boolFlag throws if flag was value-typed and accessed as bool", () => {
    const r = parseSubcommandArgs(spec, ["list", "--creds-dir", "/tmp"]);
    expect(() => boolFlag(r.flags, "--creds-dir")).toThrow(/declared as value/);
  });
});

// cortex#1057 (O-2.5) — repeatable value-list flags. A `value-list` flag
// accumulates each occurrence into a string[] (vs `value`'s last-wins).
// Needed so `cortex creds issue --pub a --pub b` collects both subjects.
const listSpec: SubcommandSpec<"issue"> = {
  cliName: "list-cli",
  subcommands: {
    issue: {
      positionals: ["agent-id"],
      flags: { "--pub": "value-list", "--sub": "value-list" },
    },
  },
  universal: { "--help": "bool", "-h": "bool", "--json": "bool" },
};

describe("parseSubcommandArgs — value-list flags (cortex#1057)", () => {
  test("single occurrence yields a one-element array", () => {
    const r = parseSubcommandArgs(listSpec, ["issue", "echo", "--pub", "a.>"]);
    expect(r.flags["--pub"]).toEqual(["a.>"]);
  });

  test("multiple occurrences accumulate in order", () => {
    const r = parseSubcommandArgs(listSpec, [
      "issue", "echo", "--pub", "a.>", "--pub", "b.>", "--pub", "c.>",
    ]);
    expect(r.flags["--pub"]).toEqual(["a.>", "b.>", "c.>"]);
  });

  test("--pub and --sub collect independently", () => {
    const r = parseSubcommandArgs(listSpec, [
      "issue", "echo", "--pub", "p1", "--sub", "s1", "--pub", "p2",
    ]);
    expect(r.flags["--pub"]).toEqual(["p1", "p2"]);
    expect(r.flags["--sub"]).toEqual(["s1"]);
  });

  test("absent value-list flag is undefined", () => {
    const r = parseSubcommandArgs(listSpec, ["issue", "echo"]);
    expect(r.flags["--pub"]).toBeUndefined();
  });

  test("value-list flag without a value throws", () => {
    expect(() => parseSubcommandArgs(listSpec, ["issue", "echo", "--pub"])).toThrow(
      CliArgsError,
    );
  });

  test("value-list flag followed by another flag throws", () => {
    expect(() =>
      parseSubcommandArgs(listSpec, ["issue", "echo", "--pub", "--json"]),
    ).toThrow(CliArgsError);
  });

  test("first-pass positional scan skips value-list values", () => {
    // --pub consumes "a.>"; the subcommand "issue" must still be identified
    // and "echo" captured as the positional.
    const r = parseSubcommandArgs(listSpec, [
      "--pub", "a.>", "issue", "echo",
    ]);
    expect(r.subcommand).toBe("issue");
    expect(r.positionals["agent-id"]).toBe("echo");
    expect(r.flags["--pub"]).toEqual(["a.>"]);
  });
});

describe("hydrate listFlag (cortex#1057)", () => {
  test("listFlag returns the array when set", () => {
    const r = parseSubcommandArgs(listSpec, ["issue", "echo", "--pub", "a", "--pub", "b"]);
    expect(listFlag(r.flags, "--pub")).toEqual(["a", "b"]);
  });

  test("listFlag returns [] when absent", () => {
    const r = parseSubcommandArgs(listSpec, ["issue", "echo"]);
    expect(listFlag(r.flags, "--pub")).toEqual([]);
  });

  test("listFlag throws if accessed on a non-list flag", () => {
    const r = parseSubcommandArgs(listSpec, ["issue", "echo", "--json"]);
    expect(() => listFlag(r.flags, "--json")).toThrow(/declared as bool/);
  });
});

// Echo cortex#66 round-1 — typed-error carrying parser-supplied rawSubcommand.
describe("MissingPositionalError carries rawSubcommand", () => {
  test("rawSubcommand reflects parser's first-pass scan (skips flag values)", () => {
    // ["--config", "/tmp", "issue"] — `/tmp` is the value of --config, not
    // a positional. Parser must identify "issue" as the subcommand even
    // though the missing-positional throw fires before second-pass completion.
    try {
      parseSubcommandArgs(spec, ["--config", "/tmp", "issue"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingPositionalError);
      expect((err as MissingPositionalError).rawSubcommand).toBe("issue");
    }
  });
});

// Echo cortex#66 round-1 — prototype-pollution defense.
describe("prototype-pollution defense", () => {
  test('"constructor" as subcommand is unknown (uses hasOwnProperty.call)', () => {
    const r = parseSubcommandArgs(spec, ["constructor"]);
    expect(r.subcommand).toBe("unknown");
    expect(r.rawSubcommand).toBe("constructor");
  });

  test('"toString" / "hasOwnProperty" / "__proto__" as subcommand all unknown', () => {
    expect(parseSubcommandArgs(spec, ["toString"]).subcommand).toBe("unknown");
    expect(parseSubcommandArgs(spec, ["hasOwnProperty"]).subcommand).toBe("unknown");
    expect(parseSubcommandArgs(spec, ["__proto__"]).subcommand).toBe("unknown");
  });

  // Echo cortex#66 round-2 security warning — `resolveFlagKind` previously
  // used bare `in`, traversing the prototype chain. `--toString` etc. would
  // resolve to `Object.prototype.toString` and silently set a `true` flag.
  test('"--toString" as flag throws UnknownFlagError (not Object.prototype.toString)', () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--toString"])).toThrow(
      UnknownFlagError,
    );
  });

  test('"--__proto__" as flag throws UnknownFlagError', () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--__proto__"])).toThrow(
      UnknownFlagError,
    );
  });

  test('"--constructor" as flag throws UnknownFlagError', () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--constructor"])).toThrow(
      UnknownFlagError,
    );
  });

  test('"--hasOwnProperty" as flag throws UnknownFlagError', () => {
    expect(() => parseSubcommandArgs(spec, ["list", "--hasOwnProperty"])).toThrow(
      UnknownFlagError,
    );
  });
});

// Echo cortex#66 round-1 N6 — missing edge cases.
describe("edge cases", () => {
  test("--flag=value syntax is currently NOT supported (documented gap)", () => {
    // The parser splits on whitespace, not `=`. `--creds-dir=/tmp` would be
    // treated as a single unknown flag. This test documents the gap; if
    // principals ever ask for the syntax, lift the gap in a follow-up.
    expect(() => parseSubcommandArgs(spec, ["list", "--creds-dir=/tmp"])).toThrow(
      UnknownFlagError,
    );
  });

  test("repeated bool flag is idempotent (last write wins, both set true)", () => {
    const r = parseSubcommandArgs(spec, ["list", "--json", "--json"]);
    expect(r.flags["--json"]).toBe(true);
  });

  test("repeated value-flag overwrites earlier value", () => {
    const r = parseSubcommandArgs(spec, [
      "list",
      "--creds-dir",
      "/tmp/first",
      "--creds-dir",
      "/tmp/second",
    ]);
    expect(r.flags["--creds-dir"]).toBe("/tmp/second");
  });

  // Echo cortex#66 round-1 perf — pin the current dash-prefix-rejection
  // behavior with a test so a future lift (to allow `-foo.txt`-style
  // values) is intentional.
  test("value-flag rejects values that start with '-' (legitimate paths excluded today)", () => {
    expect(() =>
      parseSubcommandArgs(spec, ["list", "--creds-dir", "-foo.txt"]),
    ).toThrow(CliArgsError);
  });
});
