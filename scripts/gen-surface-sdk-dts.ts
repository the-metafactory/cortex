#!/usr/bin/env bun
/**
 * gen-surface-sdk-dts.ts — regenerate the shippable, self-contained plugin-SDK
 * type artifact (cortex#1950).
 *
 * ## Why this exists
 *
 * Out-of-tree surface-plugin bundles (`metafactory-cortex-adapter-web`, and the
 * slack/mattermost/discord bundles that follow) compile against the plugin SDK
 * contract with `import type { PlatformAdapter, … } from
 * "@the-metafactory/cortex/surface-sdk"`. Those imports are erased at runtime
 * (the loader's dynamic `import()` never resolves them — see docs/plugin-sdk.md),
 * but a bundle's standalone `bunx tsc --noEmit` needs the types RESOLVABLE.
 *
 * The barrel (`src/surface-sdk/index.ts`) re-exports types rooted transitively
 * across cortex + myelin, so pointing a consumer's `tsc` at the raw `.ts` source
 * drags the whole cortex source tree + its dev-deps into the bundle's compile
 * (verified: hundreds of errors in `adapters/discord/*`, missing `discord.js`).
 * The fix is to ship a single FLAT `.d.ts` with every transitive type INLINED
 * and nothing external except `zod/v4` (which every bundle already depends on).
 * `package.json`'s `exports["./surface-sdk"].types` points at that artifact.
 *
 * ## Drift-proofing
 *
 * This artifact is GENERATED from the real barrel — it is never hand-edited, so
 * it cannot drift the way the old per-bundle vendored copies did. A `SURFACE_SDK_VERSION`
 * bump (or any contract change) is picked up automatically because the artifact
 * is regenerated from source. CI runs this script with `--check` and fails on any
 * uncommitted diff (`.github/workflows/ci.yml` → `surface-sdk-dts-sync`), so a
 * merged artifact is always byte-identical to what the current barrel produces.
 *
 * ## Usage
 *
 *   bun run sdk:dts          # regenerate + write the artifact (commit the result)
 *   bun run sdk:dts:check    # regenerate to a temp file + diff; non-zero on drift
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "src/surface-sdk/index.ts";
export const ARTIFACT = join(repoRoot, "src/surface-sdk/generated/surface-sdk.d.ts");

const HEADER = `// ============================================================================
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Self-contained type artifact for the cortex plugin SDK (cortex#1950). This is
// the file out-of-tree surface-plugin bundles resolve when they
//   import type { PlatformAdapter, … } from "@the-metafactory/cortex/surface-sdk";
// (package.json exports["./surface-sdk"].types points here).
//
// Regenerate after ANY change to src/surface-sdk/index.ts or the contract types
// it re-exports:
//   bun run sdk:dts
//
// CI (.github/workflows/ci.yml → surface-sdk-dts-sync) fails on any drift between
// this committed file and a fresh regeneration, so it can never go stale.
// ============================================================================
`;

/** Roll the barrel up into one flat .d.ts (all transitive types inlined; only
 *  zod kept as an external import — every bundle already depends on zod). */
function generate(): string {
  const bin = join(repoRoot, "node_modules/.bin/dts-bundle-generator");
  const outTmp = join(repoRoot, "src/surface-sdk/generated/.surface-sdk.gen.tmp.d.ts");
  mkdirSync(dirname(outTmp), { recursive: true });
  // dts-bundle-generator is a node/CJS tool that needs `typescript` resolvable
  // from repoRoot (devDependency). Run it under node explicitly.
  const res = spawnSync(
    "node",
    [bin, "--no-check", "--no-banner", "--silent", "-o", outTmp, "--", ENTRY],
    { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
  );
  if (res.status !== 0) {
    process.stderr.write(`dts-bundle-generator failed (exit ${res.status})\n`);
    process.exit(res.status ?? 1);
  }
  const body = readFileSync(outTmp, "utf8").trimStart();
  // clean up the temp file
  spawnSync("rm", ["-f", outTmp]);
  return HEADER + "\n" + body;
}

const check = process.argv.includes("--check");
const generated = generate();

if (check) {
  let current = "";
  try {
    current = readFileSync(ARTIFACT, "utf8");
  } catch {
    current = "";
  }
  if (current !== generated) {
    process.stderr.write(
      `\n❌ ${ARTIFACT} is out of sync with ${ENTRY}.\n` +
        `   Run \`bun run sdk:dts\` and commit the result.\n\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`✅ surface-sdk .d.ts artifact is in sync.\n`);
} else {
  mkdirSync(dirname(ARTIFACT), { recursive: true });
  writeFileSync(ARTIFACT, generated);
  process.stdout.write(`✅ wrote ${ARTIFACT}\n`);
}
