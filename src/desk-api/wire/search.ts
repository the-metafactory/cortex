export const DESK_SEARCH_KINDS = ["desk-note", "desk-reminder", "studio-capture", "studio-thread", "desk-item", "balance-task", "balance-project"] as const;
export type DeskSearchKind = (typeof DESK_SEARCH_KINDS)[number];

export interface DeskSearchOpenRoute {
  method: "GET";
  path: string;
}

/** The read route that opens a hit of each kind; the hit's `open.query` names the record on routes that take one. */
export const DESK_SEARCH_OPEN_ROUTES: Record<DeskSearchKind, DeskSearchOpenRoute> = {
  "desk-note": { method: "GET", path: "/api/desk" },
  "desk-reminder": { method: "GET", path: "/api/desk" },
  "desk-item": { method: "GET", path: "/api/desk" },
  "studio-capture": { method: "GET", path: "/api/desk/studio" },
  "studio-thread": { method: "GET", path: "/api/desk/studio" },
  "balance-task": { method: "GET", path: "/api/desk/balance-surfaces/task" },
  "balance-project": { method: "GET", path: "/api/desk/balance-surfaces/task" },
};

export interface DeskSearchHit {
  kind: DeskSearchKind;
  id: string;
  title: string;
  snippet: string;
  at: string | null;
  open: DeskSearchOpenRoute & { query: Record<string, string> };
}

export interface DeskSearchResponse {
  status: "ok" | "empty";
  hits: DeskSearchHit[];
  next: string | null;
  unavailableKinds: DeskSearchKind[];
}
