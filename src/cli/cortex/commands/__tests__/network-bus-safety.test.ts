/**
 * cortex#1728 — unit tests for the three member-bus safety guards.
 * Pure detectors: fixtures in, verdict out. No fs / NATS.
 */

import { describe, expect, test } from "bun:test";

import {
  decideLeafAccountGuard,
  decodeCredsIssuerAccount,
  parseProgramArguments,
  plistLoadsConfig,
  resolveConfigIncludes,
  scanForLeafnodeAuthorizationBomb,
  textHasLeafnodeAuthorizationUsers,
  type ConfigFileReader,
  type InspectedCreds,
  type LeafAccountGuardDecision,
  type ResolvedConfig,
} from "../network-bus-safety";
import { upsertHubLeafUser } from "../../../../common/nats/hub-leaf-authorization";
import { natsConfigCanBindAccount } from "../../../../common/nats/leaf-remote-renderer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPERATOR_STANZA = `
operator: /Users/x/.nsc/stores/O/O.jwt
resolver: MEMORY
resolver_preload {
  ABCDACCOUNT: eyJ0eXAiOiJKV1Qi.aaa.bbb
}
`.trim();

const LEAFNODE_AUTH_BOMB = `
leafnodes {
  authorization {
    users [
      { user: "jc", password: "s3cr3t-psk" }
    ]
  }
}
`.trim();

// A real .creds file shape. The JWT payload below decodes to
// { iss:"AISSUER", sub:"UUSER", nats:{ issuer_account:"AREALACCOUNT" } }.
function credsFileWith(claims: Record<string, unknown>): string {
  const header = { typ: "JWT", alg: "ed25519-nkey" };
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const jwt = `${b64url(header)}.${b64url(claims)}.c2lnbmF0dXJl`;
  return [
    "-----BEGIN NATS USER JWT-----",
    jwt,
    "------END NATS USER JWT------",
    "",
    "-----BEGIN USER NKEY SEED-----",
    "SUAFAKESEEDFAKESEEDFAKESEEDFAKESEED",
    "------END USER NKEY SEED------",
    "",
  ].join("\n");
}

const fakeIo = (files: Record<string, string>): ConfigFileReader => ({
  read: (p) => files[p],
  dirname: (p) => {
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? "/" : p.slice(0, idx);
  },
  join: (dir, file) => (dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`),
});

// ---------------------------------------------------------------------------
// resolveConfigIncludes
// ---------------------------------------------------------------------------

describe("resolveConfigIncludes", () => {
  test("follows relative + absolute includes, root first", () => {
    const io = fakeIo({
      "/etc/nats/local.conf": `${OPERATOR_STANZA}\ninclude "leafnodes-net.conf"\ninclude "/etc/nats/extra.conf"`,
      "/etc/nats/leafnodes-net.conf": "leafnodes { remotes = [] }",
      "/etc/nats/extra.conf": "# extra",
    });
    const resolved = resolveConfigIncludes("/etc/nats/local.conf", io);
    expect(resolved.files.map((f) => f.path)).toEqual([
      "/etc/nats/local.conf",
      "/etc/nats/leafnodes-net.conf",
      "/etc/nats/extra.conf",
    ]);
  });

  test("is cycle-safe (a file is read at most once)", () => {
    const io = fakeIo({
      "/a.conf": 'include "b.conf"',
      "/b.conf": 'include "a.conf"',
    });
    const resolved = resolveConfigIncludes("/a.conf", io);
    expect(resolved.files.map((f) => f.path).sort()).toEqual(["/a.conf", "/b.conf"]);
  });

  test("skips a missing include rather than throwing", () => {
    const io = fakeIo({ "/root.conf": 'include "gone.conf"' });
    const resolved = resolveConfigIncludes("/root.conf", io);
    expect(resolved.files.map((f) => f.path)).toEqual(["/root.conf"]);
  });

  test("ignores commented-out include directives", () => {
    const io = fakeIo({
      "/root.conf": '# include "should-not-follow.conf"\noperator: x',
      "/should-not-follow.conf": "boom",
    });
    const resolved = resolveConfigIncludes("/root.conf", io);
    expect(resolved.files.map((f) => f.path)).toEqual(["/root.conf"]);
  });
});

// ---------------------------------------------------------------------------
// Guard 1 — F4 crash-bomb scan
// ---------------------------------------------------------------------------

describe("Guard 1 — leafnode authorization crash bomb", () => {
  test("textHasLeafnodeAuthorizationUsers detects the block", () => {
    expect(textHasLeafnodeAuthorizationUsers(LEAFNODE_AUTH_BOMB)).toBe(true);
  });

  test("does not fire on a leafnodes block WITHOUT authorization/users", () => {
    expect(
      textHasLeafnodeAuthorizationUsers("leafnodes { remotes = [ { url: x } ] }"),
    ).toBe(false);
  });

  test("does not fire on a commented-out block", () => {
    const commented = LEAFNODE_AUTH_BOMB.split("\n")
      .map((l) => `# ${l}`)
      .join("\n");
    expect(textHasLeafnodeAuthorizationUsers(commented)).toBe(false);
  });

  test("FAILS on an operator-mode config carrying the bomb (in the root)", () => {
    const resolved: ResolvedConfig = {
      files: [{ path: "/etc/nats/local.conf", text: `${OPERATOR_STANZA}\n${LEAFNODE_AUTH_BOMB}` }],
    };
    const bombs = scanForLeafnodeAuthorizationBomb(resolved);
    expect(bombs).toHaveLength(1);
    expect(bombs[0]?.path).toBe("/etc/nats/local.conf");
    expect(bombs[0]?.fix).toContain("operator-mode");
    expect(bombs[0]?.fix).toContain("/etc/nats/local.conf");
  });

  test("FAILS when the bomb lives in an INCLUDED file (operator in root)", () => {
    const resolved: ResolvedConfig = {
      files: [
        { path: "/etc/nats/local.conf", text: `${OPERATOR_STANZA}\ninclude "psk.conf"` },
        { path: "/etc/nats/psk.conf", text: LEAFNODE_AUTH_BOMB },
      ],
    };
    const bombs = scanForLeafnodeAuthorizationBomb(resolved);
    expect(bombs.map((b) => b.path)).toEqual(["/etc/nats/psk.conf"]);
  });

  test("is SILENT on a NON-operator-mode ($G) bus with the same block (legal there)", () => {
    const resolved: ResolvedConfig = {
      files: [{ path: "/etc/nats/local.conf", text: LEAFNODE_AUTH_BOMB }],
    };
    expect(scanForLeafnodeAuthorizationBomb(resolved)).toHaveLength(0);
  });

  test.each([
    ["no listen port", ""],
    ["a listen port", "  listen: 127.0.0.1:7422\n"],
    ["only remotes", '  remotes: [ { url: "nats://127.0.0.1:7422" } ]\n'],
  ])("FAILS on the cortex-managed block with %s", (_label, extra) => {
    const conf = upsertHubLeafUser(`leafnodes {\n${extra}}\n`, "alice", "PSK");
    const bombs = scanForLeafnodeAuthorizationBomb({
      files: [{ path: "/etc/nats/local.conf", text: `${OPERATOR_STANZA}\n${conf}` }],
    });
    expect(bombs).toHaveLength(1);
  });

  test("the fix for a cortex-managed block names the owning tool and how to stop it recurring", () => {
    const conf = upsertHubLeafUser("leafnodes {\n}\n", "alice", "PSK");
    const [bomb] = scanForLeafnodeAuthorizationBomb({
      files: [{ path: "/etc/nats/local.conf", text: `${OPERATOR_STANZA}\n${conf}` }],
    });
    expect(bomb?.fix).toContain("cortex network secret add-member");
    expect(bomb?.fix).toContain("# >>> cortex-managed leaf authorization");
    expect(bomb?.fix).toContain("hub_mode: operator");
    expect(bomb?.fix).toContain("whether or not `leafnodes` has a `listen` port");
    expect(bomb?.fix).not.toContain("pre-#1491");
  });

  test("the fix for a hand-written block does not blame the secret tooling", () => {
    const [bomb] = scanForLeafnodeAuthorizationBomb({
      files: [{ path: "/etc/nats/local.conf", text: `${OPERATOR_STANZA}\n${LEAFNODE_AUTH_BOMB}` }],
    });
    expect(bomb?.fix).not.toContain("add-member");
    expect(bomb?.fix).toContain("hand-written or pre-#1491");
  });

  test("is SILENT on a clean operator-mode bus", () => {
    const resolved: ResolvedConfig = {
      files: [{ path: "/etc/nats/local.conf", text: OPERATOR_STANZA }],
    };
    expect(scanForLeafnodeAuthorizationBomb(resolved)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Guard 2 — plist ProgramArguments
// ---------------------------------------------------------------------------

const plistWithArgs = (args: string[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<plist><dict>",
    "<key>Label</key><string>ai.meta-factory.nats</string>",
    "<key>ProgramArguments</key>",
    "<array>",
    ...args.map((a) => `  <string>${a}</string>`),
    "</array>",
    "</dict></plist>",
  ].join("\n");

describe("Guard 2 — plist loads config", () => {
  test("parseProgramArguments extracts the array entries", () => {
    const xml = plistWithArgs(["/opt/homebrew/bin/nats-server", "-c", "/etc/nats/local.conf"]);
    expect(parseProgramArguments(xml)).toEqual([
      "/opt/homebrew/bin/nats-server",
      "-c",
      "/etc/nats/local.conf",
    ]);
  });

  test("returns [] when ProgramArguments is absent (bare homebrew plist)", () => {
    const bare = [
      "<plist><dict>",
      "<key>Label</key><string>homebrew.mxcl.nats-server</string>",
      "<key>Program</key><string>/opt/homebrew/bin/nats-server</string>",
      "</dict></plist>",
    ].join("\n");
    expect(parseProgramArguments(bare)).toEqual([]);
  });

  test("PASSES when the config is loaded via `-c <path>`", () => {
    const xml = plistWithArgs(["nats-server", "-c", "/etc/nats/local.conf"]);
    const res = plistLoadsConfig(xml, "/etc/nats/local.conf");
    expect(res.loadsConfig).toBe(true);
  });

  test("PASSES on the joined `--config=<path>` form", () => {
    const xml = plistWithArgs(["nats-server", "--config=/etc/nats/local.conf"]);
    expect(plistLoadsConfig(xml, "/etc/nats/local.conf").loadsConfig).toBe(true);
  });

  test("FAILS on a bare nats-server plist (no -c) — the homebrew squatter", () => {
    const xml = plistWithArgs(["/opt/homebrew/bin/nats-server"]);
    const res = plistLoadsConfig(xml, "/etc/nats/local.conf");
    expect(res.loadsConfig).toBe(false);
    expect(res.programArguments).toEqual(["/opt/homebrew/bin/nats-server"]);
  });

  test("FAILS when a DIFFERENT config is loaded", () => {
    const xml = plistWithArgs(["nats-server", "-c", "/etc/nats/other.conf"]);
    expect(plistLoadsConfig(xml, "/etc/nats/local.conf").loadsConfig).toBe(false);
  });

  test("does not count a bare path argument with no -c flag", () => {
    const xml = plistWithArgs(["nats-server", "/etc/nats/local.conf"]);
    expect(plistLoadsConfig(xml, "/etc/nats/local.conf").loadsConfig).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guard 3 — leaf account vs creds issuer_account
// ---------------------------------------------------------------------------

describe("Guard 3 — decodeCredsIssuerAccount", () => {
  test("decodes nats.issuer_account from a creds JWT", () => {
    const creds = credsFileWith({
      iss: "AISSUER",
      sub: "UUSER",
      nats: { issuer_account: "AREALACCOUNT" },
    });
    expect(decodeCredsIssuerAccount(creds)).toBe("AREALACCOUNT");
  });

  test("falls back to iss when issuer_account is absent", () => {
    const creds = credsFileWith({ iss: "AACCOUNTKEY", sub: "UUSER", nats: {} });
    expect(decodeCredsIssuerAccount(creds)).toBe("AACCOUNTKEY");
  });

  test("returns undefined for text with no user JWT block", () => {
    expect(decodeCredsIssuerAccount("not a creds file")).toBeUndefined();
  });

  test("returns undefined for a malformed JWT", () => {
    const creds = [
      "-----BEGIN NATS USER JWT-----",
      "not.a.valid.jwt.too.many.segments",
      "------END NATS USER JWT------",
    ].join("\n");
    expect(decodeCredsIssuerAccount(creds)).toBeUndefined();
  });
});

describe("Guard 3 — decideLeafAccountGuard (cortex#1728, cortex#2760)", () => {
  const FED = "AFEDACCOUNT";
  const AGENTS = "AAGENTSACCOUNT";
  const THIRD = "ATHIRDACCOUNT";
  const HUB = "AHUBMEMBERACCOUNT";
  const creds = (path: string, account: string | undefined, definedLocally: boolean): InspectedCreds => ({
    path,
    account,
    definedLocally,
  });
  const localLeaf = (account: string | undefined) => creds("/tmp/leaf.creds", account, true);
  const hubLeaf = creds("/tmp/leaf.creds", HUB, false);
  const daemon = (account: string | undefined, definedLocally = true) =>
    creds("/tmp/daemon.creds", account, definedLocally);
  const decide = (leafCreds: InspectedCreds, daemonCreds?: InspectedCreds, agentsAccount?: string) =>
    decideLeafAccountGuard({ rendered: FED, leafCreds, daemonCreds, agentsAccount });
  const stepOf = (decision: LeafAccountGuardDecision): string =>
    decision.kind === "proceed" ? (decision.step ?? "") : `REFUSED: ${decision.reason}`;
  const reasonOf = (decision: LeafAccountGuardDecision): string =>
    decision.kind === "refuse" ? decision.reason : "PROCEEDED";

  test("same operator: leaf creds on the rendered account proceed with a match step", () => {
    expect(stepOf(decide(localLeaf(FED)))).toContain("matches");
  });

  test("same operator: leaf creds on another local account refuse (the #1728 third-account bug)", () => {
    const reason = reasonOf(decide(localLeaf(THIRD), daemon(FED), THIRD));
    expect(reason).toContain(`the leaf creds`);
    expect(reason).toContain(`DIFFERENT local account ${THIRD}`);
    expect(reason).toContain(`Set stack.nats_infra.account to ${THIRD}`);
  });

  test("undecodable leaf creds proceed without a step", () => {
    expect(decide(localLeaf(undefined), daemon(THIRD))).toEqual({ kind: "proceed" });
  });

  test("cross operator: hub-issued leaf creds are not compared; a daemon on agents_account proceeds", () => {
    const step = stepOf(decide(hubLeaf, daemon(AGENTS), AGENTS));
    expect(step).toContain("foreign-operator");
    expect(step).toContain("agents_account");
  });

  test("cross operator: a daemon on the leaf's own account proceeds", () => {
    expect(stepOf(decide(hubLeaf, daemon(FED)))).toContain("the daemon publishes on the same account");
  });

  test("cross operator: a daemon on another local account refuses and never recommends the hub account", () => {
    const reason = reasonOf(decide(hubLeaf, daemon(THIRD), AGENTS));
    expect(reason).toContain(`DIFFERENT local account ${THIRD}`);
    expect(reason).toContain(`the daemon creds`);
    expect(reason).toContain(`Set stack.nats_infra.account to ${THIRD}`);
    expect(reason).not.toContain(`stack.nats_infra.account to ${HUB}`);
  });

  test("cross operator: no separate daemon creds proceeds with a note", () => {
    expect(stepOf(decide(hubLeaf))).toContain("no separate daemon creds");
    expect(stepOf(decide(hubLeaf, hubLeaf))).toContain("no separate daemon creds");
  });

  test("cross operator: daemon creds without a local account proceed with a note", () => {
    expect(stepOf(decide(hubLeaf, daemon(undefined)))).toContain("could not resolve a local account");
    expect(stepOf(decide(hubLeaf, daemon(THIRD, false)))).toContain("could not resolve a local account");
  });

  describe("with the real local-account read over an operator-mode config", () => {
    const key = (c: string) => "A" + c.repeat(55);
    const [LOCAL_FED, LOCAL_AGENTS, LOCAL_OTHER, HUB_ACCOUNT] = [key("F"), key("G"), key("T"), key("H")];
    const config = [
      "operator: eyJoperator",
      `system_account: ${key("S")}`,
      "resolver: MEMORY",
      "resolver_preload: {",
      `  ${LOCAL_FED}: eyJfed`,
      `  ${LOCAL_AGENTS}: eyJagents`,
      `  ${LOCAL_OTHER}: eyJother`,
      `  ${key("S")}: eyJsys`,
      "}",
    ].join("\n");
    const inspectFile = (path: string, issuerAccount: string): InspectedCreds => {
      const account = decodeCredsIssuerAccount(credsFileWith({ iss: "AISSUER", nats: { issuer_account: issuerAccount } }));
      return { path, account, definedLocally: account !== undefined && natsConfigCanBindAccount(config, account).canBind };
    };
    const judge = (leafAccount: string, daemonAccount: string) =>
      decideLeafAccountGuard({
        rendered: LOCAL_FED,
        leafCreds: inspectFile("/tmp/leaf.creds", leafAccount),
        daemonCreds: inspectFile("/tmp/daemon.creds", daemonAccount),
        agentsAccount: LOCAL_AGENTS,
      });

    test("hub-issued leaf creds with the daemon on agents_account proceed", () => {
      expect(stepOf(judge(HUB_ACCOUNT, LOCAL_AGENTS))).toContain("foreign-operator");
    });

    test("hub-issued leaf creds with the daemon on another local account refuse", () => {
      expect(reasonOf(judge(HUB_ACCOUNT, LOCAL_OTHER))).toContain(`DIFFERENT local account ${LOCAL_OTHER}`);
    });

    test("leaf creds on another local account still refuse (#1728)", () => {
      expect(reasonOf(judge(LOCAL_OTHER, LOCAL_FED))).toContain("the leaf creds");
    });
  });

  test("end-to-end: a decoded creds file on another local account refuses", () => {
    const text = credsFileWith({ iss: "AISSUER", nats: { issuer_account: THIRD } });
    expect(decide(localLeaf(decodeCredsIssuerAccount(text))).kind).toBe("refuse");
  });
});
