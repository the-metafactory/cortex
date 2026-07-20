// Tests for the container ref-bump core (cortex#2246, generalized to CORTEX_REF
// in cortex#2267).
//
// Pure-logic coverage — no network, no docker. The workflow
// (.github/workflows/arc-ref-bump.yml) owns the side effects (resolve latest
// release via `gh api`, docker-build gate, open the PR); this suite pins the
// decision + byte-level rewrite the workflow depends on, for BOTH pinned ARGs
// (ARC_REF and CORTEX_REF):
//   - semver compare (newer / equal / older / prerelease precedence)
//   - readRef targets the ARG DEFINITION line, not the bare re-declaration
//   - rewriteRef bumps to a newer tag + is idempotent + preserves the pin
//   - malformed / missing ARG line is handled (null, no phantom rewrite)
//   - unknown ARG name is rejected (regex-injection guard)
//   - main(): newer -> rewrite w/ --write; equal/older -> no-op; missing -> 3
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseSemver,
  compareSemver,
  readRef,
  rewriteRef,
  rewriteComposeDefault,
  decideBump,
  isKnownArgName,
  KNOWN_ARG_NAMES,
  main,
  type ArgName,
} from "../arc-ref-bump";

// A minimal but structurally faithful stand-in for Dockerfile.cortex: it has,
// for BOTH pins, the `ARG <NAME>=<value>` definition (before FROM) and the bare
// `ARG <NAME>` re-declaration (in the build stage), exactly like the real file.
function fixtureDockerfile(arcRef: string, cortexRef: string): string {
  return [
    "# syntax=docker/dockerfile:1",
    `ARG CORTEX_REF=${cortexRef}`,
    `ARG ARC_REF=${arcRef}`,
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

// Per-ARG example versions so each case exercises the correct line.
const OLD: Record<ArgName, string> = { ARC_REF: "v0.40.2", CORTEX_REF: "v6.10.0" };
const NEW: Record<ArgName, string> = { ARC_REF: "v0.42.1", CORTEX_REF: "v6.10.2" };

// Mutable, typed copy for describe.each so the callback param is ArgName (a
// readonly tuple doesn't match the .each overload and would infer `any`).
const ARG_NAMES: ArgName[] = [...KNOWN_ARG_NAMES];

// Build a fixture where the ARG under test carries `ref` and the other pin is
// left at its OLD value.
function fixtureWith(argName: ArgName, ref: string): string {
  return argName === "ARC_REF"
    ? fixtureDockerfile(ref, OLD.CORTEX_REF)
    : fixtureDockerfile(OLD.ARC_REF, ref);
}

// A structurally faithful stand-in for docker-compose.yaml: it carries ONLY the
// `${CORTEX_REF:-<tag>}` default under build.args (ARC_REF is Dockerfile-only in
// the real system — cortex#2267), so a CORTEX_REF bump exercises the compose
// rewrite while an ARC_REF bump exercises the "arg absent -> no-op" path.
function fixtureCompose(cortexRef: string): string {
  return [
    "services:",
    "  cortex:",
    "    build:",
    "      args:",
    `        CORTEX_REF: \${CORTEX_REF:-${cortexRef}}`,
    "        BUN_VERSION: ${BUN_VERSION:-1.3.14}",
    "",
  ].join("\n");
}

// The compose default a fixtureWith(argName, ref) Dockerfile should be paired
// with: the CORTEX_REF leg carries `ref`, the ARC_REF leg leaves CORTEX at OLD.
function composeRefFor(argName: ArgName, ref: string): string {
  return argName === "CORTEX_REF" ? ref : OLD.CORTEX_REF;
}

// Scaffold a temp dir with BOTH a Dockerfile.cortex and a docker-compose.yaml so
// every main() call can be pointed at an ISOLATED compose via --compose — never
// the real repo compose. Returns the two paths (same dir, so cleanup via `..`).
function tmpEnv(argName: ArgName, ref: string): { dockerfile: string; compose: string } {
  const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
  const dockerfile = join(dir, "Dockerfile.cortex");
  const compose = join(dir, "docker-compose.yaml");
  writeFileSync(dockerfile, fixtureWith(argName, ref));
  writeFileSync(compose, fixtureCompose(composeRefFor(argName, ref)));
  return { dockerfile, compose };
}

describe("parseSemver", () => {
  test("parses vX.Y.Z and X.Y.Z", () => {
    expect(parseSemver("v0.42.1")).toEqual({ major: 0, minor: 42, patch: 1, prerelease: [] });
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("v6.10.2")).toEqual({ major: 6, minor: 10, patch: 2, prerelease: [] });
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
    expect(compareSemver(p("v6.10.2"), p("v6.10.0"))).toBe(1);
  });
  test("prerelease precedence (semver §11)", () => {
    expect(compareSemver(p("v1.0.0"), p("v1.0.0-rc.1"))).toBe(1); // final > prerelease
    expect(compareSemver(p("v1.0.0-rc.1"), p("v1.0.0-rc.2"))).toBe(-1);
    expect(compareSemver(p("v1.0.0-alpha"), p("v1.0.0-beta"))).toBe(-1);
  });
});

describe("isKnownArgName", () => {
  test("accepts the two tracked pins, rejects anything else", () => {
    expect(KNOWN_ARG_NAMES).toEqual(["ARC_REF", "CORTEX_REF"]);
    expect(isKnownArgName("ARC_REF")).toBe(true);
    expect(isKnownArgName("CORTEX_REF")).toBe(true);
    expect(isKnownArgName("BUN_VERSION")).toBe(false);
    // Would be a regex-injection vector if not gated.
    expect(isKnownArgName("ARC_REF|CORTEX_REF")).toBe(false);
    expect(isKnownArgName(".*")).toBe(false);
  });
});

// Parametrized across BOTH pins so ARC_REF and CORTEX_REF get identical coverage.
describe.each(ARG_NAMES)("readRef (%s)", (argName) => {
  test("reads the ARG definition line, not the bare re-declaration", () => {
    expect(readRef(fixtureWith(argName, OLD[argName]), argName)).toBe(OLD[argName]);
  });
  test("returns null when the definition line is missing/malformed", () => {
    // Only the bare re-declaration, no `=<value>` definition.
    expect(readRef(`FROM debian:bookworm-slim\nARG ${argName}\n`, argName)).toBeNull();
    // Empty value is not \S+ -> treated as malformed.
    expect(readRef(`ARG ${argName}=\n`, argName)).toBeNull();
  });
  test("does not read the OTHER pin's value", () => {
    const df = fixtureDockerfile(NEW.ARC_REF, NEW.CORTEX_REF);
    expect(readRef(df, argName)).toBe(NEW[argName]);
  });
});

describe("readRef guards unknown ARG names", () => {
  test("throws rather than splicing an arbitrary regex", () => {
    expect(() => readRef("ARG ARC_REF=v1.0.0\n", "BUN_VERSION")).toThrow();
    expect(() => readRef("ARG ARC_REF=v1.0.0\n", "ARC_REF|CORTEX_REF")).toThrow();
  });
});

describe.each(ARG_NAMES)("rewriteRef (%s)", (argName) => {
  test("newer release -> rewrite happens with the correct new value", () => {
    const df = fixtureWith(argName, OLD[argName]);
    const r = rewriteRef(df, argName, NEW[argName]);
    expect(r.changed).toBe(true);
    expect(r.oldRef).toBe(OLD[argName]);
    expect(readRef(r.content, argName)).toBe(NEW[argName]);
    // The bare re-declaration is untouched (still exactly one, no `=`).
    expect((r.content.match(new RegExp(`^ARG[ \\t]+${argName}$`, "m")) || []).length).toBe(1);
    // Still a PINNED tag — never converted to an unpinned fetch.
    expect(r.content).toContain(`ARG ${argName}=${NEW[argName]}`);
  });
  test("rewriting one pin leaves the OTHER untouched", () => {
    const df = fixtureDockerfile(OLD.ARC_REF, OLD.CORTEX_REF);
    const other: ArgName = argName === "ARC_REF" ? "CORTEX_REF" : "ARC_REF";
    const r = rewriteRef(df, argName, NEW[argName]);
    expect(readRef(r.content, argName)).toBe(NEW[argName]);
    expect(readRef(r.content, other)).toBe(OLD[other]);
  });
  test("idempotent: same value -> no change", () => {
    const df = fixtureWith(argName, NEW[argName]);
    const r = rewriteRef(df, argName, NEW[argName]);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(df);
  });
  test("missing/malformed ARG line -> oldRef null, no rewrite", () => {
    const df = `FROM debian:bookworm-slim\nARG ${argName}\n`;
    const r = rewriteRef(df, argName, NEW[argName]);
    expect(r.oldRef).toBeNull();
    expect(r.changed).toBe(false);
    expect(r.content).toBe(df);
  });
});

describe("rewriteComposeDefault", () => {
  test("CORTEX_REF: rewrites the ${CORTEX_REF:-<tag>} default, preserving shape", () => {
    const compose = fixtureCompose("v6.10.0");
    const r = rewriteComposeDefault(compose, "CORTEX_REF", "v6.10.2");
    expect(r.present).toBe(true);
    expect(r.malformed).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.oldRef).toBe("v6.10.0");
    // Shape preserved exactly — still a pinned `${...:-<tag>}` default.
    expect(r.content).toContain("CORTEX_REF: ${CORTEX_REF:-v6.10.2}");
    // The other default is untouched.
    expect(r.content).toContain("BUN_VERSION: ${BUN_VERSION:-1.3.14}");
  });
  test("ARC_REF: absent from compose -> clean no-op (present=false)", () => {
    const compose = fixtureCompose("v6.10.0");
    const r = rewriteComposeDefault(compose, "ARC_REF", "v0.42.1");
    expect(r.present).toBe(false);
    expect(r.malformed).toBe(false);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(compose);
  });
  test("idempotent: default already at target -> no change", () => {
    const compose = fixtureCompose("v6.10.2");
    const r = rewriteComposeDefault(compose, "CORTEX_REF", "v6.10.2");
    expect(r.present).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(compose);
  });
  test("malformed empty default ${CORTEX_REF:-} -> present + malformed", () => {
    const compose = "      args:\n        CORTEX_REF: ${CORTEX_REF:-}\n";
    const r = rewriteComposeDefault(compose, "CORTEX_REF", "v6.10.2");
    expect(r.present).toBe(true);
    expect(r.malformed).toBe(true);
    expect(r.changed).toBe(false);
  });
  test("throws on an unknown ARG name (regex-injection guard)", () => {
    expect(() => rewriteComposeDefault("x", "BUN_VERSION", "1.0.0")).toThrow();
    expect(() => rewriteComposeDefault("x", "ARC_REF|CORTEX_REF", "1.0.0")).toThrow();
  });
});

describe.each(ARG_NAMES)("decideBump (%s)", (argName) => {
  test("newer -> bump; equal/older -> no bump", () => {
    expect(decideBump(argName, OLD[argName], NEW[argName]).shouldBump).toBe(true);
    expect(decideBump(argName, NEW[argName], NEW[argName]).shouldBump).toBe(false);
    expect(decideBump(argName, NEW[argName], OLD[argName]).shouldBump).toBe(false);
  });
  test("throws on unparseable input (loud, never silent)", () => {
    expect(() => decideBump(argName, OLD[argName], "main")).toThrow();
    expect(() => decideBump(argName, "garbage", NEW[argName])).toThrow();
  });
});

describe.each(ARG_NAMES)("main CLI (%s)", (argName) => {
  const flag = argName === "ARC_REF" ? [] : ["--arg-name", argName];

  test("newer release + --write rewrites the file, exit 0", () => {
    const { dockerfile, compose } = tmpEnv(argName, OLD[argName]);
    try {
      const code = main(["--latest", NEW[argName], "--dockerfile", dockerfile, "--compose", compose, "--write", ...flag]);
      expect(code).toBe(0);
      expect(readRef(readFileSync(dockerfile, "utf8"), argName)).toBe(NEW[argName]);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("newer release WITHOUT --write is a dry-run (files unchanged)", () => {
    const { dockerfile, compose } = tmpEnv(argName, OLD[argName]);
    const composeBefore = readFileSync(compose, "utf8");
    try {
      const code = main(["--latest", NEW[argName], "--dockerfile", dockerfile, "--compose", compose, ...flag]);
      expect(code).toBe(0);
      expect(readRef(readFileSync(dockerfile, "utf8"), argName)).toBe(OLD[argName]);
      expect(readFileSync(compose, "utf8")).toBe(composeBefore);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("equal/older release is a no-op, exit 0, file unchanged", () => {
    const { dockerfile, compose } = tmpEnv(argName, NEW[argName]);
    try {
      expect(main(["--latest", NEW[argName], "--dockerfile", dockerfile, "--compose", compose, "--write", ...flag])).toBe(0);
      expect(main(["--latest", OLD[argName], "--dockerfile", dockerfile, "--compose", compose, "--write", ...flag])).toBe(0);
      expect(readRef(readFileSync(dockerfile, "utf8"), argName)).toBe(NEW[argName]);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("malformed ARG line -> exit 3 (loud, no phantom bump)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
    const dockerfile = join(dir, "Dockerfile.cortex");
    const compose = join(dir, "docker-compose.yaml");
    writeFileSync(dockerfile, `FROM debian:bookworm-slim\nARG ${argName}\n`);
    writeFileSync(compose, fixtureCompose(composeRefFor(argName, OLD[argName])));
    try {
      expect(main(["--latest", NEW[argName], "--dockerfile", dockerfile, "--compose", compose, "--write", ...flag])).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unparseable --latest -> exit 3 (never track main)", () => {
    const { dockerfile, compose } = tmpEnv(argName, OLD[argName]);
    try {
      expect(main(["--latest", "main", "--dockerfile", dockerfile, "--compose", compose, "--write", ...flag])).toBe(3);
      expect(readRef(readFileSync(dockerfile, "utf8"), argName)).toBe(OLD[argName]);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });
});

// The core of cortex#2267: the compose `${<ARG>:-<tag>}` default must move in
// lockstep with the Dockerfile ARG, since it OVERRIDES the ARG on the primary
// `docker compose build` path. These cases pin the Dockerfile+compose contract.
describe("main CLI — compose lockstep (cortex#2267)", () => {
  test("CORTEX_REF bump rewrites BOTH the Dockerfile ARG and the compose default", () => {
    const { dockerfile, compose } = tmpEnv("CORTEX_REF", OLD.CORTEX_REF);
    try {
      const code = main([
        "--latest", NEW.CORTEX_REF, "--arg-name", "CORTEX_REF",
        "--dockerfile", dockerfile, "--compose", compose, "--write",
      ]);
      expect(code).toBe(0);
      // Dockerfile ARG default moved…
      expect(readRef(readFileSync(dockerfile, "utf8"), "CORTEX_REF")).toBe(NEW.CORTEX_REF);
      // …AND the compose default moved in lockstep, shape preserved.
      expect(readFileSync(compose, "utf8")).toContain(`CORTEX_REF: \${CORTEX_REF:-${NEW.CORTEX_REF}}`);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("ARC_REF bump rewrites the Dockerfile but leaves compose untouched (arg absent)", () => {
    const { dockerfile, compose } = tmpEnv("ARC_REF", OLD.ARC_REF);
    const composeBefore = readFileSync(compose, "utf8");
    try {
      const code = main([
        "--latest", NEW.ARC_REF, "--arg-name", "ARC_REF",
        "--dockerfile", dockerfile, "--compose", compose, "--write",
      ]);
      expect(code).toBe(0);
      expect(readRef(readFileSync(dockerfile, "utf8"), "ARC_REF")).toBe(NEW.ARC_REF);
      // Compose has no ${ARC_REF:-…} default -> clean no-op, byte-for-byte equal.
      expect(readFileSync(compose, "utf8")).toBe(composeBefore);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("compose default already at target -> no spurious rewrite (Dockerfile still bumps)", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
    const dockerfile = join(dir, "Dockerfile.cortex");
    const compose = join(dir, "docker-compose.yaml");
    // Dockerfile ARG is stale (v6.10.0) but compose default is already at target.
    writeFileSync(dockerfile, fixtureWith("CORTEX_REF", OLD.CORTEX_REF));
    writeFileSync(compose, fixtureCompose(NEW.CORTEX_REF));
    const composeBefore = readFileSync(compose, "utf8");
    try {
      const code = main([
        "--latest", NEW.CORTEX_REF, "--arg-name", "CORTEX_REF",
        "--dockerfile", dockerfile, "--compose", compose, "--write",
      ]);
      expect(code).toBe(0);
      expect(readRef(readFileSync(dockerfile, "utf8"), "CORTEX_REF")).toBe(NEW.CORTEX_REF);
      // Compose was already at target -> unchanged byte-for-byte (no churn).
      expect(readFileSync(compose, "utf8")).toBe(composeBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed compose default ${CORTEX_REF:-} (readable file) -> exit 3", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
    const dockerfile = join(dir, "Dockerfile.cortex");
    const compose = join(dir, "docker-compose.yaml");
    writeFileSync(dockerfile, fixtureWith("CORTEX_REF", OLD.CORTEX_REF));
    writeFileSync(compose, "      args:\n        CORTEX_REF: ${CORTEX_REF:-}\n");
    try {
      const code = main([
        "--latest", NEW.CORTEX_REF, "--arg-name", "CORTEX_REF",
        "--dockerfile", dockerfile, "--compose", compose, "--write",
      ]);
      expect(code).toBe(3);
      // Loud failure BEFORE any write — Dockerfile ARG is left at the stale value.
      expect(readRef(readFileSync(dockerfile, "utf8"), "CORTEX_REF")).toBe(OLD.CORTEX_REF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing compose file -> non-fatal skip, Dockerfile still bumped, exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "arc-ref-bump-"));
    const dockerfile = join(dir, "Dockerfile.cortex");
    const compose = join(dir, "does-not-exist-compose.yaml");
    writeFileSync(dockerfile, fixtureWith("CORTEX_REF", OLD.CORTEX_REF));
    try {
      const code = main([
        "--latest", NEW.CORTEX_REF, "--arg-name", "CORTEX_REF",
        "--dockerfile", dockerfile, "--compose", compose, "--write",
      ]);
      expect(code).toBe(0);
      expect(readRef(readFileSync(dockerfile, "utf8"), "CORTEX_REF")).toBe(NEW.CORTEX_REF);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("main (CLI) — shared behavior", () => {
  test("missing --latest -> usage error (exit 2)", () => {
    const { dockerfile, compose } = tmpEnv("ARC_REF", OLD.ARC_REF);
    try {
      expect(main(["--dockerfile", dockerfile, "--compose", compose])).toBe(2);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("unknown --arg-name -> usage error (exit 2)", () => {
    const { dockerfile, compose } = tmpEnv("ARC_REF", OLD.ARC_REF);
    try {
      expect(main(["--latest", "v1.0.0", "--arg-name", "BUN_VERSION", "--dockerfile", dockerfile, "--compose", compose])).toBe(2);
    } finally {
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
    }
  });

  test("unreadable Dockerfile -> exit 3 (loud)", () => {
    expect(main(["--latest", "v0.42.1", "--dockerfile", "/nonexistent/Dockerfile.cortex", "--compose", "/nonexistent/docker-compose.yaml"])).toBe(3);
  });

  test("--github-output writes bumped/old/new to $GITHUB_OUTPUT (CORTEX_REF)", () => {
    const { dockerfile, compose } = tmpEnv("CORTEX_REF", OLD.CORTEX_REF);
    const outDir = mkdtempSync(join(tmpdir(), "arc-ref-out-"));
    const outFile = join(outDir, "gh_output");
    writeFileSync(outFile, "");
    const prev = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outFile;
    try {
      main(["--latest", NEW.CORTEX_REF, "--arg-name", "CORTEX_REF", "--dockerfile", dockerfile, "--compose", compose, "--write", "--github-output"]);
      const out = readFileSync(outFile, "utf8");
      expect(out).toContain("bumped=true");
      expect(out).toContain(`old=${OLD.CORTEX_REF}`);
      expect(out).toContain(`new=${NEW.CORTEX_REF}`);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = prev;
      rmSync(join(dockerfile, ".."), { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
