/**
 * cortex#1482 (epic #1479, join-3, Pair 2) — `resolverPreloadHasAccountKey`
 * unit tests. This is the ONE piece of non-trivial text parsing the doctor
 * adapter adds (a brace-matched scan mirroring `insertIntoResolverPreload`);
 * the pure orchestration behavior it feeds is covered end-to-end (fake
 * ports) in `network-doctor-lib.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { resolverPreloadHasAccountKey } from "../network-doctor-adapters";

describe("resolverPreloadHasAccountKey", () => {
  test("true when the account is a resolver_preload key", () => {
    const text = [
      "resolver: MEMORY",
      "resolver_preload: {",
      "  ACCOUNT_A: eyJhbGciOiJ...",
      "}",
    ].join("\n");
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(true);
  });

  test("false when resolver_preload exists but does NOT carry the account", () => {
    const text = [
      "resolver_preload: {",
      "  ACCOUNT_OTHER: eyJhbGciOiJ...",
      "}",
    ].join("\n");
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(false);
  });

  test("does NOT false-positive on the account appearing elsewhere in the file (e.g. a leaf remote's account: line)", () => {
    // The #1 reason a bare substring search is wrong: the leaf remote's OWN
    // `account:` line commonly carries the SAME pubkey the resolver_preload
    // question is about, but that's a DIFFERENT block.
    const text = [
      "leafnodes {",
      '  remotes: [ { url: "tls://hub:7422", account: "ACCOUNT_A" } ]',
      "}",
      "resolver_preload: {",
      "  ACCOUNT_OTHER: eyJhbGciOiJ...",
      "}",
    ].join("\n");
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(false);
  });

  test("undefined when there is no resolver_preload block at all (non-operator-mode bus)", () => {
    const text = "listen: 0.0.0.0:4222\njetstream {}\n";
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBeUndefined();
  });

  test("handles a nested brace inside the block without mis-locating the close", () => {
    const text = [
      "resolver_preload: {",
      "  ACCOUNT_A: eyJhbGciOiJ...",
      "  // a comment with a { brace } inside it",
      "  ACCOUNT_B: eyJhbGciOiJ...",
      "}",
      "other_block { unrelated: true }",
    ].join("\n");
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(true);
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_B")).toBe(true);
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_C")).toBe(false);
  });

  test("matches the `resolver_preload {` (no colon) spelling too", () => {
    const text = "resolver_preload {\n  ACCOUNT_A: eyJhbGciOiJ...\n}\n";
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(true);
  });

  test("an UNBALANCED brace in a full-line comment does NOT unbalance the scan (cheap-guard, Sage nit 5)", () => {
    const text = [
      "resolver_preload: {",
      "  // TODO: rebalance this someday { and never close it",
      "  ACCOUNT_A: eyJhbGciOiJ...",
      "}",
      "leafnodes { remotes: [] }",
    ].join("\n");
    // Without the full-line-comment guard, the lone `{` in the comment would
    // push depth to 2 and the block would run past its real close.
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(true);
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_OTHER")).toBe(false);
  });

  test("an inline `tls://` after a value is NOT treated as a comment (guard only blanks LINE-LEADING //)", () => {
    const text = [
      "leafnodes {",
      '  remotes: [ { url: "tls://hub:7422", account: "ACCOUNT_A" } ]',
      "}",
      "resolver_preload: {",
      "  ACCOUNT_A: eyJhbGciOiJ...",
      "}",
    ].join("\n");
    // The `tls://` mid-line must not be blanked (it isn't line-leading), and
    // the leaf remote's account: line must still not false-positive.
    expect(resolverPreloadHasAccountKey(text, "ACCOUNT_A")).toBe(true);
  });
});
