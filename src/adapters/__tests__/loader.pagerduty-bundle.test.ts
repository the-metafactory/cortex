/**
 * cortex#1894 (S12b MOVE) — the TRANSPARENT-UPGRADE end-to-end proof for the
 * PagerDuty RENDERER, mirroring `loader.slack-bundle.test.ts`'s adapter proof
 * structure. This is the FIRST renderer-class bundle load-path test.
 *
 * The load-bearing deliverable of the S12b MOVE: proof that extracting the
 * pagerduty renderer out of cortex core into the
 * `metafactory-cortex-renderer-pagerduty` bundle is NON-BREAKING. A stack with
 * `renderers: [pagerduty]`, upgraded via `arc upgrade cortex` (which
 * auto-installs the newly-declared dependency), keeps working with ZERO config
 * change and WITHOUT the principal ever flipping `system.plugins.external` on.
 *
 * ## What this exercises
 *
 * - `pkgRoot` → `./fixtures`, `installPath` →
 *   `./fixtures/metafactory-cortex-renderer-pagerduty/` — a byte-identical copy
 *   of the real bundle repo's `cortex-plugin.yaml` + `src/plugin.ts` +
 *   `src/pagerduty.ts` + `src/schema.ts`. pagerduty has ZERO npm deps (uses
 *   `fetch`), so — unlike the slack fixture — there is no client stand-in to
 *   worry about.
 * - `cortexManifestPath` is DELIBERATELY UNSET — the loader reads cortex's OWN
 *   REAL `arc-manifest.yaml` (`defaultCortexManifestPath()`), which this same
 *   S12b slice edited to declare `metafactory-cortex-renderer-pagerduty`.
 * - `externalEnabled: false` — the default-off posture. If the bundle loads
 *   anyway, it can ONLY be because the first-party RENDERER exemption fired
 *   (the renderer twin of the S9a adapter exemption).
 * - Registers into a registry that ALSO carries the in-tree `dashboard`
 *   renderer (`createDefaultSurfacePluginRegistry`), matching real boot.
 * - Constructs a REAL PagerDutyRenderer through the loaded plugin's
 *   `createRenderer` and asserts it behaves correctly (payload shape) — not
 *   just that shape validation passed.
 * - pagerduty carries a SECRET (`routingKey`) — it is USED in the outgoing
 *   payload but every failure path asserts it is NEVER echoed in a log/error.
 *
 * ## Coverage-guard interaction (#1893, ADR-0024 §OQ9) — acceptance-critical
 *
 * The second describe block proves the two required truths of the boot
 * hard-fail guard now that pagerduty is a bundle:
 *   (a) dashboard + a LOADED pagerduty → boots (2 classes, 1 effective sink).
 *   (b) dashboard-only / pagerduty-bundle-ABSENT → the INSTALL-STATE hard-fail
 *       fires, naming `metafactory-cortex-renderer-pagerduty` + `arc install`.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { loadExternalPlugins, type ArcListRunResult } from "../loader";
import { createDefaultSurfacePluginRegistry } from "../registry";
import type { ArcPackage } from "../../common/types/plugin-manifest";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  assertRuntimeSystemCoverage,
  RendererCoverageInstallStateError,
  type RendererCoverageInput,
} from "../../renderers/coverage";

const FIXTURES_ROOT = resolve(import.meta.dir, "fixtures");
const PAGERDUTY_BUNDLE_REPO_URL =
  "https://github.com/the-metafactory/metafactory-cortex-renderer-pagerduty";

function pagerdutyBundlePkg(): ArcPackage {
  return {
    name: "metafactory-cortex-renderer-pagerduty",
    version: "0.1.0",
    type: "component",
    status: "active",
    tier: "community",
    repoUrl: PAGERDUTY_BUNDLE_REPO_URL,
    installPath: resolve(FIXTURES_ROOT, "metafactory-cortex-renderer-pagerduty"),
  };
}

function runnerFor(packages: ArcPackage[]): () => Promise<ArcListRunResult> {
  return async () => ({ stdout: JSON.stringify({ packages }), stderr: "", exitCode: 0 });
}

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "00000000-0000-4000-8000-0000000000e2",
    source: "metafactory.discord-luna.guild-1",
    type: "system.adapter.degraded",
    timestamp: "2026-07-14T00:00:00Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload: {},
    ...overrides,
  };
}

describe("transparent upgrade E2E — the real metafactory-cortex-renderer-pagerduty bundle loads flag-OFF as a first-party RENDERER (cortex#1894 S12b)", () => {
  test("cortex's REAL arc-manifest.yaml declares the pagerduty renderer bundle, so it loads with system.plugins.external OFF", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    // Precondition: pagerduty is NOT one of the in-tree renderers any more
    // (S12b MOVE deleted src/renderers/pagerduty.ts) — only `dashboard` is.
    // If this ever fails, the test below would pass for the WRONG reason
    // (duplicate-id gate refusing an already-registered "pagerduty").
    expect(registry.getRenderer("pagerduty")).toBeUndefined();
    expect(registry.listRenderers().map((p) => p.id)).toEqual(["dashboard"]);

    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false, // the secure default — no principal opt-in
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([pagerdutyBundlePkg()]),
      // cortexManifestPath intentionally OMITTED — reads the REAL repo-root
      // arc-manifest.yaml via defaultCortexManifestPath().
    });

    expect(result.discoveryIssues).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-renderer-pagerduty", kind: "renderer", id: "pagerduty", firstParty: true },
    ]);
    // Registered into the SAME registry the in-tree dashboard lives in.
    expect(registry.listRenderers().map((p) => p.id).sort()).toEqual(["dashboard", "pagerduty"]);
  });

  test("the registered plugin constructs a REAL, working PagerDutyRenderer — the routingKey is used in the payload but never echoed on failure", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([pagerdutyBundlePkg()]),
    });

    const plugin = registry.getRenderer("pagerduty");
    expect(plugin).toBeDefined();
    expect(plugin?.rendererKind).toBe("pagerduty");

    // A real-shaped-but-fake secret. It must appear in the OUTGOING payload
    // but NEVER in a thrown error / console warning.
    const SECRET = "R0UTING-KEY-SUPER-SECRET-9f3a";

    // Stub the GLOBAL fetch BEFORE constructing — the plugin's createRenderer
    // binds `this.fetchImpl = fetch` at construction time, so the stub MUST be
    // in place first (otherwise it would bind the real global and hit LIVE
    // PagerDuty). Capture the outgoing payload.
    const origFetch = globalThis.fetch;
    const origWarn = console.warn;
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const warnings: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      // The renderer always fetches a string URL; handle URL/Request defensively
      // without a base-to-string on an object.
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      calls.push({ url, body });
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

    let renderer: ReturnType<NonNullable<typeof plugin>["createRenderer"]>;
    try {
      renderer = plugin!.createRenderer({
        kind: "pagerduty",
        routingKey: SECRET,
        subscribe: ["local.{principal}.system.>"],
      });
      expect(renderer.kind).toBe("pagerduty");
      expect(renderer.surfaceConfig.id).toBe("pagerduty");
      await renderer.render(makeEnvelope({ source: "src-A", type: "system.process.crashed" }));
    } finally {
      globalThis.fetch = origFetch;
      console.warn = origWarn;
    }

    // Real events-v2 payload shape.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(calls[0]!.body).toMatchObject({
      routing_key: SECRET,
      event_action: "trigger",
      dedup_key: "src-A:system.process.crashed",
      payload: { severity: "critical" },
    });
    // No spurious warning on the 202-success path, and — critically — the
    // secret never leaked into one.
    expect(warnings.join("\n")).not.toContain(SECRET);

    // Failure path: a non-2xx logs + drops (never throws) and STILL never
    // echoes the routingKey. Construct a FRESH renderer under the 500-stub —
    // `createRenderer` binds `fetch` at construction, so the earlier renderer
    // is pinned to the 202 stub.
    const warnings2: string[] = [];
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" })) as unknown as typeof fetch;
    console.warn = (...args: unknown[]) => { warnings2.push(args.map(String).join(" ")); };
    try {
      const failing = plugin!.createRenderer({ kind: "pagerduty", routingKey: SECRET, subscribe: [] });
      await expect(failing.render(makeEnvelope())).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
      console.warn = origWarn;
    }
    expect(warnings2.length).toBeGreaterThan(0);
    expect(warnings2.join("\n")).not.toContain(SECRET);
  });

  test("the loaded plugin's configSchema rejects a missing routingKey WITHOUT echoing any value (registry-contributed schema)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([pagerdutyBundlePkg()]),
    });
    const plugin = registry.getRenderer("pagerduty")!;
    // Missing routingKey → Zod failure. The error names the FIELD PATH, never
    // a rejected value (there is none to leak here, but the schema is the
    // secret-bearing one, so we pin the discipline).
    const parsed = plugin.configSchema.safeParse({ kind: "pagerduty" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = JSON.stringify(parsed.error.issues);
      expect(msg).toContain("routingKey");
    }
  });

  test("control: the SAME bundle does NOT load when its repoUrl is un-declared (proves the exemption does the work, not a blanket allow)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor(
        [pagerdutyBundlePkg()].map((pkg) => ({
          ...pkg,
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-renderer-not-pagerduty",
        })),
      ),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([
      {
        bundleName: "metafactory-cortex-renderer-pagerduty",
        kind: "renderer",
        id: "pagerduty",
        reason: "system.plugins.external is off and this renderer bundle is not an exempt first-party bundle",
      },
    ]);
    expect(registry.getRenderer("pagerduty")).toBeUndefined();
  });

  test("control: with the flag ON, the bundle loads regardless of declaration (the flag is the other, non-exemption path)", async () => {
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: true,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        {
          ...pagerdutyBundlePkg(),
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-renderer-not-pagerduty",
        },
      ]),
    });
    expect(result.loaded).toEqual([
      { bundleName: "metafactory-cortex-renderer-pagerduty", kind: "renderer", id: "pagerduty", firstParty: false },
    ]);
  });

  test("control: an ADAPTER-named repo gets NO renderer exemption (kind × name are both required — namespaced exemptions)", async () => {
    // A bundle whose manifest says kind: renderer but whose repo name matches
    // the ADAPTER regex, not the renderer one, must NOT be exempt: the renderer
    // allowlist is built ONLY from metafactory-cortex-renderer-* deps.
    const registry = createDefaultSurfacePluginRegistry();
    const result = await loadExternalPlugins({
      registry,
      externalEnabled: false,
      pkgRoot: FIXTURES_ROOT,
      runner: runnerFor([
        {
          ...pagerdutyBundlePkg(),
          name: "metafactory-cortex-adapter-web",
          repoUrl: "https://github.com/the-metafactory/metafactory-cortex-adapter-web",
        },
      ]),
    });
    expect(result.loaded).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "system.plugins.external is off and this renderer bundle is not an exempt first-party bundle",
    ]);
  });
});

// =============================================================================
// cortex#1893 (S12b-pre, ADR-0024 §OQ9) — coverage-guard interaction proof
// =============================================================================

describe("coverage-guard interaction — the #1893 boot hard-fail with pagerduty now a bundle (cortex#1894 S12b)", () => {
  const CTX = { principal: "andreas" };
  const SYSTEM = ["local.{principal}.system.>"];

  test("(a) dashboard + a LOADED pagerduty → boots (2 distinct classes, 1 effective sink)", () => {
    const started: RendererCoverageInput[] = [
      { kind: "dashboard", subscribe: ["local.{principal}.>"] },
      { kind: "pagerduty", subscribe: SYSTEM },
    ];
    expect(() =>
      assertRuntimeSystemCoverage({ started, skippedForMissingBundle: [] }, CTX),
    ).not.toThrow();
  });

  test("(b) dashboard-only / pagerduty bundle ABSENT → INSTALL-STATE hard-fail naming the bundle + arc install", () => {
    const started: RendererCoverageInput[] = [
      { kind: "dashboard", subscribe: ["local.{principal}.>"] },
    ];
    // pagerduty was CONFIGURED (covers system) but its bundle never loaded →
    // skipped-for-missing-bundle, keyed by kind.
    const skippedForMissingBundle: RendererCoverageInput[] = [
      { kind: "pagerduty", subscribe: SYSTEM },
    ];

    let thrown: unknown;
    try {
      assertRuntimeSystemCoverage({ started, skippedForMissingBundle }, CTX);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RendererCoverageInstallStateError);
    const err = thrown as RendererCoverageInstallStateError;
    expect(err.missingKinds).toEqual(["pagerduty"]);
    expect(err.missingBundles).toEqual(["metafactory-cortex-renderer-pagerduty"]);
    expect(err.message).toContain("metafactory-cortex-renderer-pagerduty");
    expect(err.message).toContain("arc install");
    // Secrets discipline: the install-state error names KINDS + BUNDLE names
    // only — never a subscribe pattern or a routingKey.
    expect(err.message).not.toContain("routingKey");
  });
});
