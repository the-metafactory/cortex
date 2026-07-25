#!/usr/bin/env bun
/**
 * run-swarm-posture.ts — EBH-7 (cortex#2349, epic #2341) CI wrapper for the
 * swarm-posture structural least-privilege / attack-path check.
 *
 * cortex does NOT vendor a copy of swarm-posture.ts. The upstream tool
 * (https://github.com/NorthwoodsSentinel/swarm-posture, Apache-2.0) is a
 * single zero-dependency file; the CI workflow checks it out at a pinned
 * commit SHA into a sibling directory and this script *invokes* it against
 * the committed fleet description. See docs/security/swarm-posture/README.md
 * "Vendor vs. invoke" for why invoking (not copying) was the deliberate
 * choice — the short version: a copy of someone else's security tool drifts
 * silently; a pinned-SHA checkout is the same "vendor a known-good version"
 * guarantee without an unreviewable second copy of the algorithm living in
 * this repo.
 *
 * WARN-ONLY (advisory) posture: this script ALWAYS exits 0 when the tool ran
 * successfully, regardless of how many structural findings it reports — this
 * is deliberate for the initial rollout (we do not yet know the finding
 * volume / false-positive rate on a live fleet; a gate that red-lines `main`
 * on day one gets disabled, not fixed). It exits non-zero only when the
 * check itself could not run (missing tool, missing/malformed swarm.json) —
 * that is a broken CI job, not a posture finding, and SHOULD fail the build.
 *
 * To promote to BLOCKING later: parse the "N structural finding(s)" summary
 * line below, diff the count against a committed baseline (or a fixed
 * ceiling), and exit non-zero on regression. That is intentionally NOT done
 * here yet — see the epic issue (cortex#2349) acceptance criteria.
 *
 * Usage:
 *   bun scripts/security/run-swarm-posture.ts <path-to-swarm-posture.ts> [swarm.json]
 *
 * `swarm.json` defaults to docs/security/swarm-posture/cortex-fleet.swarm.json.
 */

import { existsSync, appendFileSync } from "fs";
import { spawnSync } from "child_process";
import { resolve } from "path";

const DEFAULT_SWARM_FILE = "docs/security/swarm-posture/cortex-fleet.swarm.json";

function die(msg: string): never {
  console.error(`run-swarm-posture: ${msg}`);
  process.exit(2);
}

const toolPath = process.argv[2];
const swarmFile = resolve(process.argv[3] ?? DEFAULT_SWARM_FILE);

if (!toolPath) {
  die(
    "usage: bun scripts/security/run-swarm-posture.ts <path-to-swarm-posture.ts> [swarm.json]\n" +
      "  In CI, <path-to-swarm-posture.ts> comes from the pinned NorthwoodsSentinel/swarm-posture checkout.\n" +
      "  Locally: clone https://github.com/NorthwoodsSentinel/swarm-posture and pass its swarm-posture.ts path.",
  );
}

if (!existsSync(toolPath)) {
  die(`swarm-posture.ts not found at "${toolPath}" — checkout step did not run or the path is wrong.`);
}

if (!existsSync(swarmFile)) {
  die(`swarm description not found at "${swarmFile}".`);
}

const result = spawnSync("bun", [toolPath, swarmFile], { encoding: "utf8" });

// A spawn failure (tool crashed, bun missing, etc.) is an infra problem —
// distinct from the tool running and reporting findings (which always exits
// 0; see swarm-posture.ts — it only exits non-zero on a missing/unparseable
// swarm file, which the existsSync check above already ruled out short of a
// race). Either way, a non-zero exit here means the CHECK ITSELF is broken,
// not that findings exist — fail the job so a broken gate can't silently
// look green.
if (result.error) {
  die(`failed to spawn bun: ${result.error.message}`);
}

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

if (result.status !== 0) {
  die(`swarm-posture.ts exited ${result.status} — check config error above (not a posture finding).`);
}

// Extract the one-line summary ("N structural finding(s): X excessive-permission, Y attack-path")
// for the step summary / advisory banner. Falls back gracefully if the
// upstream tool's output format ever changes — this is a nice-to-have
// extraction, not a parser this gate depends on for correctness.
// eslint-disable-next-line no-control-regex -- stripping the tool's ANSI color codes for the plain-text summary
const plain = stdout.replace(/\x1b\[[0-9;]*m/g, "");
const summaryMatch = plain.match(/([0-9]+) structural finding\(s\): (\d+) excessive-permission, (\d+) attack-path/);
const summaryLine = summaryMatch
  ? `${summaryMatch[1]} structural finding(s) — ${summaryMatch[2]} excessive-permission, ${summaryMatch[3]} attack-path`
  : "(could not parse summary line — see full output above)";

const banner = [
  "",
  "=".repeat(78),
  "swarm-posture — ADVISORY / WARN-ONLY (EBH-7, cortex#2349)",
  `Result: ${summaryLine}`,
  "This gate does NOT fail the build on findings yet — see the epic (cortex#2349)",
  "and docs/security/swarm-posture/README.md for what promotes it to blocking.",
  "=".repeat(78),
  "",
].join("\n");
console.log(banner);

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  try {
    // GITHUB_STEP_SUMMARY is a shared, cumulative file across every step in
    // the job (each writer APPENDS, per GitHub's own contract) — using
    // Bun.write here would TRUNCATE whatever earlier steps already wrote.
    appendFileSync(
      summaryFile,
      `### swarm-posture — ADVISORY / WARN-ONLY\n\n` +
        `**${summaryLine}**\n\n` +
        "This is the structural check only (declared config, no live agent runs). " +
        "It does not fail CI on findings during the burn-in window. " +
        "See `docs/security/swarm-posture/README.md` for the fleet model, the `role_owns` reasoning, " +
        "and what promoting this gate to blocking would require.\n\n" +
        "```\n" +
        plain.trim() +
        "\n```\n",
    );
  } catch (err) {
    // Non-fatal — the step summary is a nice-to-have UI surface, not the
    // gate's actual signal (which is the exit code + stdout above).
    console.warn(`run-swarm-posture: could not write GITHUB_STEP_SUMMARY: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// WARN-ONLY: always exit 0 once the check itself ran successfully, no matter
// how many findings it reported. See the module docblock.
process.exit(0);
