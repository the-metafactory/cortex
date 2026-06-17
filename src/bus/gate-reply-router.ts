/**
 * `gate-reply-router.ts` — the adapter inbound reply-bridge (Bot Packs B-3;
 * `docs/design-bot-packs.md` §5/§7/§8; cortex#1021 W-1).
 *
 * The LIVE implementation of the {@link PrincipalReplySource} seam that
 * `surface-principal-gate.ts` deliberately left injected. An open gate
 * registers interest in `(surface, channel, thread)`; the adapter inbound
 * flow offers each reply to the router BEFORE chat dispatch. A message
 * landing in a thread with a waiting gate is delivered to that gate and
 * CONSUMED (it does not also become a chat dispatch — a principal's
 * "run it" must resolve the gate, not spawn a second task).
 *
 * ## Layering (sage #1037 round 2)
 *
 * This bus-side module is deliberately blind to adapter DTOs: it takes a
 * bus-neutral {@link GateReplyOffer}, and the SURFACE layer (the adapter
 * inbound handler in `cortex.ts`) owns the `InboundMessage → offer` mapping.
 * The bus stays dumb about platform message shapes.
 *
 * ## What this router does NOT do (load-bearing)
 *
 * - **No identity filtering.** Per the `PrincipalReplySource` contract, the
 *   router delivers replies from ANY author; the gate's identity check
 *   (`authorId === principalIdForSurface(...)`) is the single source of
 *   truth (pulse#47). A router that pre-filtered could silently let a
 *   mis-configured identity through.
 * - **No text inference.** The router matches on routing keys only —
 *   surface, channel id, thread id. Message text is passed through opaque.
 *
 * ## Consumption semantics
 *
 * `offer` returns `true` (consume — skip chat dispatch) when a gate is
 * awaiting on that exact `(surface, channel, thread)` key, OR when the key
 * is within the post-delivery GRACE window below. While a gate is open its
 * thread is modal: replies there are gate replies, principal or not (the
 * gate ignores non-principal authors and re-awaits).
 *
 * ## The re-await gap, closed (sage #1037 round 2)
 *
 * Between the router delivering a (possibly non-principal) reply and the
 * gate's NEXT `awaitReply` there is a microtask-sized window with no waiter
 * registered. A reply arriving exactly there must NOT fall through to chat
 * dispatch — that would be precisely the duplicate-task path this router
 * exists to prevent. So a delivery marks its key "hot" for
 * {@link REAWAIT_GRACE_MS}: offers on a hot key with no waiter are BUFFERED
 * (and consumed), and the next `awaitReply` on that key drains the buffer
 * first. The trade-off is explicit: if the gate never re-awaits (verdict
 * already reached), a reply buffered inside the grace window is dropped
 * with the buffer's expiry — a bounded, documented suppression in a thread
 * that just closed its gate, versus an unbounded duplicate-task hazard.
 */

import type {
  PrincipalReply,
  PrincipalReplySource,
} from "./surface-principal-gate";

/**
 * A bus-neutral reply offer. The surface layer maps its platform message
 * shape into this — the router never sees adapter DTOs.
 */
export interface GateReplyOffer {
  /** Surface name as the gate's task source spells it ("mattermost", …). */
  surface: string;
  /** Platform-native channel id. */
  channel: string;
  /** Platform-native thread id; absent/empty when the message is unthreaded. */
  thread?: string;
  /** Platform-native author id — checked by the GATE, never here. */
  authorId: string;
  /** Reply text — opaque to the router. */
  text: string;
}

/** One gate-side `awaitReply` waiting for the next reply on its key. */
interface PendingWaiter {
  resolve: (reply: PrincipalReply | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Buffered replies for a key inside its re-await grace window. */
interface GraceBuffer {
  expiresAt: number;
  replies: PrincipalReply[];
  /** Self-eviction timer — a long-lived process gating across many unique
   *  threads must not retain expired entries (sage #1037 round 3). */
  evictTimer: ReturnType<typeof setTimeout>;
}

/**
 * How long after a delivery a key stays "hot" (replies buffered instead of
 * falling through to chat dispatch). The gap it covers is microtask-sized;
 * 500 ms is comfortably past any event-loop scheduling jitter while keeping
 * the post-verdict suppression window (see module doc) tightly bounded.
 */
const REAWAIT_GRACE_MS = 500;

/**
 * Composite keys are joined with U+001F (the ASCII unit separator). A
 * crafted id CONTAINING U+001F could otherwise collide two distinct route
 * triples — and a collision is NOT bounded by the gate's identity check
 * (a principal-authored reply in thread A would pass the identity check of
 * a colliding gate in thread B). So the invariant is ENFORCED, not assumed:
 * {@link hasSeparator} callers refuse any surface/channel/thread containing
 * the separator — the gate side fails closed (null → timeout-fail), the
 * offer side passes the message through to ordinary chat dispatch.
 */
const KEY_SEPARATOR = "\u001f";

function hasSeparator(...parts: (string | undefined)[]): boolean {
  return parts.some((part) => part?.includes(KEY_SEPARATOR));
}

function routeKey(surface: string, channel: string, thread: string): string {
  return `${surface}${KEY_SEPARATOR}${channel}${KEY_SEPARATOR}${thread}`;
}

/**
 * The live {@link PrincipalReplySource}: a registry of open-gate waiters keyed
 * by `(surface, channel, thread)`, fed by the surface adapters' inbound flow.
 *
 * Constructed ONCE at cortex boot (before brain consumers — gates capture it
 * by reference) and wired into each surface adapter's inbound handler as it
 * starts. A gate only consults the router at `ask_principal` time, so the
 * agents-before-adapters boot order is safe.
 */
export class GateReplyRouter implements PrincipalReplySource {
  private readonly waiters = new Map<string, PendingWaiter[]>();
  private readonly grace = new Map<string, GraceBuffer>();
  private stopped = false;

  /**
   * Gate side — await the next reply in the thread. Resolves with the reply
   * (any author — the gate filters identity) or `null` on timeout/shutdown.
   * Drains the key's grace buffer first (see module doc).
   */
  awaitReply(opts: {
    surface: string;
    channel: string;
    thread: string;
    timeoutMs: number;
  }): Promise<PrincipalReply | null> {
    // Fail fast: a stopped router (shutdown drain) or an unroutable key never
    // waits — the gate maps `null` to its fail-closed timeout branch.
    if (
      this.stopped ||
      opts.channel.length === 0 ||
      opts.thread.length === 0 ||
      opts.timeoutMs <= 0 ||
      hasSeparator(opts.surface, opts.channel, opts.thread)
    ) {
      return Promise.resolve(null);
    }
    const key = routeKey(opts.surface, opts.channel, opts.thread);

    // A reply that arrived inside the re-await gap is waiting here.
    const buffered = this.takeBuffered(key);
    if (buffered !== undefined) {
      this.markHot(key); // delivery — the gate may loop again
      return Promise.resolve(buffered);
    }

    return new Promise<PrincipalReply | null>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.remove(key, waiter);
          resolve(null);
        }, opts.timeoutMs),
      };
      const queue = this.waiters.get(key);
      if (queue === undefined) {
        this.waiters.set(key, [waiter]);
      } else {
        queue.push(waiter);
      }
    });
  }

  /**
   * Surface side — offer a reply mapped from an inbound platform message.
   * Returns `true` when consumed (delivered to a waiting gate, or buffered
   * inside the key's grace window — caller skips chat dispatch), `false`
   * otherwise (caller dispatches as usual). FIFO across multiple gates on
   * one key.
   */
  offer(reply: GateReplyOffer): boolean {
    if (this.stopped) return false;
    // A gate prompt always lives in a thread (the gate fail-closes on an
    // empty thread before awaiting), so an unthreaded message can never be
    // a gate reply.
    if (reply.thread === undefined || reply.thread.length === 0) return false;
    // Separator-bearing ids cannot form an unambiguous key — never a gate
    // reply (see KEY_SEPARATOR doc); ordinary chat dispatch handles it.
    if (hasSeparator(reply.surface, reply.channel, reply.thread)) return false;
    const key = routeKey(reply.surface, reply.channel, reply.thread);
    const principalReply: PrincipalReply = {
      authorId: reply.authorId,
      text: reply.text,
    };

    const queue = this.waiters.get(key);
    const waiter = queue?.shift();
    if (waiter !== undefined) {
      if (queue?.length === 0) this.waiters.delete(key);
      clearTimeout(waiter.timer);
      this.markHot(key);
      waiter.resolve(principalReply);
      return true;
    }

    // No waiter — consume into the grace buffer if the key is hot (the
    // re-await gap), otherwise pass through to chat dispatch.
    const buffer = this.grace.get(key);
    if (buffer !== undefined && buffer.expiresAt > Date.now()) {
      buffer.replies.push(principalReply);
      return true;
    }
    return false;
  }

  /** Deregister a waiter (timeout path); empty queues are dropped. */
  private remove(key: string, waiter: PendingWaiter): void {
    const queue = this.waiters.get(key);
    if (queue === undefined) return;
    const i = queue.indexOf(waiter);
    if (i !== -1) queue.splice(i, 1);
    if (queue.length === 0) this.waiters.delete(key);
  }

  /** Open (or refresh) the key's grace window after a delivery. */
  private markHot(key: string): void {
    const expiresAt = Date.now() + REAWAIT_GRACE_MS;
    const existing = this.grace.get(key);
    if (existing !== undefined) {
      existing.expiresAt = expiresAt;
      clearTimeout(existing.evictTimer);
      existing.evictTimer = this.scheduleEvict(key);
    } else {
      this.grace.set(key, {
        expiresAt,
        replies: [],
        evictTimer: this.scheduleEvict(key),
      });
    }
  }

  /** Drop the key's grace entry at expiry — no unbounded retention. */
  private scheduleEvict(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const buffer = this.grace.get(key);
      if (buffer !== undefined && buffer.expiresAt <= Date.now()) {
        this.grace.delete(key);
      }
    }, REAWAIT_GRACE_MS + 50);
  }

  /** Shift the oldest in-grace buffered reply for the key, if any. */
  private takeBuffered(key: string): PrincipalReply | undefined {
    const buffer = this.grace.get(key);
    if (buffer === undefined) return undefined;
    if (buffer.expiresAt <= Date.now()) {
      clearTimeout(buffer.evictTimer);
      this.grace.delete(key);
      return undefined;
    }
    return buffer.replies.shift();
  }

  /**
   * Shutdown — resolve every pending waiter with `null` (the gate's
   * fail-closed timeout branch) so an open gate cannot hold the drain
   * hostage past its deadline. Subsequent `awaitReply` calls resolve `null`
   * immediately; subsequent offers are ignored.
   */
  stop(): void {
    this.stopped = true;
    for (const queue of this.waiters.values()) {
      for (const waiter of queue) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      }
    }
    this.waiters.clear();
    for (const buffer of this.grace.values()) clearTimeout(buffer.evictTimer);
    this.grace.clear();
  }

  /** Open-waiter count — drain/test visibility only. */
  get pendingCount(): number {
    let n = 0;
    for (const queue of this.waiters.values()) n += queue.length;
    return n;
  }
}
