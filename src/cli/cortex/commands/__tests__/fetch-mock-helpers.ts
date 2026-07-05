/**
 * S5 (#1519, epic #1514; Sage review round 3 on PR #1586) — shared
 * `globalThis.fetch` mocking helpers, so `network-admit.test.ts` and
 * `network-admit-adapters.test.ts` don't each carry their own copy.
 */

/** Install a mock `globalThis.fetch`. Callers restore the real one in `afterEach`. */
export function setMockFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
}

/** Normalize a fetch `input` (string | URL | Request) down to its URL string. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
