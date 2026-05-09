/**
 * Grove Mission Control v2 — F-12b URL parser unit tests.
 *
 * Pure-function coverage of every accepted format from Decision 4 plus
 * each documented rejection case. No I/O, no DB.
 */

import { describe, it, expect } from "bun:test";
import {
  parseGitHubRef,
  canonicalRef,
  canonicalUrl,
  isParseError,
  type GitHubRef,
} from "../api/github-ref";

function ok(x: GitHubRef | { error: string }): GitHubRef {
  if (isParseError(x)) {
    throw new Error(`expected GitHubRef, got error: ${x.error}`);
  }
  return x;
}

function err(x: GitHubRef | { error: string }): { error: string } {
  if (!isParseError(x)) {
    throw new Error(`expected ParseError, got ref: ${JSON.stringify(x)}`);
  }
  return x;
}

describe("parseGitHubRef — accepted formats", () => {
  it("parses an issue URL", () => {
    const r = ok(
      parseGitHubRef("https://github.com/the-metafactory/grove-v2/issues/42")
    );
    expect(r.owner).toBe("the-metafactory");
    expect(r.repo).toBe("grove-v2");
    expect(r.number).toBe(42);
    expect(r.kind).toBe("issue");
  });

  it("parses a PR URL", () => {
    const r = ok(
      parseGitHubRef("https://github.com/the-metafactory/grove-v2/pull/45")
    );
    expect(r.kind).toBe("pr");
    expect(r.number).toBe(45);
  });

  it("parses owner/repo#N shorthand → kind=auto", () => {
    const r = ok(parseGitHubRef("the-metafactory/grove-v2#42"));
    expect(r.owner).toBe("the-metafactory");
    expect(r.repo).toBe("grove-v2");
    expect(r.number).toBe(42);
    expect(r.kind).toBe("auto");
  });

  it("parses repo#N with default owner", () => {
    const r = ok(
      parseGitHubRef("grove-v2#42", { owner: "the-metafactory" })
    );
    expect(r.owner).toBe("the-metafactory");
    expect(r.repo).toBe("grove-v2");
    expect(r.kind).toBe("auto");
  });

  it("parses #N with default owner+repo", () => {
    const r = ok(
      parseGitHubRef("#42", { owner: "the-metafactory", repo: "grove-v2" })
    );
    expect(r.owner).toBe("the-metafactory");
    expect(r.repo).toBe("grove-v2");
    expect(r.number).toBe(42);
  });

  it("trims surrounding whitespace", () => {
    const r = ok(parseGitHubRef("  the-metafactory/grove-v2#42  "));
    expect(r.number).toBe(42);
  });
});

describe("parseGitHubRef — rejected formats", () => {
  it("rejects http:// URLs", () => {
    const e = err(parseGitHubRef("http://github.com/owner/repo/issues/1"));
    expect(e.error).toMatch(/HTTPS/);
  });

  it("rejects gist.github.com URLs", () => {
    const e = err(parseGitHubRef("https://gist.github.com/xyz"));
    expect(e.error).toMatch(/github\.com/);
  });

  it("rejects github.com URLs that are not /issues/ or /pull/", () => {
    const e = err(
      parseGitHubRef("https://github.com/orgs/the-metafactory/repositories")
    );
    expect(e.error).toMatch(/issues|pull/);
  });

  it("accepts URL with trailing path segments — only owner/repo/segment/N matter", () => {
    // GitHub appends /comments/, /commits/, etc. to issue/PR URLs in some
    // contexts; the parser ignores anything past the number. This is
    // intentional — the canonical {owner, repo, number} triple is what we
    // re-issue against the API, the trailing path is not honoured.
    const r = ok(
      parseGitHubRef(
        "https://github.com/owner/repo/issues/42/comments/extra"
      )
    );
    expect(r.owner).toBe("owner");
    expect(r.repo).toBe("repo");
    expect(r.number).toBe(42);
  });

  it("rejects #N without configured default repo", () => {
    const e = err(parseGitHubRef("#42"));
    expect(e.error).toMatch(/default/i);
  });

  it("rejects repo#N without configured default owner", () => {
    const e = err(parseGitHubRef("grove-v2#42"));
    expect(e.error).toMatch(/default/i);
  });

  it("rejects owner with invalid characters", () => {
    const e = err(parseGitHubRef("bad space/repo#1"));
    expect(e.error).toMatch(/owner|character/i);
  });

  it("rejects owner with leading dash", () => {
    const e = err(parseGitHubRef("-evil/repo#1"));
    expect(e.error).toMatch(/owner|character/i);
  });

  it("rejects owner with leading dot", () => {
    const e = err(parseGitHubRef(".git/repo#1"));
    expect(e.error).toMatch(/owner|character/i);
  });

  it("rejects repo with leading dash", () => {
    const e = err(parseGitHubRef("owner/-repo#1"));
    expect(e.error).toMatch(/repo|character/i);
  });

  it("rejects repo equal to '.' or '..'", () => {
    const e1 = err(parseGitHubRef("owner/.#1"));
    expect(e1.error).toMatch(/repo|character/i);
    const e2 = err(parseGitHubRef("owner/..#1"));
    expect(e2.error).toMatch(/repo|character/i);
  });

  it("accepts owner/repo with internal dots and dashes", () => {
    // Sanity: tightening the regex must not break legitimate identifiers
    // that have `.` / `-` after the first character (e.g. `grove-v2`,
    // `node.js`, `the-metafactory`).
    const ok = parseGitHubRef("the-metafactory/grove-v2#1");
    expect("error" in ok).toBe(false);
  });

  it("rejects repo with embedded slash", () => {
    const e = err(parseGitHubRef("owner/repo/extra#1"));
    expect(e.error).toMatch(/extra|segment|slash/i);
  });

  it("rejects non-positive numbers", () => {
    const e1 = err(parseGitHubRef("owner/repo#0"));
    expect(e1.error).toMatch(/positive|integer/i);
    const e2 = err(parseGitHubRef("owner/repo#-3"));
    expect(e2.error).toMatch(/positive|integer/i);
  });

  it("rejects empty input", () => {
    const e = err(parseGitHubRef("   "));
    expect(e.error).toMatch(/empty/i);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — runtime guard test
    const e = err(parseGitHubRef(42));
    expect(e.error).toMatch(/string/i);
  });

  it("rejects format with neither '#' nor URL prefix", () => {
    const e = err(parseGitHubRef("just-a-string"));
    expect(e.error).toMatch(/URL|owner|#N/);
  });
});

describe("canonicalRef and canonicalUrl", () => {
  it("canonicalRef formats as owner/repo#N", () => {
    const c = canonicalRef({ owner: "a", repo: "b", number: 7 });
    expect(c).toBe("a/b#7");
  });

  it("canonicalUrl uses /pull/ for PR kind, /issues/ otherwise", () => {
    expect(
      canonicalUrl({ owner: "a", repo: "b", number: 7, kind: "pr" })
    ).toBe("https://github.com/a/b/pull/7");
    expect(
      canonicalUrl({ owner: "a", repo: "b", number: 7, kind: "issue" })
    ).toBe("https://github.com/a/b/issues/7");
    expect(
      canonicalUrl({ owner: "a", repo: "b", number: 7, kind: "auto" })
    ).toBe("https://github.com/a/b/issues/7");
  });

  it("URL form and shorthand canonicalise to the same string", () => {
    const url = ok(parseGitHubRef("https://github.com/x/y/issues/3"));
    const sh = ok(parseGitHubRef("x/y#3"));
    expect(canonicalRef(url)).toBe(canonicalRef(sh));
  });
});
