/**
 * Grove Mission Control v3 — datetime hydrate helper.
 *
 * Lifted out of `db/assignments.ts` so the shared session-join helper
 * (`db/session-join.ts`) can consume it without a circular import back
 * to `assignments.ts`. Per Echo's PR #57 cycle-2 nit.
 */

/**
 * SQLite's `datetime('now')` emits `YYYY-MM-DD HH:MM:SS` (space-separated,
 * no timezone). That string is not strictly ISO-8601 and `Date.parse` is
 * only required to handle ISO-8601 reliably — older WebKit in particular
 * has been inconsistent with space-separated forms.
 *
 * We normalize at the hydrate boundary so every timestamp the API surfaces
 * is unambiguous: `T` separator, explicit `Z` (UTC) suffix. Idempotent —
 * values that already contain `T` or timezone info are returned unchanged.
 *
 * See PR #8 review finding S2 (original home: db/assignments.ts).
 */
export function normalizeSqliteDatetime(raw: string): string {
  if (!raw) return raw;
  // Already ISO-ish (has 'T' or timezone) — leave alone.
  if (raw.includes("T")) return raw;
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(raw)) return raw;
  // SQLite `datetime('now')` is UTC. Convert `YYYY-MM-DD HH:MM:SS[.sss]` →
  // `YYYY-MM-DDTHH:MM:SS[.sss]Z`.
  return raw.replace(" ", "T") + "Z";
}
