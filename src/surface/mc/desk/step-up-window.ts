/** How long one step-up code unlocks Desk writes in the browser that typed it. */
export const DESK_STEP_UP_WINDOW_MS = 10 * 60_000;

/** The routes one step-up code unlocks for the window. Control verbs (seal, rotate-K, revoke) never join it. */
export const DESK_STEP_UP_WINDOW_ROUTES: ReadonlySet<string> = new Set(["/api/desk/action"]);
