/**
 * FND-6 — unit coverage for the mutation-guard pure logic (Host/Origin
 * allowlist, authorization binding, guarded-route predicate). The HTTP-level
 * DNS-rebinding scenario is exercised end-to-end in
 * `__tests__/mutation-guard-rebinding.test.ts`.
 */

import { describe, it, expect } from "bun:test";
import {
  buildAllowedHostnames,
  parseHostHeader,
  isHostAllowed,
  isOriginAllowed,
  checkAuthorization,
  isIdentityGatedMutation,
  isRebindExempt,
  type MutationGuardContext,
} from "../mutation-guard";

function ctx(
  overrides: Partial<MutationGuardContext> = {},
): MutationGuardContext {
  return {
    isLoopback: true,
    allowedHostnames: buildAllowedHostnames("127.0.0.1"),
    listenPort: 8767,
    principals: new Set<string>(),
    ...overrides,
  };
}

describe("buildAllowedHostnames", () => {
  it("always includes the loopback interfaces", () => {
    const hosts = buildAllowedHostnames("127.0.0.1");
    expect(hosts.has("127.0.0.1")).toBe(true);
    expect(hosts.has("localhost")).toBe(true);
    expect(hosts.has("::1")).toBe(true);
  });

  it("adds a real configured hostname (lowercased)", () => {
    const hosts = buildAllowedHostnames("MC.Internal.Example");
    expect(hosts.has("mc.internal.example")).toBe(true);
  });

  it("does not add a wildcard bind as a hostname", () => {
    expect(buildAllowedHostnames("0.0.0.0").has("0.0.0.0")).toBe(false);
    expect(buildAllowedHostnames("::").has("::")).toBe(false);
    expect(buildAllowedHostnames("").size).toBe(3);
  });
});

describe("parseHostHeader", () => {
  it("splits host:port", () => {
    expect(parseHostHeader("localhost:8767")).toEqual({ host: "localhost", port: "8767" });
    expect(parseHostHeader("127.0.0.1:8767")).toEqual({ host: "127.0.0.1", port: "8767" });
  });
  it("handles a bare host with no port", () => {
    expect(parseHostHeader("localhost")).toEqual({ host: "localhost", port: null });
  });
  it("handles bracketed IPv6 with and without a port", () => {
    expect(parseHostHeader("[::1]:8767")).toEqual({ host: "::1", port: "8767" });
    expect(parseHostHeader("[::1]")).toEqual({ host: "::1", port: null });
  });
  it("treats an unbracketed bare IPv6 as host-only", () => {
    expect(parseHostHeader("::1")).toEqual({ host: "::1", port: null });
  });
  it("lowercases the host", () => {
    expect(parseHostHeader("EVIL.COM:8767")).toEqual({ host: "evil.com", port: "8767" });
  });
  it("rejects a non-numeric port and empty input", () => {
    expect(parseHostHeader("localhost:abc")).toBeNull();
    expect(parseHostHeader("")).toBeNull();
  });
});

describe("isHostAllowed", () => {
  it("accepts loopback hosts on the listening port", () => {
    expect(isHostAllowed("127.0.0.1:8767", ctx())).toBe(true);
    expect(isHostAllowed("localhost:8767", ctx())).toBe(true);
    expect(isHostAllowed("[::1]:8767", ctx())).toBe(true);
  });
  it("accepts a bare loopback host (no port)", () => {
    expect(isHostAllowed("localhost", ctx())).toBe(true);
  });
  it("rejects a foreign host — the DNS-rebinding tell", () => {
    expect(isHostAllowed("evil.com:8767", ctx())).toBe(false);
    expect(isHostAllowed("attacker.internal", ctx())).toBe(false);
  });
  it("rejects a loopback host on the WRONG port", () => {
    expect(isHostAllowed("localhost:9999", ctx())).toBe(false);
  });
  it("fails closed on an absent or malformed Host", () => {
    expect(isHostAllowed(null, ctx())).toBe(false);
    expect(isHostAllowed("localhost:abc", ctx())).toBe(false);
  });
  it("accepts a configured non-loopback hostname", () => {
    const c = ctx({ allowedHostnames: buildAllowedHostnames("mc.example.com") });
    expect(isHostAllowed("mc.example.com:8767", c)).toBe(true);
  });
});

describe("isOriginAllowed", () => {
  it("allows an absent or empty Origin (non-browser / same-origin)", () => {
    expect(isOriginAllowed(null, ctx())).toBe(true);
    expect(isOriginAllowed("", ctx())).toBe(true);
  });
  it("allows a same-origin loopback Origin", () => {
    expect(isOriginAllowed("http://localhost:8767", ctx())).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:8767", ctx())).toBe(true);
  });
  it("rejects a foreign Origin", () => {
    expect(isOriginAllowed("https://evil.com", ctx())).toBe(false);
    expect(isOriginAllowed("http://evil.com:8767", ctx())).toBe(false);
  });
  it("rejects a loopback Origin on the wrong port", () => {
    expect(isOriginAllowed("http://localhost:9999", ctx())).toBe(false);
  });
  it("rejects the opaque `null` origin and garbage", () => {
    expect(isOriginAllowed("null", ctx())).toBe(false);
    expect(isOriginAllowed("not-a-url", ctx())).toBe(false);
  });
});

describe("checkAuthorization", () => {
  it("allows a listed principal", () => {
    const c = ctx({ principals: new Set(["principal@example.com"]) });
    expect(checkAuthorization("principal@example.com", c)).toBeNull();
  });
  it("is case-insensitive on the principal", () => {
    const c = ctx({ principals: new Set(["principal@example.com"]) });
    expect(checkAuthorization("Principal@Example.com", c)).toBeNull();
  });
  it("403s an unlisted principal even on loopback", async () => {
    const c = ctx({ principals: new Set(["someone@else.com"]) });
    const res = checkAuthorization("principal@example.com", c);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect((await res?.json())?.error).toBe("not_authorized");
  });
  it("allows on loopback when the allowlist is unset (permissive)", () => {
    expect(checkAuthorization("anyone@example.com", ctx({ principals: new Set() }))).toBeNull();
  });
  it("fails closed (403) off loopback when the allowlist is unset", async () => {
    const c = ctx({ isLoopback: false, principals: new Set() });
    const res = checkAuthorization("anyone@example.com", c);
    expect(res?.status).toBe(403);
    expect((await res?.json())?.error).toBe("not_authorized");
  });
});

describe("isIdentityGatedMutation", () => {
  it("gates the governed glass mutations", () => {
    expect(isIdentityGatedMutation("POST", "/api/sessions")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/networks/admission-decision")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/assignments/abc/requeue")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/assignments/abc/abandon")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/assignments/abc/handoff")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/assignments/abc/input")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/attention/xyz/resolve")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/attention/xyz/dismiss")).toBe(true);
  });
  it("also gates the previously-unauthenticated tasks/iterations family (cortex#1640, invariant 3)", () => {
    // These spawn principal-credentialed CC sessions / shell out to `gh` with
    // the principal's creds, yet were rebind-guarded but NOT identity-gated.
    expect(isIdentityGatedMutation("POST", "/api/tasks")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/tasks/t1/abandon")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/tasks/preview")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/iterations")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/iterations/from-github")).toBe(true);
    expect(isIdentityGatedMutation("PATCH", "/api/iterations/i1")).toBe(true);
    expect(isIdentityGatedMutation("POST", "/api/iterations/i1/tasks")).toBe(true);
    expect(isIdentityGatedMutation("DELETE", "/api/iterations/i1/tasks/t1")).toBe(true);
  });
  it("does NOT gate reads, or the HMAC-authed M2M webhook (no CF principal)", () => {
    expect(isIdentityGatedMutation("GET", "/api/sessions")).toBe(false);
    expect(isIdentityGatedMutation("GET", "/api/assignments/abc/requeue")).toBe(false);
    expect(isIdentityGatedMutation("GET", "/api/tasks")).toBe(false);
    expect(isIdentityGatedMutation("GET", "/api/attention")).toBe(false);
    // The webhook is the ONE mutating route left un-identity-gated — it
    // authenticates by HMAC, which a browser cannot forge, and carries no
    // CF-Access principal.
    expect(isIdentityGatedMutation("POST", "/api/github/webhook")).toBe(false);
  });
});

describe("isRebindExempt", () => {
  it("exempts only the HMAC-authed webhook", () => {
    expect(isRebindExempt("/api/github/webhook")).toBe(true);
    expect(isRebindExempt("/api/sessions")).toBe(false);
    expect(isRebindExempt("/api/networks/admission-decision")).toBe(false);
  });
});
