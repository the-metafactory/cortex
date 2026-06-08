/**
 * #794 — `natsConfigCanBindAccount` pre-flight tests (RED-first).
 *
 * `cortex network join` renders a leaf remote with `account: <A…>` and restarts
 * nats-server. nats-server resolves that account against the LOCAL config's
 * account tree. An anonymous + hard-isolated bus (no operator-mode account
 * tree — the halden/community pattern) does NOT define the account, so the
 * server crashes on startup (`cannot find local account "<A…>" specified in
 * leafnode remote`) and the whole bus goes DOWN.
 *
 * `natsConfigCanBindAccount` is the pure pre-flight the join orchestrator runs
 * BEFORE any mutation: operator-mode config that names the account → can bind;
 * anonymous config, or operator-mode missing THIS account → cannot bind.
 */

import { describe, expect, test } from "bun:test";

import { natsConfigCanBindAccount } from "../leaf-remote-renderer";

// A valid nkey-U account public key grammar (A + 55 base32 chars).
const ACCOUNT = "A" + "B".repeat(55);
const OTHER_ACCOUNT = "A" + "C".repeat(55);

// An operator-mode local.conf that DEFINES the account (resolver_preload names
// it as a key) — the andreas/meta-factory shape. nats-server can bind the leaf.
const OPERATOR_WITH_ACCOUNT = [
  "// nats-server operator-mode config.",
  "operator: /Users/andreas/.config/nats/operator.jwt", // NSC operator JWT key
  "system_account: ADSYSACCOUNT",
  "resolver: { type: full, dir: /Users/andreas/.config/nats/jwt }",
  "resolver_preload: {",
  `  ${ACCOUNT}: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ..."`,
  "}",
  "",
].join("\n");

// An operator-mode config that DOESN'T define this specific account (it defines
// a different one). nats-server would crash binding ACCOUNT.
const OPERATOR_WITHOUT_ACCOUNT = [
  "operator: /Users/andreas/.config/nats/operator.jwt", // NSC operator JWT key
  "resolver_preload: {",
  `  ${OTHER_ACCOUNT}: "eyJ0eXAiOiJKV1Qi..."`,
  "}",
  "",
].join("\n");

// The halden/community pattern: anonymous + hard-isolated. No NSC operator JWT,
// no accounts, no resolver_preload — nats-server defines NO accounts at all.
const ANONYMOUS = [
  "// anonymous hard-isolated bus (community pattern).",
  "host: 0.0.0.0",
  "port: 4224",
  "jetstream { store_dir: /Users/andreas/.config/nats/community-js }",
  "",
].join("\n");

describe("natsConfigCanBindAccount", () => {
  test("operator-mode config that DEFINES the account → can bind", () => {
    const res = natsConfigCanBindAccount(OPERATOR_WITH_ACCOUNT, ACCOUNT);
    expect(res.canBind).toBe(true);
    expect(res.reason).toBeUndefined();
  });

  test("anonymous / hard-isolated config → cannot bind (the crash case)", () => {
    const res = natsConfigCanBindAccount(ANONYMOUS, ACCOUNT);
    expect(res.canBind).toBe(false);
    expect(res.reason).toContain("anonymous");
  });

  test("operator-mode config MISSING this account → cannot bind", () => {
    const res = natsConfigCanBindAccount(OPERATOR_WITHOUT_ACCOUNT, ACCOUNT);
    expect(res.canBind).toBe(false);
    expect(res.reason).toContain("does not define account");
  });

  test("empty config (absent file) → cannot bind", () => {
    const res = natsConfigCanBindAccount("", ACCOUNT);
    expect(res.canBind).toBe(false);
  });

  test("a COMMENTED-OUT operator directive does NOT count as operator-mode", () => {
    const commented = [
      "// operator: /Users/andreas/.config/nats/operator.jwt", // NSC operator JWT (commented out)
      "# accounts { FOO {} }",
      "port: 4224",
      "",
    ].join("\n");
    const res = natsConfigCanBindAccount(commented, ACCOUNT);
    expect(res.canBind).toBe(false);
  });

  test("a COMMENTED-OUT account line does NOT count as defining the account", () => {
    const commented = [
      "operator: /Users/andreas/.config/nats/operator.jwt", // NSC operator JWT key
      "resolver_preload: {",
      `  // ${ACCOUNT}: "jwt..."`,
      "}",
      "",
    ].join("\n");
    const res = natsConfigCanBindAccount(commented, ACCOUNT);
    expect(res.canBind).toBe(false);
    expect(res.reason).toContain("does not define account");
  });

  test("accounts block (no NSC operator JWT key) still counts as operator-mode", () => {
    const accountsOnly = [
      "accounts: {",
      `  MYACC: { jetstream: enabled, users: [] }`,
      `  preload: ${ACCOUNT}`,
      "}",
      "",
    ].join("\n");
    const res = natsConfigCanBindAccount(accountsOnly, ACCOUNT);
    expect(res.canBind).toBe(true);
  });

  test("a malformed account is rejected (not a valid nkey-U)", () => {
    const res = natsConfigCanBindAccount(OPERATOR_WITH_ACCOUNT, "not-an-account");
    expect(res.canBind).toBe(false);
    expect(res.reason).toContain("not a valid nkey-U");
  });

  test("tolerates the `key =` HOCON assignment form for the NSC operator JWT key", () => {
    const eqForm = [
      "operator = /Users/andreas/.config/nats/operator.jwt", // NSC operator JWT key
      `resolver_preload: { ${ACCOUNT}: "jwt..." }`,
      "",
    ].join("\n");
    const res = natsConfigCanBindAccount(eqForm, ACCOUNT);
    expect(res.canBind).toBe(true);
  });
});
