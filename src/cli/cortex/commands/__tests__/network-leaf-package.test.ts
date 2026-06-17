/**
 * O-4b (cortex#1063, epic #1050, spec
 * `docs/design-automated-operator-onboarding.md` §3) — `cortex network join`
 * SOURCES the operator-mode leaf package from a file (`--from-package <file>`)
 * instead of demanding the four `--operator-jwt`/`--account-jwt`/`--account`/
 * `--system-account*` flags by hand.
 *
 * This file is the RED-first spec for the PURE parser/validator half of O-4b:
 * {@link parseLeafPackageFile}. It reads the JSON wire shape O-4a's signed
 * register→issue response will carry ({@link LeafPackageFile}), validates it with
 * the SAME nkey-U / JWT-shape guards O-3 uses (reused, never re-derived), and
 * fails fast on a malformed package — so unvalidated key material can never reach
 * the operator-mode conversion seam.
 *
 * Public repo — every value here is an OBVIOUS fake `eyJ…` / `A…`-shaped fixture.
 * No real key material; no seeds (the package is JWT + nkey-U pubkey text only).
 */

import { describe, expect, test } from "bun:test";

import {
  parseLeafPackageFile,
  leafPackageToOperatorMode,
  type LeafPackageFile,
  type LeafPackageParseResult,
} from "../network-leaf-package";
import {
  isNkeyAccountPubkey,
  isNscJwtShape,
} from "../../../../common/nats/leaf-remote-renderer";

// =============================================================================
// Fixtures — obvious fakes shaped like the real wire material.
// =============================================================================

/** A well-formed fake operator JWT (`eyJ…` + three base64url segments). */
const FAKE_OPERATOR_JWT = "eyJhbGciOiJlZDI1NTE5In0.eyJvcCI6ImZha2UifQ.c2lnbmF0dXJlMQ";
/** A well-formed fake account JWT. */
const FAKE_ACCOUNT_JWT = "eyJhbGciOiJlZDI1NTE5In0.eyJhYyI6ImZha2UifQ.c2lnbmF0dXJlMg";
/** A well-formed fake system-account JWT. */
const FAKE_SYS_JWT = "eyJhbGciOiJlZDI1NTE5In0.eyJzeXMiOiJmYWtlIn0.c2lnbmF0dXJlMw";
/** A well-formed fake account nkey-U (`A` + 55 base32 chars). */
const FAKE_ACCOUNT = "A" + "B".repeat(55);
/** A well-formed fake system-account nkey-U. */
const FAKE_SYS_ACCOUNT = "A" + "C".repeat(55);

/** The minimal valid package — operator JWT + account + account JWT + creds. */
const MINIMAL: LeafPackageFile = {
  operatorJwt: FAKE_OPERATOR_JWT,
  account: FAKE_ACCOUNT,
  accountJwt: FAKE_ACCOUNT_JWT,
  credsPath: "~/.config/nats/metafactory-community.creds",
};

/** The full package — adds the optional system account (+ JWT) + endpoint. */
const FULL: LeafPackageFile = {
  ...MINIMAL,
  systemAccount: FAKE_SYS_ACCOUNT,
  systemAccountJwt: FAKE_SYS_JWT,
  endpoint: "tls://hub.meta-factory.dev:7422",
};

/** Narrow to a parsed package, failing the test with the reason otherwise. */
function mustParse(result: LeafPackageParseResult): LeafPackageFile {
  if (!result.ok) throw new Error(`expected ok, got refuse: ${result.reason}`);
  return result.package;
}

// =============================================================================
// Reused-guard sanity — the fixtures actually exercise O-3's grammar.
// =============================================================================

describe("O-4b fixtures exercise the reused O-3 guards", () => {
  test("the fake account/JWTs pass the exported O-3 predicates", () => {
    expect(isNkeyAccountPubkey(FAKE_ACCOUNT)).toBe(true);
    expect(isNkeyAccountPubkey(FAKE_SYS_ACCOUNT)).toBe(true);
    expect(isNscJwtShape(FAKE_OPERATOR_JWT)).toBe(true);
    expect(isNscJwtShape(FAKE_ACCOUNT_JWT)).toBe(true);
    expect(isNscJwtShape(FAKE_SYS_JWT)).toBe(true);
  });
});

// =============================================================================
// Happy path — a valid package parses to the wire shape.
// =============================================================================

describe("parseLeafPackageFile — valid packages", () => {
  test("parses a minimal package (operator JWT + account + accountJwt + credsPath)", () => {
    const pkg = mustParse(parseLeafPackageFile(JSON.stringify(MINIMAL)));
    expect(pkg).toEqual(MINIMAL);
  });

  test("parses a full package (system account + JWT + endpoint)", () => {
    const pkg = mustParse(parseLeafPackageFile(JSON.stringify(FULL)));
    expect(pkg).toEqual(FULL);
  });

  test("ignores unknown extra fields (forward-compat with O-4a additions)", () => {
    const withExtra = { ...MINIMAL, futureField: "ignored", another: 7 };
    const pkg = mustParse(parseLeafPackageFile(JSON.stringify(withExtra)));
    // Only the known wire fields survive; extras are dropped, not echoed back.
    expect(pkg).toEqual(MINIMAL);
    expect((pkg as unknown as Record<string, unknown>).futureField).toBeUndefined();
  });
});

// =============================================================================
// Fail-fast — malformed packages refuse, with an actionable reason.
// =============================================================================

describe("parseLeafPackageFile — malformed packages fail fast", () => {
  test("non-JSON → refuse", () => {
    const res = parseLeafPackageFile("{ not json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/parse|json/i);
  });

  test("non-object JSON (array) → refuse", () => {
    const res = parseLeafPackageFile("[1,2,3]");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/object/i);
  });

  test("missing operatorJwt → refuse naming the field", () => {
    const { operatorJwt: _drop, ...rest } = MINIMAL;
    const res = parseLeafPackageFile(JSON.stringify(rest));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/operatorJwt/);
  });

  test("operatorJwt with bad JWT shape (2 segments) → refuse", () => {
    const res = parseLeafPackageFile(
      JSON.stringify({ ...MINIMAL, operatorJwt: "eyJhbGci.payload" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/operatorJwt|JWT/);
  });

  test("account that is not an nkey-U (wrong prefix) → refuse", () => {
    const res = parseLeafPackageFile(
      JSON.stringify({ ...MINIMAL, account: "U" + "B".repeat(55) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/account|nkey/i);
  });

  test("accountJwt with bad shape → refuse", () => {
    const res = parseLeafPackageFile(
      JSON.stringify({ ...MINIMAL, accountJwt: "not-a-jwt" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/accountJwt|JWT/);
  });

  test("missing credsPath → refuse naming the field", () => {
    const { credsPath: _drop, ...rest } = MINIMAL;
    const res = parseLeafPackageFile(JSON.stringify(rest));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/credsPath/);
  });

  test("empty credsPath → refuse", () => {
    const res = parseLeafPackageFile(JSON.stringify({ ...MINIMAL, credsPath: "  " }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/credsPath/);
  });

  test("systemAccount offered without systemAccountJwt → refuse", () => {
    const res = parseLeafPackageFile(
      JSON.stringify({ ...MINIMAL, systemAccount: FAKE_SYS_ACCOUNT }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/system.?account.?jwt/i);
  });

  test("systemAccount with bad nkey shape → refuse", () => {
    const res = parseLeafPackageFile(
      JSON.stringify({
        ...MINIMAL,
        systemAccount: "Z" + "C".repeat(55),
        systemAccountJwt: FAKE_SYS_JWT,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/system.?account|nkey/i);
  });

  test("endpoint with wrong type → refuse", () => {
    const res = parseLeafPackageFile(
      JSON.stringify({ ...MINIMAL, endpoint: 1234 }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/endpoint|string/i);
  });
});

// =============================================================================
// Projection — the package SUPERSET maps onto O-3's render subset.
// =============================================================================

describe("leafPackageToOperatorMode — drops credsPath/endpoint", () => {
  test("a full package projects to the OperatorModeLeafPackage render fields only", () => {
    const om = leafPackageToOperatorMode(FULL);
    expect(om).toEqual({
      operatorJwt: FAKE_OPERATOR_JWT,
      account: FAKE_ACCOUNT,
      accountJwt: FAKE_ACCOUNT_JWT,
      systemAccount: FAKE_SYS_ACCOUNT,
      systemAccountJwt: FAKE_SYS_JWT,
    });
    // credsPath + endpoint are NOT operator-mode render material.
    expect((om as unknown as Record<string, unknown>).credsPath).toBeUndefined();
    expect((om as unknown as Record<string, unknown>).endpoint).toBeUndefined();
  });

  test("a minimal package omits the optional SYS fields", () => {
    const om = leafPackageToOperatorMode(MINIMAL);
    expect(om).toEqual({
      operatorJwt: FAKE_OPERATOR_JWT,
      account: FAKE_ACCOUNT,
      accountJwt: FAKE_ACCOUNT_JWT,
    });
  });
});
