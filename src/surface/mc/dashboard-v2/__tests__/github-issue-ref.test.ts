/**
 * Tests for the F-12b GitHub URL/shorthand parser.
 *
 * The server-side parser at `src/mission-control/api/github-ref.ts` is
 * the authoritative validator (cross-checked by `task-create-endpoints.test.ts`
 * over there). These tests pin the *client-side* pre-flight so a malformed
 * paste fails before the modal hits the network.
 *
 * Cross-references:
 *   - `docs/design-mc-f12b-add-to-queue.md` Decision 4 (accepted formats)
 *   - `lib/github-issue-ref.ts` (this module)
 */

import { describe, it, expect } from "bun:test";
import {
  canonicalRef,
  parseGitHubRef,
} from "../lib/github-issue-ref";

describe("parseGitHubRef — accepted forms (Decision 4)", () => {
  it("parses a full https issue URL", () => {
    const r = parseGitHubRef("https://github.com/the-metafactory/grove-v2/issues/42");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toEqual({
        owner: "the-metafactory", repo: "grove-v2", number: 42, kind: "issue",
      });
    }
  });

  it("parses a full https pull-request URL with kind='pr'", () => {
    const r = parseGitHubRef("https://github.com/owner/repo/pull/45");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref.kind).toBe("pr");
  });

  it("parses owner/repo#N shorthand with kind='auto'", () => {
    const r = parseGitHubRef("the-metafactory/grove-v2#42");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toEqual({
        owner: "the-metafactory", repo: "grove-v2", number: 42, kind: "auto",
      });
    }
  });

  it("parses repo#N shorthand using defaults.owner", () => {
    const r = parseGitHubRef("grove-v2#42", { owner: "the-metafactory" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref.owner).toBe("the-metafactory");
  });

  it("parses bare #N shorthand using both defaults", () => {
    const r = parseGitHubRef("#42", { owner: "the-metafactory", repo: "grove-v2" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref).toEqual({
        owner: "the-metafactory", repo: "grove-v2", number: 42, kind: "auto",
      });
    }
  });

  it("trims whitespace before parsing", () => {
    const r = parseGitHubRef("  owner/repo#7  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ref.number).toBe(7);
  });
});

describe("parseGitHubRef — rejected forms", () => {
  it("rejects empty string", () => {
    const r = parseGitHubRef("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty");
  });

  it("rejects whitespace-only string", () => {
    const r = parseGitHubRef("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty");
  });

  it("rejects bare #N when defaults aren't configured", () => {
    const r = parseGitHubRef("#5");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("needs-default-repo");
  });

  it("rejects repo#N when defaults.owner missing", () => {
    const r = parseGitHubRef("repo#5", { repo: "ignored" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("needs-default-repo");
  });

  it("rejects http (not https) URLs", () => {
    const r = parseGitHubRef("http://github.com/owner/repo/issues/1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-format");
  });

  it("rejects non-github.com hosts", () => {
    const r = parseGitHubRef("https://gist.github.com/abc/123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not-github-host");
  });

  it("rejects URLs that don't point at /issues/N or /pull/N", () => {
    const r = parseGitHubRef("https://github.com/owner/repo/discussions/1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-format");
  });

  it("rejects URLs with too few path parts", () => {
    const r = parseGitHubRef("https://github.com/owner");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-format");
  });

  it("rejects shorthand with too many slashes", () => {
    const r = parseGitHubRef("a/b/c#1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-format");
  });

  it("rejects malformed input that contains no '#'", () => {
    const r = parseGitHubRef("not-a-ref");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-format");
  });

  it("rejects invalid owner characters", () => {
    const r = parseGitHubRef("bad space/repo#1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-owner");
  });

  it("rejects invalid repo characters", () => {
    const r = parseGitHubRef("owner/bad space#1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-repo");
  });

  it("rejects zero or negative issue number", () => {
    // The shorthand pattern requires \d+ so '0' parses to 0 then rejects.
    const r = parseGitHubRef("owner/repo#0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-number");
  });

  it("rejects URLs that aren't valid", () => {
    const r = parseGitHubRef("https://[not a url]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad-format");
  });
});

describe("canonicalRef", () => {
  it("renders owner/repo#N", () => {
    expect(
      canonicalRef({ owner: "x", repo: "y", number: 9, kind: "auto" })
    ).toBe("x/y#9");
  });

  it("is identity-preserving across parse → canonical", () => {
    const r = parseGitHubRef("owner/repo#1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(canonicalRef(r.ref)).toBe("owner/repo#1");
  });
});
