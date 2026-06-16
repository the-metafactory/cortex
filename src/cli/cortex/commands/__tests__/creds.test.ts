// cortex#79 — `cortex creds` CLI tests. Mutation paths now shell out to
// `arc nats … --json`; the runner is injected via `__setArcRunnerForTests`
// so tests stay hermetic (no real `arc` binary required).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  __setArcRunnerForTests,
  dispatchCreds,
  parseCredsArgs,
  runCredsIssue,
  runCredsList,
  runCredsRevoke,
  runCredsRotate,
  MIN_ARC_VERSION,
  type ArcRunner,
  type ArcRunResult,
  type ParsedCredsArgs,
} from "../creds";
import { CliArgsError } from "../_shared/arg-error";

// =============================================================================
// Mock arc runner — captures argv, returns programmed result
// =============================================================================

interface MockArcRunner {
  runner: ArcRunner;
  /** Most recent argv passed to `arc` — `["nats", "add-bot", …]`. */
  lastArgv: readonly string[] | null;
  /** Full argv history when a test exercises multiple invocations. */
  argvLog: (readonly string[])[];
}

function mockArc(
  result: ArcRunResult | ((argv: readonly string[]) => ArcRunResult),
): MockArcRunner {
  const state: { lastArgv: readonly string[] | null; argvLog: (readonly string[])[] } = {
    lastArgv: null,
    argvLog: [],
  };
  const runner: ArcRunner = async (argv) => {
    state.lastArgv = argv;
    state.argvLog.push(argv);
    return typeof result === "function" ? result(argv) : result;
  };
  return {
    runner,
    get lastArgv() {
      return state.lastArgv;
    },
    get argvLog() {
      return state.argvLog;
    },
  };
}

/** Build an arc.nats.v1 success envelope for add-bot. */
function addBotOk(opts: { bot: string; account?: string; credsPath?: string; pubKey?: string }): string {
  return JSON.stringify({
    schema: "arc.nats.v1",
    ok: true,
    bot: opts.bot,
    account: opts.account ?? "OP_JC",
    credsPath: opts.credsPath ?? `/tmp/${opts.bot}.creds`,
    jwt: "eyJ-fake",
    pubKey: opts.pubKey ?? "UAFAKEPUBKEY",
  });
}

function reissueBotOk(opts: { bot: string; newPubKey?: string; revokedPubKey?: string }): string {
  return JSON.stringify({
    schema: "arc.nats.v1",
    ok: true,
    bot: opts.bot,
    account: "OP_JC",
    credsPath: `/tmp/${opts.bot}.creds`,
    newPubKey: opts.newPubKey ?? "UANEWKEY",
    revokedPubKey: opts.revokedPubKey ?? "UAOLDKEY",
  });
}

function removeBotOk(opts: { bot: string; revokedPubKey?: string; credsFileDeleted?: boolean }): string {
  return JSON.stringify({
    schema: "arc.nats.v1",
    ok: true,
    bot: opts.bot,
    account: "OP_JC",
    revokedPubKey: opts.revokedPubKey ?? "UAREVOKED",
    credsFileDeleted: opts.credsFileDeleted ?? true,
  });
}

function arcErr(code: string, message: string): string {
  return JSON.stringify({ schema: "arc.nats.v1", ok: false, error: { code, message } });
}

afterEach(() => {
  __setArcRunnerForTests(null);
});

// =============================================================================
// parseCredsArgs
// =============================================================================

describe("parseCredsArgs", () => {
  test("parses 'list' subcommand", () => {
    const r = parseCredsArgs(["list"]);
    expect(r.subcommand).toBe("list");
  });

  test("parses 'issue <id>' subcommand", () => {
    const r = parseCredsArgs(["issue", "echo"]);
    expect(r.subcommand).toBe("issue");
    expect(r.agentId).toBe("echo");
  });

  test("parses 'revoke <id>' subcommand", () => {
    const r = parseCredsArgs(["revoke", "luna"]);
    expect(r.subcommand).toBe("revoke");
    expect(r.agentId).toBe("luna");
  });

  test("parses 'rotate <id>' subcommand", () => {
    const r = parseCredsArgs(["rotate", "holly"]);
    expect(r.subcommand).toBe("rotate");
    expect(r.agentId).toBe("holly");
  });

  test("--help yields subcommand=help", () => {
    const r = parseCredsArgs(["--help"]);
    expect(r.subcommand).toBe("help");
  });

  test("no args → unknown", () => {
    const r = parseCredsArgs([]);
    expect(r.subcommand).toBe("unknown");
  });

  test("unknown subcommand → unknown", () => {
    const r = parseCredsArgs(["unicorn"]);
    expect(r.subcommand).toBe("unknown");
    expect(r.rawSubcommand).toBe("unicorn");
  });

  test("parses --creds-dir flag", () => {
    const r = parseCredsArgs(["list", "--creds-dir", "/tmp/x"]);
    expect(r.credsDir).toBe("/tmp/x");
  });

  test("parses --json flag", () => {
    const r = parseCredsArgs(["list", "--json"]);
    expect(r.json).toBe(true);
  });

  test("parses --account flag on issue", () => {
    const r = parseCredsArgs(["issue", "echo", "--account", "OP_JC"]);
    expect(r.account).toBe("OP_JC");
  });

  test("parses --account flag on revoke", () => {
    const r = parseCredsArgs(["revoke", "echo", "--account", "OP_ANDREAS"]);
    expect(r.account).toBe("OP_ANDREAS");
  });

  test("parses --account flag on rotate", () => {
    const r = parseCredsArgs(["rotate", "echo", "--account", "OP_JC"]);
    expect(r.account).toBe("OP_JC");
  });

  describe("CliArgsError throws", () => {
    test("--creds-dir without value throws", () => {
      expect(() => parseCredsArgs(["list", "--creds-dir"])).toThrow(CliArgsError);
    });
    test("--account without value throws", () => {
      expect(() => parseCredsArgs(["issue", "echo", "--account"])).toThrow(CliArgsError);
    });
  });

  describe("per-subcommand flag scoping", () => {
    test("--account is rejected on list", () => {
      expect(() => parseCredsArgs(["list", "--account", "x"])).toThrow(CliArgsError);
    });
    test("--creds-dir is rejected on issue", () => {
      expect(() => parseCredsArgs(["issue", "echo", "--creds-dir", "/tmp"])).toThrow(CliArgsError);
    });
    test("--creds-dir is rejected on revoke", () => {
      expect(() => parseCredsArgs(["revoke", "echo", "--creds-dir", "/tmp"])).toThrow(CliArgsError);
    });
  });
});

// =============================================================================
// runCredsList — local filesystem scan
// =============================================================================

describe("runCredsList", () => {
  function withTmpDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "creds-list-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("lists creds files in a directory", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "echo.creds"), "fake");
      writeFileSync(join(dir, "luna.creds"), "fake");
      const r = runCredsList({
        subcommand: "list", rawSubcommand: "list", agentId: undefined,
        credsDir: dir, account: undefined, pub: [], sub: [], json: false, help: false,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("echo");
      expect(r.stdout).toContain("luna");
    });
  });

  test("output sorted alphabetically by id", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "zulu.creds"), "fake");
      writeFileSync(join(dir, "alpha.creds"), "fake");
      const r = runCredsList({
        subcommand: "list", rawSubcommand: "list", agentId: undefined,
        credsDir: dir, account: undefined, pub: [], sub: [], json: false, help: false,
      });
      expect(r.stdout.indexOf("alpha")).toBeLessThan(r.stdout.indexOf("zulu"));
    });
  });

  test("empty dir → exit 0", () => {
    withTmpDir((dir) => {
      const r = runCredsList({
        subcommand: "list", rawSubcommand: "list", agentId: undefined,
        credsDir: dir, account: undefined, pub: [], sub: [], json: false, help: false,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("0 creds files");
    });
  });

  test("nonexistent dir → exit 0 with 'does not exist' note", () => {
    const r = runCredsList({
      subcommand: "list", rawSubcommand: "list", agentId: undefined,
      credsDir: "/tmp/does-not-exist-xyz", account: undefined, pub: [], sub: [], json: false, help: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("does not exist");
  });

  test("--json emits envelope with creds array", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "echo.creds"), "fake");
      const r = runCredsList({
        subcommand: "list", rawSubcommand: "list", agentId: undefined,
        credsDir: dir, account: undefined, pub: [], sub: [], json: true, help: false,
      });
      const parsed = JSON.parse(r.stdout);
      expect(parsed.status).toBe("ok");
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].id).toBe("echo");
    });
  });

  test("skips files whose stem fails the agent-id regex", () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, "Bad!Name.creds"), "fake");
      writeFileSync(join(dir, "ok.creds"), "fake");
      const r = runCredsList({
        subcommand: "list", rawSubcommand: "list", agentId: undefined,
        credsDir: dir, account: undefined, pub: [], sub: [], json: false, help: false,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("ok");
      expect(r.stderr).toContain("Bad!Name");
    });
  });
});

// =============================================================================
// Principal-input validation — applies before any subprocess call
// =============================================================================

function args(subcommand: "issue" | "revoke" | "rotate", overrides: Partial<ParsedCredsArgs> = {}): ParsedCredsArgs {
  return {
    subcommand,
    rawSubcommand: subcommand,
    agentId: "echo",
    credsDir: undefined,
    account: undefined,
    pub: [],
    sub: [],
    json: false,
    help: false,
    ...overrides,
  };
}

describe("principal-input validation", () => {
  test("issue rejects invalid agent id (uppercase)", async () => {
    const r = await runCredsIssue(args("issue", { agentId: "BadName" }));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid");
  });

  test("issue rejects empty agent id (parser path)", async () => {
    const r = await runCredsIssue(args("issue", { agentId: undefined }));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("missing agent id");
  });

  test("revoke rejects invalid agent id", async () => {
    const r = await runCredsRevoke(args("revoke", { agentId: "WITH_UNDERSCORE" }));
    expect(r.exitCode).toBe(2);
  });

  test("rotate rejects invalid agent id", async () => {
    const r = await runCredsRotate(args("rotate", { agentId: "has.dot" }));
    expect(r.exitCode).toBe(2);
  });

  test("validation error emits envelope shape in --json", async () => {
    const r = await runCredsIssue(args("issue", { agentId: "BAD", json: true }));
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("error");
    expect(env.error.context.subcommand).toBe("issue");
  });
});

// =============================================================================
// arc shellout — argv composition
// =============================================================================

describe("arc shellout — argv composition", () => {
  test("issue invokes `arc nats add-bot <id> --pub <default> --sub <default> --json`", async () => {
    // cortex#1057 — issue ALWAYS scopes; omitting --pub/--sub applies the
    // safe default (federated.<id>.> + _INBOX.>) rather than issuing unscoped.
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "federated.echo.>,_INBOX.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
  });

  test("rotate invokes `arc nats reissue-bot <id> --json`", async () => {
    const mock = mockArc({ stdout: reissueBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsRotate(args("rotate", { agentId: "echo" }));
    expect(mock.lastArgv).toEqual(["nats", "reissue-bot", "echo", "--json"]);
  });

  test("revoke invokes `arc nats remove-bot <id> --delete-creds --json`", async () => {
    const mock = mockArc({ stdout: removeBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsRevoke(args("revoke", { agentId: "echo" }));
    expect(mock.lastArgv).toEqual(["nats", "remove-bot", "echo", "--delete-creds", "--json"]);
  });

  test("--account is passed through to arc (before the scope flags)", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo", account: "OP_X" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo", account: "OP_X" }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--account", "OP_X",
      "--pub", "federated.echo.>,_INBOX.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
  });

  test("--account is passed through on revoke (before --delete-creds)", async () => {
    const mock = mockArc({ stdout: removeBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsRevoke(args("revoke", { agentId: "echo", account: "OP_X" }));
    expect(mock.lastArgv).toEqual(["nats", "remove-bot", "echo", "--account", "OP_X", "--delete-creds", "--json"]);
  });
});

// =============================================================================
// cortex#1057 (O-2.5) — --pub/--sub subject-scope passthrough + safe default
//
// arc's `add-bot --pub <subjects>` takes a SINGLE comma-separated string
// (Commander option, last-wins if repeated; arc splits on ","). cortex's
// surface accepts REPEATABLE --pub/--sub for ergonomics and joins them with
// commas into one arc flag — passing one arc flag per value would silently
// drop all but the last subject (the exact leak this slice prevents).
//
// The subject scope IS the isolation boundary in ADR-0012's shared-account
// default: an UNSCOPED bot in the shared `community` account could subscribe
// `federated.>` (everyone). So an omitted scope is NOT issued unscoped — it
// defaults to `federated.<sanitized-agent-id>.>` + `_INBOX.>`.
// =============================================================================

describe("creds issue — explicit --pub/--sub passthrough (cortex#1057)", () => {
  test("explicit single --pub/--sub thread verbatim into arc as one flag each", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "leaf-jc" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", {
      agentId: "leaf-jc",
      account: "community",
      pub: ["federated.jc.>"],
      sub: ["federated.jc.>"],
    }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "leaf-jc",
      "--account", "community",
      "--pub", "federated.jc.>",
      "--sub", "federated.jc.>",
      "--json",
    ]);
  });

  test("multiple --pub values are comma-joined into a single arc --pub flag", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "leaf-jc" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", {
      agentId: "leaf-jc",
      pub: ["federated.jc.>", "_INBOX.>"],
      sub: ["federated.jc.>", "_INBOX.>"],
    }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "leaf-jc",
      "--pub", "federated.jc.>,_INBOX.>",
      "--sub", "federated.jc.>,_INBOX.>",
      "--json",
    ]);
  });

  test("only --pub given → --pub threaded, --sub falls back to safe default", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo", pub: ["custom.>"] }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "custom.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
  });

  // NIT-2 — mirror of "only --pub given": --pub and --sub default
  // independently, so passing only --sub must still get a safe --pub default.
  test("only --sub given → --sub threaded, --pub falls back to safe default", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo", sub: ["custom.>"] }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "federated.echo.>,_INBOX.>",
      "--sub", "custom.>",
      "--json",
    ]);
  });
});

describe("creds issue — whitespace-padded scope cannot bypass safe default (cortex#1057 NIT-1)", () => {
  test('--pub " federated.> " is trimmed → collapses to safe default, not everyone-scope', async () => {
    // arc does `split(",").map(s => s.trim())`, so a padded value would be
    // un-padded by arc back into the everyone-subject `federated.>`. cortex
    // must trim first: a whitespace-padded everyone-subject is still the
    // everyone-subject and must NOT be allowed through. The chosen behavior
    // is: trim → the value survives only if it's a real (non-empty) subject;
    // here the caller deliberately passed the everyone token, so it reaches
    // arc as the trimmed literal — that's caller self-sabotage we surface,
    // NOT a silent un-padding bypass. The load-bearing guarantee is that
    // cortex's view equals arc's view (no hidden padding).
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo", pub: [" federated.jc.> "] }));
    // The padded value is trimmed before join — arc receives the clean token,
    // exactly what arc would compute, so there is no cortex-vs-arc divergence.
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "federated.jc.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
  });

  test("whitespace-only --pub collapses to [] → safe default applied (NOT everyone)", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    // `--pub "   "` is whitespace-only: after trim+filter it's empty, so the
    // safe default kicks in rather than an empty arc --pub (which arc would
    // treat as no scope). The everyone-subject must never materialize.
    await runCredsIssue(args("issue", { agentId: "echo", pub: ["   "] }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "federated.echo.>,_INBOX.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
    const flat = (mock.lastArgv ?? []).join(" ");
    expect(flat).not.toContain("federated.>");
    // No empty arc --pub value snuck through.
    expect(flat).not.toContain("--pub  ");
  });

  test("empty-after-split values are dropped before join", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    // A real subject plus a whitespace-only entry: the empty one is filtered,
    // the real one survives — no trailing/leading comma in the arc flag.
    await runCredsIssue(args("issue", { agentId: "echo", pub: ["federated.jc.>", "  "] }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "federated.jc.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
  });
});

describe("creds issue — safe default scope when omitted (cortex#1057)", () => {
  test("omitted --pub/--sub → NOT unscoped; defaults to federated.<id>.> + _INBOX.>", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "echo",
      "--pub", "federated.echo.>,_INBOX.>",
      "--sub", "federated.echo.>,_INBOX.>",
      "--json",
    ]);
    // The everyone-subscribe subject is the literal token `federated.>`
    // (no segment between `federated` and the `>` wildcard). This asserts
    // that exact string never appears in the argv: the safe default emits
    // `federated.echo.>`, which is NOT a superstring of `federated.>` (the
    // `echo.` segment intervenes), so a passing assertion proves the default
    // scoped the bot to its own namespace rather than to everyone.
    const flat = (mock.lastArgv ?? []).join(" ");
    expect(flat).not.toContain("federated.>");
  });

  test("safe default uses the agent id verbatim (already regex-validated)", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "leaf-northwood" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "leaf-northwood", account: "community" }));
    expect(mock.lastArgv).toEqual([
      "nats", "add-bot", "leaf-northwood",
      "--account", "community",
      "--pub", "federated.leaf-northwood.>,_INBOX.>",
      "--sub", "federated.leaf-northwood.>,_INBOX.>",
      "--json",
    ]);
  });

  test("the safe default is the documented federated.<op>.> scope from ADR-0012", async () => {
    const mock = mockArc({ stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsIssue(args("issue", { agentId: "echo" }));
    const flat = (mock.lastArgv ?? []).join(" ");
    expect(flat).toContain("federated.echo.>");
    expect(flat).toContain("_INBOX.>");
  });
});

describe("creds rotate/revoke — unaffected by --pub/--sub (cortex#1057)", () => {
  test("rotate never threads pub/sub even if present on args", async () => {
    const mock = mockArc({ stdout: reissueBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsRotate(args("rotate", { agentId: "echo", pub: ["x.>"], sub: ["y.>"] }));
    expect(mock.lastArgv).toEqual(["nats", "reissue-bot", "echo", "--json"]);
  });

  test("revoke never threads pub/sub even if present on args", async () => {
    const mock = mockArc({ stdout: removeBotOk({ bot: "echo" }), stderr: "", exitCode: 0 });
    __setArcRunnerForTests(mock.runner);
    await runCredsRevoke(args("revoke", { agentId: "echo", pub: ["x.>"], sub: ["y.>"] }));
    expect(mock.lastArgv).toEqual(["nats", "remove-bot", "echo", "--delete-creds", "--json"]);
  });
});

describe("parseCredsArgs — --pub/--sub (cortex#1057)", () => {
  test("parses repeatable --pub on issue", () => {
    const r = parseCredsArgs(["issue", "echo", "--pub", "a.>", "--pub", "b.>"]);
    expect(r.pub).toEqual(["a.>", "b.>"]);
  });

  test("parses repeatable --sub on issue", () => {
    const r = parseCredsArgs(["issue", "echo", "--sub", "a.>", "--sub", "b.>"]);
    expect(r.sub).toEqual(["a.>", "b.>"]);
  });

  test("absent --pub/--sub default to empty arrays", () => {
    const r = parseCredsArgs(["issue", "echo"]);
    expect(r.pub).toEqual([]);
    expect(r.sub).toEqual([]);
  });

  test("--pub is rejected on rotate (issue-only flag)", () => {
    expect(() => parseCredsArgs(["rotate", "echo", "--pub", "a.>"])).toThrow(CliArgsError);
  });

  test("--sub is rejected on revoke (issue-only flag)", () => {
    expect(() => parseCredsArgs(["revoke", "echo", "--sub", "a.>"])).toThrow(CliArgsError);
  });

  test("--pub without a value throws", () => {
    expect(() => parseCredsArgs(["issue", "echo", "--pub"])).toThrow(CliArgsError);
  });
});

// =============================================================================
// arc shellout — success path
// =============================================================================

describe("arc shellout — success", () => {
  test("issue returns exit 0 + surfaces creds_path + pubKey in stdout", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: addBotOk({ bot: "echo", credsPath: "/home/jc/.config/nats/echo.creds", pubKey: "UAECHO" }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo");
    expect(r.stdout).toContain("/home/jc/.config/nats/echo.creds");
    expect(r.stdout).toContain("UAECHO");
  });

  test("issue --json emits envelope with data block carrying arc fields", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: addBotOk({ bot: "echo", credsPath: "/x/echo.creds", pubKey: "UAECHO" }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo", json: true }));
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.creds_path).toBe("/x/echo.creds");
    expect(env.data.pub_key).toBe("UAECHO");
    expect(env.data.arc_bot).toBe("echo");
  });

  test("rotate surfaces newPubKey + revokedPubKey", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: reissueBotOk({ bot: "echo", newPubKey: "UANEW", revokedPubKey: "UAOLD" }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsRotate(args("rotate", { agentId: "echo" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("UANEW");
    expect(r.stdout).toContain("UAOLD");
  });

  test("rotate --json surfaces both pub keys in data block", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: reissueBotOk({ bot: "echo", newPubKey: "UANEW", revokedPubKey: "UAOLD" }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsRotate(args("rotate", { agentId: "echo", json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.new_pub_key).toBe("UANEW");
    expect(env.data.revoked_pub_key).toBe("UAOLD");
  });

  test("revoke surfaces revokedPubKey + credsFileDeleted", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: removeBotOk({ bot: "echo", revokedPubKey: "UAREV", credsFileDeleted: true }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsRevoke(args("revoke", { agentId: "echo" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("UAREV");
    expect(r.stdout).toContain("creds_file_deleted: true");
  });

  test("revoke --json surfaces credsFileDeleted in data block", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: removeBotOk({ bot: "echo", credsFileDeleted: true }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsRevoke(args("revoke", { agentId: "echo", json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.data.creds_file_deleted).toBe("true");
  });
});

// =============================================================================
// arc shellout — error mapping
// =============================================================================

describe("arc shellout — error mapping", () => {
  test("VALIDATION_ERROR → exit 1 with code + message", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("VALIDATION_ERROR", "bot name \"BAD\" must be lowercase alphanumeric + hyphens."),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("VALIDATION_ERROR");
    expect(r.stderr).toContain("must be lowercase");
  });

  test("NSC_NOT_INSTALLED → exit 1 with code", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("NSC_NOT_INSTALLED", "nsc not on PATH"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("NSC_NOT_INSTALLED");
  });

  test("ACCOUNT_NOT_FOUND → exit 1", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("ACCOUNT_NOT_FOUND", "no operator account active"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ACCOUNT_NOT_FOUND");
  });

  test("ALREADY_EXISTS → exit 1", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("ALREADY_EXISTS", "user echo already exists"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ALREADY_EXISTS");
  });

  test("PUSH_FAILED on issue surfaces the loud bus-side warning", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("PUSH_FAILED", "nsc push -a OP_JC failed"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsRotate(args("rotate", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("PUSH_FAILED");
    expect(r.stderr).toContain("WARNING");
    expect(r.stderr).toContain("VALID");
  });

  test("PUSH_FAILED on revoke surfaces the same warning", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("PUSH_FAILED", "nsc push failed"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsRevoke(args("revoke", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("WARNING");
  });

  test("USER_NOT_FOUND on revoke → idempotent exit 0", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("USER_NOT_FOUND", "user echo not found"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsRevoke(args("revoke", { agentId: "echo" }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("not present server-side");
  });

  test("USER_NOT_FOUND on revoke --json → status=ok with idempotent note", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("USER_NOT_FOUND", "user echo not found"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsRevoke(args("revoke", { agentId: "echo", json: true }));
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("ok");
    expect(env.data.note).toContain("idempotent");
    expect(env.data.arc_code).toBe("USER_NOT_FOUND");
  });

  test("USER_NOT_FOUND on issue is NOT idempotent — exit 1", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("USER_NOT_FOUND", "user echo not found"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("USER_NOT_FOUND");
  });

  test("USER_NOT_FOUND on rotate is NOT idempotent — exit 1", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("USER_NOT_FOUND", "user echo not found"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsRotate(args("rotate", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
  });

  test("error envelope --json carries arc_code in context", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: arcErr("ALREADY_EXISTS", "echo already exists"),
      stderr: "", exitCode: 1,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo", json: true }));
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("error");
    expect(env.error.context.arc_code).toBe("ALREADY_EXISTS");
    expect(env.error.reason).toContain("already exists");
  });
});

// =============================================================================
// arc shellout — transport + contract drift
// =============================================================================

describe("arc shellout — transport failures", () => {
  test("arc binary missing → exit 1 with install hint", async () => {
    const failingRunner: ArcRunner = async () => {
      throw new Error("spawn arc ENOENT");
    };
    __setArcRunnerForTests(failingRunner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ENOENT");
    expect(r.stderr).toContain(MIN_ARC_VERSION);
  });

  test("arc returns empty stdout → exit 1 with contract-drift message", async () => {
    __setArcRunnerForTests(mockArc({ stdout: "", stderr: "boom", exitCode: 1 }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no valid 'arc.nats.v1'");
  });

  test("arc returns non-JSON → exit 1 with contract-drift message", async () => {
    __setArcRunnerForTests(mockArc({ stdout: "not json at all", stderr: "", exitCode: 0 }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no valid 'arc.nats.v1'");
  });

  test("arc returns wrong schema → exit 1 with contract-drift message", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: JSON.stringify({ schema: "arc.nats.v2", ok: true }),
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no valid 'arc.nats.v1'");
  });

  test("contract drift --json passes raw arc output in context (truncated)", async () => {
    __setArcRunnerForTests(mockArc({ stdout: "garbage line", stderr: "stderr-tail", exitCode: 0 }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo", json: true }));
    expect(r.exitCode).toBe(1);
    const env = JSON.parse(r.stdout);
    expect(env.status).toBe("error");
    expect(env.error.context.arc_output).toContain("garbage line");
  });

  test("ignores leading blank lines in arc stdout", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: "\n\n" + addBotOk({ bot: "echo" }) + "\n",
      stderr: "", exitCode: 0,
    }).runner);
    const r = await runCredsIssue(args("issue", { agentId: "echo" }));
    expect(r.exitCode).toBe(0);
  });
});

// =============================================================================
// dispatchCreds — routing
// =============================================================================

describe("dispatchCreds", () => {
  test("'list' on missing dir → exit 0", async () => {
    const r = await dispatchCreds(["list", "--creds-dir", "/tmp/does-not-exist-zzz"]);
    expect(r.exitCode).toBe(0);
  });

  test("'issue echo' routes to runArcSubcommand and surfaces arc result", async () => {
    __setArcRunnerForTests(mockArc({
      stdout: addBotOk({ bot: "echo" }), stderr: "", exitCode: 0,
    }).runner);
    const r = await dispatchCreds(["issue", "echo"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ok");
  });

  test("'--help' returns help text", async () => {
    const r = await dispatchCreds(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("cortex creds");
    expect(r.stdout).toContain("arc nats");
  });

  test("no subcommand → exit 2 usage error", async () => {
    const r = await dispatchCreds([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("no subcommand specified");
  });

  test("unknown subcommand → exit 2", async () => {
    const r = await dispatchCreds(["unicorn"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown subcommand");
  });

  test("issue missing positional → exit 2", async () => {
    const r = await dispatchCreds(["issue"]);
    expect(r.exitCode).toBe(2);
  });
});
