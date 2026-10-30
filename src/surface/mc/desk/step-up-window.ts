/** How long one step-up code unlocks Desk writes in the browser that typed it. */
export const DESK_STEP_UP_WINDOW_MS = 10 * 60_000;

/** The one route a step-up code unlocks for the window. Control verbs (seal, rotate-K, revoke) never join it. */
export const DESK_STEP_UP_WINDOW_ROUTE = "/api/desk/action";

/** Response header carrying the window's end (epoch ms) when a code opened one. */
export const DESK_UNLOCKED_UNTIL_HEADER = "X-Cortex-Desk-Unlocked-Until";

/** The page closes its own view of the window this much early, so clock skew never sends a stale unlock. */
export const DESK_STEP_UP_CLIENT_MARGIN_MS = 30_000;

/** Desk write unlocks as the Desk sees them; `api/desk-unlock.ts` implements it with an HttpOnly cookie. */
export interface DeskUnlock {
  isOpen(principal: string, token: string | null, now: number): boolean;
  open(principal: string, now: number, secure: boolean): { cookie: string; until: number };
}
