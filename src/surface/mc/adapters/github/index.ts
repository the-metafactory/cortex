/**
 * G-1113.B.3 — GitHub adapter boundary.
 *
 * The single entry point for GitHub-specific logic in the Mission Control
 * surface: URL/ref parsing (`./ref`) and `gh`-CLI issue/PR fetch (`./fetch`).
 * Consumers (handlers, iteration-import) import from `adapters/github` rather
 * than reaching into the individual modules, so adding a future provider means
 * adding a sibling `adapters/<provider>/` — not touching call sites.
 *
 * The boundary also emits the provider-neutral {@link SourceRef}
 * ({@link githubRefToSourceRef}) so the rest of Mission Control consumes the
 * normalized shape, not GitHub-native types.
 *
 * (Behavior-preserving move — `ref.ts` / `fetch.ts` are the former
 * `api/github-ref.ts` / `api/github-fetch.ts`, unchanged.)
 */
import type { SourceRef } from "../../types";
import { type GitHubRef, canonicalRef, canonicalUrl } from "./ref";

export * from "./ref";
export * from "./fetch";
export * from "./ingest";
export * from "./iteration-webhook";

/**
 * Normalize a parsed {@link GitHubRef} into a {@link SourceRef}. `externalId`
 * is the canonical `owner/repo#N` (the same string stored in
 * `source_external_id` and used as the dedup key); `url` is the canonical web
 * URL. `providerNativeType` reflects the ref kind — `"issue"` / `"pull_request"`
 * — or null for `"auto"` shorthand the GitHub API hasn't yet disambiguated.
 */
export function githubRefToSourceRef(ref: GitHubRef): SourceRef {
  return {
    provider: "github",
    externalId: canonicalRef(ref),
    url: canonicalUrl(ref),
    providerNativeType:
      ref.kind === "pr" ? "pull_request" : ref.kind === "issue" ? "issue" : null,
  };
}
