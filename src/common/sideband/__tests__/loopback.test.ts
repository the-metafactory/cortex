/**
 * P-14 U0.1 — loopback enforcement matrix (signal cortex-sideband.md §3/§8).
 *
 * The invariant under test: MC NEVER proxies to a non-loopback sideband. The
 * gate is fail-closed — anything not provably loopback is REFUSED.
 */

import { describe, expect, test } from "bun:test";
import {
  checkLoopbackSideband,
  isLoopbackSideband,
  DEFAULT_SIDEBAND_URL,
} from "../loopback";

describe("checkLoopbackSideband — accept set (§3 loopback boundary)", () => {
  const accepted = [
    ["default contract URL", DEFAULT_SIDEBAND_URL],
    ["127.0.0.1 with port", "http://127.0.0.1:9092"],
    ["127.0.0.1 no port", "http://127.0.0.1"],
    ["127.0.0.0/8 block member", "http://127.0.0.2:9092"],
    ["127.x high octet", "http://127.255.255.254:9092"],
    ["localhost", "http://localhost:9092"],
    ["localhost mixed case", "http://LocalHost:9092"],
    ["IPv6 ::1 bracketed", "http://[::1]:9092"],
    ["IPv6 ::1 no port", "http://[::1]"],
    ["IPv6 expanded loopback", "http://[0:0:0:0:0:0:0:1]:9092"],
    ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]:9092"],
    ["https loopback (reverse proxy)", "https://127.0.0.1:9443"],
    ["path suffix preserved", "http://127.0.0.1:9092/sideband"],
  ] as const;

  for (const [label, url] of accepted) {
    test(`accepts ${label}: ${url}`, () => {
      const res = checkLoopbackSideband(url);
      expect(res.ok).toBe(true);
      expect(isLoopbackSideband(url)).toBe(true);
    });
  }
});

describe("checkLoopbackSideband — reject set (fail closed)", () => {
  const rejected = [
    ["unspecified IPv4 bind", "http://0.0.0.0:9092"],
    ["unspecified IPv6 bind", "http://[::]:9092"],
    ["LAN private 192.168", "http://192.168.1.50:9092"],
    ["LAN private 10.x", "http://10.0.0.5:9092"],
    ["LAN private 172.16", "http://172.16.0.9:9092"],
    ["public IPv4", "http://203.0.113.7:9092"],
    ["routable IPv6", "http://[2001:db8::1]:9092"],
    ["arbitrary hostname", "http://sideband.internal:9092"],
    ["evil hostname", "http://evil.com:9092"],
    ["subdomain of localhost (not loopback)", "http://localhost.evil.com:9092"],
    ["userinfo smuggling", "http://127.0.0.1@evil.com:9092"],
    ["userinfo on loopback host", "http://user:pass@127.0.0.1:9092"],
    ["non-http scheme file", "file:///etc/passwd"],
    ["non-http scheme ws", "ws://127.0.0.1:9092"],
    ["non-http scheme javascript", "javascript:alert(1)"],
    ["out-of-range octet", "http://127.0.0.999:9092"],
    ["not a url", "not-a-url"],
    ["empty string", ""],
    ["whitespace only", "   "],
  ] as const;

  for (const [label, url] of rejected) {
    test(`refuses ${label}: ${url}`, () => {
      const res = checkLoopbackSideband(url);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason.length).toBeGreaterThan(0);
      }
      expect(isLoopbackSideband(url)).toBe(false);
    });
  }
});

describe("checkLoopbackSideband — returns parsed URL on accept", () => {
  test("exposes the parsed URL for the proxy to build request URLs from", () => {
    const res = checkLoopbackSideband("http://127.0.0.1:9092");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.url.hostname).toBe("127.0.0.1");
      expect(res.url.port).toBe("9092");
      expect(res.url.protocol).toBe("http:");
    }
  });
});
