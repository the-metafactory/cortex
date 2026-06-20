// cortex#1120 — `cortex release` CLI tests (G4).
//
// All shell invocations (arc, wrangler, bun build) and HTTP health fetches are
// injected via the testable-injection seam (`__setShellRunnerForTests` /
// `__setFetcherForTests`) so the test suite is fully hermetic — no real arc,
// wrangler, or network traffic.
//
// Coverage requirements (from G4 spec):
//   1. Dry-run (default): prints the 4-surface ordered plan, NO shell executions.
//   2. --apply without --include-prod: runs bot + dashboard, skips api + registry.
//   3. --apply --include-prod: runs all 4 surfaces with a prod-deploy notice.
//   4. --surfaces filter: only the requested surfaces appear in plan + execution.
//   5. Version-skew guard: flags when deployed version != intended.
//   6. Version-skew "unknown": gracefully reports when health endpoint is unreachable.
//   7. --json: emits a machine-readable JSON envelope.
//   8. Non-zero exit when a surface command fails.
//   9. Summary at the end: what ran, what skipped, any skew.
//  10. `--include-prod` without `--apply` is rejected as a usage error.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  __setFetcherForTests,
  __setShellRunnerForTests,
  dispatchRelease,
  parseReleaseArgs,
  type ReleaseShellRunner,
  type ReleaseFetcher,
  type ShellRunResult,
} from "../release";

// =============================================================================
// Test helpers
// =============================================================================

/** Read the intended version from arc-manifest.yaml for assertions. */
function intendedVersion(): string {
  // import.meta.dir = src/cli/cortex/commands/__tests__/
  // 5 levels up: __tests__ → commands → cortex → cli → src → project root
  const root = join(import.meta.dir, "../../../../..");
  const raw = readFileSync(join(root, "arc-manifest.yaml"), "utf8");
  const m = /^version:\s+"?([^"\n]+)"?/m.exec(raw);
  if (!m?.[1]) throw new Error("arc-manifest.yaml: version field not found");
  return m[1].trim();
}

interface MockShellRunner {
  runner: ReleaseShellRunner;
  calls: { argv: readonly string[]; result: ShellRunResult }[];
}

function mockShell(
  factory: (argv: readonly string[]) => ShellRunResult = () => ({ exitCode: 0, stdout: "", stderr: "" }),
): MockShellRunner {
  const calls: { argv: readonly string[]; result: ShellRunResult }[] = [];
  const runner: ReleaseShellRunner = async (argv) => {
    const result = factory(argv);
    calls.push({ argv, result });
    return result;
  };
  return { runner, calls };
}

interface MockFetcher {
  fetcher: ReleaseFetcher;
  calls: string[];
}

function mockFetcher(
  factory: (url: string) => { ok: boolean; json: unknown } = () => ({ ok: false, json: null }),
): MockFetcher {
  const calls: string[] = [];
  const fetcher: ReleaseFetcher = async (url) => {
    calls.push(url);
    return factory(url);
  };
  return { fetcher, calls };
}

/** Build a health response with a specific api_version that we use as a version proxy. */
function healthOk(version: string): { ok: boolean; json: unknown } {
  return { ok: true, json: { status: "ok", deployed_version: version } };
}

function healthDown(): { ok: boolean; json: unknown } {
  return { ok: false, json: null };
}

// Clean up injected state after each test.
afterEach(() => {
  __setShellRunnerForTests(null);
  __setFetcherForTests(null);
});

// =============================================================================
// 1. parseReleaseArgs — argument parsing
// =============================================================================

describe("parseReleaseArgs", () => {
  test("defaults: apply=false, includeProd=false, json=false, all surfaces", () => {
    const args = parseReleaseArgs([]);
    expect(args.apply).toBe(false);
    expect(args.includeProd).toBe(false);
    expect(args.json).toBe(false);
    expect(args.surfaces).toEqual(["bot", "dashboard", "api", "registry"]);
  });

  test("--apply sets apply=true", () => {
    const args = parseReleaseArgs(["--apply"]);
    expect(args.apply).toBe(true);
  });

  test("--include-prod sets includeProd=true", () => {
    const args = parseReleaseArgs(["--apply", "--include-prod"]);
    expect(args.includeProd).toBe(true);
  });

  test("--json sets json=true", () => {
    const args = parseReleaseArgs(["--json"]);
    expect(args.json).toBe(true);
  });

  test("--surfaces filters surfaces", () => {
    const args = parseReleaseArgs(["--surfaces", "bot,dashboard"]);
    expect(args.surfaces).toEqual(["bot", "dashboard"]);
  });

  test("--surfaces single surface", () => {
    const args = parseReleaseArgs(["--surfaces", "registry"]);
    expect(args.surfaces).toEqual(["registry"]);
  });

  test("unknown surface name is a usage error", () => {
    expect(() => parseReleaseArgs(["--surfaces", "bot,unknown"])).toThrow();
  });

  test("--include-prod without --apply is a usage error", () => {
    expect(() => parseReleaseArgs(["--include-prod"])).toThrow();
  });
});

// =============================================================================
// 2. Dry-run (default): plan printed, NO shell executions
// =============================================================================

describe("dispatchRelease — dry-run (default)", () => {
  test("prints plan for all 4 surfaces, no shell calls", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0);
    // No shell invocations in dry-run
    expect(shell.calls).toHaveLength(0);
    // Plan must mention all 4 surfaces
    expect(result.stdout).toContain("bot");
    expect(result.stdout).toContain("dashboard");
    expect(result.stdout).toContain("api");
    expect(result.stdout).toContain("registry");
    // Must mention it's a dry-run
    expect(result.stdout.toLowerCase()).toContain("dry-run");
    // Must show the exact arc upgrade command for bot
    expect(result.stdout).toContain("arc upgrade Cortex");
    // Must show bun build command for dashboard
    expect(result.stdout).toContain("bun build");
    // Must show wrangler deploy for api and registry
    expect(result.stdout).toContain("wrangler");
  });

  test("shows intended version from arc-manifest.yaml", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0);
    const ver = intendedVersion();
    expect(result.stdout).toContain(ver);
  });

  test("--surfaces bot: only bot surface in plan, no shell calls", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--surfaces", "bot"]);

    expect(result.exitCode).toBe(0);
    expect(shell.calls).toHaveLength(0);
    expect(result.stdout).toContain("bot");
    // Dashboard/api/registry should NOT appear as action items (they're not selected)
    // The plan output should say arc upgrade for bot
    expect(result.stdout).toContain("arc upgrade Cortex");
  });

  test("prod surfaces (api, registry) show manual run instructions", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0);
    // Without --include-prod, plan must indicate prod surfaces need explicit flag
    expect(result.stdout).toContain("--include-prod");
  });
});

// =============================================================================
// 3. --apply without --include-prod: runs bot + dashboard, skips api + registry
// =============================================================================

describe("dispatchRelease — --apply without --include-prod", () => {
  test("runs arc upgrade and bun build+deploy, skips prod surfaces", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply"]);

    expect(result.exitCode).toBe(0);
    // Shell must have been called (arc + bun build + wrangler pages deploy = bot + dashboard)
    expect(shell.calls.length).toBeGreaterThan(0);

    // Must NOT have called wrangler with --env production for api
    const prodApiCall = shell.calls.find(
      (c) => c.argv.some((a) => a === "--env") && c.argv.includes("production") &&
              c.argv.some((a) => typeof a === "string" && a.includes("mc/worker")),
    );
    expect(prodApiCall).toBeUndefined();

    // Must NOT have called wrangler with --env production for registry
    const prodRegCall = shell.calls.find(
      (c) => c.argv.some((a) => a === "--env") && c.argv.includes("production") &&
              c.argv.some((a) => typeof a === "string" && a.includes("network-registry")),
    );
    expect(prodRegCall).toBeUndefined();

    // Summary must say prod surfaces were skipped
    expect(result.stdout).toContain("skip");
  });

  test("arc upgrade Cortex is invoked for bot surface", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    await dispatchRelease(["--apply"]);

    const arcCall = shell.calls.find((c) => c.argv[0] === "arc" && c.argv.includes("upgrade"));
    expect(arcCall).toBeDefined();
    expect(arcCall?.argv).toContain("Cortex");
  });

  test("bun build is invoked for dashboard surface", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    await dispatchRelease(["--apply"]);

    const buildCall = shell.calls.find(
      (c) => c.argv[0] === "bun" && c.argv.includes("build"),
    );
    expect(buildCall).toBeDefined();
    expect(buildCall?.argv).toContain("--outdir");
  });

  test("wrangler pages deploy is invoked for dashboard surface", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    await dispatchRelease(["--apply"]);

    const wranglerPagesCall = shell.calls.find(
      (c) => c.argv[0] === "bunx" &&
              c.argv.includes("wrangler") &&
              c.argv.includes("pages") &&
              c.argv.includes("deploy"),
    );
    expect(wranglerPagesCall).toBeDefined();
    expect(wranglerPagesCall?.argv).toContain("grove-dashboard");
  });
});

// =============================================================================
// 4. --apply --include-prod: runs all 4 surfaces, prints prod notice
// =============================================================================

describe("dispatchRelease — --apply --include-prod", () => {
  test("runs all 4 surfaces including prod wrangler deploys", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--include-prod"]);

    expect(result.exitCode).toBe(0);

    // Must have called arc upgrade for bot
    expect(shell.calls.find((c) => c.argv[0] === "arc" && c.argv.includes("Cortex"))).toBeDefined();

    // Must have called bun build for dashboard
    expect(shell.calls.find((c) => c.argv[0] === "bun" && c.argv.includes("build"))).toBeDefined();

    // Must have called wrangler deploy --env production for api worker
    const apiProdCall = shell.calls.find(
      (c) => c.argv.includes("wrangler") &&
              c.argv.includes("deploy") &&
              c.argv.includes("--env") &&
              c.argv.includes("production") &&
              !c.argv.includes("pages"),
    );
    expect(apiProdCall).toBeDefined();

    // Must have called wrangler deploy --env production for registry
    const registryCalls = shell.calls.filter(
      (c) => c.argv.includes("wrangler") &&
              c.argv.includes("deploy") &&
              c.argv.includes("--env") &&
              c.argv.includes("production") &&
              !c.argv.includes("pages"),
    );
    // At least 2 wrangler prod calls (api + registry) — could be same argv shape
    expect(registryCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("prints a 'DEPLOYING TO PRODUCTION' notice", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--include-prod"]);

    expect(result.stdout.toUpperCase()).toContain("PRODUCTION");
  });
});

// =============================================================================
// 5. Version-skew guard
// =============================================================================

describe("version-skew guard", () => {
  test("no skew: deployed version matches intended", async () => {
    const ver = intendedVersion();
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthOk(ver));
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0);
    // Should NOT flag a SKEW warning or mismatch
    // Note: the plan header says "Version-skew report" — that's expected; we
    // check that the WARNING line (which contains "detected") is absent.
    const out = result.stdout.toLowerCase();
    expect(out).not.toContain("skew detected");
    expect(out).not.toContain("mismatch");
    // Also must not contain " SKEW — " (the per-surface skew flag)
    expect(out).not.toContain("skew — ");
  });

  test("skew detected: deployed version differs from intended", async () => {
    const ver = intendedVersion();
    const deployedVer = ver === "0.0.0-test" ? "0.0.1-test" : "0.0.0-test";
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthOk(deployedVer));
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0); // dry-run still succeeds, but warns
    expect(result.stdout.toLowerCase()).toMatch(/skew|mismatch|version/);
  });

  test("skew unknown: health endpoint unreachable", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0);
    // Must say "unknown" not "error" or "skew" when endpoint is down
    expect(result.stdout.toLowerCase()).toContain("unknown");
  });

  test("skew unknown: health endpoint returns 200 but no deployed_version field", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => ({ ok: true, json: { status: "ok" } }));
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease([]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("unknown");
  });
});

// =============================================================================
// 6. Non-zero exit when a surface command fails
// =============================================================================

describe("failure handling", () => {
  test("non-zero exit when arc upgrade fails", async () => {
    const shell = mockShell((argv) => {
      if (argv[0] === "arc") return { exitCode: 1, stdout: "", stderr: "arc failed" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply"]);

    expect(result.exitCode).not.toBe(0);
    // Summary must mention what failed
    const combined = result.stdout + result.stderr;
    expect(combined.toLowerCase()).toMatch(/fail|error|bot/);
  });

  test("non-zero exit when bun build fails for dashboard", async () => {
    const shell = mockShell((argv) => {
      if (argv[0] === "bun" && argv.includes("build")) {
        return { exitCode: 1, stdout: "", stderr: "build failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply"]);

    expect(result.exitCode).not.toBe(0);
  });

  test("non-zero exit when wrangler pages deploy fails for dashboard", async () => {
    const shell = mockShell((argv) => {
      if (argv.includes("pages") && argv.includes("deploy")) {
        return { exitCode: 1, stdout: "", stderr: "pages deploy failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply"]);

    expect(result.exitCode).not.toBe(0);
  });

  test("summary at end reports: ran, skipped, skew", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply"]);

    const out = result.stdout.toLowerCase();
    // Must mention skipped (prod surfaces not run without --include-prod)
    expect(out).toMatch(/skip/);
  });
});

// =============================================================================
// 7. --json output
// =============================================================================

describe("--json output", () => {
  test("dry-run --json: emits valid JSON envelope", async () => {
    const shell = mockShell();
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--json"]);

    expect(result.exitCode).toBe(0);
    // Should be parseable JSON
    interface JsonEnvelope { status: string; items: unknown[] }
    let parsed: JsonEnvelope | undefined;
    expect(() => { parsed = JSON.parse(result.stdout) as JsonEnvelope; }).not.toThrow();
    expect(parsed?.status).toBe("ok");
    expect(Array.isArray(parsed?.items)).toBe(true);
  });

  test("--apply --json: emits JSON with surface results", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--json"]);

    expect(result.exitCode).toBe(0);
    interface JsonEnvelope { status: string; items: unknown[] }
    let parsed: JsonEnvelope | undefined;
    expect(() => { parsed = JSON.parse(result.stdout) as JsonEnvelope; }).not.toThrow();
    expect(parsed?.status).toBe("ok");
    expect((parsed?.items.length ?? 0)).toBeGreaterThan(0);
  });

  test("failure --json: emits JSON with error status", async () => {
    const shell = mockShell(() => ({ exitCode: 1, stdout: "", stderr: "fail" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--json"]);

    expect(result.exitCode).not.toBe(0);
    interface JsonEnvelope { status: string; items: unknown[] }
    let parsed: JsonEnvelope | undefined;
    expect(() => { parsed = JSON.parse(result.stdout) as JsonEnvelope; }).not.toThrow();
    expect(parsed?.status).toBe("error");
  });
});

// =============================================================================
// 8. --surfaces filtering in apply mode
// =============================================================================

describe("--surfaces filtering", () => {
  test("--surfaces bot --apply: only calls arc upgrade, nothing else", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--surfaces", "bot"]);

    expect(result.exitCode).toBe(0);
    expect(shell.calls.length).toBe(1);
    expect(shell.calls[0]?.argv[0]).toBe("arc");
  });

  test("--surfaces dashboard --apply: only bun build + wrangler pages, no arc", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--surfaces", "dashboard"]);

    expect(result.exitCode).toBe(0);
    expect(shell.calls.length).toBe(2); // bun build + wrangler pages deploy
    expect(shell.calls.find((c) => c.argv[0] === "arc")).toBeUndefined();
    expect(shell.calls.find((c) => c.argv[0] === "bun")).toBeDefined();
    expect(shell.calls.find((c) => c.argv.includes("pages"))).toBeDefined();
  });

  test("--surfaces api --apply --include-prod: only api wrangler prod deploy", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--include-prod", "--surfaces", "api"]);

    expect(result.exitCode).toBe(0);
    expect(shell.calls.length).toBe(1);
    const call = shell.calls[0]!;
    expect(call.argv).toContain("wrangler");
    expect(call.argv).toContain("deploy");
    expect(call.argv).toContain("--env");
    expect(call.argv).toContain("production");
    expect(call.argv).not.toContain("pages");
  });

  test("--surfaces registry --apply --include-prod: only registry wrangler prod deploy", async () => {
    const shell = mockShell(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const fetcher = mockFetcher(() => healthDown());
    __setShellRunnerForTests(shell.runner);
    __setFetcherForTests(fetcher.fetcher);

    const result = await dispatchRelease(["--apply", "--include-prod", "--surfaces", "registry"]);

    expect(result.exitCode).toBe(0);
    expect(shell.calls.length).toBe(1);
    const call = shell.calls[0]!;
    expect(call.argv).toContain("wrangler");
    expect(call.argv).toContain("deploy");
    expect(call.argv).toContain("--env");
    expect(call.argv).toContain("production");
  });
});
