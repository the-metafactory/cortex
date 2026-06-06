/**
 * S3 (Network Join Control Plane, #737 / epic #733) — nats-server launchd
 * plist loader. Spec §6 F3; DD-6. Closes the "configured-but-dormant" trap.
 *
 * ## What this is
 *
 * During bring-up the homebrew launchd plist
 * (`homebrew.mxcl.nats-server.plist`) ran bare `nats-server -js` and never
 * loaded the rendered config — so a leaf remote could be rendered to disk
 * and the server would silently ignore it ("configured but dormant"). This
 * module is the pure half that corrects the plist's `ProgramArguments` to
 * include `-c <config>` so the daemon actually loads the leaf config.
 *
 * It does NOT write the plist, `launchctl unload/load`, or restart anything —
 * those live, stateful steps are S4's `cortex network join`. This unit:
 *
 *   - {@link ensureConfigArg} — given the current `ProgramArguments` + the
 *     config path, returns the corrected arguments. Idempotent: if a
 *     `-c <config>` / `--config=<config>` already points at the right file,
 *     it is a no-op; a `-c` pointing elsewhere is repointed (one `-c` only).
 *   - {@link plistConfigArgPresent} — predicate the caller can gate on.
 *   - {@link renderProgramArguments} — emit the corrected args as the launchd
 *     plist `<key>ProgramArguments</key><array>…</array>` block (XML-escaped)
 *     for S4 to splice into the plist.
 *
 * Pure + fixture-driven: no live `~/Library/LaunchAgents/...` read or write.
 */

/** Recognized "load this config" flags in a nats-server invocation. */
const SHORT_FLAG = "-c";
const LONG_FLAG = "--config";

/**
 * True iff `args` already loads exactly `configPath` via `-c <path>`,
 * `--config <path>`, or `--config=<path>`. Used by callers to decide whether
 * a plist rewrite is even needed (the no-op fast path).
 */
export function plistConfigArgPresent(
  args: readonly string[],
  configPath: string,
): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === SHORT_FLAG || a === LONG_FLAG) && args[i + 1] === configPath) {
      return true;
    }
    if (a === `${LONG_FLAG}=${configPath}`) {
      return true;
    }
  }
  return false;
}

/**
 * Return `ProgramArguments` that load `configPath`, idempotently:
 *
 *   - already loading `configPath` (any supported flag form) → unchanged.
 *   - a `-c`/`--config` flag present but pointing elsewhere → repointed to
 *     `configPath` (the stale-config case), keeping exactly one config flag.
 *   - no config flag → `-c <configPath>` appended.
 *
 * Pure: the input array is never mutated. Throws on an empty arg list (no
 * binary to invoke) or a non-absolute config path (launchd needs absolute).
 */
export function ensureConfigArg(
  args: readonly string[],
  configPath: string,
): string[] {
  if (args.length === 0) {
    throw new Error(
      "nats-plist-loader: ProgramArguments is empty — no nats-server binary to invoke",
    );
  }
  if (!configPath.startsWith("/")) {
    throw new Error(
      `nats-plist-loader: config path must be absolute, got ${JSON.stringify(configPath)}`,
    );
  }

  if (plistConfigArgPresent(args, configPath)) {
    return [...args];
  }

  // Drop any existing (stale) config flag + its value, then append the
  // correct one. Handles `-c X`, `--config X`, and `--config=X`.
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === SHORT_FLAG || a === LONG_FLAG) {
      i++; // skip the flag's value too
      continue;
    }
    if (a.startsWith(`${LONG_FLAG}=`)) {
      continue;
    }
    out.push(a);
  }
  out.push(SHORT_FLAG, configPath);
  return out;
}

/** Escape the five XML predefined entities for safe insertion into a plist. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the corrected `ProgramArguments` as the launchd plist key+array
 * block, XML-escaped. S4 splices this into the nats-server plist before
 * `launchctl` reload. Byte-stable for the same arguments (idempotent render).
 */
export function renderProgramArguments(args: readonly string[]): string {
  const items = args
    .map((a) => `\t\t<string>${escapeXml(a)}</string>`)
    .join("\n");
  return [
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    items,
    "\t</array>",
  ].join("\n");
}
