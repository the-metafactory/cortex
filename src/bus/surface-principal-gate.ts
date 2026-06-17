/**
 * `surface-principal-gate.ts` — the Bot Packs B-2 surface gate
 * (`docs/design-bot-packs.md` §5, §7, §8; pulse#47 lesson).
 *
 * This is the bridge that finally makes `ask_principal` REAL. B-1 shipped only
 * {@link DenyAllPrincipalGate} (fail-closed) because there was no live surface to
 * render a gate to and no host-side principal check. B-2 adds the surface gate:
 * when a brain task's `response_routing` names a LIVE surface the cortex instance
 * hosts, this gate:
 *
 *   1. RENDERS the gate prompt to the task's surface/thread via the
 *      dispatch-sink/post path (a `dispatch.task.post` envelope — the SAME path
 *      a brain `post` rides; §5 property 1: the brain cannot choose the channel,
 *      the host-supplied routing does);
 *   2. AWAITS a reply from the CONFIGURED PRINCIPAL — resolved by IDENTITY
 *      (platform user id: `principal.mattermostId` / `discordId` / `slackId`),
 *      NEVER by message-text inference. This is the pulse#47 lesson made
 *      structural: "any channel member could say 'run it'" is impossible here
 *      because a reply from anyone but the configured principal id is IGNORED;
 *   3. MAPS the principal's reply to the gate vocabulary (`pass` / `fail`) and
 *      returns the HOST-RESOLVED principal id on the verdict (so the brain
 *      receives an authoritative principal, never a chat-inferred one);
 *   4. TIMES OUT to `fail` — a gate with no principal reply within the window is
 *      denied, fail-closed.
 *
 * ## What is host-real vs. what is the injected seam
 *
 * The IDENTITY CHECK, the pass/fail mapping, the timeout, the host-resolved
 * principal, and the prompt RENDER are all fully implemented here. The one
 * deliberately-injected seam is {@link PrincipalReplySource} — how a live
 * principal reply in a thread is OBSERVED. Wiring that to the live adapter
 * inbound (a DM/@mention correlated back to the open gate) is the deepest part
 * of the adapter integration; isolating it behind a typed source keeps this
 * gate's decision logic — the security-bearing part — fully tested with a stub,
 * and lets the live inbound bridge land without touching the decision logic.
 *
 * ## Fail-closed routing
 *
 * A BUS-ONLY task (no live surface in `response_routing`, or the named surface
 * is not one this instance hosts) NEVER reaches the await — it returns
 * {@link DenyAllPrincipalGate}'s `fail` verbatim. Only a task whose routing
 * names a live, hosted surface AND a configured principal identity gets a real
 * gate. Everything else is denied. (§8: policy stays in cortex; the brain's own
 * claim is never trusted.)
 */

import type { TaskSource } from "../brain/protocol";
import {
  DenyAllPrincipalGate,
  type PrincipalGate,
} from "./brain-consumer";
import type { GateVerdictValue } from "../brain/protocol";
import type { MyelinRuntime } from "./myelin/runtime";
import type { SystemEventSource } from "./system-events";
import { createDispatchTaskPostEvent } from "./dispatch-events";

// ---------------------------------------------------------------------------
// Principal identity + reply seams
// ---------------------------------------------------------------------------

/**
 * The platform user ids of the configured principal, per surface. Resolved from
 * `principal.mattermostId` / `discordId` / `slackId` at boot (see
 * `PrincipalConfig`). A surface with NO configured id cannot run a real gate —
 * the gate cannot verify identity, so it fails closed for that surface.
 */
export interface PrincipalIdentity {
  mattermostId?: string;
  discordId?: string;
  slackId?: string;
}

/**
 * Resolve the configured principal's platform user id FOR A GIVEN SURFACE. The
 * gate compares an inbound reply's author id against THIS — the structural
 * pulse#47 fix. Returns `undefined` when the principal has no id on that surface
 * (gate fails closed — identity unverifiable).
 */
export function principalIdForSurface(
  identity: PrincipalIdentity,
  surface: string,
): string | undefined {
  switch (surface) {
    case "mattermost":
      return identity.mattermostId;
    case "discord":
      return identity.discordId;
    case "slack":
      return identity.slackId;
    default:
      return undefined;
  }
}

/** A single inbound reply observed in a gate's thread. */
export interface PrincipalReply {
  /** The platform user id of the replier — the IDENTITY the gate checks. */
  authorId: string;
  /** The reply text — used ONLY for pass/fail wording, NEVER for identity. */
  text: string;
}

/**
 * How the gate observes a principal reply in the task's thread. The live
 * implementation correlates an inbound adapter message (DM/@mention in the
 * gate's channel+thread) back to the open gate; the test stub resolves a
 * scripted reply.
 *
 * Contract: `awaitReply` resolves with the NEXT reply in the named
 * channel/thread (from ANY author — the gate filters by identity), or `null` on
 * timeout / no live source. The source does NOT itself filter by author — that
 * is the gate's job, so the gate's identity check is the single source of truth
 * (a source that pre-filtered could silently let a mis-configured identity
 * through).
 */
export interface PrincipalReplySource {
  awaitReply(opts: {
    surface: string;
    channel: string;
    thread: string;
    timeoutMs: number;
  }): Promise<PrincipalReply | null>;
}

/**
 * How the gate RENDERS its prompt to the surface. The live implementation
 * publishes a `dispatch.task.post` envelope (the same path a brain `post`
 * rides), letting the dispatch sink deliver it to the thread. Injected so the
 * gate doesn't own the publish path + tests assert the rendered prompt.
 */
export interface GatePromptRenderer {
  render(opts: {
    agentId: string;
    taskId: string;
    gate: string;
    prompt: string;
    source: TaskSource;
  }): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Pass/fail mapping
// ---------------------------------------------------------------------------

/**
 * Affirmative / negative TOKEN allow-lists. Deliberately explicit word lists,
 * not fuzzy NLP — a gate verdict is a security decision. The text is matched
 * ONLY after the identity check passes, so it never carries identity weight
 * (pulse#47).
 *
 * Matched per-WORD (not whole-string) so a natural reply like
 * "yes, run the flow" or "approve this reset" passes, while staying fail-closed:
 * a negative word ANYWHERE wins, so "no, don't run it" — which contains the
 * affirmative "run" — still fails.
 */
const AFFIRMATIVE = new Set([
  "yes", "y", "yeah", "yep", "yup",
  "approve", "approved", "approving",
  "run", "go", "ok", "okay",
  "pass", "confirm", "confirmed", "ack", "proceed", "affirmative",
]);
const NEGATIVE = new Set([
  "no", "n", "nope", "nah", "not", "never",
  "deny", "denied", "reject", "rejected", "cancel", "cancelled", "canceled",
  "stop", "abort", "aborted", "halt", "hold", "wait",
  // Refusal verbs — a reply can negate WITHOUT "no"/"not" ("refuse to run").
  "refuse", "refused", "refusing", "decline", "declined", "declining",
  "veto", "vetoed", "nay", "negative", "against", "dismiss", "dismissed",
  // Contraction stems — apostrophes are stripped WITHIN words before tokenizing
  // (don't → dont), so the negation isn't lost as a bare "t".
  "dont", "doesnt", "didnt", "wont", "cant", "cannot",
  "shouldnt", "wouldnt", "couldnt", "isnt", "arent", "wasnt", "werent", "aint",
]);

/**
 * Map a principal's reply text to a gate verdict. FAIL-CLOSED: `pass` requires a
 * recognised AFFIRMATIVE word and NO recognised NEGATIVE word. NEGATIVE is
 * checked first, so a recognised negative in the SAME reply wins over a
 * co-occurring affirmative ("no, run it" / "refuse to run" → fail). An
 * unrecognised reply ("maybe", a question) also fails — absence of a clear
 * affirmative IS the deny. Never parses identity.
 *
 * Apostrophes are stripped WITHIN words FIRST ("don't" → "dont", not "don"+"t")
 * before non-alphanumerics become separators, so a contracted negative keeps
 * its negation (else "don't run it" would fail-OPEN on the affirmative "run").
 *
 * LIMITATION (not exhaustive NLP): both lists are explicit, so an UNLISTED
 * refusal phrasing that also contains an affirmative word would pass. The
 * principal is already IDENTITY-verified before this runs (pulse#47), so this
 * mapping only guards against misreading the PRINCIPAL'S OWN wording, not an
 * adversary — keep the deny-list current; a bare "yes"/"no" is unambiguous.
 */
export function replyToVerdict(text: string): GateVerdictValue {
  const words = text
    .toLowerCase()
    .replace(/['‘’ʼ`´]/g, "") // strip apostrophes within words: don't → dont
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.some((w) => NEGATIVE.has(w))) return "fail"; // recognised negative wins
  if (words.some((w) => AFFIRMATIVE.has(w))) return "pass";
  return "fail";
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Construction options for {@link SurfacePrincipalGate}. */
export interface SurfacePrincipalGateOpts {
  /** The configured principal's per-surface platform ids. */
  principalIdentity: PrincipalIdentity;
  /** Which surfaces this cortex instance actually hosts a live adapter for. */
  liveSurfaces: ReadonlySet<string>;
  /** Renders the gate prompt to the surface (the dispatch.task.post path). */
  renderer: GatePromptRenderer;
  /** Observes the principal's reply in the thread. */
  replySource: PrincipalReplySource;
  /** Gate timeout (ms) — no principal reply by then → fail. Defaults to 300_000 (5 min). */
  timeoutMs?: number;
}

/**
 * The B-2 surface gate. Implements {@link PrincipalGate} so it drops straight
 * into the BrainConsumer's `principalGate` seam, replacing
 * {@link DenyAllPrincipalGate} for tasks routed to a live surface.
 */
export class SurfacePrincipalGate implements PrincipalGate {
  private readonly principalIdentity: PrincipalIdentity;
  private readonly liveSurfaces: ReadonlySet<string>;
  private readonly renderer: GatePromptRenderer;
  private readonly replySource: PrincipalReplySource;
  private readonly timeoutMs: number;
  /** Fallback for bus-only / non-hosted-surface tasks — fail-closed. */
  private readonly denyAll = new DenyAllPrincipalGate();

  constructor(opts: SurfacePrincipalGateOpts) {
    this.principalIdentity = opts.principalIdentity;
    this.liveSurfaces = opts.liveSurfaces;
    this.renderer = opts.renderer;
    this.replySource = opts.replySource;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
  }

  async resolve(input: {
    agentId: string;
    taskId: string;
    gate: string;
    prompt: string;
    source: TaskSource;
  }): Promise<{ verdict: GateVerdictValue; principal: string; notes?: string }> {
    const { surface, channel, thread } = input.source;

    // Fail-closed routing: a bus-only task, or a task routed to a surface this
    // instance does not host, never gets a real gate. DenyAll handles it.
    if (surface === "bus" || !this.liveSurfaces.has(surface)) {
      return this.denyAll.resolve();
    }

    // Resolve the configured principal's id for THIS surface. No configured id
    // ⇒ identity unverifiable ⇒ fail closed (we will not run a gate we cannot
    // attribute to the principal).
    const principalId = principalIdForSurface(this.principalIdentity, surface);
    if (principalId === undefined || principalId.length === 0) {
      return {
        verdict: "fail",
        principal: "",
        notes: `no configured principal id for surface "${surface}" — cannot verify identity`,
      };
    }

    // A channel/thread is required to both render and observe the reply. A task
    // with a live surface but no channel can't host a thread gate — fail closed.
    if (channel.length === 0) {
      return {
        verdict: "fail",
        principal: "",
        notes: `surface "${surface}" task has no channel to render the gate into`,
      };
    }

    // 1. Render the prompt to the surface/thread (host-supplied routing — the
    //    brain cannot choose the channel).
    try {
      await this.renderer.render({
        agentId: input.agentId,
        taskId: input.taskId,
        gate: input.gate,
        prompt: input.prompt,
        source: input.source,
      });
    } catch (err) {
      // A render failure means the principal never saw the prompt — fail closed.
      return {
        verdict: "fail",
        principal: "",
        notes: `failed to render gate prompt to surface: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 2. Await a reply, filtering by IDENTITY (the pulse#47 fix). A reply from
    //    anyone but the configured principal id is IGNORED — we keep waiting
    //    until the deadline. The text is used ONLY for the pass/fail mapping,
    //    never for identity.
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let reply: PrincipalReply | null;
      try {
        reply = await this.replySource.awaitReply({
          surface,
          channel,
          thread,
          timeoutMs: remaining,
        });
      } catch (err) {
        return {
          verdict: "fail",
          principal: "",
          notes: `reply source error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (reply === null) break; // source timed out / no live source
      if (reply.authorId !== principalId) {
        // NOT the principal — ignore and keep waiting (someone else in the
        // thread said "run it"; that is exactly the pulse#47 case we refuse).
        continue;
      }
      // 3. The configured principal replied — map text → verdict, return the
      //    HOST-RESOLVED principal id (authoritative, not chat-inferred).
      return {
        verdict: replyToVerdict(reply.text),
        principal: principalId,
        notes: `principal ${principalId} on ${surface} replied: ${truncate(reply.text)}`,
      };
    }

    // 4. Timeout — no principal reply within the window. Fail closed.
    return {
      verdict: "fail",
      principal: "",
      notes: `no reply from principal ${principalId} on ${surface} within ${this.timeoutMs}ms`,
    };
  }
}

/** Trim a reply to a bounded length for the verdict notes. */
function truncate(s: string, max = 120): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Default dispatch-post renderer
// ---------------------------------------------------------------------------

/**
 * The production {@link GatePromptRenderer}: render the gate prompt by
 * publishing a `dispatch.task.post` envelope (the SAME path a brain `post`
 * rides), so the dispatch sink delivers it to the task's surface/thread. The
 * routing comes from the task source — the brain never chooses the channel
 * (§5 property 1).
 *
 * Best-effort publish: a publish failure rejects so the gate's render-failure
 * branch fails the gate closed (the principal never saw the prompt).
 */
export function makeDispatchPostRenderer(opts: {
  runtime: MyelinRuntime;
  source: SystemEventSource;
}): GatePromptRenderer {
  return {
    async render(r): Promise<void> {
      await opts.runtime.publish(
        createDispatchTaskPostEvent({
          source: opts.source,
          taskId: crypto.randomUUID(),
          agentId: r.agentId,
          correlationId: r.taskId,
          text: r.prompt,
          taskSource: {
            surface: r.source.surface,
            channel: r.source.channel,
            thread: r.source.thread,
            user: r.source.user,
            // cortex#1038 — carry the adapter instance so the gate PROMPT
            // (ask_principal) reaches the originating adapter via the chat
            // dispatch-sink, same as the brain's own posts.
            ...(r.source.adapter_instance !== undefined && {
              adapter_instance: r.source.adapter_instance,
            }),
          },
        }),
      );
    },
  };
}
