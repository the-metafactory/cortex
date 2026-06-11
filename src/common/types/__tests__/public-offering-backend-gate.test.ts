/**
 * CO-7 M3 (epic cortex#939) — public-offering ⇒ non-local-backend gate tests.
 *
 * Asserts the fail-closed config gate: a `public`-scoped offering on a local
 * (or unset / undeclared) backend is a VIOLATION; on a declared non-local
 * backend it passes; `local`/`federated` offerings are never gated; no
 * offerings ⇒ no violations (byte-identical default).
 */

import { describe, test, expect } from "bun:test";

import {
  checkPublicOfferingBackendGate,
  resolvesToNonLocalBackend,
  LOCAL_BACKEND_NAME,
  type ExecutionConfigView,
  type OfferingScopesView,
} from "../public-offering-backend-gate";

const localExec: ExecutionConfigView = { default: "local", backends: [] };
const sandboxExec: ExecutionConfigView = {
  default: "cf-sandbox",
  backends: [{ name: "cf-sandbox", type: "cloudflare" }],
};

describe("resolvesToNonLocalBackend", () => {
  test("undefined exec ⇒ false (local default)", () => {
    expect(resolvesToNonLocalBackend(undefined)).toBe(false);
  });
  test("default 'local' ⇒ false", () => {
    expect(resolvesToNonLocalBackend(localExec)).toBe(false);
  });
  test("declared non-local backend ⇒ true", () => {
    expect(resolvesToNonLocalBackend(sandboxExec)).toBe(true);
  });
  test("default names an UNDECLARED backend ⇒ false (fail closed)", () => {
    expect(
      resolvesToNonLocalBackend({ default: "ghost", backends: [] }),
    ).toBe(false);
  });
  test("a declared backend whose type is the local built-in ⇒ false", () => {
    expect(
      resolvesToNonLocalBackend({
        default: "x",
        backends: [{ name: "x", type: LOCAL_BACKEND_NAME }],
      }),
    ).toBe(false);
  });
});

describe("checkPublicOfferingBackendGate", () => {
  const publicOffering: OfferingScopesView = {
    capability: "code-review.typescript",
    scopes: ["public"],
  };
  const localOffering: OfferingScopesView = {
    capability: "dev.implement",
    scopes: ["local"],
  };
  const federatedOffering: OfferingScopesView = {
    capability: "chat",
    scopes: ["federated"],
  };

  test("no offerings ⇒ no violations (byte-identical default)", () => {
    expect(checkPublicOfferingBackendGate(undefined, localExec)).toEqual([]);
    expect(checkPublicOfferingBackendGate([], localExec)).toEqual([]);
  });

  test("public offering on a LOCAL backend ⇒ violation", () => {
    const v = checkPublicOfferingBackendGate([publicOffering], localExec);
    expect(v.length).toBe(1);
    expect(v[0]?.capability).toBe("code-review.typescript");
    expect(v[0]?.resolvedBackend).toBe("local");
    expect(v[0]?.message).toContain("non-local ExecutionBackend");
  });

  test("public offering on an UNSET (undefined) exec ⇒ violation", () => {
    const v = checkPublicOfferingBackendGate([publicOffering], undefined);
    expect(v.length).toBe(1);
    expect(v[0]?.resolvedBackend).toBe(LOCAL_BACKEND_NAME);
  });

  test("public offering on a NON-LOCAL backend ⇒ gate passes", () => {
    expect(checkPublicOfferingBackendGate([publicOffering], sandboxExec)).toEqual([]);
  });

  test("local/federated offerings are NEVER gated (even on local backend)", () => {
    expect(
      checkPublicOfferingBackendGate([localOffering, federatedOffering], localExec),
    ).toEqual([]);
  });

  test("batch-emits all public violations in one pass", () => {
    const second: OfferingScopesView = { capability: "chat", scopes: ["public"] };
    const v = checkPublicOfferingBackendGate(
      [publicOffering, localOffering, second],
      localExec,
    );
    expect(v.map((x) => x.capability).sort()).toEqual(["chat", "code-review.typescript"]);
    // indices point at the right offerings.
    expect(v.find((x) => x.capability === "chat")?.offeringIndex).toBe(2);
  });

  test("a multi-scope offering including public is gated when backend is local", () => {
    const multi: OfferingScopesView = {
      capability: "code-review.typescript",
      scopes: ["local", "public"],
    };
    expect(checkPublicOfferingBackendGate([multi], localExec).length).toBe(1);
    expect(checkPublicOfferingBackendGate([multi], sandboxExec)).toEqual([]);
  });
});
