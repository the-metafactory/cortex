import type { Database } from "bun:sqlite";
import { DESK_SEARCH_KINDS, type DeskSearchKind } from "../../../desk-api/wire/search";
import { failResponse } from "../desk/act-result";
import { currentDayItems, type DeskRuntime, type DeskVigilSource } from "../desk/compose";
import { isSearchKind, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET, SEARCH_MAX_QUERY, searchDesk, type SearchRequest } from "../desk/search";

export const DESK_SEARCH_PATH = "/api/desk/search";

const noStore = { "Cache-Control": "no-store" };

const invalid = (field: string, error: string): Response => failResponse(400, error, { code: "act.invalid", params: { field } });

function integer(raw: string | null, fallback: number, max: number, min: number): number | null {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value < min || value > max ? null : value;
}

function kindsOf(raw: string | null): DeskSearchKind[] | null {
  if (raw === null || raw === "") return [...DESK_SEARCH_KINDS];
  const names = raw.split(",").map((name) => name.trim());
  return names.every(isSearchKind) ? [...new Set(names)] : null;
}

function parseSearchRequest(url: URL): SearchRequest | Response {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q === "" || q.length > SEARCH_MAX_QUERY) return invalid("q", `Search needs a query of 1 to ${SEARCH_MAX_QUERY} characters.`);
  const limit = integer(url.searchParams.get("limit"), SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT, 1);
  if (limit === null) return invalid("limit", `The limit is a whole number from 1 to ${SEARCH_MAX_LIMIT}.`);
  const offset = integer(url.searchParams.get("offset"), 0, SEARCH_MAX_OFFSET, 0);
  if (offset === null) return invalid("offset", `The offset is a whole number from 0 to ${SEARCH_MAX_OFFSET}.`);
  const kinds = kindsOf(url.searchParams.get("kinds"));
  if (kinds === null) return invalid("kinds", `The kinds are a comma-separated list of: ${DESK_SEARCH_KINDS.join(", ")}.`);
  return { q, kinds, limit, offset };
}

export async function handleDeskSearch(req: Request, db: Database, runtime: DeskRuntime | undefined, vigil: DeskVigilSource | undefined, now = Date.now()): Promise<Response> {
  if (req.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405, headers: { ...noStore, Allow: "GET" } });
  const desk = runtime?.options;
  if (!runtime || !desk?.enabled) return failResponse(503, "The Desk is not enabled.");
  const request = parseSearchRequest(new URL(req.url));
  if (request instanceof Response) return request;
  return Response.json(await searchDesk({ db, desk, deskItems: () => currentDayItems(db, runtime, vigil, now), now }, request), { headers: noStore });
}
