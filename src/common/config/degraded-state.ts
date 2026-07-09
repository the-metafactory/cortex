/**
 * FS-7 / D-3 (cortex#1839) — DEGRADED-boot state marker.
 *
 * When the daemon boots on the last-known-good snapshot after `loadConfigWithAgents`
 * threw on the LIVE config (D-3 fallback, see `src/cortex.ts` boot + `last-good.ts`),
 * it is running DEGRADED: serving the previous config while the live one is broken.
 * That state must be VISIBLE — design Principle 5's whole point is "never a silent
 * crash-loop", and a silent degraded boot is just a quieter failure.
 *
 * This module is the single source of truth for the degraded state, persisted as a
 * small JSON marker file so it is visible across processes:
 *   - the daemon WRITES it at degraded boot / CLEARS it on a healthy boot;
 *   - `cortex status` (a separate process) READS it to print DEGRADED + the error;
 *   - the in-process MC server surfaces it on `/health` (threaded in at boot).
 *
 * The marker path is derived from the SAME `pidFileFor` locator the lifecycle
 * uses (`<pid>.pid` → `<pid>.degraded.json`), so the daemon that writes it and the
 * `cortex status` that reads it always agree on the file across config-path
 * spellings.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

import { pidFileFor } from "../pidfile";

/** Persisted shape of a degraded boot. */
export interface DegradedInfo {
  /** Precise config-load error that forced the fallback (multi-line allowed). */
  error: string;
  /** Absolute path of the last-good snapshot the daemon booted from. */
  snapshotPath: string;
  /** ISO-8601 timestamp the degraded boot happened. */
  since: string;
}

/**
 * Marker path for a `--config` value: the PID file path with `.pid` swapped for
 * `.degraded.json`. Reuses `pidFileFor` so writer (daemon) and reader
 * (`cortex status`) resolve the same file across path spellings.
 */
export function degradedMarkerPath(configPath: string | undefined): string {
  return pidFileFor(configPath).replace(/\.pid$/, ".degraded.json");
}

/** Persist the degraded-boot marker (0600 — the error text can name config internals). */
export function writeDegradedMarker(configPath: string | undefined, info: DegradedInfo): void {
  const path = degradedMarkerPath(configPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

/** Read the degraded-boot marker, or `null` when the daemon booted healthy. */
export function readDegradedMarker(configPath: string | undefined): DegradedInfo | null {
  const path = degradedMarkerPath(configPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DegradedInfo;
  } catch (err) {
    // A corrupt marker is not fatal — report it and treat as "no marker" so a
    // parse glitch never masks the real status output or crashes the reader.
    process.stderr.write(
      `cortex: could not parse degraded marker ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/** Remove the degraded-boot marker (a healthy boot clears any prior degraded state). Best-effort. */
export function clearDegradedMarker(configPath: string | undefined): void {
  const path = degradedMarkerPath(configPath);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    // Best-effort cleanup — a stale marker is surfaced as DEGRADED, which is
    // strictly safer than crashing the boot on an unlink race. Log and proceed.
    process.stderr.write(
      `cortex: could not clear degraded marker ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
