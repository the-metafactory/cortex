// Tests for the L6 deploy-surface confidentiality scan (design doc §4 L6,
// compass#93, cortex feat/c-conf-deploy-gates).
//
// RUNTIME-CONSTRUCTED FIXTURES ONLY (self-conflict fix, matching
// scripts/__tests__/check-shippable-hygiene.test.ts): every forbidden shape
// this suite plants is built by concatenation at runtime, never written as a
// literal — so this test file itself stays clean under the confidentiality
// scanners (including the very engine it drives). The synthetic snowflake
// below is obviously-fake and non-sequential; it is not a real platform id.
//
// ENGINE DEPENDENCY: this suite shells to the INSTALLED confidentiality-scan
// engine, resolved via `DEFAULT_ENGINE_PATH` through the shared arc-pack-repos
// resolver (cortex#2007: canonical ~/.local/share/metafactory/arc/repos on a
// migrated box, legacy ~/.config/metafactory/pkg/repos on a singleTree install)
// under `metafactory-actions/scan/` — an arc-managed local package, not
// something vendored into this repo or fetched
// by GitHub Actions' `bun test` job. Mirrors the existing `hasClaude` /
// `testClaude` self-skip pattern in src/common/test-utils.ts for the same
// reason (external binary not present on GitHub Actions runners): tests that
// need the real engine self-skip via `testEngine` so they still run locally
// (and for the engineer driving this PR) without failing CI red for an
// environment gap outside this PR's scope.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  DEFAULT_ENGINE_PATH,
  main,
  resolveSurfaceFiles,
  scanFile,
} from "../scan-deploy-surface";

const hasEngine = existsSync(DEFAULT_ENGINE_PATH);
const testEngine = test.skipIf(!hasEngine);

// --- runtime-built forbidden strings (never literals) ----------------------
const SYNTH_SNOWFLAKE = ["9", "8", "7", "6", "5", "4", "3", "2", "1", "8", "7", "6", "5", "4", "3", "2", "1"].join(
  "",
); // 17 digits, obviously synthetic — not all-zero / all-same-digit (so it isn't allowlisted)
const SYNTH_INTERNAL_EMAIL = "leak" + "@" + "meta-factory" + ".ai"; // org's own domain, class-6 shape
const PLACEHOLDER_SEED_EMAIL = "operator" + "@" + "example.com"; // RFC-reserved → clean

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `deploy-surface-${prefix}-`));
}
function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}
function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe("resolveSurfaceFiles — pure file-set resolution (no engine needed)", () => {
  test("dashboard surface lists text-scannable build output, skips missing dir", () => {
    const root = tmpRoot("dashboard-list");
    expect(resolveSurfaceFiles("dashboard", root)).toEqual([]);
    write(root, "dist/dashboard-v2/entry-abc123.js", "console.log(1);\n");
    write(root, "dist/dashboard-v2/index.html", "<html></html>\n");
    write(root, "dist/dashboard-v2/logo.png", "\x89PNG\r\n"); // binary — skipped, not scannable
    const files = resolveSurfaceFiles("dashboard", root);
    expect(files.some((f) => f.endsWith("entry-abc123.js"))).toBe(true);
    expect(files.some((f) => f.endsWith("index.html"))).toBe(true);
    expect(files.some((f) => f.endsWith("logo.png"))).toBe(false);
    cleanup(root);
  });

  test("worker surface lists only src/**/*.ts under the worker package", () => {
    const root = tmpRoot("worker-list");
    write(root, "src/surface/mc/worker/src/index.ts", "export {};\n");
    write(root, "src/surface/mc/worker/src/routes/health.ts", "export {};\n");
    write(root, "src/surface/mc/worker/wrangler.toml", 'name = "cortex-api"\n');
    const files = resolveSurfaceFiles("worker", root);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.endsWith(".ts"))).toBe(true);
  });

  test("d1 surface lists schema.sql + migrations/*.sql, skips missing schema.sql", () => {
    const root = tmpRoot("d1-list");
    write(root, "src/surface/mc/worker/migrations/0001_a.sql", "CREATE TABLE a (id TEXT);\n");
    write(root, "src/surface/mc/worker/migrations/0002_b.sql", "CREATE TABLE b (id TEXT);\n");
    const noSchema = resolveSurfaceFiles("d1", root);
    expect(noSchema.length).toBe(2); // schema.sql absent — just the migrations

    write(root, "src/surface/mc/worker/schema.sql", "CREATE TABLE schema_version (v INT);\n");
    const withSchema = resolveSurfaceFiles("d1", root);
    expect(withSchema.length).toBe(3);
    expect(withSchema.some((f) => f.endsWith("schema.sql"))).toBe(true);
  });

  test("unknown surface via main() exits 2 (usage error)", () => {
    expect(main(["not-a-real-surface"])).toBe(2);
  });

  test("missing surface arg via main() exits 2", () => {
    expect(main([])).toBe(2);
  });
});

describe("scan-deploy-surface — engine fail-closed / advisory behavior", () => {
  test("missing engine binary fails closed (exit 3) in blocking mode", () => {
    const root = tmpRoot("no-engine");
    write(root, "dist/dashboard-v2/app.js", "console.log('clean');\n");
    const code = main(["dashboard", "--root", root, "--engine", join(root, "does-not-exist.ts")]);
    expect(code).toBe(3);
    cleanup(root);
  });

  test("missing engine binary in --advisory mode does not block (exit 0)", () => {
    const root = tmpRoot("no-engine-advisory");
    write(root, "src/surface/mc/worker/schema.sql", "CREATE TABLE t (id TEXT);\n");
    const code = main(["d1", "--advisory", "--root", root, "--engine", join(root, "does-not-exist.ts")]);
    expect(code).toBe(0);
    cleanup(root);
  });

  test("empty file set (nothing built yet) is treated as clean", () => {
    const root = tmpRoot("empty-dashboard");
    const code = main(["dashboard", "--root", root]); // real DEFAULT_ENGINE_PATH — irrelevant, no files to scan
    expect(code).toBe(0);
    cleanup(root);
  });
});

describe("scan-deploy-surface — against the REAL installed engine", () => {
  testEngine("clean dashboard build output passes (exit 0)", () => {
    const root = tmpRoot("real-dashboard-clean");
    write(root, "dist/dashboard-v2/entry.js", "export const x = 1;\n");
    write(root, "dist/dashboard-v2/index.html", "<!doctype html><html></html>\n");
    const code = main(["dashboard", "--root", root]);
    expect(code).toBe(0);
    cleanup(root);
  });

  testEngine("planted fixture snowflake in dashboard build output BLOCKS (exit 1)", () => {
    const root = tmpRoot("real-dashboard-block");
    write(root, "dist/dashboard-v2/entry.js", `const leaked = "${SYNTH_SNOWFLAKE}";\n`);
    const code = main(["dashboard", "--root", root]);
    expect(code).toBe(1);
    cleanup(root);
  });

  testEngine("planted internal-domain email in worker src BLOCKS (exit 1)", () => {
    const root = tmpRoot("real-worker-block");
    write(
      root,
      "src/surface/mc/worker/src/index.ts",
      `export const CONTACT = "${SYNTH_INTERNAL_EMAIL}";\n`,
    );
    const code = main(["worker", "--root", root]);
    expect(code).toBe(1);
    cleanup(root);
  });

  testEngine("clean placeholder seed passes d1 surface (exit 0)", () => {
    const root = tmpRoot("real-d1-clean");
    write(
      root,
      "src/surface/mc/worker/migrations/0002_seed_data.sql",
      `INSERT OR IGNORE INTO users (id, email) VALUES ('operator', '${PLACEHOLDER_SEED_EMAIL}');\n`,
    );
    const code = main(["d1", "--root", root]);
    expect(code).toBe(0);
    cleanup(root);
  });

  testEngine("d1 surface with a fixture finding does not block in --advisory mode (exit 0)", () => {
    const root = tmpRoot("real-d1-advisory");
    write(
      root,
      "src/surface/mc/worker/schema.sql",
      `-- contact ${SYNTH_INTERNAL_EMAIL}\nCREATE TABLE t (id TEXT);\n`,
    );
    const code = main(["d1", "--advisory", "--root", root]);
    expect(code).toBe(0); // advisory — findings printed but never block
    cleanup(root);
  });

  testEngine("scanFile() returns the engine's own masked output — never the planted literal", () => {
    const root = tmpRoot("real-mask-check");
    const file = join(root, "probe.js");
    write(root, "probe.js", `const leaked = "${SYNTH_SNOWFLAKE}";\n`);
    const { code, output } = scanFile(DEFAULT_ENGINE_PATH, file, root);
    expect(code).toBe(1);
    expect(output).not.toContain(SYNTH_SNOWFLAKE);
    cleanup(root);
  });
});
