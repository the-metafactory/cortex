/**
 * O-3 (cortex#1053, epic #1050, operator-mode conversion; spec
 * `docs/design-automated-operator-onboarding.md` §4-D2) — `cortex network join`
 * auto-converts an anonymous/default bus to operator-mode instead of
 * fail-fasting (#794) and telling a human to hand-edit `<slug>.conf`.
 *
 * This file is the RED-first spec for the PURE renderer half of O-3:
 * {@link renderOperatorModeBlocks}. Given the stack's CURRENT (anonymous /
 * hard-isolated) nats config text + a "leaf package" (operator JWT + the issued
 * account pubkey `A…` + account JWT, optional system account), it renders the
 * SOP §B0.1 operator-mode blocks INTO the config — `operator:`, `system_account`,
 * `resolver: MEMORY`, `resolver_preload { <account>: <jwt> }` — while KEEPING the
 * stack's own `server_name` / `listen` / `http` / `jetstream.domain` and WITHOUT
 * adding a meta-factory leaf include (the join renders its own).
 *
 * It is a PURE function (text in, text out) — no filesystem, no daemon. The
 * orchestrator (network-lib joinNetwork) calls it through the LeafFilePort.
 *
 * Fail-fast remains ONLY when the package is genuinely absent (no operator JWT /
 * no account). Idempotent: re-running on an already-converted bus is a byte-stable
 * no-op (status "already"). NEVER clobber a bus that's ALREADY operator-mode under
 * a DIFFERENT operator JWT — detect + refuse with a clear error.
 *
 * Public repo — key material here is obvious fake `eyJ…` / `A…`-shaped fixtures.
 */

import { describe, expect, test } from "bun:test";

import {
  renderOperatorModeBlocks,
  natsConfigHasAccountTree,
  natsConfigCanBindAccount,
  type OperatorModeConversion,
  type OperatorModeLeafPackage,
} from "../leaf-remote-renderer";

/** Narrow to the converted config, failing the test with the reason otherwise. */
function mustConvert(result: OperatorModeConversion): string {
  if (result.status !== "converted") {
    throw new Error(
      `expected converted, got ${result.status}` +
        (result.status === "refuse" ? `: ${result.reason}` : ""),
    );
  }
  return result.conf;
}

/**
 * cortex#1480 — INDEPENDENT structural parse of the rendered `resolver_preload
 * { … }` block: returns the account pubkeys that appear as literal `<pubkey>:`
 * KEY lines inside it. Deliberately does NOT call any production predicate
 * (`natsConfigCanBindAccount`), so a keystone assertion built on it can't be
 * circular with the code under test (which computes what to append USING that
 * predicate). Test-only; a small hand-rolled brace-matched extractor.
 */
function preloadKeys(conf: string): string[] {
  const m = /resolver_preload\s*[:=]?\s*\{/.exec(conf);
  if (m === null) return [];
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = open; i < conf.length; i++) {
    if (conf[i] === "{") depth++;
    else if (conf[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const keys: string[] = [];
  for (const line of conf.slice(open + 1, end).split("\n")) {
    const km = /^\s*(A[A-Z2-7]{55})\s*:/.exec(line);
    if (km?.[1] !== undefined) keys.push(km[1]);
  }
  return keys;
}

// =============================================================================
// Fixtures — an anonymous bus (the Part-1 hard-isolated shape) + a leaf package.
// =============================================================================

/**
 * The anonymous / hard-isolated bus shape from sop-stack-onboarding.md Step 2:
 * server identity + ports + jetstream domain, NO leafnodes/cluster/gateway,
 * NO operator-mode account tree. This is what Part-1 stands a stack up on.
 */
const ANON_CONF = [
  "server_name: community-andreas",
  "listen: 127.0.0.1:4224",
  "http: 127.0.0.1:8224",
  "jetstream {",
  "  store_dir: /Users/andreas/.config/nats/community-jetstream",
  "  max_mem: 64mb",
  "  max_file: 1gb",
  "  domain: community-andreas",
  "}",
  "",
].join("\n");

// Obvious fake operator-mode material (a public-repo-safe leaf package).
const OPERATOR_JWT =
  "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_OPERATOR_JWT_BODY.sig";
const ACCOUNT = "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX";
const ACCOUNT_JWT =
  "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_ACCOUNT_JWT_BODY.sig";
const SYS_ACCOUNT = "ADSYS6VXCEEKH62BYKGBHXQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVM";
const SYS_ACCOUNT_JWT =
  "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_SYS_JWT_BODY.sig";
// cortex#1480 (join-1, epic #1479) — the AGENTS account, the third leg of the
// "FED + AGENTS + SYS" trio a fully-converged resolver_preload must carry.
const AGENTS_ACCOUNT = "A" + "G".repeat(55);
const AGENTS_ACCOUNT_JWT =
  "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_AGENTS_JWT_BODY.sig";

const PACKAGE: OperatorModeLeafPackage = {
  operatorJwt: OPERATOR_JWT,
  account: ACCOUNT,
  accountJwt: ACCOUNT_JWT,
};

const PACKAGE_WITH_SYS: OperatorModeLeafPackage = {
  ...PACKAGE,
  systemAccount: SYS_ACCOUNT,
  systemAccountJwt: SYS_ACCOUNT_JWT,
};

const PACKAGE_WITH_AGENTS: OperatorModeLeafPackage = {
  ...PACKAGE,
  agentsAccount: AGENTS_ACCOUNT,
  agentsAccountJwt: AGENTS_ACCOUNT_JWT,
};

const PACKAGE_WITH_ALL_THREE: OperatorModeLeafPackage = {
  ...PACKAGE_WITH_SYS,
  agentsAccount: AGENTS_ACCOUNT,
  agentsAccountJwt: AGENTS_ACCOUNT_JWT,
};

// =============================================================================
// Happy path — anonymous bus + leaf package → operator-mode blocks added.
// =============================================================================

describe("renderOperatorModeBlocks — convert an anonymous bus (O-3 D2)", () => {
  test("an anonymous bus is NOT operator-mode to start (the #794 fail-fast input)", () => {
    expect(natsConfigHasAccountTree(ANON_CONF)).toBe(false);
  });

  test("renders the four SOP §B0.1 operator-mode blocks", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, PACKAGE);
    expect(result.status).toBe("converted");
    const conf = mustConvert(result);

    expect(conf).toContain(`operator: ${OPERATOR_JWT}`);
    expect(conf).toContain("resolver: MEMORY");
    expect(conf).toContain("resolver_preload");
    // the issued account is preloaded with its JWT
    expect(conf).toContain(`${ACCOUNT}: ${ACCOUNT_JWT}`);
  });

  test("the converted config IS operator-mode (the bind check now passes)", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    expect(natsConfigHasAccountTree(conf)).toBe(true);
  });

  test("KEEPS the stack's own server_name / listen / http / jetstream domain", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    expect(conf).toContain("server_name: community-andreas");
    expect(conf).toContain("listen: 127.0.0.1:4224");
    expect(conf).toContain("http: 127.0.0.1:8224");
    expect(conf).toContain("domain: community-andreas");
    expect(conf).toContain(
      "store_dir: /Users/andreas/.config/nats/community-jetstream",
    );
  });

  test("does NOT add a meta-factory leaf include (the join renders its own)", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    // No leafnodes block and no `include "leafnodes-…"` — that is join's job.
    expect(conf).not.toContain("leafnodes-metafactory");
    expect(conf).not.toMatch(/^[ \t]*leafnodes[ \t]*\{/m);
    expect(conf).not.toMatch(/include[ \t]+["']leafnodes-/);
  });

  test("renders system_account when the package carries a SYS account", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE_WITH_SYS));
    expect(conf).toContain(`system_account: ${SYS_ACCOUNT}`);
    // and the SYS account is preloaded too
    expect(conf).toContain(`${SYS_ACCOUNT}: ${SYS_ACCOUNT_JWT}`);
  });

  // cortex#1480 (join-1, epic #1479) — resolver_preload must carry EVERY
  // account the stack federates on: FED (always), AGENTS and SYS when the
  // package carries them — and ONLY those it declares (no stray entries).
  test("cortex#1480: preloads AGENTS alongside FED when the package carries one, and omits SYS when absent", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE_WITH_AGENTS));
    expect(conf).toContain(`${ACCOUNT}: ${ACCOUNT_JWT}`);
    expect(conf).toContain(`${AGENTS_ACCOUNT}: ${AGENTS_ACCOUNT_JWT}`);
    // "only those it declares" — no SYS account line was offered, so none renders.
    expect(conf).not.toContain("system_account:");
    expect(conf).not.toContain(SYS_ACCOUNT);
  });

  test("cortex#1480: preloads all three (FED + AGENTS + SYS) when the package carries all three", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE_WITH_ALL_THREE));
    expect(conf).toContain(`${ACCOUNT}: ${ACCOUNT_JWT}`);
    expect(conf).toContain(`${AGENTS_ACCOUNT}: ${AGENTS_ACCOUNT_JWT}`);
    expect(conf).toContain(`${SYS_ACCOUNT}: ${SYS_ACCOUNT_JWT}`);
    expect(conf).toContain(`system_account: ${SYS_ACCOUNT}`);
  });

  test("cortex#1480 ACCEPTANCE KEYSTONE: FED + AGENTS + SYS each appear as a literal preload KEY in the rendered " +
    "resolver_preload block — asserted by an INDEPENDENT structural parse (NOT the production bind predicate). With " +
    "fake JWTs this is text-structure-verified, not nats-server-verified", () => {
    const conf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE_WITH_ALL_THREE));
    const keys = preloadKeys(conf);
    expect(keys).toContain(ACCOUNT);
    expect(keys).toContain(AGENTS_ACCOUNT);
    expect(keys).toContain(SYS_ACCOUNT);
    // Secondary sanity check via the production predicate — kept, but NOT the
    // keystone: it would be circular (renderOperatorModeBlocks decides what to
    // append using this SAME predicate).
    expect(natsConfigCanBindAccount(conf, ACCOUNT).canBind).toBe(true);
  });
});

// =============================================================================
// Idempotency — re-running on a converted bus is a byte-stable no-op.
// =============================================================================

describe("renderOperatorModeBlocks — idempotent", () => {
  test("re-running on a bus this package already converted is status 'already'", () => {
    const firstConf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    const second = renderOperatorModeBlocks(firstConf, PACKAGE);
    expect(second.status).toBe("already");
  });

  test("re-render produces byte-identical config (no drift, no duplicate blocks)", () => {
    const firstConf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    const second = renderOperatorModeBlocks(firstConf, PACKAGE);
    // 'already' carries the unchanged conf so the orchestrator can write it
    // byte-stably (or skip the write).
    if (second.status !== "already") throw new Error("expected already");
    expect(second.conf).toBe(firstConf);
    // exactly ONE operator-mode `operator:` line — no duplicate splice.
    const operatorModeLines = firstConf
      .split("\n")
      .filter((l) => /^[ \t]*operator[ \t]*:/.test(l)); // operator-mode block
    expect(operatorModeLines).toHaveLength(1);
  });
});

// =============================================================================
// Fail-fast — material genuinely absent → cannot convert.
// =============================================================================

describe("renderOperatorModeBlocks — fail-fast on missing material", () => {
  test("missing operator JWT → refuse with an actionable reason", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      operatorJwt: "",
    });
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toMatch(/operator/i); // operator-mode material
  });

  test("missing account → refuse", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      account: "",
    });
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toMatch(/account/i);
  });

  test("missing account JWT → refuse (resolver_preload needs the JWT)", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      accountJwt: "",
    });
    expect(result.status).toBe("refuse");
  });

  test("a non-nkey-U account → refuse (HOCON-injection guard)", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      account: "not-an-nkey",
    });
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toMatch(/nkey|account/i);
  });

  // Security-review NIT-1 (#1058) — JWT_SHAPE requires EXACTLY 3 segments.
  test("a 2-segment operatorJwt → refuse (not a valid NSC JWT — fail fast here)", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      operatorJwt: "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.ONLY_TWO_SEGMENTS",
    });
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toMatch(/JWT/i);
  });

  test("a 2-segment account 'JWT' → refuse", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      accountJwt: "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.ONLY_TWO",
    });
    expect(result.status).toBe("refuse");
  });

  test("a canonical 3-segment JWT is accepted (header.payload.signature)", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, {
      ...PACKAGE,
      operatorJwt: "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.PAYLOAD.SIGNATURE",
    });
    expect(result.status).toBe("converted");
  });
});

// =============================================================================
// Never clobber — already operator-mode under a DIFFERENT operator → refuse.
// =============================================================================

describe("renderOperatorModeBlocks — never clobber a foreign operator", () => {
  const FOREIGN_OPERATOR_JWT =
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.A_DIFFERENT_OPERATOR.sig";
  const ALREADY_OPERATOR_CONF = [
    "server_name: community-andreas",
    "listen: 127.0.0.1:4224",
    `operator: ${FOREIGN_OPERATOR_JWT}`,
    "system_account: ADSYSACCOUNT0000000000000000000000000000000000000000000",
    "resolver: MEMORY",
    "resolver_preload: {",
    "  ABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB: eyJ.OTHER.sig",
    "}",
    "",
  ].join("\n");

  test("converting onto a config already operator-mode under a DIFFERENT operator refuses", () => {
    const result = renderOperatorModeBlocks(ALREADY_OPERATOR_CONF, PACKAGE);
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toMatch(/operator|already/i); // operator-mode
  });

  test("converting onto a config already operator-mode under the SAME operator + account is 'already'", () => {
    // Build the exact converted shape this package would produce, then re-run.
    const convertedConf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    const again = renderOperatorModeBlocks(convertedConf, PACKAGE);
    expect(again.status).toBe("already");
  });
});

// =============================================================================
// cortex#1480 (join-1, epic #1479) — ENSURE a MISSING account under the SAME
// operator. This is the RED-first spec for the real production bug: a bus
// bootstrapped before its FED account existed (or hand-converted carrying
// only the AGENTS account) stays "operator-mode under the SAME operator"
// forever, so the OLD operator-JWT-only "already" check silently left FED
// un-preloaded — the exact "does not define account <FED>" fail-closed that
// blocked the metafactory-community bring-up.
// =============================================================================

describe("renderOperatorModeBlocks — cortex#1480: ensure a MISSING account under the SAME operator", () => {
  // A bus operator-mode under OPERATOR_JWT (the SAME operator PACKAGE uses)
  // whose resolver_preload carries ONLY the AGENTS account — exactly the
  // real-world shape (make-live's always-run AGENTS append succeeded; FED
  // never got preloaded because the old bootstrap gate only fired when
  // resolver_preload was WHOLLY ABSENT).
  const AGENTS_ONLY_CONF = [
    "server_name: community-andreas",
    "listen: 127.0.0.1:4224",
    `operator: ${OPERATOR_JWT}`,
    "resolver: MEMORY",
    "resolver_preload: {",
    `  ${AGENTS_ACCOUNT}: ${AGENTS_ACCOUNT_JWT}`,
    "}",
    "",
  ].join("\n");

  test("precondition: the bus IS operator-mode but does NOT yet bind FED (the real bug's starting state)", () => {
    expect(natsConfigHasAccountTree(AGENTS_ONLY_CONF)).toBe(true);
    expect(natsConfigCanBindAccount(AGENTS_ONLY_CONF, ACCOUNT).canBind).toBe(false);
  });

  test("a FED-only package on the AGENTS-only bus ENSURES (appends) the missing FED account — status 'converted', not 'already'", () => {
    const result = renderOperatorModeBlocks(AGENTS_ONLY_CONF, PACKAGE);
    expect(result.status).toBe("converted");
    const conf = mustConvert(result);
    expect(conf).toContain(`${ACCOUNT}: ${ACCOUNT_JWT}`);
    // the pre-existing AGENTS entry survives untouched.
    expect(conf).toContain(`${AGENTS_ACCOUNT}: ${AGENTS_ACCOUNT_JWT}`);
    // no duplicate `operator:` line — the skeleton itself was NOT re-rendered,
    // only the missing account was spliced into the EXISTING resolver_preload.
    const operatorLines = conf.split("\n").filter((l) => /^[ \t]*operator[ \t]*:/.test(l)); // operator-mode block
    expect(operatorLines).toHaveLength(1);
  });

  test("ACCEPTANCE KEYSTONE: after the ensure, the FED pubkey appears as a literal preload KEY (INDEPENDENT structural parse, not the production predicate)", () => {
    const conf = mustConvert(renderOperatorModeBlocks(AGENTS_ONLY_CONF, PACKAGE));
    expect(preloadKeys(conf)).toContain(ACCOUNT);
    // pre-existing AGENTS key survives too.
    expect(preloadKeys(conf)).toContain(AGENTS_ACCOUNT);
  });

  test("re-running the SAME package again after the ensure is now a byte-stable 'already' (nothing left missing)", () => {
    const ensuredConf = mustConvert(renderOperatorModeBlocks(AGENTS_ONLY_CONF, PACKAGE));
    const again = renderOperatorModeBlocks(ensuredConf, PACKAGE);
    expect(again.status).toBe("already");
    if (again.status !== "already") throw new Error("expected already");
    expect(again.conf).toBe(ensuredConf); // byte-stable, no drift, no duplicate splice.
  });

  test("a package carrying an AGENTS account ALSO ensures AGENTS into a FED-only bus", () => {
    // FED-only bus (mirrors a bus bootstrapped before AGENTS was ever included).
    const fedOnlyConf = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    expect(preloadKeys(fedOnlyConf)).not.toContain(AGENTS_ACCOUNT);

    const result = renderOperatorModeBlocks(fedOnlyConf, PACKAGE_WITH_AGENTS);
    expect(result.status).toBe("converted");
    const conf = mustConvert(result);
    expect(preloadKeys(conf)).toContain(ACCOUNT);
    expect(preloadKeys(conf)).toContain(AGENTS_ACCOUNT);
  });

  // cortex#1480 — an operator-mode bus needs BOTH the SYS account in
  // resolver_preload AND a top-level `system_account:` directive; the ensure
  // path must add the directive too (not only the preload entry), or the server
  // would know the account but never use it as the system account.
  test("ensuring a SYS account into an operator-mode bus that lacks the `system_account:` directive ADDS the directive too", () => {
    // A FED-only bus rendered from scratch carries NO `system_account:` (no SYS
    // in that package) — the real starting shape.
    const fedOnlyNoSys = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    expect(fedOnlyNoSys).not.toContain("system_account:");

    const result = renderOperatorModeBlocks(fedOnlyNoSys, PACKAGE_WITH_SYS);
    expect(result.status).toBe("converted");
    const conf = mustConvert(result);
    // SYS added to resolver_preload (structural) AND the top-level directive set.
    expect(preloadKeys(conf)).toContain(SYS_ACCOUNT);
    expect(conf).toContain(`system_account: ${SYS_ACCOUNT}`);
  });

  test("the SYS-directive ensure is idempotent: re-running is byte-stable 'already', directive not duplicated", () => {
    const fedOnly = mustConvert(renderOperatorModeBlocks(ANON_CONF, PACKAGE));
    const ensured = mustConvert(renderOperatorModeBlocks(fedOnly, PACKAGE_WITH_SYS));
    const again = renderOperatorModeBlocks(ensured, PACKAGE_WITH_SYS);
    expect(again.status).toBe("already");
    if (again.status !== "already") throw new Error("expected already");
    expect(again.conf).toBe(ensured);
    const directiveLines = ensured
      .split("\n")
      .filter((l) => /^[ \t]*system_account[ \t]*:/.test(l));
    expect(directiveLines).toHaveLength(1);
  });

  test("does NOT clobber an EXISTING `system_account:` directive when ensuring other accounts", () => {
    // A bus whose SYS directive + SYS preload already exist, but FED is missing.
    const withSysDirective = [
      `operator: ${OPERATOR_JWT}`,
      `system_account: ${SYS_ACCOUNT}`,
      "resolver: MEMORY",
      "resolver_preload: {",
      `  ${SYS_ACCOUNT}: ${SYS_ACCOUNT_JWT}`,
      "}",
      "",
    ].join("\n");
    const conf = mustConvert(renderOperatorModeBlocks(withSysDirective, PACKAGE_WITH_SYS));
    // FED got added; SYS directive stays exactly once (never re-appended).
    expect(preloadKeys(conf)).toContain(ACCOUNT);
    const directiveLines = conf.split("\n").filter((l) => /^[ \t]*system_account[ \t]*:/.test(l));
    expect(directiveLines).toHaveLength(1);
  });

  test("refuses (never silently drops the missing account) when operator-mode under THIS operator but no resolver_preload block exists to append into", () => {
    const noPreloadBlock = [
      `operator: ${OPERATOR_JWT}`,
      `system_account: ${SYS_ACCOUNT}`, // an operator-mode signal, but no resolver_preload block anywhere
      "",
    ].join("\n");
    const result = renderOperatorModeBlocks(noPreloadBlock, PACKAGE);
    expect(result.status).toBe("refuse");
    if (result.status !== "refuse") throw new Error("expected refuse");
    expect(result.reason).toContain("resolver_preload");
  });
});
