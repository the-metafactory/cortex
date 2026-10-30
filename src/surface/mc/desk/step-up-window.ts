/** How long one step-up code unlocks Desk writes for the principal who typed it. */
export const DESK_STEP_UP_WINDOW_MS = 10 * 60_000;

/** The routes one step-up code unlocks for the window. Control verbs (seal, rotate-K, revoke) never join it. */
export const DESK_STEP_UP_WINDOW_ROUTES: ReadonlySet<string> = new Set(["/api/desk/action"]);

/**
 * Desk write unlocks per principal: a valid code opens a fixed window from the moment it was typed,
 * and use does not extend it. Held in memory, so a restart asks for a code again.
 */
export class StepUpWindow {
  private readonly until = new Map<string, number>();

  constructor(private readonly windowMs: number = DESK_STEP_UP_WINDOW_MS) {}

  isOpen(principal: string, now: number): boolean {
    return (this.until.get(principal) ?? 0) > now;
  }

  open(principal: string, now: number): number {
    const until = now + this.windowMs;
    this.until.set(principal, until);
    return until;
  }
}
