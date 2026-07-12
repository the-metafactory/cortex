/**
 * cortex#1949 — extraction boundary check (reusable helper).
 *
 * The S5 boundary-guard test (`boundary-guard.test.ts`) is SYMBOL-scoped: it
 * only forbids importing a plugin-CONTRACT symbol from its pre-SDK location. It
 * deliberately permits an in-tree plugin's OTHER cross-boundary imports (into
 * `common/policy`, `MyelinRuntime`, …) because those are the residual couplings
 * the per-adapter dependency-inversions (cortex#1896) resolve one at a time.
 *
 * THIS helper is the check an ALREADY-INVERTED plugin (one about to extract to
 * its own bundle) must pass: it may import ONLY from its own directory and the
 * `surface-sdk` barrel — ANY other relative import that resolves OUTSIDE the
 * plugin directory is a cross-boundary coupling that would break the bundle
 * out-of-tree.
 *
 * It exists because the S9b (web) dependency-inversion's own boundary test had
 * a real gap — it flagged only `../../` (two-level) specifiers, so a ONE-level
 * `../plugin-support` runtime import slipped through undetected and only
 * surfaced at the MOVE. This helper catches ANY cross-directory `../`
 * specifier, one level or more.
 *
 * Enforcement is per-plugin and gated on that plugin being inverted: cortex#1896
 * calls {@link crossBoundaryImports} for discord/slack/mattermost as each is
 * inverted, asserting `[]`. It is NOT run against the un-inverted in-tree
 * adapters (they would legitimately fail — that's what #1896 fixes).
 */

import { readdirSync, readFileSync } from "fs";
import { dirname, relative, resolve } from "path";

export interface CrossBoundaryImport {
  /** Absolute path of the file containing the offending import. */
  file: string;
  /** The raw import specifier (e.g. `"../plugin-support"`). */
  specifier: string;
  /** Absolute path the specifier resolves to (sans extension). */
  resolved: string;
}

const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /import\s*["']([^"']+)["']/g;
// Dynamic `import("../x")` / `await import("../x")` — a lazy-loaded boundary
// import is exactly the class this guard exists to catch (#1953 review): a
// lazy `import("../plugin-support")` would extract broken just like a static
// one, so a guard blind to it is false confidence.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']/g;

/** Recursively list `*.ts` files under `dir`, skipping `__tests__` + `.d.ts`. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Return every relative import in `pluginDir` that resolves OUTSIDE `pluginDir`
 * and is not the `surface-sdk` barrel. An inverted, ready-to-extract plugin
 * must return `[]`.
 *
 * @param pluginDir absolute path of the plugin's directory (e.g. an adapter dir)
 * @param sdkDir    absolute path of `src/surface-sdk` (the one allowed cross-dir target)
 */
export function crossBoundaryImports(pluginDir: string, sdkDir: string): CrossBoundaryImport[] {
  const pluginRoot = resolve(pluginDir);
  const sdkRoot = resolve(sdkDir);
  const violations: CrossBoundaryImport[] = [];

  for (const file of tsFiles(pluginRoot)) {
    const src = readFileSync(file, "utf-8");
    const specifiers = new Set<string>();
    for (const m of src.matchAll(IMPORT_RE)) specifiers.add(m[1]!);
    for (const m of src.matchAll(BARE_IMPORT_RE)) specifiers.add(m[1]!);
    for (const m of src.matchAll(DYNAMIC_IMPORT_RE)) specifiers.add(m[1]!);

    for (const spec of specifiers) {
      if (!spec.startsWith(".")) continue; // package/bare import — not a boundary concern
      const resolved = resolve(dirname(file), spec);
      // Inside the plugin's own directory → fine.
      if (resolved === pluginRoot || resolved.startsWith(pluginRoot + "/")) continue;
      // The surface-sdk barrel → the one allowed cross-dir target.
      if (resolved === sdkRoot || resolved.startsWith(sdkRoot + "/")) continue;
      violations.push({ file: relative(pluginRoot, file), specifier: spec, resolved });
    }
  }
  return violations;
}
