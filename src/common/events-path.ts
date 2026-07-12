/**
 * XDG wave-1 (cortex#1908, EPIC cortex#1867 X-03) — EVENTS_DIR path seam.
 *
 * The Claude Code event buffer lives at `~/.claude/events/{raw,published}` and
 * is touched from THREE independent sites that must all agree byte-for-byte
 * (the #1870 guard's "byte-identical events dir across hook/relay/MC"
 * invariant): the event-logger hook (writer), the relay (reader→publisher),
 * and Mission Control's hook poller (reader). Before this module each site
 * inlined its own `join(process.env.HOME ?? "~", ".claude", "events")`, so
 * there was nowhere to point a hermetic guard.
 *
 * This is the single seam for `CORTEX_EVENTS_DIR`:
 *   - UNSET  ⇒ `~/.claude/events` — byte-identical to the previous inline
 *     spelling at each call site (callers pass their own `home` source so an
 *     `os.homedir()`-based site stays `os.homedir()`-based).
 *   - SET    ⇒ that directory VERBATIM, so a guard (#1870) can point the whole
 *     hook→relay→MC pipeline at a scratch dir with zero real-home access.
 *
 * SCOPE — this is JUST the env read. It does NOT honor `$XDG_DATA_HOME` /
 * `$XDG_STATE_HOME` or move the buffer (that classification is #1867 P3 /
 * #1902). No `GROVE_*` dual-read: `CORTEX_EVENTS_DIR` is a newly-introduced
 * var, not a name being migrated (cortex#774's dual-read is only for renames).
 */

import { join } from "path";

import { readDirEnv } from "./xdg";

function homeDir(home?: string): string {
  return home ?? process.env.HOME ?? "~";
}

/**
 * The `CORTEX_EVENTS_DIR` override, or `undefined` when unset/empty. A blank OR
 * whitespace-only value is treated as unset (via {@link readDirEnv}) so
 * `CORTEX_EVENTS_DIR=` and `CORTEX_EVENTS_DIR="  "` both keep today's behavior
 * rather than resolving to `/` or a literal relative `"  "` directory
 * (PR#1920 nit a).
 */
export function eventsDirOverride(): string | undefined {
  return readDirEnv("CORTEX_EVENTS_DIR");
}

/**
 * The events-buffer ROOT: `$CORTEX_EVENTS_DIR` if set, else `~/.claude/events`.
 * @param home Override for `$HOME` (tests / call sites that resolve home via
 *   `os.homedir()`); ignored when `CORTEX_EVENTS_DIR` is set.
 */
export function eventsDir(home?: string): string {
  return eventsDirOverride() ?? join(homeDir(home), ".claude", "events");
}

/** The raw event buffer: `<eventsDir>/raw`. */
export function rawEventsDir(home?: string): string {
  return join(eventsDir(home), "raw");
}

/** The published event buffer: `<eventsDir>/published`. */
export function publishedEventsDir(home?: string): string {
  return join(eventsDir(home), "published");
}
