/**
 * #763 (Linux/systemd support for `cortex network join`) — nats-server systemd
 * unit loader. The Linux sibling of {@link file://./nats-plist-loader.ts}.
 *
 * ## What this is
 *
 * On macOS the nats-server service is a launchd plist whose `ProgramArguments`
 * carry the `-c <config>` flag (see `nats-plist-loader.ts`). On Linux (clawbox
 * and any systemd peer) the same service is a **systemd unit** whose
 * `[Service] ExecStart=` line carries the flag. The dormant-config trap is
 * identical: a unit running bare `nats-server -js` never loads the rendered
 * leaf config, so a leaf can be written to disk and silently ignored.
 *
 * This module is the pure half that corrects the unit's `ExecStart=` line to
 * include `-c <config>`, mirroring the plist loader's `ensureConfigArg`:
 *
 *   - {@link ensureUnitConfigArg} — given the full unit text + the config path,
 *     returns the corrected unit text. Idempotent + BYTE-STABLE: when the
 *     `ExecStart` already loads `configPath` the input is returned verbatim; a
 *     `-c`/`--config` pointing elsewhere is repointed (one config flag only);
 *     every other `ExecStart` argument and every other unit section/directive
 *     is preserved verbatim. Only the single `ExecStart=` line is rewritten.
 *   - {@link systemdUnitConfigArgPresent} — predicate for the no-op fast path.
 *   - {@link systemdUnitServiceId} — read the unit's service id (its `.service`
 *     file basename, falling back to a `Description`-derived id) — the systemd
 *     analogue of the launchd plist `<key>Label</key>` used as the
 *     `systemctl restart` target.
 *
 * The actual arg-list transform is delegated to the plist loader's
 * {@link ensureConfigArg} / {@link plistConfigArgPresent} — the SINGLE source of
 * truth for "ensure exactly one `-c <config>` in this argv". This module only
 * parses/serialises the systemd `ExecStart=` line around it (tokenise → ensure
 * → re-join), so the launchd and systemd paths share one tested arg algorithm.
 *
 * Pure + fixture-driven: no live `~/.config/systemd/...` read/write, no
 * `systemctl`. The S4 adapter (`network-adapters.ts`) does the I/O + restart.
 */

import { ensureConfigArg, plistConfigArgPresent } from "./nats-plist-loader";

/**
 * systemd `ExecStart=` may carry one or more special exec prefixes
 * (`@`, `-`, `+`, `!`, `!!`, `:`) BEFORE the executable path. We preserve any
 * such prefix verbatim and only ensure the config flag on the argv that
 * follows. See `man systemd.service` → "Command lines".
 */
const EXEC_PREFIX_RE = /^([@\-+!:]+)/;

/** Locate the single `ExecStart=` directive line in a systemd unit. */
function findExecStartLine(
  unitText: string,
): { lines: string[]; index: number } | undefined {
  const lines = unitText.split("\n");
  const index = lines.findIndex((l) => /^\s*ExecStart\s*=/.test(l));
  if (index < 0) return undefined;
  return { lines, index };
}

/**
 * Split an `ExecStart=` value into [exec-prefix, ...argv]. The prefix (if any)
 * is kept attached to the binary token so re-joining reproduces the line.
 */
function splitExecArgv(value: string): { prefix: string; argv: string[] } {
  const trimmed = value.trim();
  const m = EXEC_PREFIX_RE.exec(trimmed);
  const prefix = m?.[1] ?? "";
  const rest = trimmed.slice(prefix.length).trim();
  // Whitespace tokenisation matches systemd's default (non-quoted) splitting,
  // which is all the nats-server invocation needs (no quoted args in play).
  const argv = rest.length === 0 ? [] : rest.split(/\s+/);
  return { prefix, argv };
}

/** The `ExecStart=` value (everything after the first `=`). */
function execStartValue(line: string): string {
  const eq = line.indexOf("=");
  return eq < 0 ? "" : line.slice(eq + 1);
}

/**
 * True iff the unit's `ExecStart` already loads exactly `configPath` via
 * `-c <path>`, `--config <path>`, or `--config=<path>`. Used by callers to
 * decide whether a unit rewrite is even needed (the no-op fast path). Returns
 * false when there is no `ExecStart` line at all.
 */
export function systemdUnitConfigArgPresent(
  unitText: string,
  configPath: string,
): boolean {
  const found = findExecStartLine(unitText);
  if (found === undefined) return false;
  const { argv } = splitExecArgv(execStartValue(found.lines[found.index] ?? ""));
  return plistConfigArgPresent(argv, configPath);
}

/**
 * Return the unit text with `ExecStart=` corrected to load `configPath`,
 * idempotently + byte-stably:
 *
 *   - already loading `configPath` (any supported flag form) → input returned
 *     verbatim (byte-stable no-op).
 *   - a `-c`/`--config` flag present but pointing elsewhere → repointed to
 *     `configPath` (the stale-config case), keeping exactly one config flag.
 *   - no config flag → `-c <configPath>` appended to the `ExecStart` argv.
 *
 * Only the single `ExecStart=` line is touched; every other line (other unit
 * sections, other `[Service]` directives, comments, blank lines) is preserved
 * verbatim, and the line count + ordering are unchanged. Any systemd exec
 * prefix (`@`, `-`, `+`, …) on `ExecStart=` is preserved.
 *
 * Pure: the input string is never mutated. Throws on a missing `ExecStart`
 * (no nats-server invocation to correct — the systemd analogue of the plist
 * loader's empty-`ProgramArguments` guard, with an actionable message rather
 * than the cryptic "ProgramArguments is empty" the plist parser emitted when a
 * systemd unit was fed to it) or a non-absolute config path.
 */
export function ensureUnitConfigArg(
  unitText: string,
  configPath: string,
): string {
  const found = findExecStartLine(unitText);
  if (found === undefined) {
    throw new Error(
      "systemd-unit-loader: no `[Service] ExecStart=` directive — not a nats-server systemd unit (or no command to invoke)",
    );
  }
  if (!configPath.startsWith("/")) {
    throw new Error(
      `systemd-unit-loader: config path must be absolute, got ${JSON.stringify(configPath)}`,
    );
  }

  const { lines, index } = found;
  const line = lines[index] ?? "";
  const value = execStartValue(line);
  const { prefix, argv } = splitExecArgv(value);

  if (argv.length === 0) {
    throw new Error(
      "systemd-unit-loader: `ExecStart=` has no command — no nats-server binary to invoke",
    );
  }

  // Byte-stable fast path: already loading the right config → return verbatim.
  if (plistConfigArgPresent(argv, configPath)) {
    return unitText;
  }

  // Reuse the launchd arg algorithm (single source of truth): ensure exactly
  // one `-c <configPath>`, dropping any stale config flag.
  const nextArgv = ensureConfigArg(argv, configPath);

  // Preserve the directive's leading indentation (if any) verbatim.
  const indentMatch = /^(\s*)ExecStart\s*=/.exec(line);
  const indent = indentMatch?.[1] ?? "";
  const nextValue = `${prefix}${nextArgv.join(" ")}`;
  const nextLines = [...lines];
  nextLines[index] = `${indent}ExecStart=${nextValue}`;
  return nextLines.join("\n");
}

/**
 * The unit's service id — the `systemctl restart <id>` target, analogous to the
 * launchd plist `<key>Label</key>`. Prefers the `.service` file basename (the
 * canonical systemd unit name, e.g. `nats-server.service`); when the path is
 * not a `.service` file, falls back to a `Description`-derived slug so the
 * function is total (never returns an empty id). The unit text is read only for
 * the fallback.
 */
export function systemdUnitServiceId(
  unitPath: string,
  unitText: string,
): string {
  const base = unitPath.split("/").pop() ?? "";
  if (base.endsWith(".service") && base.length > ".service".length) {
    return base;
  }
  // Fallback: derive from Description=… (slugified) + `.service`.
  const desc = /^\s*Description\s*=\s*(.+)$/m.exec(unitText)?.[1]?.trim();
  if (desc !== undefined && desc !== "") {
    const slug = desc
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug !== "") return `${slug}.service`;
  }
  // Last resort: the basename as-is (or a stable placeholder).
  return base !== "" ? base : "nats-server.service";
}
