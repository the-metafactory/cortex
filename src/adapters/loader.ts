/**
 * cortex#1792 (S6, ADR-0024 D1/D3/D4/D5, OQ9/OQ11) — plugin discovery,
 * the compat gate, and the fail-isolated boot-time loader.
 *
 * This is the TRUST-PATH slice of the pluggable-adapters epic: it
 * dynamically `await import()`s installed third-party code into the
 * running daemon. Every stage is written to fail LOUD and ISOLATED — one
 * bad bundle never takes down boot or another bundle (ADR-0024 §3.3, D3).
 *
 * ## Pipeline
 *
 *   1. {@link discoverPluginBundles} — shells to `arc list --json`
 *      (arc#289's contract: `{packages:[{name,version,type,status,tier,
 *      repoUrl,installPath,library?}]}`, verified live against a real
 *      `arc list --json` run), resolves each package's `installPath`
 *      to a real (symlink-resolved) path, REFUSES any path that escapes
 *      the trusted `pkgRoot` (path-traversal / symlinked-pkg-dir defense),
 *      and parses `<installPath>/cortex-plugin.yaml` where present. A
 *      package with no manifest is simply not a plugin bundle — silent,
 *      not an error. A malformed manifest, an escaping installPath, or a
 *      dead `arc list` is recorded as a discovery ISSUE and does not stop
 *      discovery of the next package.
 *   2. {@link loadExternalPlugins} — for each discovered bundle, in
 *      deterministic (bundle-name-sorted) order:
 *        a. org-trust gate (ADR-0024 D4 mitigation #1 — org-trusted repos
 *           only, unconditionally, regardless of the external flag);
 *        b. external-flag / first-party-renderer gate (OQ6/OQ9);
 *        c. compat gate — `Bun.semver.satisfies(SURFACE_SDK_VERSION,
 *           manifest.sdkRange)` (D1, loader-authoritative);
 *        d. duplicate-id gate — an in-tree plugin (or an earlier-loaded
 *           bundle) ALWAYS wins on `manifest.id`; a later bundle may not
 *           shadow it (checked BEFORE importing — no reason to execute
 *           code that will be refused anyway);
 *        e. entry-path containment (must resolve inside the bundle dir,
 *           symlinks included) + `import()`;
 *        f. runtime structural shape validation against the declared
 *           `kind`, INCLUDING pinning the exported plugin's namespace key
 *           (`platform` for an adapter, `rendererKind` for a renderer) to
 *           `manifest.id` — the exact key gate (d) checked. Without this
 *           pin, a bundle could pass gate (d) under a unique, unclaimed
 *           `manifest.id` while its export's real `platform`/`rendererKind`
 *           names an ALREADY-BOUND namespace (e.g. `platform: "discord"`),
 *           and the gateway resolves adapters by `platform`, not registry
 *           key — a shadow-via-platform token-disclosure path (cortex#1792
 *           adversarial finding, closed here);
 *        g. registration into the live {@link SurfacePluginRegistry}.
 *      Every stage is wrapped so a throw at ANY point for ONE bundle is
 *      caught, recorded, and logged — the loop moves to the next bundle.
 *      Nothing here ever propagates out of {@link loadExternalPlugins}.
 *
 * ## What this module does NOT do
 *
 * It does not publish bus envelopes itself — `src/cortex.ts` (which holds
 * the boot's `MyelinRuntime` + `SystemEventSource`) converts this module's
 * structured `loaded`/`skipped`/`failed` results into
 * `system.plugin.loaded` / `system.plugin.load_failed` envelopes
 * (`src/bus/system-events.ts`) and a stderr line each, mirroring the
 * existing renderer-boot-loop convention (`cortex.ts`'s `console.error` +
 * loop, upgraded to a `system.*` event per ADR-0024 §3.3). Keeping the
 * loader itself bus-free makes it unit-testable without a `MyelinRuntime`
 * test double.
 *
 * It does not implement the OQ9 boot-coverage hard-fail (that is cortex#1893,
 * a separate issue) — it only SURFACES which plugins loaded (this file's
 * return value + the `loaded` bus events cortex.ts emits from it) so #1893
 * has something to check coverage against.
 */

import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve as resolvePath, sep } from "path";
import { pathToFileURL } from "url";
import { parse as parseYaml } from "yaml";

import {
  ArcListOutputSchema,
  PluginManifestSchema,
  type ArcPackage,
  type PluginManifest,
} from "../common/types/plugin-manifest";
import { SURFACE_SDK_VERSION } from "../surface-sdk";
import type {
  AdapterPlugin,
  PluginKind,
  RendererPlugin,
  SurfacePluginRegistry,
} from "./registry";

// =============================================================================
// arc subprocess driver — injectable for tests. Same "spawn, capture
// stdout/stderr/exitCode, let the caller decide what a non-zero exit
// means" shape several other cortex CLI commands already use for shelling
// out to arc.
// =============================================================================

export interface ArcListRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Pluggable subprocess driver. Tests inject a fake; production shells to
 *  `arc list --json`. */
export type ArcListRunner = () => Promise<ArcListRunResult>;

async function defaultArcListRunner(): Promise<ArcListRunResult> {
  const proc = Bun.spawn(["arc", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Default trusted install root — arc#289's real on-disk layout. Overridable
 *  (tests point this at a fixtures directory). */
export function defaultPkgRoot(): string {
  return join(homedir(), ".config", "metafactory", "pkg", "repos");
}

// =============================================================================
// Discovery
// =============================================================================

export interface DiscoveredBundle {
  /** arc package `name` — the identifier surfaced in every issue/event. */
  bundleName: string;
  /** Realpath'd, containment-verified install directory. */
  installPath: string;
  manifest: PluginManifest;
  arcPackage: ArcPackage;
}

export interface BundleIssue {
  bundleName: string;
  stage: string;
  reason: string;
}

export interface DiscoverPluginBundlesResult {
  bundles: DiscoveredBundle[];
  issues: BundleIssue[];
}

export interface DiscoverPluginBundlesOptions {
  /**
   * Trusted containment boundary — every discovered bundle's realpath'd
   * `installPath` MUST resolve inside this directory or it is refused
   * (path-traversal / symlinked-pkg-dir defense). Defaults to arc's real
   * install root ({@link defaultPkgRoot}); tests pass a fixtures directory.
   */
  pkgRoot?: string;
  /** Injectable `arc list --json` driver. Defaults to a real `Bun.spawn`. */
  runner?: ArcListRunner;
}

/**
 * Discover installed plugin bundles via `arc list --json` (the arc#289
 * contract — verified live, not hardcode-scanned: `installPath` is read
 * from arc's own record of where it actually put the package, never
 * guessed from a directory-naming convention).
 *
 * Never throws — a dead `arc list`, unparseable JSON, an escaping
 * `installPath`, or a malformed manifest are all recorded as
 * {@link BundleIssue}s and discovery continues with whatever it could
 * establish. Boot must survive a broken `arc` exactly as it survives a
 * broken bundle.
 */
export async function discoverPluginBundles(
  options: DiscoverPluginBundlesOptions = {},
): Promise<DiscoverPluginBundlesResult> {
  const pkgRoot = options.pkgRoot ?? defaultPkgRoot();
  const runner = options.runner ?? defaultArcListRunner;
  const issues: BundleIssue[] = [];

  let realPkgRoot: string;
  try {
    realPkgRoot = realpathSync(pkgRoot);
  } catch {
    // No pkg root on disk yet == nothing installed == zero bundles. Not an
    // error — this is the default state on a fresh stack that has never
    // run `arc install`.
    return { bundles: [], issues };
  }

  let runResult: ArcListRunResult;
  try {
    runResult = await runner();
  } catch (err) {
    issues.push({
      bundleName: "(arc list)",
      stage: "arc_list",
      reason: `arc list --json failed to run: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { bundles: [], issues };
  }

  if (runResult.exitCode !== 0) {
    issues.push({
      bundleName: "(arc list)",
      stage: "arc_list",
      reason: `arc list --json exited ${runResult.exitCode}: ${runResult.stderr.slice(0, 500)}`,
    });
    return { bundles: [], issues };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(runResult.stdout);
  } catch (err) {
    issues.push({
      bundleName: "(arc list)",
      stage: "arc_list_parse",
      reason: `arc list --json produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { bundles: [], issues };
  }

  const parsed = ArcListOutputSchema.safeParse(parsedJson);
  if (!parsed.success) {
    issues.push({
      bundleName: "(arc list)",
      stage: "arc_list_schema",
      reason: `arc list --json output did not match the expected {packages:[...]} shape: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
    return { bundles: [], issues };
  }

  const packages = [...parsed.data.packages].sort((a, b) => a.name.localeCompare(b.name));
  const bundles: DiscoveredBundle[] = [];

  for (const pkg of packages) {
    try {
      let realInstallPath: string;
      try {
        realInstallPath = realpathSync(pkg.installPath);
      } catch (err) {
        issues.push({
          bundleName: pkg.name,
          stage: "containment",
          reason: `installPath "${pkg.installPath}" does not resolve to a readable path: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // Path-traversal / symlinked-pkg-dir defense: the resolved real
      // install path MUST live inside the trusted pkgRoot. arc's own
      // record is treated as untrusted input here — a compromised or
      // buggy `arc list` output naming a path outside the trusted root
      // (via `..`, an absolute escape, or a symlink) is refused, not
      // followed.
      const isContained =
        realInstallPath === realPkgRoot || realInstallPath.startsWith(realPkgRoot + sep);
      if (!isContained) {
        issues.push({
          bundleName: pkg.name,
          stage: "containment",
          reason: `installPath "${pkg.installPath}" (resolved: "${realInstallPath}") escapes the trusted pkgRoot "${realPkgRoot}" — refused`,
        });
        continue;
      }

      const manifestPath = join(realInstallPath, "cortex-plugin.yaml");
      if (!existsSync(manifestPath)) {
        // Not every installed arc package is a cortex plugin bundle
        // (actions, skills, tools, … all list here too). Silent, not an
        // issue.
        continue;
      }

      // Symlink-escape defense for the manifest FILE itself — symmetric
      // with `resolveEntryWithinBundle`'s containment check for
      // `manifest.entry` below. `realInstallPath` (the DIRECTORY) is
      // already realpath'd + containment-verified above, but
      // `cortex-plugin.yaml` itself could be a symlink planted inside that
      // (legitimately contained) directory pointing OUTSIDE it — or at a
      // non-regular file (e.g. `/dev/zero`) — that `Bun.file(...).text()`
      // would follow, giving a malicious bundle an arbitrary-read or
      // boot-OOM primitive via its own manifest file. realpath + containment
      // on the FILE closes the gap the directory check alone leaves open.
      let realManifestPath: string;
      try {
        realManifestPath = realpathSync(manifestPath);
      } catch (err) {
        issues.push({
          bundleName: pkg.name,
          stage: "manifest_containment",
          reason: `cortex-plugin.yaml does not resolve to a readable path: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (!realManifestPath.startsWith(realInstallPath + sep)) {
        issues.push({
          bundleName: pkg.name,
          stage: "manifest_containment",
          reason: `cortex-plugin.yaml (resolved: "${realManifestPath}") escapes the trusted bundle directory "${realInstallPath}" — refused (symlinked-manifest defense)`,
        });
        continue;
      }

      let manifestRaw: unknown;
      try {
        const file = await Bun.file(realManifestPath).text();
        manifestRaw = parseYaml(file);
      } catch (err) {
        issues.push({
          bundleName: pkg.name,
          stage: "manifest_parse",
          reason: `cortex-plugin.yaml could not be read/parsed as YAML: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const manifestParsed = PluginManifestSchema.safeParse(manifestRaw);
      if (!manifestParsed.success) {
        issues.push({
          bundleName: pkg.name,
          stage: "manifest_parse",
          reason: `cortex-plugin.yaml is invalid: ${manifestParsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
        });
        continue;
      }

      bundles.push({
        bundleName: pkg.name,
        installPath: realInstallPath,
        manifest: manifestParsed.data,
        arcPackage: pkg,
      });
    } catch (err) {
      // Ultimate per-package backstop — a bug anywhere above must not stop
      // discovery of the NEXT package.
      issues.push({
        bundleName: pkg.name,
        stage: "discovery",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  bundles.sort((a, b) => a.bundleName.localeCompare(b.bundleName));
  return { bundles, issues };
}

// =============================================================================
// Trust gates
// =============================================================================

/**
 * ADR-0024 D4 mitigation #1 — "org-trusted repos only". Applies to EVERY
 * plugin load attempt, unconditionally, regardless of `system.plugins.external`
 * or the OQ9 first-party exemption: a bundle whose `arc list`-recorded
 * `repoUrl` is not under the `the-metafactory` GitHub org is refused before
 * anything else runs. Installing from a non-org repo is possible via
 * `arc install <url>` (arc does not itself restrict install sources) — this
 * is cortex's own belt on top of that, matching the mitigation's exact text
 * ("v1 loads only the-metafactory bundles via arc's repo-first install").
 */
const TRUSTED_ORG_REPO_RE = /^https:\/\/github\.com\/the-metafactory\/[^/]+\/?$/i;

export function isTrustedOrgRepo(repoUrl: string): boolean {
  return TRUSTED_ORG_REPO_RE.test(repoUrl.trim());
}

/**
 * ADR-0024 §OQ9 — the first-party-renderer exemption from
 * `system.plugins.external`. **This is the #1 named adversarial target for
 * this slice** (issue #1792): "first-party" must be a checkable property a
 * bundle CANNOT self-grant, not a naming convention.
 *
 * Two signals were considered and explicitly REJECTED as the trust anchor
 * because they are fully controlled by the BUNDLE AUTHOR, not by cortex or
 * a principal-side action:
 *
 *   - `cortex-plugin.yaml`'s `kind`/`id` — a malicious bundle can declare
 *     `kind: renderer, id: pagerduty` trivially. Using the manifest's own
 *     self-description as the trust signal IS the naming-convention trap
 *     the issue warns against.
 *   - arc's `tier` field (`arc-manifest.yaml: tier: official|community|custom`)
 *     — empirically verified SELF-DECLARED inside the bundle's own manifest
 *     (`grep tier ~/.config/metafactory/pkg/repos/*\/arc-manifest.yaml` shows
 *     ordinary community bundles declaring their own tier value; nothing
 *     assigns or verifies it centrally). A bundle author can write
 *     `tier: official` in their own repo just as easily as `kind: renderer`.
 *     Using it would be the identical trap with extra steps.
 *
 * The ONE signal not under the bundle author's control is: does this exact
 * installed repo URL appear on an explicit, in-tree, PR-reviewed allowlist
 * cortex itself ships ({@link FIRST_PARTY_RENDERER_REPOS})? Nothing about
 * the bundle's own content — kind, id, tier, or any `arc list` metadata the
 * bundle influences — can grant the exemption; only a cortex source change
 * (reviewed like any other code change) can. This composes with (never
 * replaces) {@link isTrustedOrgRepo}: the allowlist only matters for a
 * bundle that already cleared the org-trust gate.
 */
const FIRST_PARTY_RENDERER_REPOS: ReadonlySet<string> = new Set([
  // Populated as real first-party renderer bundles are published and
  // reviewed (e.g. a future `metafactory-pagerduty` at S12b). Empty today:
  // no first-party renderer bundle repo exists outside this slice's
  // load-path fixture proof, which exercises this function via an
  // INJECTED allowlist in tests (`src/adapters/__tests__/loader.test.ts`),
  // never this production constant.
]);

function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

export function isFirstPartyRendererBundle(
  arcPackage: Pick<ArcPackage, "repoUrl">,
  kind: PluginKind,
  allowlist: ReadonlySet<string> = FIRST_PARTY_RENDERER_REPOS,
): boolean {
  if (kind !== "renderer") return false;
  return allowlist.has(normalizeRepoUrl(arcPackage.repoUrl));
}

// =============================================================================
// Entry-path containment (path traversal via manifest `entry`)
// =============================================================================

interface EntryResolution {
  ok: boolean;
  absPath: string;
  reason: string;
}

/**
 * Resolve `manifest.entry` against the bundle's (already realpath'd)
 * install directory and verify the RESOLVED, SYMLINK-FOLLOWED real path
 * still lives inside it. `PluginManifestSchema` already rejects an
 * absolute `entry` or one containing `..` segments at the schema layer
 * (belt); this is the suspenders — a relative-looking entry can still
 * resolve outside the bundle via a symlink planted inside it, which only a
 * runtime `realpathSync` + containment check catches.
 */
function resolveEntryWithinBundle(installPath: string, entry: string): EntryResolution {
  const candidate = resolvePath(installPath, entry);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (err) {
    return {
      ok: false,
      absPath: candidate,
      reason: `entry "${entry}" does not resolve to a readable file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const contained = real === installPath || real.startsWith(installPath + sep);
  if (!contained) {
    return {
      ok: false,
      absPath: real,
      reason: `entry "${entry}" resolves outside the bundle directory (resolved: "${real}") — path traversal / symlink escape refused`,
    };
  }
  return { ok: true, absPath: real, reason: "" };
}

// =============================================================================
// Runtime structural shape validation
// =============================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Structural check against `AdapterPlugin` (`src/adapters/registry.ts`) —
 *  the TS interface is erased at runtime, so a bundle's default export must
 *  be validated by hand before it is trusted enough to register. */
function isAdapterPluginShape(v: unknown): v is AdapterPlugin {
  if (!isRecord(v)) return false;
  return (
    v.kind === "adapter" &&
    typeof v.id === "string" &&
    typeof v.platform === "string" &&
    isRecord(v.bindingSchema) &&
    typeof (v.bindingSchema as { safeParse?: unknown }).safeParse === "function" &&
    typeof v.foldsIntoPresence === "boolean" &&
    Array.isArray(v.secretFields) &&
    typeof v.demuxKey === "function" &&
    typeof v.buildGatewayConstructArgs === "function" &&
    typeof v.createAdapter === "function"
  );
}

/** Structural check against `RendererPlugin` (`src/adapters/registry.ts`). */
function isRendererPluginShape(v: unknown): v is RendererPlugin {
  if (!isRecord(v)) return false;
  return (
    v.kind === "renderer" &&
    typeof v.id === "string" &&
    typeof v.rendererKind === "string" &&
    isRecord(v.configSchema) &&
    typeof (v.configSchema as { safeParse?: unknown }).safeParse === "function" &&
    typeof v.createRenderer === "function"
  );
}

// =============================================================================
// Load result shapes
// =============================================================================

export interface LoadedPluginInfo {
  bundleName: string;
  kind: PluginKind;
  id: string;
  /** True when this bundle loaded under the OQ9 first-party-renderer
   *  exemption rather than because `system.plugins.external` was on. */
  firstParty: boolean;
}

export interface SkippedPluginInfo {
  bundleName: string;
  kind: PluginKind;
  id: string;
  reason: string;
}

export interface FailedPluginInfo {
  bundleName: string;
  kind?: PluginKind;
  pluginId?: string;
  stage: string;
  reason: string;
}

export interface LoadPluginsOptions {
  registry: SurfacePluginRegistry;
  /** `system.plugins.external` — default-off external-plugin loading gate. */
  externalEnabled: boolean;
  pkgRoot?: string;
  runner?: ArcListRunner;
  /** Test seam — see {@link isFirstPartyRendererBundle}. Production callers
   *  never set this (defaults to the real in-tree allowlist). */
  firstPartyRendererRepos?: ReadonlySet<string>;
}

export interface LoadPluginsResult {
  loaded: LoadedPluginInfo[];
  skipped: SkippedPluginInfo[];
  failed: FailedPluginInfo[];
  discoveryIssues: BundleIssue[];
}

/**
 * The full discover → gate → import → register pipeline. Never throws —
 * every failure mode for ONE bundle is caught, recorded in the returned
 * arrays, and logged to stderr; the daemon and every other (in-tree or
 * bundle) plugin stay live (ADR-0024 §3.3, D3).
 */
export async function loadExternalPlugins(
  options: LoadPluginsOptions,
): Promise<LoadPluginsResult> {
  const { registry, externalEnabled } = options;
  const loaded: LoadedPluginInfo[] = [];
  const skipped: SkippedPluginInfo[] = [];
  const failed: FailedPluginInfo[] = [];

  const { bundles, issues: discoveryIssues } = await discoverPluginBundles({
    pkgRoot: options.pkgRoot,
    runner: options.runner,
  });

  for (const issue of discoveryIssues) {
    process.stderr.write(
      `cortex plugin-loader: discovery issue (${issue.bundleName}, stage=${issue.stage}): ${issue.reason}\n`,
    );
  }

  for (const bundle of bundles) {
    try {
      await loadOneBundle(bundle, {
        registry,
        externalEnabled,
        firstPartyRendererRepos: options.firstPartyRendererRepos,
        loaded,
        skipped,
        failed,
      });
    } catch (err) {
      // Ultimate per-bundle backstop — a bug anywhere in loadOneBundle must
      // never crash boot or stop the NEXT bundle from loading.
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({
        bundleName: bundle.bundleName,
        kind: bundle.manifest.kind,
        pluginId: bundle.manifest.id,
        stage: "unexpected",
        reason,
      });
      process.stderr.write(
        `cortex plugin-loader: ${bundle.bundleName} failed unexpectedly: ${reason}\n`,
      );
    }
  }

  return { loaded, skipped, failed, discoveryIssues };
}

interface LoadOneBundleSinks {
  registry: SurfacePluginRegistry;
  externalEnabled: boolean;
  firstPartyRendererRepos: ReadonlySet<string> | undefined;
  loaded: LoadedPluginInfo[];
  skipped: SkippedPluginInfo[];
  failed: FailedPluginInfo[];
}

async function loadOneBundle(bundle: DiscoveredBundle, sinks: LoadOneBundleSinks): Promise<void> {
  const { manifest, arcPackage, bundleName, installPath } = bundle;
  const { registry } = sinks;
  const fail = (stage: string, reason: string): void => {
    sinks.failed.push({ bundleName, kind: manifest.kind, pluginId: manifest.id, stage, reason });
    process.stderr.write(
      `cortex plugin-loader: ${bundleName} (${manifest.kind}:${manifest.id}) refused at ${stage}: ${reason}\n`,
    );
  };

  // (a) Org-trust gate — ADR-0024 D4 mitigation #1. Unconditional: applies
  // even when `system.plugins.external` is on.
  if (!isTrustedOrgRepo(arcPackage.repoUrl)) {
    fail(
      "org_trust",
      `repoUrl "${arcPackage.repoUrl}" is not under the-metafactory org — v1 loads only org-trusted bundles (ADR-0024 D4)`,
    );
    return;
  }

  // (b) External-flag / first-party-renderer gate (OQ6/OQ9).
  const firstParty = isFirstPartyRendererBundle(
    arcPackage,
    manifest.kind,
    sinks.firstPartyRendererRepos,
  );
  if (!sinks.externalEnabled && !firstParty) {
    sinks.skipped.push({
      bundleName,
      kind: manifest.kind,
      id: manifest.id,
      reason: "system.plugins.external is off and this bundle is not an exempt first-party renderer",
    });
    return;
  }

  // (c) Compat gate — ADR-0024 D1, loader-authoritative. Only the RUNNING
  // daemon's SURFACE_SDK_VERSION is ever consulted; `manifest.cortex` is
  // advisory-only and never checked here.
  let satisfies: boolean;
  try {
    satisfies = Bun.semver.satisfies(SURFACE_SDK_VERSION, manifest.sdkRange);
  } catch (err) {
    fail(
      "compat_check",
      `sdkRange "${manifest.sdkRange}" is not a valid semver range: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!satisfies) {
    fail(
      "compat_check",
      `plugin requires SURFACE_SDK_VERSION satisfying "${manifest.sdkRange}"; running daemon is ${SURFACE_SDK_VERSION}`,
    );
    return;
  }

  // (d) Duplicate-id gate — keyed on `manifest.id`, NOT `manifest.platform`
  // (the manifest has no such field — see plugin-manifest.ts). An in-tree
  // plugin ALWAYS wins; a bundle may not shadow it. Checked BEFORE importing
  // so a refused bundle's code never runs. This gate is ONLY as strong as
  // the id↔namespace pin stage (f) enforces below: `registry.getAdapter`/
  // `getRenderer` are keyed by `id`, but `buildGatewayAdapters`
  // (`src/gateway/gateway-adapters.ts`) resolves surface bindings by the
  // exported plugin's `platform` field. Stage (f) pins `platform`/
  // `rendererKind` to equal `manifest.id`, which is what makes checking
  // `id` here equivalent to checking the namespace the gateway actually
  // resolves on (cortex#1792 adversarial finding — shadow-via-platform).
  const existing =
    manifest.kind === "adapter" ? registry.getAdapter(manifest.id) : registry.getRenderer(manifest.id);
  if (existing) {
    fail(
      "duplicate",
      `a ${manifest.kind} plugin with id "${manifest.id}" is already registered (in-tree plugins and earlier-loaded bundles always win) — refusing to shadow it`,
    );
    return;
  }

  // (e) Entry containment + import.
  const resolved = resolveEntryWithinBundle(installPath, manifest.entry);
  if (!resolved.ok) {
    fail("entry_containment", resolved.reason);
    return;
  }

  let imported: unknown;
  try {
    const mod: unknown = await import(pathToFileURL(resolved.absPath).href);
    imported = isRecord(mod) ? mod.default : undefined;
  } catch (err) {
    fail("import", `entry module threw at import: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // (f) Runtime shape validation + (g) register. Both stages live in ONE
  // per-kind branch below (not split as before) because of the TOCTOU fix
  // documented on the routing-critical-field comment further down: once we
  // snapshot+freeze a decoupled plugin object, deciding "adapter or
  // renderer" for the register call must use the TRUSTED `manifest.kind`
  // discriminant (known since manifest parse), never a live re-read of
  // `plugin.kind` off the (possibly still-untrusted, pre-freeze) object —
  // keeping register in the SAME branch lets TypeScript's real
  // `AdapterPlugin`/`RendererPlugin` types flow straight into
  // `registerAdapter`/`registerRenderer` with no cast.
  if (manifest.kind === "adapter") {
    if (!isAdapterPluginShape(imported)) {
      fail("shape_validate", "default export does not satisfy the AdapterPlugin shape");
      return;
    }
    // cortex#1792 — TOCTOU getter/Proxy re-check (adversarial re-check,
    // second round). Read each ROUTING-CRITICAL field off the untrusted
    // `imported` object EXACTLY ONCE, into a local const, right here.
    // `isAdapterPluginShape` already established `imported.kind === "adapter"`
    // structurally (from the untrusted value) at ITS OWN read a moment ago —
    // a static `imported.kind !== manifest.kind` here would always be
    // `false` per the narrowed literal types, which is exactly why it's not
    // written; `kind` is instead pinned from `manifest.kind` below, same as
    // `id`/`platform`, so nothing ever re-reads `imported.kind` again either.
    const id = imported.id;
    const platform = imported.platform;
    if (id !== manifest.id) {
      fail("shape_validate", `default export's id ("${id}") does not match the manifest ("${manifest.id}")`);
      return;
    }
    // cortex#1792 adversarial finding — shadow-via-platform token
    // disclosure. The duplicate-id gate (stage d) checks `manifest.id`
    // against the registry, but `buildGatewayAdapters`
    // (`src/gateway/gateway-adapters.ts`'s `surfacesByPlatform[plugin.platform]`)
    // resolves which `surfaces.*` binding (including secrets like a Discord
    // bot token) a registered adapter receives by its `platform` field, NOT
    // its registry `id`. Pinning `platform` to equal `id` (which already
    // equals `manifest.id`, checked above) closes the STATIC form of this:
    // a bundle claiming `platform: "discord"` MUST declare `id: "discord"`,
    // which then correctly collides with the in-tree discord adapter at
    // stage (d) and is refused before any of this bundle's code runs.
    if (platform !== manifest.id) {
      fail(
        "shape_validate",
        `default export's platform ("${platform}") does not match its own id ("${manifest.id}") — a plugin's platform must equal its id so the duplicate-id gate (stage d) covers the exact namespace the gateway resolves adapters by`,
      );
      return;
    }
    // cortex#1792 — TOCTOU (time-of-check/time-of-use) closure, round 2.
    // The check above reads `imported.id`/`imported.platform` ONCE. But
    // `buildGatewayAdapters` reads `plugin.platform` again — TWICE more,
    // much LATER in boot, on whatever object `registerAdapter` stored — and
    // `SurfacePluginRegistry.registerAdapter`/`.getAdapter` re-read
    // `plugin.id` several more times right after this check (`has`, error
    // message, `set`). A malicious default export can define `id`/`platform`
    // as GETTERS (or hand back a Proxy) that return the TRUSTED value on
    // THIS read (defeating the check above) and a DIFFERENT value — e.g.
    // `"discord"` — on a later read once the gateway resolves bindings, or
    // simply MUTATE a plain writable property on `imported` from inside its
    // own module after this point (a `setTimeout`, an event callback, …).
    // Registering `imported` itself (the live, still-referenced object) was
    // the gap: every later read went straight back to attacker-controlled
    // code. Instead, register a SANITIZED, FROZEN COPY. The spread copies
    // every other field (`bindingSchema`, `secretFields`, `demuxKey`,
    // `buildGatewayConstructArgs`, `createAdapter`, `foldsIntoPresence`,
    // `groupBindings?`) as a VALUE at THIS instant — a getter on any of
    // THOSE is invoked once here and never touched again. The trailing
    // `kind`/`id`/`platform` keys are object-literal OVERRIDES: they win
    // over whatever the spread copied for those three keys specifically
    // (later keys always win in an object literal), so even a getter that
    // fires DURING the spread cannot smuggle a different value through for
    // the fields that matter — and they're set from `manifest`, the TRUSTED
    // source, not from the already-snapshotted `id`/`platform` consts,
    // though those are now provably equal to `manifest.id` anyway.
    // `Object.freeze` then blocks any attempt to mutate the COPY itself
    // post-registration (freeze is shallow — it protects the copy's own
    // `id`/`platform`/`kind` properties, which is what routing depends on;
    // it does not need to protect the referenced function values, which
    // this bundle's own code already owns and could rewrite regardless of
    // what we do to the wrapper). Nothing downstream ever reads `imported`
    // again after this line.
    const plugin: AdapterPlugin = Object.freeze({
      ...imported,
      kind: manifest.kind,
      id: manifest.id,
      platform: manifest.id,
    });
    try {
      registry.registerAdapter(plugin);
    } catch (err) {
      fail("register", err instanceof Error ? err.message : String(err));
      return;
    }
  } else {
    if (!isRendererPluginShape(imported)) {
      fail("shape_validate", "default export does not satisfy the RendererPlugin shape");
      return;
    }
    const id = imported.id;
    const rendererKind = imported.rendererKind;
    if (id !== manifest.id) {
      fail("shape_validate", `default export's id ("${id}") does not match the manifest ("${manifest.id}")`);
      return;
    }
    // cortex#1792 — the renderer analogue of the adapter pin above.
    // `renderers[].kind` resolution (`resolveRendererPluginOrThrow`,
    // `src/adapters/registry.ts`) is keyed on registry `id` today, but
    // pinning `rendererKind` to `id` here closes the SAME class of bug
    // pre-emptively should a future construction path ever resolve
    // renderers by `rendererKind` instead of registry key, and keeps the
    // two plugin kinds symmetric (ADR-0024 D5: one loader, both kinds,
    // one invariant).
    if (rendererKind !== manifest.id) {
      fail(
        "shape_validate",
        `default export's rendererKind ("${rendererKind}") does not match its own id ("${manifest.id}") — a plugin's rendererKind must equal its id so the duplicate-id gate (stage d) covers the exact namespace resolution keys on`,
      );
      return;
    }
    // Same TOCTOU closure as the adapter branch above — register a frozen,
    // decoupled copy pinned to the trusted `manifest` values, not `imported`.
    const plugin: RendererPlugin = Object.freeze({
      ...imported,
      kind: manifest.kind,
      id: manifest.id,
      rendererKind: manifest.id,
    });
    try {
      registry.registerRenderer(plugin);
    } catch (err) {
      fail("register", err instanceof Error ? err.message : String(err));
      return;
    }
  }

  sinks.loaded.push({ bundleName, kind: manifest.kind, id: manifest.id, firstParty });
  process.stderr.write(
    `cortex plugin-loader: loaded ${manifest.kind} "${manifest.id}" from bundle "${bundleName}"${firstParty ? " (first-party renderer exemption)" : ""}\n`,
  );
}
