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
 *        b. external-flag / first-party gate (OQ6/OQ9, extended cortex#1794
 *           S9a) — a first-party RENDERER (in-tree allowlist) or a
 *           first-party ADAPTER (repoUrl declared under cortex's OWN
 *           `arc-manifest.yaml` `dependencies:`, read fresh each load —
 *           {@link isFirstPartyBundle}) loads even with the flag off;
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

import { existsSync, readFileSync, realpathSync } from "fs";
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

/** Shared empty-set default for {@link isFirstPartyBundle}'s adapter branch
 *  — never populated in place; a genuinely empty allowlist just means "no
 *  adapter exemption this call" (the fail-closed posture). */
const EMPTY_REPO_SET: ReadonlySet<string> = new Set();

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

/**
 * cortex#1794 (S9a) — the ADAPTER analogue of {@link isFirstPartyRendererBundle}.
 * `kind`-gated the same way (an adapter bundle is NEVER exempt through the
 * renderer allowlist, and vice versa — the two exemptions are namespaced by
 * kind, never merged), but the allowlist source is different in kind, not
 * just in content: the renderer allowlist ({@link FIRST_PARTY_RENDERER_REPOS})
 * is a hardcoded in-tree constant; the adapter allowlist is COMPUTED fresh
 * at every load from {@link readCortexDeclaredAdapterRepos} and handed in
 * explicitly by the caller — this function stays a pure predicate over
 * whatever set it's given, with no I/O and no default of its own, so a
 * caller can never forget which allowlist it's checking against.
 */
export function isFirstPartyAdapterBundle(
  arcPackage: Pick<ArcPackage, "repoUrl">,
  kind: PluginKind,
  allowlist: ReadonlySet<string>,
): boolean {
  if (kind !== "adapter") return false;
  return allowlist.has(normalizeRepoUrl(arcPackage.repoUrl));
}

/**
 * cortex#1794 (S9a) — kind-aware dispatch composing both first-party
 * exemptions into one call so `loadOneBundle` (and any future caller) never
 * has to branch on `kind` itself to decide which allowlist applies. Renderer
 * behavior is delegated VERBATIM to {@link isFirstPartyRendererBundle}
 * (same function, same default, zero behavior change — the regression
 * guarantee for OQ9) and only the adapter branch is new.
 */
export function isFirstPartyBundle(
  arcPackage: Pick<ArcPackage, "repoUrl">,
  kind: PluginKind,
  allowlists: {
    rendererAllowlist?: ReadonlySet<string>;
    adapterAllowlist?: ReadonlySet<string>;
  } = {},
): boolean {
  if (kind === "renderer") {
    return isFirstPartyRendererBundle(arcPackage, kind, allowlists.rendererAllowlist);
  }
  return isFirstPartyAdapterBundle(arcPackage, kind, allowlists.adapterAllowlist ?? EMPTY_REPO_SET);
}

/**
 * cortex#1794 (S9a) — a dependency `name` in cortex's OWN `arc-manifest.yaml`
 * grants the adapter exemption ONLY if it also asserts, by its OWN name
 * shape, that it IS a cortex-owned adapter-type component — never merely
 * "cortex depends on it for some reason". This is the fix for a code-review
 * MAJOR (PR #1942): an earlier version of this anchor treated cortex's
 * ENTIRE `dependencies:` list as adapter-exempt, so `arc` (the package
 * manager) and `metafactory-discord` (ADR-0017 CLI/skill *tooling* —
 * explicitly NOT the adapter, per ADR-0024's own migration provenance
 * section) would BOTH have granted the exemption to any `kind: adapter`
 * plugin they ever happened to ship, despite neither being declared FOR
 * adapter-trust reasons. That is exactly the failure ADR-0024 §OQ9 names:
 * *"'First-party' must be a checkable property of a bundle, not a naming
 * convention… an unchecked 'first-party' exemption is a trust hole wearing
 * a friendly name."* — the naming convention there is about a BUNDLE
 * claiming its own trust; here the risk was the REVERSE mistake, reading
 * "listed as a dependency" as "trusted as an adapter" when a dependency can
 * be declared for any number of unrelated reasons.
 *
 * The fix narrows to the **ecosystem-wide, structurally-checkable**
 * repo-naming standard (compass `standards/component-repo-naming.md`, PR
 * the-metafactory/compass#115, adopted the same day as the epic #1784
 * decision this anchor implements): a cortex-owned adapter bundle's repo
 * name is ALWAYS `metafactory-cortex-adapter-<name>` (`<owner>` = `cortex`,
 * `<type>` = `adapter`) — locked BEFORE the first such repo is created
 * specifically so this epic's extractions have a stable name to check
 * against ("Requested by Andreas 2026-07-12", same standard doc). This is
 * still un-spoofable for the same reason as before — the NAME is read out
 * of cortex's own PR-reviewed manifest, never anything the bundle
 * self-declares — the narrowing only adds a SECOND, independently-checkable
 * requirement on TOP of "declared by cortex": the declared name must also
 * self-identify, in a fixed and enforced shape, as a cortex-adapter
 * component. `arc` and `metafactory-discord` (or its scheduled rename,
 * `metafactory-bundle-discord` — compass#116) never match this shape, by
 * construction: neither is a `metafactory-cortex-adapter-*` name, so
 * neither is EVER treated as first-party for the adapter exemption, no
 * matter what kind of `cortex-plugin.yaml` a bundle at that name might one
 * day ship. See {@link ADAPTER_BUNDLE_DEP_NAME_RE}.
 */
const ADAPTER_BUNDLE_DEP_NAME_RE = /^metafactory-cortex-adapter-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * cortex#1794 (S9a, epic #1784 "Andreas decision 2026-07-12") — the
 * un-spoofable first-party ADAPTER anchor: cortex's OWN, PR-reviewed
 * `arc-manifest.yaml` `dependencies:` block, NARROWED to only the entries
 * whose `name` matches {@link ADAPTER_BUNDLE_DEP_NAME_RE} (see that
 * constant's doc comment for why the narrowing is required — PR #1942
 * code-review MAJOR). This is deliberately NOT a hardcoded allowlist like
 * {@link FIRST_PARTY_RENDERER_REPOS} — it is read fresh at every load, so
 * declaring a new first-party adapter bundle (e.g. the planned
 * `metafactory-cortex-adapter-web`) is a plain `arc-manifest.yaml` PR, never
 * a `loader.ts` code change.
 *
 * Why this is un-spoofable: a bundle's OWN manifest (`cortex-plugin.yaml`)
 * and arc's `tier` field were already rejected as trust anchors for the
 * renderer exemption above (both fully controlled by the bundle author —
 * see {@link isFirstPartyRendererBundle}'s doc comment for the empirical
 * evidence). `arc-manifest.yaml` `dependencies:` has the SAME shape of
 * un-spoofability: it is CORTEX's manifest, shipped in CORTEX's repo, only
 * ever changed by a PR against CORTEX — a bundle author publishing
 * `metafactory-evil-adapter` cannot make cortex's own dependency list
 * declare their repo, AND (post-narrowing) could not even self-select into
 * the exemption by picking a matching name for their OWN repo — membership
 * requires appearing, under that exact name, in CORTEX's manifest, which
 * only a cortex-repo PR controls either way.
 *
 * Deriving a repo URL from a dependency `name`: `arc-manifest.yaml`
 * dependency names in this ecosystem ARE the GitHub repo name under the
 * trusted `the-metafactory` org, by the repo-first install convention
 * (ADR-0017 — see cortex's own `arc-manifest.yaml`, the `metafactory-discord`
 * entry: "the bundle is `arc install`-able from the
 * the-metafactory/metafactory-discord repo"). So `name:
 * "metafactory-cortex-adapter-web"` derives
 * `https://github.com/the-metafactory/metafactory-cortex-adapter-web`,
 * normalized the same way {@link normalizeRepoUrl} normalizes an installed
 * bundle's `arc list`-recorded `repoUrl`, making membership a plain
 * set-lookup. Every derived URL is by construction inside `the-metafactory`
 * — this composes with (never replaces) the unconditional
 * {@link isTrustedOrgRepo} gate, which still runs first and independently
 * for every bundle.
 *
 * **Threat-model note (both this anchor AND {@link isTrustedOrgRepo}):**
 * un-spoofability here ultimately rests on arc recording `repoUrl` as the
 * package's actual git clone source (confirmed empirically against a live
 * `arc list --json` — S6). If a future arc version ever added a `--repo-url`
 * override decoupled from the real clone source, BOTH gates would fall
 * together — this is an explicit cross-repo (arc) dependency of cortex's
 * entire plugin trust model, not something this module can independently
 * verify or defend against; it is recorded here so a future arc change is
 * evaluated against it.
 *
 * **Persistence-via-self-rewrite (author-flagged, PR #1942 nit):** an
 * already-loaded bundle — which, under D4's accepted full-daemon-authority
 * model, already has filesystem access equivalent to the daemon — could
 * rewrite cortex's OWN `arc-manifest.yaml` on disk to grant a FUTURE bundle
 * this exemption on the next boot. This is NOT symmetric with the renderer
 * allowlist's equivalent risk, only equivalent UNDER D4's full-compromise
 * assumption: {@link FIRST_PARTY_RENDERER_REPOS} is a compiled-in TS
 * constant, so self-granting via it means editing `loader.ts` source AND
 * getting a rebuild to pick it up; this anchor is a plain YAML data file,
 * read fresh every boot, no rebuild required — a strictly CHEAPER edit for
 * an attacker who already has arbitrary file write. Under D4 (arbitrary
 * code exec inside an already-loaded plugin = full compromise) neither
 * barrier stops the attacker; the difference is defense-in-depth cost, not
 * whether the barrier holds — recorded here, not fixed here, because D4
 * already accepts this class of risk for v1 (named future escalation:
 * registry signing / separate-process-over-IPC, ADR-0024 D4).
 *
 * Fail-closed by design: ANY read/parse failure — missing file, invalid
 * YAML, no `dependencies:` key, non-array `dependencies:`, a dependency
 * entry with no string `name` — is caught and returns an EMPTY set, never
 * throws and never crashes boot. An unreadable manifest can only NARROW
 * trust (no adapter bundle gets the exemption that boot); it must never be
 * able to WIDEN it.
 */
export function readCortexDeclaredAdapterRepos(manifestPath: string): ReadonlySet<string> {
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed: unknown = parseYaml(raw);
    if (!isRecord(parsed)) return new Set();
    const deps: unknown = parsed.dependencies;
    if (!Array.isArray(deps)) return new Set();
    const repos = new Set<string>();
    for (const dep of deps) {
      if (!isRecord(dep) || typeof dep.name !== "string") continue;
      const name = dep.name.trim();
      // PR #1942 MAJOR fix — only a dependency name that self-identifies as
      // a cortex-owned ADAPTER component (the compass#115 naming standard)
      // grants the exemption. `arc`, `metafactory-discord`, and any other
      // legitimately-declared-but-unrelated dependency never match, no
      // matter what they ship.
      if (!ADAPTER_BUNDLE_DEP_NAME_RE.test(name)) continue;
      repos.add(normalizeRepoUrl(`https://github.com/the-metafactory/${name}`));
    }
    return repos;
  } catch {
    return new Set();
  }
}

/**
 * Default location of cortex's OWN `arc-manifest.yaml`, resolved relative to
 * THIS module's location on disk — mirrors the established
 * `getCortexVersion`/`getVersion`/`readIntendedVersion` pattern
 * (`src/bus/dispatch-handler.ts`, `src/cortex.ts`,
 * `src/cli/cortex/commands/release.ts`) that already reads cortex's own
 * `arc-manifest.yaml` this same way. Deliberately NOT `defaultPkgRoot()` —
 * that trusted root holds OTHER installed packages' bundles, never cortex's
 * own checkout.
 */
export function defaultCortexManifestPath(): string {
  // src/adapters/loader.ts -> repo root is two levels up.
  return resolvePath(import.meta.dir, "..", "..", "arc-manifest.yaml");
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
  /** True when this bundle loaded under a first-party exemption — the OQ9
   *  renderer allowlist, or the cortex#1794 S9a adapter exemption (repoUrl
   *  declared under cortex's own `arc-manifest.yaml` `dependencies:`) —
   *  rather than because `system.plugins.external` was on. */
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
  /**
   * cortex#1794 (S9a) test seam — pre-resolved first-party ADAPTER allowlist.
   * Production callers never set this: it is computed automatically, once
   * per {@link loadExternalPlugins} call, from cortex's own
   * `arc-manifest.yaml` via {@link readCortexDeclaredAdapterRepos}. Set this
   * ONLY in tests that want to inject the allowlist directly instead of
   * pointing {@link cortexManifestPath} at a fixture file; if both are set,
   * this one wins (`cortexManifestPath` is never read).
   */
  firstPartyAdapterRepos?: ReadonlySet<string>;
  /**
   * cortex#1794 (S9a) test seam — where to read cortex's OWN
   * `arc-manifest.yaml` from when deriving the first-party adapter allowlist
   * (ignored if {@link firstPartyAdapterRepos} is set explicitly). Defaults
   * to {@link defaultCortexManifestPath} — cortex's REAL manifest at its
   * real repo-relative location. Tests point this at a fixture manifest so
   * the "declared dependency" mechanism is exercised end-to-end without
   * depending on (or mutating) the real file.
   */
  cortexManifestPath?: string;
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

  // cortex#1794 (S9a) — resolve the first-party ADAPTER allowlist ONCE per
  // load, not per bundle: `readCortexDeclaredAdapterRepos` is a file read +
  // YAML parse, and every bundle in this load is gated against the SAME
  // snapshot of cortex's own manifest (a manifest edit mid-loop, however
  // implausible, must not gate different bundles inconsistently within one
  // boot). Explicit `firstPartyAdapterRepos` (test seam) always wins over
  // reading a manifest at all.
  const firstPartyAdapterRepos =
    options.firstPartyAdapterRepos ??
    readCortexDeclaredAdapterRepos(options.cortexManifestPath ?? defaultCortexManifestPath());

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
        firstPartyAdapterRepos,
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
  /** cortex#1794 (S9a) — pre-resolved once in {@link loadExternalPlugins},
   *  never re-read per bundle. */
  firstPartyAdapterRepos: ReadonlySet<string>;
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

  // (b) External-flag / first-party gate (OQ6/OQ9, extended cortex#1794
  // S9a). `isFirstPartyBundle` dispatches by `manifest.kind`: a renderer is
  // checked against the in-tree allowlist EXACTLY as before (regression);
  // an adapter is checked against the allowlist derived from cortex's own
  // `arc-manifest.yaml` `dependencies:`, resolved once in
  // `loadExternalPlugins` and threaded through unchanged for every bundle.
  const firstParty = isFirstPartyBundle(arcPackage, manifest.kind, {
    rendererAllowlist: sinks.firstPartyRendererRepos,
    adapterAllowlist: sinks.firstPartyAdapterRepos,
  });
  if (!sinks.externalEnabled && !firstParty) {
    sinks.skipped.push({
      bundleName,
      kind: manifest.kind,
      id: manifest.id,
      reason: `system.plugins.external is off and this ${manifest.kind} bundle is not an exempt first-party bundle`,
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
    `cortex plugin-loader: loaded ${manifest.kind} "${manifest.id}" from bundle "${bundleName}"${firstParty ? ` (first-party ${manifest.kind} exemption)` : ""}\n`,
  );
}

// =============================================================================
// Runtime re-import — cortex#1793 (S8, ADR-0024 D3) reload support
// =============================================================================

/** Result of {@link reimportRendererPlugin}. */
export type ReimportRendererResult =
  | { ok: true; plugin: RendererPlugin }
  | { ok: false; stage: string; reason: string };

/**
 * Re-`import()` a bundle's entry module and re-validate its default export
 * as a {@link RendererPlugin} — the re-import half of `cortex plugin reload`
 * (S8). Deliberately reuses the SAME entry-containment (stage e) and
 * shape-validate/id-pin/freeze (stage f) logic `loadOneBundle` applies at
 * boot, applied to the SAME bundle a second time, so a reload is held to the
 * identical trust bar as a fresh boot-time load — no relaxed re-import path.
 *
 * Does NOT touch the {@link SurfacePluginRegistry} — the registry is a
 * `(kind, id)`-keyed CLASS registry (ADR-0024 D5), and a reload replaces a
 * live INSTANCE, not the class binding config-parsing resolves against. The
 * caller (`src/gateway/plugin-runtime.ts`) uses the returned plugin's
 * `createRenderer(config)` factory directly with the instance's ORIGINAL
 * parsed config, then discards this frozen plugin object — never registers
 * it.
 *
 * cortex#1793 (S8) scratch-verified finding: bun's dynamic `import()` only
 * honors a `?v=` cache-busting query string when the specifier is a PLAIN
 * filesystem path — the SAME query string on a `file://` URL (what
 * `loadOneBundle`'s boot-time import uses, `pathToFileURL(...).href`)
 * resolves to the SAME cached module every time (bun 1.3.2). `opts.bust`
 * therefore imports via the plain `resolved.absPath`, not a `file://` URL,
 * when re-importing for a reload; `loadOneBundle` is UNCHANGED (boot-time
 * imports never need busting — they're each bundle's first and only import
 * for that process lifetime).
 *
 * Renderer-only (adapters are out of scope for `cortex plugin reload` in
 * this slice — see `docs/plugin-sdk.md` §Runtime lifecycle for the
 * rationale: adapter re-construction needs binding-seed + demux-key inputs
 * `GatewayAdapterFactory` owns today, tracked separately at cortex#1896).
 */
export async function reimportRendererPlugin(
  bundle: DiscoveredBundle,
  opts: { bust: boolean },
): Promise<ReimportRendererResult> {
  const { manifest, bundleName } = bundle;
  const fail = (stage: string, reason: string): ReimportRendererResult => {
    process.stderr.write(
      `cortex plugin-loader: reload of ${bundleName} (renderer:${manifest.id}) refused at ${stage}: ${reason}\n`,
    );
    return { ok: false, stage, reason };
  };

  if (manifest.kind !== "renderer") {
    return fail("kind_check", `reimportRendererPlugin only supports renderer bundles; "${bundleName}" is kind "${manifest.kind}"`);
  }

  const resolved = resolveEntryWithinBundle(bundle.installPath, manifest.entry);
  if (!resolved.ok) {
    return fail("entry_containment", resolved.reason);
  }

  let imported: unknown;
  try {
    // See doc comment: plain path + query-bust for reload; file:// URL never
    // busts in bun 1.3.2 (scratch-verified cortex#1793).
    const specifier = opts.bust ? `${resolved.absPath}?v=${Date.now()}` : pathToFileURL(resolved.absPath).href;
    const mod: unknown = await import(specifier);
    imported = isRecord(mod) ? mod.default : undefined;
  } catch (err) {
    return fail("import", `entry module threw at re-import: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isRendererPluginShape(imported)) {
    return fail("shape_validate", "default export does not satisfy the RendererPlugin shape");
  }
  const id = imported.id;
  const rendererKind = imported.rendererKind;
  if (id !== manifest.id) {
    return fail("shape_validate", `default export's id ("${id}") does not match the manifest ("${manifest.id}")`);
  }
  if (rendererKind !== manifest.id) {
    return fail(
      "shape_validate",
      `default export's rendererKind ("${rendererKind}") does not match its own id ("${manifest.id}")`,
    );
  }
  // Same TOCTOU closure as `loadOneBundle`'s renderer branch — a frozen,
  // decoupled copy pinned to the trusted `manifest` values.
  const plugin: RendererPlugin = Object.freeze({
    ...imported,
    kind: manifest.kind,
    id: manifest.id,
    rendererKind: manifest.id,
  });
  return { ok: true, plugin };
}
