/**
 * Wave 0 PR-A.0b — exports-map CI gate.
 *
 * cortex's `package.json` `exports` field declares the public surface that
 * external consumers (pilot, signal-collector, future M7 apps) import via
 * named entry points:
 *
 *   @the-metafactory/cortex/bus            → ./src/bus/index.ts
 *   @the-metafactory/cortex/config-loader  → ./src/common/config/loader.ts
 *
 * These tests are the spec contract from `docs/design-pilot-restructure.md`
 * §7.4 — every row in the symbol table is asserted here. A failing test
 * means either:
 *   (a) the barrel dropped a symbol pilot consumes (regression — fix the
 *       barrel), or
 *   (b) cortex's internals renamed a symbol (intentional refactor — update
 *       BOTH the barrel AND this test in the same PR, then coordinate the
 *       cortex-sha bump on the pilot side).
 *
 * The test imports through the package name (NOT the deep `../bus/index`
 * path) so the assertion exercises the actual `exports` map resolution
 * that pilot will hit. Refs cortex#232, cortex#238.
 */

import { describe, expect, test } from "bun:test";

// `@the-metafactory/cortex/bus` — the bus surface pilot's `bus/` imports.
import {
  NatsLink,
  MyelinSubscriber,
  validateEnvelope,
  getSignedByChain,
  type Envelope,
  type EnvelopeHandler,
  type EnvelopeErrorHandler,
  type InvalidEnvelopeHandler,
  type InvalidEnvelopeReason,
  type MyelinSubscriberOptions,
  type NatsLinkOptions,
  type SignedBy,
  type SignedByEd25519,
  type SignedByHubStamp,
  type Classification,
  type ValidationResult,
} from "@the-metafactory/cortex/bus";

// `@the-metafactory/cortex/config-loader` — config bootstrap pilot's
// `bus/nats-link.ts` calls before opening a connection.
import {
  loadConfigWithAgents,
  loadConfig,
  expandTilde,
  type LoadedConfig,
} from "@the-metafactory/cortex/config-loader";

describe("exports map — @the-metafactory/cortex/bus", () => {
  test("re-exports the §7.4 symbol table (runtime values)", () => {
    // Class constructors — verify they're functions (classes are callable
    // factories). We don't instantiate (NatsLink.connect needs a real
    // server) — just confirm the symbol resolved through the exports map.
    expect(typeof NatsLink).toBe("function");
    expect(typeof MyelinSubscriber).toBe("function");

    // Pure validators / accessors — must be callable.
    expect(typeof validateEnvelope).toBe("function");
    expect(typeof getSignedByChain).toBe("function");
  });

  test("validateEnvelope returns a discriminated-union result on a malformed envelope", () => {
    const result = validateEnvelope({});
    // Result is `{ ok: true, envelope } | { ok: false, errors }` — assert
    // the shape pilot's publish path branches on. An empty object is
    // missing every required field, so `ok` MUST be false.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test("getSignedByChain returns an array (empty for an envelope with no chain)", () => {
    // Cast to Envelope shape just enough for the runtime walk — we're
    // exercising the symbol resolution, not the validator path.
    const fake = { signedBy: undefined } as unknown as Envelope;
    const chain = getSignedByChain(fake);
    expect(Array.isArray(chain)).toBe(true);
  });

  test("re-exports the type symbols (compile-time only — touched here to keep the imports load-bearing)", () => {
    // TypeScript erases types at runtime; we touch them in a no-op assign
    // so the imports above are NOT pruned by `verbatimModuleSyntax`.
    // The real assertion is that this file type-checks (run via
    // `bunx tsc --noEmit`) — that's the gate the spec relies on.
    type _Probe = [
      Envelope,
      EnvelopeHandler,
      EnvelopeErrorHandler,
      InvalidEnvelopeHandler,
      InvalidEnvelopeReason,
      MyelinSubscriberOptions,
      NatsLinkOptions,
      SignedBy,
      SignedByEd25519,
      SignedByHubStamp,
      Classification,
      ValidationResult,
    ];
    const _check: _Probe | undefined = undefined;
    expect(_check).toBeUndefined();
  });
});

describe("exports map — @the-metafactory/cortex/config-loader", () => {
  test("re-exports loadConfigWithAgents + loadConfig + expandTilde", () => {
    expect(typeof loadConfigWithAgents).toBe("function");
    expect(typeof loadConfig).toBe("function");
    expect(typeof expandTilde).toBe("function");
  });

  test("expandTilde resolves a leading ~ against $HOME", () => {
    const home = process.env.HOME ?? "~";
    expect(expandTilde("~/x")).toBe(`${home}/x`);
    // No-tilde path passes through untouched.
    expect(expandTilde("/abs/path")).toBe("/abs/path");
  });

  test("LoadedConfig type is reachable (compile-time)", () => {
    const _probe: LoadedConfig | undefined = undefined;
    expect(_probe).toBeUndefined();
  });
});
