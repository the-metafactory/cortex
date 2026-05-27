/**
 * `safeSourceHref` — XSS guard for principal-imported source URLs.
 *
 * Iteration source URLs come from upstream issue bodies; a malicious
 * upstream could embed `javascript:` or `data:` URLs that would execute
 * on click. The helper returns `null` for any non-`http(s):` scheme so
 * the caller can render a non-anchor badge instead.
 */

import { describe, it, expect } from "bun:test";
import { safeSourceHref } from "../lib/safe-href";

describe("safeSourceHref", () => {
  it("returns the URL for http: and https:", () => {
    expect(safeSourceHref("http://example.com/x")).toBe("http://example.com/x");
    expect(safeSourceHref("https://github.com/o/r/issues/1")).toBe("https://github.com/o/r/issues/1");
  });

  it("returns null for javascript: (the canonical XSS vector)", () => {
    expect(safeSourceHref("javascript:alert(1)")).toBeNull();
    expect(safeSourceHref("JavaScript:alert(1)")).toBeNull();      // case-insensitive
    expect(safeSourceHref("  javascript:alert(1)")).toBeNull();    // leading whitespace
  });

  it("returns null for data: URLs (would execute as HTML)", () => {
    expect(safeSourceHref("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("returns null for other non-web schemes", () => {
    expect(safeSourceHref("file:///etc/passwd")).toBeNull();
    expect(safeSourceHref("mailto:x@y.com")).toBeNull();
    expect(safeSourceHref("ftp://example.com")).toBeNull();
  });

  it("returns null for null / undefined / empty input", () => {
    expect(safeSourceHref(null)).toBeNull();
    expect(safeSourceHref(undefined)).toBeNull();
    expect(safeSourceHref("")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(safeSourceHref("not a url")).toBeNull();
    expect(safeSourceHref("//example.com")).toBeNull();   // relative protocol — no scheme to allowlist
  });
});
