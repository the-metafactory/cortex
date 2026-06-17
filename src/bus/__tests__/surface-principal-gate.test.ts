/**
 * `surface-principal-gate` tests (Bot Packs B-2; `docs/design-bot-packs.md`
 * §5/§7/§8; the pulse#47 lesson).
 *
 * The gate's SECURITY-bearing logic — render to surface, identity-checked await,
 * pass/fail mapping, timeout, fail-closed routing — is fully exercised with a
 * stub renderer + reply source. The live adapter-inbound bridge is the one
 * injected seam (`PrincipalReplySource`); everything else is real here.
 *
 * Covered (task deliverable 7):
 *   - surface gate PASS (rendered prompt captured + injected principal reply)
 *   - wrong-user reply IGNORED (the pulse#47 structural fix)
 *   - timeout → fail
 *   - bus-only task → DenyAll fail-closed
 *   - non-hosted surface → fail-closed
 *   - no configured principal id for the surface → fail-closed
 */

import { describe, expect, test } from "bun:test";
import {
  SurfacePrincipalGate,
  replyToVerdict,
  principalIdForSurface,
  type PrincipalReply,
  type PrincipalReplySource,
  type GatePromptRenderer,
} from "../surface-principal-gate";
import type { TaskSource } from "../../brain/protocol";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface RenderedPrompt {
  agentId: string;
  taskId: string;
  gate: string;
  prompt: string;
  source: TaskSource;
}

function recordingRenderer(): GatePromptRenderer & { rendered: RenderedPrompt[] } {
  const rendered: RenderedPrompt[] = [];
  return {
    rendered,
    render: (r) => void rendered.push(r),
  };
}

/** A reply source that yields a SCRIPTED queue of replies, then null (timeout). */
function scriptedReplies(replies: PrincipalReply[]): PrincipalReplySource {
  let i = 0;
  return {
    awaitReply: async () => {
      const next = replies[i];
      i += 1;
      return next ?? null;
    },
  };
}

function source(over: Partial<TaskSource> = {}): TaskSource {
  return {
    surface: "mattermost",
    channel: "c1",
    thread: "th1",
    user: "u1",
    ...over,
  };
}

const PRINCIPAL_MM = "mm-principal-123";

function makeGate(opts: {
  replies?: PrincipalReply[];
  replySource?: PrincipalReplySource;
  liveSurfaces?: string[];
  mattermostId?: string;
  timeoutMs?: number;
}): { gate: SurfacePrincipalGate; renderer: ReturnType<typeof recordingRenderer> } {
  const renderer = recordingRenderer();
  const gate = new SurfacePrincipalGate({
    principalIdentity: { mattermostId: opts.mattermostId ?? PRINCIPAL_MM },
    liveSurfaces: new Set(opts.liveSurfaces ?? ["mattermost"]),
    renderer,
    replySource: opts.replySource ?? scriptedReplies(opts.replies ?? []),
    timeoutMs: opts.timeoutMs ?? 5_000,
  });
  return { gate, renderer };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("replyToVerdict", () => {
  test("affirmatives map to pass", () => {
    for (const t of ["yes", "Y", " run it ", "approve", "GO", "ok"]) {
      expect(replyToVerdict(t)).toBe("pass");
    }
  });
  test("natural-language affirmatives map to pass (per-word match)", () => {
    for (const t of [
      "yes, run the flow",
      "yes, run it",
      "approve this reset",
      "ok go ahead",
      "Yep — proceed",
      "confirmed, run it now",
    ]) {
      expect(replyToVerdict(t)).toBe("pass");
    }
  });
  test("negatives and unrecognised map to fail (fail-closed)", () => {
    for (const t of ["no", "deny", "stop", "maybe", "", "what?"]) {
      expect(replyToVerdict(t)).toBe("fail");
    }
  });
  test("a negative word anywhere wins, even alongside an affirmative", () => {
    for (const t of [
      "no, don't run it", // contains "run"
      "do not run the flow",
      "cancel the run",
      "hold off, don't approve",
      "yes but not now", // ambiguous → fail-closed
    ]) {
      expect(replyToVerdict(t)).toBe("fail");
    }
  });
  test("contracted negatives fail-closed (apostrophe stripped, not split to a bare 't')", () => {
    // Each contains an affirmative word ("run"/"approve"/"go") — the contraction
    // MUST still deny, or an explicit refusal would fail-OPEN (sage blocker).
    for (const t of [
      "don't run it",
      "don’t approve", // curly apostrophe
      "won't run",
      "can't approve this",
      "cannot run the flow",
      "shouldn't go ahead",
    ]) {
      expect(replyToVerdict(t)).toBe("fail");
    }
  });
  test("refusal verbs deny even with an affirmative word present", () => {
    for (const t of [
      "refuse to run",
      "I decline to approve",
      "veto this run",
      "dismiss — do not run",
    ]) {
      expect(replyToVerdict(t)).toBe("fail");
    }
  });
});

describe("principalIdForSurface", () => {
  test("resolves per-surface, undefined for unknown/unconfigured", () => {
    const id = { mattermostId: "m", discordId: "d" };
    expect(principalIdForSurface(id, "mattermost")).toBe("m");
    expect(principalIdForSurface(id, "discord")).toBe("d");
    expect(principalIdForSurface(id, "slack")).toBeUndefined();
    expect(principalIdForSurface(id, "bus")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gate behaviour
// ---------------------------------------------------------------------------

describe("SurfacePrincipalGate", () => {
  test("PASS — renders the prompt and accepts the configured principal's reply", async () => {
    const { gate, renderer } = makeGate({
      replies: [{ authorId: PRINCIPAL_MM, text: "run it" }],
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run this flow?",
      source: source(),
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.principal).toBe(PRINCIPAL_MM);
    // The prompt was rendered to the surface.
    expect(renderer.rendered.length).toBe(1);
    expect(renderer.rendered[0]?.prompt).toBe("Run this flow?");
    expect(renderer.rendered[0]?.source.surface).toBe("mattermost");
  });

  test("wrong-user reply is IGNORED, then the principal's reply decides (pulse#47)", async () => {
    // A non-principal says "run it" first — it MUST be ignored. Then the
    // principal says "no" — the gate fails (deny), proving the impostor never
    // counted.
    const { gate } = makeGate({
      replies: [
        { authorId: "someone-else", text: "run it" },
        { authorId: PRINCIPAL_MM, text: "no" },
      ],
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source(),
    });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.principal).toBe(PRINCIPAL_MM);
  });

  test("an impostor 'run it' alone never passes — it's ignored to timeout", async () => {
    // Only an impostor replies; the source then yields null (timeout). The gate
    // must NOT pass — the structural pulse#47 fix.
    const { gate } = makeGate({
      replies: [{ authorId: "impostor", text: "run it" }],
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source(),
    });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.notes).toMatch(/no reply from principal/i);
  });

  test("timeout (no reply) fails closed", async () => {
    const { gate } = makeGate({ replies: [] });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source(),
    });
    expect(verdict.verdict).toBe("fail");
  });

  test("a bus-only task never reaches the gate — DenyAll fail-closed", async () => {
    const { gate, renderer } = makeGate({
      replies: [{ authorId: PRINCIPAL_MM, text: "yes" }],
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source({ surface: "bus" }),
    });
    expect(verdict.verdict).toBe("fail");
    // Never rendered — bus tasks don't get a surface gate.
    expect(renderer.rendered.length).toBe(0);
  });

  test("a surface this instance does not host fails closed", async () => {
    const { gate, renderer } = makeGate({
      liveSurfaces: ["mattermost"],
      replies: [{ authorId: PRINCIPAL_MM, text: "yes" }],
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source({ surface: "discord" }), // not hosted
    });
    expect(verdict.verdict).toBe("fail");
    expect(renderer.rendered.length).toBe(0);
  });

  test("no configured principal id for the surface fails closed", async () => {
    const renderer = recordingRenderer();
    const gate = new SurfacePrincipalGate({
      principalIdentity: {}, // no ids configured
      liveSurfaces: new Set(["mattermost"]),
      renderer,
      replySource: scriptedReplies([{ authorId: "anyone", text: "yes" }]),
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source(),
    });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.notes).toMatch(/no configured principal id/i);
    expect(renderer.rendered.length).toBe(0);
  });

  test("a render failure fails closed (principal never saw the prompt)", async () => {
    const gate = new SurfacePrincipalGate({
      principalIdentity: { mattermostId: PRINCIPAL_MM },
      liveSurfaces: new Set(["mattermost"]),
      renderer: {
        render: () => {
          throw new Error("publish blew up");
        },
      },
      replySource: scriptedReplies([{ authorId: PRINCIPAL_MM, text: "yes" }]),
    });
    const verdict = await gate.resolve({
      agentId: "yarrow",
      taskId: "t-1",
      gate: "principal-ack",
      prompt: "Run?",
      source: source(),
    });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.notes).toMatch(/failed to render/i);
  });
});
