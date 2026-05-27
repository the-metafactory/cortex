/**
 * F-8 task table — hash (de)serializer for filter + sort state.
 *
 * Per F-8 Decision 3 the filter state lives in `location.hash` (not
 * localStorage) so URLs are shareable and per-tab. Schema mirrors the
 * legacy monolith (`dashboard/index.html:2453-2503`):
 *
 *   #tasks?p=0,1&age=5&closed=1&q=webhook&sort=priority:asc
 *
 * Pure functions — no DOM. The React `useTasks` hook calls these with
 * `location.hash` / `history.replaceState`; tests pass strings directly.
 */

import type {
  TaskFilterState,
  TaskSortKey,
  TaskSortState,
  SortDir,
} from "./task-table-filter";

const SORT_KEYS: readonly TaskSortKey[] = [
  "priority", "title", "agents", "state", "age",
];

export interface ParsedHash {
  filters: TaskFilterState;
  sort: TaskSortState;
}

/** Default state — what the UI starts with when no hash is present. */
export function defaultHashState(): ParsedHash {
  return {
    filters: {
      priorities: new Set<number>(),
      ageMinMinutes: 0,
      search: "",
      includeClosed: false,
      // F-16 — null iteration filter = "show all". The hash codec
      // round-trips through `?iter=<id>` (see parseHash / serializeHash).
      iterationId: null,
    },
    sort: { key: "default", dir: "asc" },
  };
}

/**
 * Parse a hash like `#tasks?p=0,1&age=5&closed=1&q=foo&sort=priority:desc`
 * into a `ParsedHash`. Unknown keys, malformed values, and out-of-range
 * priorities are silently ignored — never throws (legacy parity, the
 * hash is principal input and may be hand-edited).
 *
 * Hashes that don't start with `#tasks` return defaults so other apps
 * (e.g. F-7's `#a/:id` slot) can coexist on the same page later.
 */
export function parseHash(hash: string): ParsedHash {
  const out = defaultHashState();
  if (!hash.startsWith("#tasks")) return out;
  const qIdx = hash.indexOf("?");
  if (qIdx < 0) return out;
  const params = new URLSearchParams(hash.slice(qIdx + 1));

  if (params.has("p")) {
    const raw = params.get("p") ?? "";
    const ps = raw
      .split(",")
      .map((x) => Number.parseInt(x, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 3);
    out.filters.priorities = new Set(ps);
  }
  if (params.has("age")) {
    const n = Number.parseInt(params.get("age") ?? "", 10);
    out.filters.ageMinMinutes = Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (params.has("closed")) {
    out.filters.includeClosed = params.get("closed") === "1";
  }
  if (params.has("q")) {
    out.filters.search = params.get("q") ?? "";
  }
  if (params.has("iter")) {
    // F-16 — single-iteration pin. Treat empty/whitespace as "no
    // filter" (legacy parity with `q=` — empty strings collapse to
    // unset rather than "match nothing"). Iteration ids are ULID-ish
    // (26 chars) but we don't validate shape here; a malformed id
    // simply matches no rows, which is the same outcome as a
    // deleted iteration.
    const raw = params.get("iter") ?? "";
    const trimmed = raw.trim();
    out.filters.iterationId = trimmed.length > 0 ? trimmed : null;
  }
  if (params.has("sort")) {
    const raw = params.get("sort") ?? "";
    const [key, dir] = raw.split(":");
    if (key && (SORT_KEYS as readonly string[]).includes(key)) {
      out.sort.key = key as TaskSortKey;
      out.sort.dir = (dir === "desc" ? "desc" : "asc") as SortDir;
    }
  }
  return out;
}

/**
 * Serialize back into the `#tasks?...` shape. Returns `""` when no
 * filter / sort is active — callers can use this to clear the hash
 * entirely (don't pollute the URL with `#tasks?` for the empty state).
 *
 * Priorities are sorted on the way out so two equivalent state shapes
 * produce the same hash (idempotent canonical form).
 */
export function serializeHash(state: ParsedHash): string {
  const params = new URLSearchParams();
  if (state.filters.priorities.size > 0) {
    params.set("p", [...state.filters.priorities].sort((a, b) => a - b).join(","));
  }
  if (state.filters.ageMinMinutes > 0) {
    params.set("age", String(state.filters.ageMinMinutes));
  }
  if (state.filters.includeClosed) params.set("closed", "1");
  if (state.filters.search.length > 0) params.set("q", state.filters.search);
  // F-16 — iteration pin round-trips as `?iter=<id>`. Omitted when
  // null so the canonical empty-state hash stays empty.
  if (state.filters.iterationId !== null) {
    params.set("iter", state.filters.iterationId);
  }
  if (state.sort.key !== "default") {
    params.set("sort", `${state.sort.key}:${state.sort.dir}`);
  }
  const qs = params.toString();
  return qs ? `#tasks?${qs}` : "";
}
