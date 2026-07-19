// Tests for the ARC_REF bump core (cortex#2246).
//
// Pure-logic coverage — no network, no docker. The workflow
// (.github/workflows/arc-ref-bump.yml) owns the side effects (resolve latest
// release via `gh api`, docker-build gate, open the PR); this suite pins the
// decision + byte-level rewrite the workflow depends on:
//   - semver compare (newer / equal / older / prerelease precedence)
//   - readArcRef targets the ARG DEFINITION line, not the bare re-declaration
//   - rewriteArcRef bumps to a newer tag + is idempotent + preserves the pin
//   - malformed / missing ARG line is handled (null, no phantom rewrite)
//   - main(): newer -> rewrite w/ --write; equal/older -> no-op; missing -> 3
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSemver,
  compareSemver,
  readArcRef,
  rewriteArcRef,
  decideBump,
  main,
} from "../arc-ref-bump";

// A minimal but structurally faithful stand-in for Dockerfile.cortex: it has
// BOTH the `ARG ARC_REF=<value>` definition (before FROM) and the bare
// `ARG ARC_REF` re-declaration (in the build stage), exactly like the real file.
function fixtureDockerfile(ref: string): string {
  return [
    "# syntax=docker/dockerfile:1",
    "ARG CORTEX_REF=v6.10.0",
    `ARG ARC_REF=${ref}`,
    "ARG CORTEX_SURFACES=discord",
    "",
    "FROM debian:bookworm-slim",
    "ARG CORTEX_REF",
    "ARG ARC_REF",
    "ARG CORTEX_SURFACES",
    "",
    'RUN git clone --depth 1 --branch "${ARC_REF}" https://github.com/the-metafactory/arc /opt/arc',
    "",
  ].join("\n");
}

function tmpDockerfile(ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
  const path = join(dir, "Dockerfile.cortex");
  writeFileSync(path, fixtureDockerfile(ref));
  return path;
}

describe("parseSemver", () => {
  test("parses vX.Y.Z and X.Y.Z", () => {
    expect(parseSemver("v0.42.1")).toEqual({ major: 0, minor: 42, patch: 1, prerelease: [] });
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });
  test("parses prerelease + ignores build metadata", () => {
    expect(parseSemver("v1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] });
    expect(parseSemver("v1.2.3+build.5")?.prerelease).toEqual([]);
  });
  test("rejects malformed", () => {
    expect(parseSemver("main")).toBeNull();
    expect(parseSemver("v1.2")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("v1.2.x")).toBeNull();
  });
});

describe("compareSemver", () => {
  const p = (s: string) => parseSemver(s)!;
  test("orders core versions", () => {
    expect(compareSemver(p("v0.42.1"), p("v0.40.2"))).toBe(1);
    expect(compareSemver(p("v0.40.2"), p("v0.42.1"))).toBe(-1);
    expect(compareSemver(p("v1.0.0"), p("v1.0.0"))).toBe(0);
    expect(compareSemver(p("v1.2.0"), p("v1.1.9"))).toBe(1);
  });
  test("prerelease precedence (semver §11)", () => {
    expect(compareSemver(p("v1.0.0"), p("v1.0.0-rc.1"))).toBe(1); // final > prerelease
    expect(compareSemver(p("v1.0.0-rc.1"), p("v1.0.0-rc.2"))).toBe(-1);
    expect(compareSemver(p("v1.0.0-alpha"), p("v1.0.0-beta"))).toBe(-1);
  });
});

describe("readArcRef", () => {
  test("reads the ARG definition line, not the bare re-declaration", () => {
    expect(readArcRef(fixtureDockerfile("v0.40.2"))).toBe("v0.40.2");
  });
  test("returns null when the definition line is missing/malformed", () => {
    // Only the bare re-declaration, no `=<value>` definition.
    const df = "FROM debian:bookworm-slim\nARG ARC_REF\n";
    expect(readArcRef(df)).toBeNull();
    // Empty value is not \S+ -> treated as malformed.
    expect(readArcRef("ARG ARC_REF=\n")).toBeNull();
  });
});

describe("rewriteArcRef", () => {
  test("newer release -> rewrite happens with the correct new value", () => {
    const df = fixtureDockerfile("v0.40.2");
    const r = rewriteArcRef(df, "v0.42.1");
    expect(r.changed).toBe(true);
    expect(r.oldRef).toBe("v0.40.2");
    expect(readArcRef(r.content)).toBe("v0.42.1");
    // The bare re-declaration is untouched (still exactly one, no `=`).
    expect((r.content.match(/^ARG[ \t]+ARC_REF$/m) || []).length).toBe(1);
    // Still a PINNED tag — never converted to an unpinned fetch.
    expect(r.content).toContain("ARG ARC_REF=v0.42.1");
  });
  test("idempotent: same value -> no change", () => {
    const df = fixtureDockerfile("v0.42.1");
    const r = rewriteArcRef(df, "v0.42.1");
    expect(r.changed).toBe(false);
    expect(r.content).toBe(df);
  });
  test("missing/malformed ARG line -> oldRef null, no rewrite", () => {
    const df = "FROM debian:bookworm-slim\nARG ARC_REF\n";
    const r = rewriteArcRef(df, "v0.42.1");
    expect(r.oldRef).toBeNull();
    expect(r.changed).toBe(false);
    expect(r.content).toBe(df);
  });
});

describe("decideBump", () => {
  test("newer -> bump; equal/older -> no bump", () => {
    expect(decideBump("v0.40.2", "v0.42.1").shouldBump).toBe(true);
    expect(decideBump("v0.42.1", "v0.42.1").shouldBump).toBe(false);
    expect(decideBump("v0.42.1", "v0.40.2").shouldBump).toBe(false);
  });
  test("throws on unparseable input (loud, never silent)", () => {
    expect(() => decideBump("v0.40.2", "main")).toThrow();
    expect(() => decideBump("garbage", "v0.42.1")).toThrow();
  });
});

describe("main (CLI)", () => {
  test("newer release + --write rewrites the file, exit 0", () => {
    const path = tmpDockerfile("v0.40.2");
    try {
      const code = main(["--latest", "v0.42.1", "--dockerfile", path, "--write"]);
      expect(code).toBe(0);
      expect(readArcRef(readFileSync(path, "utf8"))).toBe("v0.42.1");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("newer release WITHOUT --write is a dry-run (file unchanged)", () => {
    const path = tmpDockerfile("v0.40.2");
    try {
      const code = main(["--latest", "v0.42.1", "--dockerfile", path]);
      expect(code).toBe(0);
      expect(readArcRef(readFileSync(path, "utf8"))).toBe("v0.40.2");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("equal/older release is a no-op, exit 0, file unchanged", () => {
    const path = tmpDockerfile("v0.42.1");
    try {
      expect(main(["--latest", "v0.42.1", "--dockerfile", path, "--write"])).toBe(0);
      expect(main(["--latest", "v0.40.2", "--dockerfile", path, "--write"])).toBe(0);
      expect(readArcRef(readFileSync(path, "utf8"))).toBe("v0.42.1");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("missing --latest -> usage error (exit 2)", () => {
    const path = tmpDockerfile("v0.40.2");
    try {
      expect(main(["--dockerfile", path])).toBe(2);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("unreadable Dockerfile -> exit 3 (loud)", () => {
    expect(main(["--latest", "v0.42.1", "--dockerfile", "/nonexistent/Dockerfile.cortex"])).toBe(3);
  });

  test("malformed ARG line -> exit 3 (loud, no phantom bump)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
    const path = join(dir, "Dockerfile.cortex");
    writeFileSync(path, "FROM debian:bookworm-slim\nARG ARC_REF\n");
    try {
      expect(main(["--latest", "v0.42.1", "--dockerfile", path, "--write"])).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unparseable --latest -> exit 3 (never track main)", () => {
    const path = tmpDockerfile("v0.40.2");
    try {
      expect(main(["--latest", "main", "--dockerfile", path, "--write"])).toBe(3);
      expect(readArcRef(readFileSync(path, "utf8"))).toBe("v0.40.2");
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  test("--github-output writes bumped/old/new to $GITHUB_OUTPUT", () => {
    const path = tmpDockerfile("v0.40.2");
    const outDir = mkdtempSync(join(tmpdir(), "arc-ref-out-"));
    const outFile = join(outDir, "gh_output");
    writeFileSync(outFile, "");
    const prev = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outFile;
    try {
      main(["--latest", "v0.42.1", "--dockerfile", path, "--write", "--github-output"]);
      const out = readFileSync(outFile, "utf8");
      expect(out).toContain("bumped=true");
      expect(out).toContain("old=v0.40.2");
      expect(out).toContain("new=v0.42.1");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prev;
      rmSync(join(path, ".."), { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
