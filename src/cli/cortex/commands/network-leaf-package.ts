/**
 * O-4b (cortex#1063, epic #1050, spec
 * `docs/design-automated-operator-onboarding.md` §3) — the LEAF-PACKAGE wire
 * shape + its parser/validator.
 *
 * ## What this is
 *
 * O-3 (#1053) made `cortex network join` render the SOP §B0.1 operator-mode
 * blocks from an {@link OperatorModeLeafPackage}, but a human still had to hand
 * it the four `--operator-jwt` / `--account-jwt` / `--account` /
 * `--system-account*` flags. O-4 closes that: the signed register→issue response
 * carries the leaf package, and join consumes it.
 *
 * O-4a (the wire transport) is not built yet. O-4b is the CONSUMER side: it adds
 * a `--from-package <file>` SOURCE — an interim, on-disk form of the EXACT JSON
 * shape O-4a's signed response will carry ({@link LeafPackageFile}) — so a
 * joining principal can already drive the automated-conversion path from a file
 * the onboarding bot writes, without the four flags.
 *
 * ## The single contract
 *
 * {@link LeafPackageFile} IS the wire shape O-4a will PRODUCE and O-4b CONSUMES.
 * It is the operator-mode material O-3's renderer needs ({@link
 * OperatorModeLeafPackage}: `operatorJwt`, `account`, `accountJwt`, optional
 * `systemAccount` + `systemAccountJwt`) PLUS the two facts the join already
 * threads from elsewhere but the bot now supplies in one document:
 *
 *   - `credsPath` — the issued leaf `.creds` path (today derived from
 *     `--creds` / `stack.nats_infra.creds_path` / convention). REQUIRED on the
 *     package: the issued creds are the whole point of the register→issue
 *     handshake, so a package that omits them is malformed.
 *   - `endpoint` — OPTIONAL leaf dial URL hint. The authoritative hub_url comes
 *     from the SIGNED+VERIFIED network descriptor (DD-12), so this is advisory
 *     only and the join does NOT bind it into the descriptor; it is carried for
 *     forward-compat / diagnostics and validated only for shape.
 *
 * ## Public-repo safety
 *
 * The package is JWT + nkey-U PUBLIC-KEY text — NEVER a seed. The `.creds` it
 * points at is a secret on disk, but the PATH is not. The parser refuses any
 * malformed material with a fail-fast (never feeds unvalidated material into the
 * operator-mode conversion).
 *
 * ## Validation — REUSE, don't duplicate
 *
 * The nkey-U / JWT-shape guards are O-3's, exported from leaf-remote-renderer as
 * {@link isNkeyAccountPubkey} / {@link isNscJwtShape}. This module calls them so
 * the package validator and the renderer share ONE grammar (a second copy could
 * drift and let a value O-3 rejects slip past the parser, or vice-versa).
 */

import {
  isNkeyAccountPubkey,
  isNscJwtShape,
  type OperatorModeLeafPackage,
} from "../../../common/nats/leaf-remote-renderer";

// =============================================================================
// The wire shape — the single O-4a-produces / O-4b-consumes contract.
// =============================================================================

/**
 * The leaf package as it crosses the wire (and, interim, as the `--from-package`
 * file on disk). The SINGLE contract O-4a's signed register→issue response will
 * produce and `cortex network join` consumes.
 *
 * Superset of {@link OperatorModeLeafPackage} (the operator-mode render material)
 * + `credsPath` (the issued leaf creds, REQUIRED) + `endpoint` (an OPTIONAL,
 * advisory dial-URL hint — the authoritative hub_url is the signed descriptor's,
 * DD-12).
 *
 * Every field is PUBLIC material: JWTs (`eyJ…`) and nkey-U account PUBLIC keys
 * (`A…`) — never a seed. `credsPath` is a filesystem path, not the creds.
 */
export interface LeafPackageFile {
  /** The NSC operator JWT (`eyJ…`) — root of the local account tree. */
  operatorJwt: string;
  /** The issued account public key (nkey-U, `A…`) the leaf binds to. */
  account: string;
  /** The issued account's JWT (`eyJ…`) — preloaded under `resolver_preload`. */
  accountJwt: string;
  /** OPTIONAL system-account public key (nkey-U). Sets `system_account`. */
  systemAccount?: string;
  /** OPTIONAL system-account JWT — preloaded alongside the issued account. */
  systemAccountJwt?: string;
  /**
   * The issued leaf `.creds` path. REQUIRED — the issued creds are the point of
   * the handshake. (The PATH is public; the file it names is the secret.)
   */
  credsPath: string;
  /**
   * OPTIONAL advisory leaf dial-URL hint (`tls://host:port`). The authoritative
   * hub_url is the SIGNED+VERIFIED descriptor's (DD-12); this is carried for
   * forward-compat / diagnostics and is NOT bound into the descriptor.
   */
  endpoint?: string;
}

/** The result of {@link parseLeafPackageFile}: a validated package, or a reason. */
export type LeafPackageParseResult =
  | { ok: true; package: LeafPackageFile }
  | { ok: false; reason: string };

// =============================================================================
// Parse + validate.
// =============================================================================

/** Read a non-empty string field, TRIMMED; returns `undefined` when absent/empty/wrong-type. */
function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse + validate a leaf-package JSON document into a {@link LeafPackageFile}.
 * PURE (string in, result out): no filesystem, no daemon — the caller reads the
 * file and passes the text.
 *
 * Fail-fast (`{ ok: false, reason }`) on ANY malformed material — never return a
 * half-formed package that could feed unvalidated key material into the
 * operator-mode conversion. The grammar guards are O-3's, REUSED:
 *   - `operatorJwt` / `accountJwt` (+ `systemAccountJwt` when offered) →
 *     {@link isNscJwtShape};
 *   - `account` (+ `systemAccount` when offered) → {@link isNkeyAccountPubkey}.
 *
 * Validation rules (mirroring O-3's {@link renderOperatorModeBlocks} so the
 * parser and the renderer agree on what "well-formed" means):
 *   - the document must be a JSON OBJECT;
 *   - `operatorJwt`, `account`, `accountJwt`, `credsPath` are REQUIRED;
 *   - if `systemAccount` is offered it must be a valid nkey-U AND be paired with
 *     a valid `systemAccountJwt` (a half-specified SYS account is malformed);
 *   - `endpoint` is optional and, when present, must be a string.
 *
 * Unknown extra fields are IGNORED (forward-compat: O-4a may add fields).
 */
export function parseLeafPackageFile(jsonText: string): LeafPackageParseResult {
  // 1) Parse the JSON. A syntax error is a malformed package file handed to us.
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      reason: `leaf package is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      reason: "leaf package must be a JSON object (got " + (Array.isArray(raw) ? "an array" : typeof raw) + ")",
    };
  }
  const obj = raw as Record<string, unknown>;

  // 2) Required operator JWT.
  const operatorJwt = optionalString(obj.operatorJwt);
  if (operatorJwt === undefined) {
    return { ok: false, reason: "leaf package is missing `operatorJwt` (the NSC operator JWT)" };
  }
  if (!isNscJwtShape(operatorJwt)) {
    return {
      ok: false,
      reason: `leaf package \`operatorJwt\` is not a JWT (expected an \`eyJ…\` token with three dot-separated segments)`,
    };
  }

  // 3) Required account nkey-U.
  const account = optionalString(obj.account);
  if (account === undefined) {
    return { ok: false, reason: "leaf package is missing `account` (the issued account public key)" };
  }
  if (!isNkeyAccountPubkey(account)) {
    return {
      ok: false,
      reason: "leaf package `account` is not an nkey-U account public key (`A…`, 56 chars)",
    };
  }

  // 4) Required account JWT.
  const accountJwt = optionalString(obj.accountJwt);
  if (accountJwt === undefined) {
    return { ok: false, reason: "leaf package is missing `accountJwt` (the issued account JWT)" };
  }
  if (!isNscJwtShape(accountJwt)) {
    return {
      ok: false,
      reason: "leaf package `accountJwt` is not a JWT (expected an `eyJ…` token with three dot-separated segments)",
    };
  }

  // 5) Required creds path. The PATH (not the creds) — must be a non-empty string.
  const credsPath = optionalString(obj.credsPath);
  if (credsPath === undefined) {
    return {
      ok: false,
      reason: "leaf package is missing `credsPath` (the issued leaf .creds path)",
    };
  }

  // 6) Optional system account — when offered, it must be a valid nkey-U AND
  // paired with a valid JWT (a half-specified SYS account is malformed, exactly
  // as O-3's renderer refuses).
  const systemAccount = optionalString(obj.systemAccount);
  const systemAccountJwt = optionalString(obj.systemAccountJwt);
  if (systemAccount !== undefined) {
    if (!isNkeyAccountPubkey(systemAccount)) {
      return {
        ok: false,
        reason: "leaf package `systemAccount` is not an nkey-U account public key (`A…`, 56 chars)",
      };
    }
    if (systemAccountJwt === undefined || !isNscJwtShape(systemAccountJwt)) {
      return {
        ok: false,
        reason:
          "leaf package offers a `systemAccount` without a valid `systemAccountJwt` — " +
          "resolver_preload must carry the SYS account's JWT too",
      };
    }
  } else if (systemAccountJwt !== undefined) {
    // A SYS JWT with no SYS account is malformed (nothing to preload it against).
    return {
      ok: false,
      reason: "leaf package offers a `systemAccountJwt` without a `systemAccount`",
    };
  }

  // 7) Optional endpoint — shape only (must be a string when present). The
  // authoritative hub_url is the signed descriptor's (DD-12); this is advisory.
  if (obj.endpoint !== undefined && typeof obj.endpoint !== "string") {
    return { ok: false, reason: "leaf package `endpoint` must be a string (a dial-URL hint) when present" };
  }
  const endpoint = optionalString(obj.endpoint);

  return {
    ok: true,
    package: {
      operatorJwt,
      account,
      accountJwt,
      credsPath,
      ...(systemAccount !== undefined && { systemAccount }),
      ...(systemAccountJwt !== undefined && { systemAccountJwt }),
      ...(endpoint !== undefined && { endpoint }),
    },
  };
}

/**
 * Project a validated {@link LeafPackageFile} onto the {@link
 * OperatorModeLeafPackage} O-3's renderer consumes. The package is a SUPERSET
 * (it also carries `credsPath` + `endpoint`, which are NOT operator-mode render
 * material), so this drops those two and returns only the render fields.
 */
export function leafPackageToOperatorMode(
  pkg: LeafPackageFile,
): OperatorModeLeafPackage {
  return {
    operatorJwt: pkg.operatorJwt,
    account: pkg.account,
    accountJwt: pkg.accountJwt,
    ...(pkg.systemAccount !== undefined && { systemAccount: pkg.systemAccount }),
    ...(pkg.systemAccountJwt !== undefined && {
      systemAccountJwt: pkg.systemAccountJwt,
    }),
  };
}
