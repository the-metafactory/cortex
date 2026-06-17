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
