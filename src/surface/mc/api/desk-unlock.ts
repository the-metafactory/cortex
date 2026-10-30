import { randomBytes, timingSafeEqual } from "node:crypto";
import { DESK_STEP_UP_WINDOW_MS } from "../desk/step-up-window";

/** The HttpOnly cookie that carries the unlock, so only the browser that typed the code is unlocked. */
export const DESK_UNLOCK_COOKIE = "cortex_desk_unlock";

const sameToken = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Desk write unlocks: a valid code mints a random token bound to the principal, with a fixed end that use
 * does not extend. Held in memory, so a restart asks for a code again.
 */
export class StepUpWindow {
  private readonly unlocks = new Map<string, { principal: string; until: number }>();

  constructor(private readonly windowMs: number = DESK_STEP_UP_WINDOW_MS) {}

  isOpen(principal: string, token: string | null, now: number): boolean {
    if (!token) return false;
    for (const [t, u] of this.unlocks) {
      if (sameToken(t, token)) return u.principal === principal && u.until > now;
    }
    return false;
  }

  open(principal: string, now: number): string {
    for (const [t, u] of this.unlocks) if (u.until <= now) this.unlocks.delete(t);
    const token = randomBytes(32).toString("base64url");
    this.unlocks.set(token, { principal, until: now + this.windowMs });
    return `${DESK_UNLOCK_COOKIE}=${token}; Path=/api/desk; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.windowMs / 1000)}`;
  }
}

/** The unlock token from the request's cookies, or null. */
export function unlockToken(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DESK_UNLOCK_COOKIE) return rest.join("=") || null;
  }
  return null;
}
