/**
 * `cortex-brain/v1` protocol codec tests (Bot Packs B-1).
 *
 * Covers: codec round-trips for every event + effect type, unknown-type
 * tolerance (drop-and-log, never throw), unknown-field tolerance (strip),
 * the 256 KiB inline-attachment cap, and chunked/partial-line JSONL decoding.
 */

import { describe, expect, test } from "bun:test";
import {
  encodeBrainEvent,
  parseBrainEvent,
  encodeBrainEffect,
  parseBrainEffect,
  JsonlDecoder,
  MAX_ATTACHMENT_B64_BYTES,
  BRAIN_PROTOCOL_VERSION,
  BRAIN_PROTOCOL_ID,
  type BrainEvent,
  type BrainEffect,
} from "../protocol";

// ---------------------------------------------------------------------------
// Fixtures — one of every event + effect
// ---------------------------------------------------------------------------

const events: BrainEvent[] = [
  {
    v: 1,
    type: "task",
    task_id: "t1",
    capability: "soc.compose.flow",
    payload: { scenario: "phish" },
    source: { surface: "mattermost", channel: "c1", thread: "th1", user: "u1" },
    persona: "You are Yarrow.",
  },
  {
    v: 1,
    type: "message",
    task_id: "t1",
    text: "follow up",
    user: "u1",
  },
  {
    v: 1,
    type: "gate_verdict",
    task_id: "t1",
    gate: "principal-ack",
    verdict: "pass",
    notes: "run it",
    principal: "andreas",
  },
  { v: 1, type: "cancel", task_id: "t1" },
  { v: 1, type: "shutdown", deadline_ms: 5000 },
  {
    v: 1,
    type: "thread_created",
    task_id: "t1",
    thread_id: "thread-abc123",
  },
  {
    v: 1,
    type: "effect_rejected",
    task_id: "t1",
    effect: "dispatch",
    reason: { kind: "wont_do", detail: "capability outside manifest" },
  },
  {
    v: 1,
    type: "hello",
    persona: "You are Yarrow.",
    agent: "yarrow",
    protocol: "cortex-brain/v1",
  },
];

const effects: BrainEffect[] = [
  {
    v: 1,
    type: "post",
    task_id: "t1",
    text: "here is the flow",
    attachment: { filename: "flow.png", b64: "aGVsbG8=" },
  },
  {
    v: 1,
    type: "post",
    task_id: "t1",
    text: "big one",
    attachment: { filename: "flow.png", path: "/scratch/flow.png" },
  },
  { v: 1, type: "post", task_id: "t1", text: "no attachment" },
  {
    v: 1,
    type: "ask_principal",
    task_id: "t1",
    gate: "principal-ack",
    prompt: "Run this flow?",
  },
  {
    v: 1,
    type: "dispatch",
    task_id: "t1",
    capability: "soc.triage.email",
    payload: { id: 7 },
    sovereignty: { model_class: "local-only" },
  },
  {
    v: 1,
    type: "dispatch",
    task_id: "t1",
    capability: "soc.triage.email",
    payload: {},
  },
  {
    v: 1,
    type: "create_private_thread",
    task_id: "t1",
    name: "welcome newcomer",
    members: "source",
  },
  {
    v: 1,
    type: "create_private_thread",
    task_id: "t1",
    name: "quest party",
    members: ["u1", "u2"],
  },
  { v: 1, type: "result", task_id: "t1", status: "complete", summary: "done" },
  { v: 1, type: "result", task_id: "t1", status: "complete" },
  {
    v: 1,
    type: "result",
    task_id: "t1",
    status: "failed",
    reason: { kind: "not_now", detail: "substrate busy" },
  },
  { v: 1, type: "log", level: "info", text: "composing" },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("protocol constants", () => {
  test("version + id are pinned", () => {
    expect(BRAIN_PROTOCOL_VERSION).toBe(1);
    expect(BRAIN_PROTOCOL_ID).toBe("cortex-brain/v1");
    expect(MAX_ATTACHMENT_B64_BYTES).toBe(256 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

describe("event codec round-trips", () => {
  for (const ev of events) {
    test(`event ${ev.type} round-trips`, () => {
      const line = encodeBrainEvent(ev);
      expect(line).not.toContain("\n");
      const parsed = parseBrainEvent(line);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind === "ok") {
        expect(parsed.event).toEqual(ev);
      }
    });

    test(`event ${ev.type} carries v:1`, () => {
      const obj = JSON.parse(encodeBrainEvent(ev));
      expect(obj.v).toBe(1);
      expect(obj.type).toBe(ev.type);
    });
  }
});

describe("effect codec round-trips", () => {
  for (const [i, ef] of effects.entries()) {
    test(`effect ${ef.type} #${i} round-trips`, () => {
      const line = encodeBrainEffect(ef);
      expect(line).not.toContain("\n");
      const parsed = parseBrainEffect(line);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind === "ok") {
        expect(parsed.effect).toEqual(ef);
      }
    });

    test(`effect ${ef.type} #${i} carries v:1`, () => {
      const obj = JSON.parse(encodeBrainEffect(ef));
      expect(obj.v).toBe(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown-type tolerance
// ---------------------------------------------------------------------------

describe("unknown-type tolerance (forward-compat §5)", () => {
  test("unknown effect type → {kind:unknown}, never throws", () => {
    const line = JSON.stringify({ v: 1, type: "stream_partial", task_id: "t1", chunk: "x" });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("unknown");
    if (parsed.kind === "unknown") {
      expect(parsed.raw.type).toBe("stream_partial");
    }
  });

  test("unknown event type → {kind:unknown}, never throws", () => {
    const line = JSON.stringify({ v: 1, type: "pause", task_id: "t1" });
    const parsed = parseBrainEvent(line);
    expect(parsed.kind).toBe("unknown");
  });

  test("malformed JSON → {kind:invalid}, never throws", () => {
    const parsed = parseBrainEffect("{ not json");
    expect(parsed.kind).toBe("invalid");
  });

  test("non-object JSON → invalid", () => {
    expect(parseBrainEffect("42").kind).toBe("invalid");
    expect(parseBrainEffect('"a string"').kind).toBe("invalid");
    expect(parseBrainEffect("[1,2,3]").kind).toBe("invalid");
    expect(parseBrainEffect("null").kind).toBe("invalid");
  });

  test("missing type field → invalid", () => {
    expect(parseBrainEffect(JSON.stringify({ v: 1 })).kind).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Unknown-field tolerance (strip on known types)
// ---------------------------------------------------------------------------

describe("unknown-field tolerance", () => {
  test("extra fields on a known effect are stripped, parse succeeds", () => {
    const line = JSON.stringify({
      v: 1,
      type: "log",
      level: "info",
      text: "hi",
      future_field: "ignore me",
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).not.toHaveProperty("future_field");
    }
  });

  test("extra fields on a known event are stripped", () => {
    const line = JSON.stringify({
      v: 1,
      type: "cancel",
      task_id: "t1",
      extra: true,
    });
    const parsed = parseBrainEvent(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.event).not.toHaveProperty("extra");
    }
  });

  test("emission strips stray keys before serialization", () => {
    const dirty = {
      v: 1,
      type: "log",
      level: "info",
      text: "hi",
      leaked_secret: "DO NOT EMIT",
    } as unknown as BrainEffect;
    const line = encodeBrainEffect(dirty);
    expect(line).not.toContain("leaked_secret");
  });
});

// ---------------------------------------------------------------------------
// 256 KiB attachment cap
// ---------------------------------------------------------------------------

describe("256 KiB inline-attachment cap", () => {
  test("b64 at the limit parses", () => {
    const b64 = "a".repeat(MAX_ATTACHMENT_B64_BYTES);
    const line = JSON.stringify({
      v: 1,
      type: "post",
      task_id: "t1",
      text: "ok",
      attachment: { filename: "f.png", b64 },
    });
    expect(parseBrainEffect(line).kind).toBe("ok");
  });

  test("b64 one byte over the limit is rejected as invalid", () => {
    const b64 = "a".repeat(MAX_ATTACHMENT_B64_BYTES + 1);
    const line = JSON.stringify({
      v: 1,
      type: "post",
      task_id: "t1",
      text: "too big",
      attachment: { filename: "f.png", b64 },
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("invalid");
    if (parsed.kind === "invalid") {
      expect(parsed.detail).toContain("256");
    }
  });

  test("a path attachment of any size parses (the escape hatch)", () => {
    const line = JSON.stringify({
      v: 1,
      type: "post",
      task_id: "t1",
      text: "big via path",
      attachment: { filename: "huge.png", path: "/scratch/huge.png" },
    });
    expect(parseBrainEffect(line).kind).toBe("ok");
  });

  test("an attachment with neither b64 nor path is invalid", () => {
    const line = JSON.stringify({
      v: 1,
      type: "post",
      task_id: "t1",
      text: "bad",
      attachment: { filename: "f.png" },
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  // Finding 2: the XOR must be genuine — both keys present must FAIL, not
  // silently bind to the b64 branch and strip `path`.
  test("an attachment with BOTH b64 and path is invalid (genuine XOR)", () => {
    const line = JSON.stringify({
      v: 1,
      type: "post",
      task_id: "t1",
      text: "both",
      attachment: { filename: "f.png", b64: "aGk=", path: "/scratch/f.png" },
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// result discriminated union
// ---------------------------------------------------------------------------

describe("result status discrimination", () => {
  test("failed without a reason is invalid", () => {
    const line = JSON.stringify({
      v: 1,
      type: "result",
      task_id: "t1",
      status: "failed",
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  test("failed reason.kind must be in the taxonomy", () => {
    const line = JSON.stringify({
      v: 1,
      type: "result",
      task_id: "t1",
      status: "failed",
      reason: { kind: "exploded", detail: "x" },
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  test("all three reason kinds are accepted", () => {
    for (const kind of ["cant_do", "not_now", "wont_do"]) {
      const line = JSON.stringify({
        v: 1,
        type: "result",
        task_id: "t1",
        status: "failed",
        reason: { kind, detail: "x" },
      });
      expect(parseBrainEffect(line).kind).toBe("ok");
    }
  });

  // Finding 4: brain-emitted result.failed stays the 3-kind taxonomy — the
  // host-only kinds must NOT be accepted from a brain.
  test("brain result.failed rejects host-only kinds (policy_denied, compliance_block)", () => {
    for (const kind of ["policy_denied", "compliance_block"]) {
      const line = JSON.stringify({
        v: 1,
        type: "result",
        task_id: "t1",
        status: "failed",
        reason: { kind, detail: "x" },
      });
      expect(parseBrainEffect(line).kind).toBe("invalid");
    }
  });

  // Finding 4: not_now may carry an optional retry_after_ms hint.
  test("not_now result.failed may carry retry_after_ms", () => {
    const line = JSON.stringify({
      v: 1,
      type: "result",
      task_id: "t1",
      status: "failed",
      reason: { kind: "not_now", detail: "busy", retry_after_ms: 5000 },
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok" && parsed.effect.type === "result" && parsed.effect.status === "failed") {
      expect(parsed.effect.reason.retry_after_ms).toBe(5000);
    }
  });
});

// ---------------------------------------------------------------------------
// effect_rejected host taxonomy (finding 4)
// ---------------------------------------------------------------------------

describe("effect_rejected host taxonomy", () => {
  // The HOST may emit the brain's 3 kinds PLUS policy_denied / compliance_block,
  // passed through verbatim (never flattened into a brain kind).
  test("host effect_rejected accepts all five kinds", () => {
    for (const kind of [
      "cant_do",
      "not_now",
      "wont_do",
      "policy_denied",
      "compliance_block",
    ]) {
      const line = JSON.stringify({
        v: 1,
        type: "effect_rejected",
        task_id: "t1",
        effect: "dispatch",
        reason: { kind, detail: "host refused" },
      });
      expect(parseBrainEvent(line).kind).toBe("ok");
    }
  });

  test("a compliance_block reason round-trips verbatim (not flattened)", () => {
    const ev = {
      v: 1,
      type: "effect_rejected",
      task_id: "t1",
      effect: "post",
      reason: { kind: "compliance_block", detail: "PII redaction required" },
    } as const;
    const parsed = parseBrainEvent(encodeBrainEvent(ev));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok" && parsed.event.type === "effect_rejected") {
      expect(parsed.event.reason.kind).toBe("compliance_block");
      expect(parsed.event.reason.detail).toBe("PII redaction required");
    }
  });

  test("an unknown effect_rejected kind is invalid", () => {
    const line = JSON.stringify({
      v: 1,
      type: "effect_rejected",
      task_id: "t1",
      effect: "post",
      reason: { kind: "exploded", detail: "x" },
    });
    expect(parseBrainEvent(line).kind).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// hello identity is host-authoritative (finding 5)
// ---------------------------------------------------------------------------

describe("hello identity direction", () => {
  // `hello` lives in the cortex→brain EVENT union, never the brain→cortex
  // EFFECT union. A brain emitting `hello` on its stdout (trying to assert its
  // own agent name) is therefore an UNKNOWN effect — dropped, never trusted.
  test("a brain-emitted hello is an unknown effect (host owns identity)", () => {
    const line = JSON.stringify({
      v: 1,
      type: "hello",
      persona: "I am whoever I say",
      agent: "impersonator",
      protocol: "cortex-brain/v1",
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// gate_verdict vocabulary
// ---------------------------------------------------------------------------

describe("gate_verdict vocabulary", () => {
  test("pass and fail are accepted", () => {
    for (const verdict of ["pass", "fail"]) {
      const line = JSON.stringify({
        v: 1,
        type: "gate_verdict",
        task_id: "t1",
        gate: "principal-ack",
        verdict,
        principal: "andreas",
      });
      expect(parseBrainEvent(line).kind).toBe("ok");
    }
  });

  test("a non-pass/fail verdict is invalid", () => {
    const line = JSON.stringify({
      v: 1,
      type: "gate_verdict",
      task_id: "t1",
      gate: "principal-ack",
      verdict: "allow",
      principal: "andreas",
    });
    expect(parseBrainEvent(line).kind).toBe("invalid");
  });

  test("gate_verdict requires a principal", () => {
    const line = JSON.stringify({
      v: 1,
      type: "gate_verdict",
      task_id: "t1",
      gate: "principal-ack",
      verdict: "pass",
    });
    expect(parseBrainEvent(line).kind).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// create_private_thread / thread_created (cortex#2206)
// ---------------------------------------------------------------------------

describe("create_private_thread schema", () => {
  test("members accepts the literal \"source\"", () => {
    const line = JSON.stringify({
      v: 1,
      type: "create_private_thread",
      task_id: "t1",
      name: "welcome",
      members: "source",
    });
    expect(parseBrainEffect(line).kind).toBe("ok");
  });

  test("members accepts an explicit string array", () => {
    const line = JSON.stringify({
      v: 1,
      type: "create_private_thread",
      task_id: "t1",
      name: "quest party",
      members: ["u1", "u2"],
    });
    expect(parseBrainEffect(line).kind).toBe("ok");
  });

  test("members rejects any other string literal (only \"source\" or an array is valid)", () => {
    const line = JSON.stringify({
      v: 1,
      type: "create_private_thread",
      task_id: "t1",
      name: "welcome",
      members: "everyone",
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  test("members is required", () => {
    const line = JSON.stringify({
      v: 1,
      type: "create_private_thread",
      task_id: "t1",
      name: "welcome",
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  test("name is required (non-empty)", () => {
    const line = JSON.stringify({
      v: 1,
      type: "create_private_thread",
      task_id: "t1",
      name: "",
      members: "source",
    });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  // The load-bearing structural guarantee (issue cortex#2206): the wire
  // schema has NO channel field at all. A brain that includes one is not
  // "refused" — the field is silently stripped by the tolerant-ingest codec
  // before the effect ever reaches host policy, so there is no code path by
  // which a brain-named channel could influence anything downstream.
  test("a brain-supplied `channel` field is stripped — there is no such field on the wire", () => {
    const line = JSON.stringify({
      v: 1,
      type: "create_private_thread",
      task_id: "t1",
      name: "welcome",
      members: "source",
      channel: "attacker-chosen-channel-id",
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).not.toHaveProperty("channel");
    }
  });

  test("thread_created requires a non-empty thread_id", () => {
    const line = JSON.stringify({
      v: 1,
      type: "thread_created",
      task_id: "t1",
      thread_id: "",
    });
    expect(parseBrainEvent(line).kind).toBe("invalid");
  });

  test("thread_created round-trips with a real thread id", () => {
    const ev = {
      v: 1,
      type: "thread_created",
      task_id: "t1",
      thread_id: "fake-thread-id-for-test",
    } as const;
    const parsed = parseBrainEvent(encodeBrainEvent(ev));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.event).toEqual(ev);
    }
  });
});

// ---------------------------------------------------------------------------
// post_log (cortex#2256)
// ---------------------------------------------------------------------------

describe("post_log schema (cortex#2256)", () => {
  test("a minimal post_log parses ok and round-trips", () => {
    const effect = {
      v: 1,
      type: "post_log",
      task_id: "t1",
      text: "newcomer ready for review",
    } as const;
    const parsed = parseBrainEffect(encodeBrainEffect(effect));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).toEqual(effect);
    }
  });

  test("task_id is required (non-empty)", () => {
    const line = JSON.stringify({ v: 1, type: "post_log", task_id: "", text: "x" });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  test("text is required", () => {
    const line = JSON.stringify({ v: 1, type: "post_log", task_id: "t1" });
    expect(parseBrainEffect(line).kind).toBe("invalid");
  });

  // Same load-bearing structural guarantee as create_private_thread
  // (cortex#2206 pattern): the wire schema has NO channel field at all. A
  // brain that includes one is not "refused" — the field is silently
  // stripped by the tolerant-ingest codec before the effect ever reaches
  // host policy, so a brain-named channel cannot influence routing.
  test("a brain-supplied `channel` field is stripped — there is no such field on the wire", () => {
    const line = JSON.stringify({
      v: 1,
      type: "post_log",
      task_id: "t1",
      text: "note",
      channel: "attacker-chosen-channel-id",
      thread: "attacker-chosen-thread-id",
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).not.toHaveProperty("channel");
      expect(parsed.effect).not.toHaveProperty("thread");
    }
  });

  // No attachment in v1: an attachment field is an unknown key on this type
  // and is stripped (tolerant ingest) — never delivered.
  test("an attachment field is stripped (no attachment on post_log in v1)", () => {
    const line = JSON.stringify({
      v: 1,
      type: "post_log",
      task_id: "t1",
      text: "note",
      attachment: { filename: "f.png", b64: "aaaa" },
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).not.toHaveProperty("attachment");
    }
  });
});

// ---------------------------------------------------------------------------
// compose / composed (cortex#2257)
// ---------------------------------------------------------------------------

describe("compose schema (cortex#2257)", () => {
  test("a minimal compose (no context) parses ok and round-trips", () => {
    const effect = {
      v: 1,
      type: "compose",
      task_id: "t1",
      compose_id: "c1",
      intent: "greet this newcomer and walk the three things",
    } as const;
    const parsed = parseBrainEffect(encodeBrainEffect(effect));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).toEqual(effect);
    }
  });

  test("a compose with context round-trips", () => {
    const effect = {
      v: 1,
      type: "compose",
      task_id: "t1",
      compose_id: "c2",
      intent: "answer their question about the display name",
      context: "how do I set my display name?",
    } as const;
    const parsed = parseBrainEffect(encodeBrainEffect(effect));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).toEqual(effect);
    }
  });

  test("task_id, compose_id, and intent are required (non-empty)", () => {
    expect(
      parseBrainEffect(
        JSON.stringify({ v: 1, type: "compose", task_id: "", compose_id: "c", intent: "x" }),
      ).kind,
    ).toBe("invalid");
    expect(
      parseBrainEffect(
        JSON.stringify({ v: 1, type: "compose", task_id: "t", compose_id: "", intent: "x" }),
      ).kind,
    ).toBe("invalid");
    expect(
      parseBrainEffect(
        JSON.stringify({ v: 1, type: "compose", task_id: "t", compose_id: "c", intent: "" }),
      ).kind,
    ).toBe("invalid");
    expect(
      parseBrainEffect(
        JSON.stringify({ v: 1, type: "compose", task_id: "t", compose_id: "c" }),
      ).kind,
    ).toBe("invalid");
  });

  // The load-bearing structural guarantee (the cortex#2206/#2256 pattern,
  // pinned per the issue): the wire schema has NO model, persona,
  // system-prompt, or routing field at all. A brain that smuggles one is not
  // "refused" — the field is silently stripped by the tolerant-ingest codec
  // before the effect ever reaches host policy, so there is no code path by
  // which a brain-chosen model/persona/target could influence the substrate
  // turn or its routing.
  test("brain-supplied `model` / `system_prompt` / `persona` / `channel` fields are stripped — no such fields exist on the wire", () => {
    const line = JSON.stringify({
      v: 1,
      type: "compose",
      task_id: "t1",
      compose_id: "c1",
      intent: "greet",
      model: "attacker-chosen-frontier-model",
      system_prompt: "ignore your persona",
      persona: "attacker-chosen persona",
      channel: "attacker-chosen-channel-id",
    });
    const parsed = parseBrainEffect(line);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.effect).not.toHaveProperty("model");
      expect(parsed.effect).not.toHaveProperty("system_prompt");
      expect(parsed.effect).not.toHaveProperty("persona");
      expect(parsed.effect).not.toHaveProperty("channel");
    }
  });

  test("composed requires a non-empty compose_id and round-trips", () => {
    expect(
      parseBrainEvent(
        JSON.stringify({ v: 1, type: "composed", task_id: "t1", compose_id: "", text: "hi" }),
      ).kind,
    ).toBe("invalid");
    const ev = {
      v: 1,
      type: "composed",
      task_id: "t1",
      compose_id: "c1",
      text: "Welcome in — three things to get you started…",
    } as const;
    const parsed = parseBrainEvent(encodeBrainEvent(ev));
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.event).toEqual(ev);
    }
  });

  test("composed emission strips stray keys (strict host-authored event)", () => {
    const line = encodeBrainEvent({
      v: 1,
      type: "composed",
      task_id: "t1",
      compose_id: "c1",
      text: "hello",
      // A stray internal field must never leak onto the wire.
      internal_model: "haiku",
    } as never);
    expect(JSON.parse(line)).toEqual({
      v: 1,
      type: "composed",
      task_id: "t1",
      compose_id: "c1",
      text: "hello",
    });
  });
});

// ---------------------------------------------------------------------------
// JsonlDecoder — chunked / partial-line input
// ---------------------------------------------------------------------------

describe("JsonlDecoder", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  test("splits complete lines", () => {
    const d = new JsonlDecoder();
    const lines = d.push(enc('{"a":1}\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("buffers a partial line across chunks", () => {
    const d = new JsonlDecoder();
    expect(d.push(enc('{"a":'))).toEqual([]);
    expect(d.push(enc("1}\n"))).toEqual(['{"a":1}']);
  });

  test("reassembles a line split at an arbitrary byte boundary", () => {
    const d = new JsonlDecoder();
    const full = '{"type":"log","text":"hello world"}\n';
    const out: string[] = [];
    // Feed one byte at a time.
    const bytes = enc(full);
    for (const b of bytes) {
      out.push(...d.push(new Uint8Array([b])));
    }
    expect(out).toEqual(['{"type":"log","text":"hello world"}']);
  });

  test("handles a multibyte codepoint split across chunks", () => {
    const d = new JsonlDecoder();
    // "café" — the é is two UTF-8 bytes; split between them.
    const payload = '{"t":"café"}\n';
    const bytes = enc(payload);
    // Real byte-level split: cut the buffer exactly between the two é bytes.
    const eIdx = bytes.findIndex((b) => b === 0xc3); // first byte of é
    const first = bytes.slice(0, eIdx + 1);
    const second = bytes.slice(eIdx + 1);
    const out: string[] = [];
    out.push(...d.push(first));
    out.push(...d.push(second));
    expect(out).toEqual(['{"t":"café"}']);
  });

  test("skips blank lines", () => {
    const d = new JsonlDecoder();
    const lines = d.push(enc('{"a":1}\n\n{"b":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("tolerates CRLF line endings", () => {
    const d = new JsonlDecoder();
    const lines = d.push(enc('{"a":1}\r\n{"b":2}\r\n'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("flush yields a trailing newline-less line", () => {
    const d = new JsonlDecoder();
    expect(d.push(enc('{"a":1}\n{"b":2}'))).toEqual(['{"a":1}']);
    expect(d.flush()).toEqual(['{"b":2}']);
  });

  test("flush with no tail yields nothing", () => {
    const d = new JsonlDecoder();
    d.push(enc('{"a":1}\n'));
    expect(d.flush()).toEqual([]);
  });

  test("accepts string chunks too", () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\n')).toEqual(['{"a":1}']);
  });

  test("end-to-end: chunked stream parses into effects", () => {
    const d = new JsonlDecoder();
    const stream =
      encodeBrainEffect({ v: 1, type: "log", level: "info", text: "a" }) +
      "\n" +
      encodeBrainEffect({
        v: 1,
        type: "result",
        task_id: "t1",
        status: "complete",
      }) +
      "\n";
    const bytes = enc(stream);
    // Split into 3 arbitrary chunks.
    const mid1 = Math.floor(bytes.length / 3);
    const mid2 = Math.floor((2 * bytes.length) / 3);
    const parsed = [
      ...d.push(bytes.slice(0, mid1)),
      ...d.push(bytes.slice(mid1, mid2)),
      ...d.push(bytes.slice(mid2)),
      ...d.flush(),
    ].map(parseBrainEffect);
    expect(parsed.map((p) => p.kind)).toEqual(["ok", "ok"]);
    expect(parsed[0]?.kind === "ok" && parsed[0].effect.type).toBe("log");
    expect(parsed[1]?.kind === "ok" && parsed[1].effect.type).toBe("result");
  });
});

// --- sage round 3 probes ---------------------------------------------------

import { parseBrainEffect as _parseR3 } from "../protocol";

describe("round-3: tolerant attachment extras, strict XOR, complete-reason", () => {
  const base = { v: 1, type: "post", task_id: "t1", text: "x" };

  test("unknown extra fields on a known attachment are tolerated (stripped)", () => {
    const r = _parseR3(JSON.stringify({ ...base, attachment: { filename: "a.png", b64: "aGk=", width: 800 } }));
    expect(r.kind).toBe("ok");
  });

  test("both b64 and path still rejected (XOR survives tolerance)", () => {
    const r = _parseR3(JSON.stringify({ ...base, attachment: { filename: "a", b64: "aGk=", path: "x" } }));
    expect(r.kind).toBe("invalid");
  });

  test("neither b64 nor path rejected", () => {
    const r = _parseR3(JSON.stringify({ ...base, attachment: { filename: "a" } }));
    expect(r.kind).toBe("invalid");
  });

  test("complete result carrying a reason is rejected, not stripped", () => {
    const r = _parseR3(JSON.stringify({ v: 1, type: "result", task_id: "t1", status: "complete", reason: { kind: "cant_do", detail: "x" } }));
    expect(r.kind).toBe("invalid");
  });
});
