/**
 * cortex#1728 — unit tests for the three member-bus safety guards.
 * Pure detectors: fixtures in, verdict out. No fs / NATS.
 */

import { describe, expect, test } from "bun:test";

import {
  checkLeafAccountMatchesCreds,
  decodeCredsIssuerAccount,
  parseProgramArguments,
  plistLoadsConfig,
  resolveConfigIncludes,
  scanForLeafnodeAuthorizationBomb,
  textHasLeafnodeAuthorizationUsers,
  type ConfigFileReader,
  type ResolvedConfig,
} from "../network-bus-safety";

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

describe("Guard 3 — checkLeafAccountMatchesCreds", () => {
  test("match when rendered account equals creds issuer_account", () => {
    const res = checkLeafAccountMatchesCreds({
      renderedAccount: "AREALACCOUNT",
      credsIssuerAccount: "AREALACCOUNT",
    });
    expect(res.status).toBe("match");
  });

  test("MISMATCH when they differ (the third-account bug)", () => {
    const res = checkLeafAccountMatchesCreds({
      renderedAccount: "AFEDACCOUNT",
      credsIssuerAccount: "AREALPUBLISHERACCOUNT",
    });
    expect(res.status).toBe("mismatch");
    if (res.status === "mismatch") {
      expect(res.renderedAccount).toBe("AFEDACCOUNT");
      expect(res.credsAccount).toBe("AREALPUBLISHERACCOUNT");
    }
  });

  test("indeterminate when no rendered account (creds-only/$G or secret-auth bus)", () => {
    expect(
      checkLeafAccountMatchesCreds({
        renderedAccount: undefined,
        credsIssuerAccount: "AREALACCOUNT",
      }).status,
    ).toBe("indeterminate");
  });

  test("indeterminate when creds account is undecodable", () => {
    expect(
      checkLeafAccountMatchesCreds({
        renderedAccount: "AFEDACCOUNT",
        credsIssuerAccount: undefined,
      }).status,
    ).toBe("indeterminate");
  });

  test("end-to-end: decode a creds file then compare against a divergent rendered account", () => {
    const creds = credsFileWith({
      iss: "AISSUER",
      nats: { issuer_account: "AREALACCOUNT" },
    });
    const credsAccount = decodeCredsIssuerAccount(creds);
    const res = checkLeafAccountMatchesCreds({
      renderedAccount: "ACONFIGSAIDFEDACCOUNT",
      credsIssuerAccount: credsAccount,
    });
    expect(res.status).toBe("mismatch");
  });
});
