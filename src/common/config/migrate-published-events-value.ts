/**
 * XDG wave-5 (cortex#1902, EPIC cortex#1867 §P3b) — publishedEventsDir config
 * VALUE migrator.
 *
 * `paths.publishedEventsDir` is a PERSISTED config value: `stack-lib.ts` writes
 * it literally into every generated `cortex.yaml`. Because it is pinned in the
 * file, an env var or a changed zod default CANNOT relocate it — the pinned old
 * value wins at parse time and keeps the reader pointed at
 * `~/.claude/events/published`. So the move is done by MIGRATING the file:
 * rewriting the pinned legacy value to the new metafactory data-root value
 * (`~/.local/share/metafactory/cortex/events/published`). "Migrate, don't
 * shadow."
 *
 * ── What is rewritten ────────────────────────────────────────────────────────
 * ONLY a value that matches a known LEGACY spelling of the old default — the
 * `~`-prefixed `~/.claude/events/published` OR its `$HOME`-expanded absolute
 * form. A genuinely CUSTOM pinned path (a user who chose their own location) is
 * LEFT ALONE (their intent is respected), and an already-migrated value is a
 * no-op (idempotent).
 *
 * ── Formatting preservation ──────────────────────────────────────────────────
 * The rewrite is a TARGETED single-line edit (indentation + optional quotes +
 * trailing comment preserved), NOT a parse→stringify round-trip that would strip
 * every comment from the generated `cortex.yaml`. The file is validated by a
 * real YAML parse first (to read the current value + confirm structure), then
 * the one scalar is replaced textually and written atomically (temp-O_EXCL →
 * fsync → chmod → rename, source mode preserved).
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import { atomicWriteFile } from "./migrate-config-dir";
import {
  LEGACY_PUBLISHED_EVENTS_DIR_DEFAULT,
  PUBLISHED_EVENTS_DIR_DEFAULT,
} from "../data-path";

export interface PublishedEventsValueMigration {
  /** True when THIS call rewrote the file. */
  changed: boolean;
  /** The value before the rewrite (present only when `changed`). */
  from?: string;
  /** The value written (present only when `changed`). */
  to?: string;
}

/** The `$HOME`-expanded absolute form of the legacy default. */
function legacyExpanded(home: string): string {
  return join(home, ".claude", "events", "published");
}

/**
 * Whether `value` is a known legacy spelling of the old `publishedEventsDir`
 * default (the `~`-prefixed form or its `$HOME`-expanded absolute form). A
 * custom path returns false (left untouched).
 */
export function isLegacyPublishedEventsDir(value: string, home: string): boolean {
  return value === LEGACY_PUBLISHED_EVENTS_DIR_DEFAULT || value === legacyExpanded(home);
}

/**
 * Textually replace the scalar on the `publishedEventsDir:` line, preserving
 * indentation, optional surrounding quotes, and any trailing comment. Returns
 * the rewritten file text, or `null` when no `publishedEventsDir:` line is found
 * (the caller then leaves the file untouched).
 */
function rewriteLine(raw: string, newValue: string): string | null {
  // Matches: <indent>publishedEventsDir:<sp><optquote><value><optquote><sp><#comment?>
  const re = /^(\s*publishedEventsDir:[ \t]*)(["']?)(.*?)\2([ \t]*(?:#.*)?)$/m;
  if (!re.test(raw)) return null;
  return raw.replace(re, (_m, prefix: string, quote: string, _val: string, tail: string) => {
    return `${prefix}${quote}${newValue}${quote}${tail}`;
  });
}

/**
 * Migrate the pinned `paths.publishedEventsDir` value inside an existing
 * `cortex.yaml`, in place, to the new metafactory data-root default.
 *
 * Non-destructive + idempotent:
 *   - file missing / not a YAML mapping / no `paths.publishedEventsDir` string →
 *     no-op (`changed:false`);
 *   - value is a CUSTOM path (not a legacy default spelling) → no-op (intent
 *     respected);
 *   - value already equals the new default → no-op;
 *   - value is a legacy default spelling → the one scalar is rewritten to the new
 *     default and the file is written atomically (source mode preserved).
 *
 * @param configPath Absolute path to the `cortex.yaml` to migrate.
 * @param opts.home  Override for `$HOME` (tests pass a scratch home).
 */
export function migratePublishedEventsDirValue(
  configPath: string,
  opts: { home?: string } = {},
): PublishedEventsValueMigration {
  if (!existsSync(configPath)) return { changed: false };

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return { changed: false };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return { changed: false }; // malformed YAML — never rewrite blindly
  }

  const current = (parsed as { paths?: { publishedEventsDir?: unknown } } | null)?.paths
    ?.publishedEventsDir;
  if (typeof current !== "string") return { changed: false };

  const home = opts.home ?? process.env.HOME ?? "~";
  if (!isLegacyPublishedEventsDir(current, home)) return { changed: false }; // custom / already new
  if (current === PUBLISHED_EVENTS_DIR_DEFAULT) return { changed: false }; // already migrated

  const next = rewriteLine(raw, PUBLISHED_EVENTS_DIR_DEFAULT);
  if (next === null || next === raw) return { changed: false };

  const mode = statSync(configPath).mode & 0o777;
  atomicWriteFile(configPath, Buffer.from(next, "utf-8"), mode);
  return { changed: true, from: current, to: PUBLISHED_EVENTS_DIR_DEFAULT };
}
