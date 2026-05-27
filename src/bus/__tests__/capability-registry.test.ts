/**
 * cortex#237 PR-3 — tests for `capability-registry.ts` publisher.
 *
 * Coverage axes (mirrors the rest of `bus/__tests__/`):
 *
 *   1. Cardinality — the publisher emits exactly one envelope per
 *      agent×non-empty-capability-set. Zero agents → zero envelopes;
 *      one agent × one capability → one envelope; two agents × three
 *      capabilities each → two envelopes (NOT six — capabilities are
 *      a payload list, not a per-capability fan-out per §3.2).
 *
 *   2. Filtering — agents with empty `capabilities[]` are skipped per
 *      spec §3.4.
 *
 *   3. Shape — envelope `type` matches the §3.2 spec exactly; payload
 *      carries `agent_id` + `capabilities` + `registered_at` + `instance`;
 *      sovereignty defaults to local / NZ / hop=0 per §3.2; every
 *      envelope validates against the vendored myelin schema.
 *
 *   4. Subject literal — the exported `CAPABILITY_REGISTERED_EVENT_TYPE`
 *      constant matches the spec literal (so pilot Phase B's reader
 *      and PR-7's boot wiring can subscribe against the same string).
 *
 *   5. Mockability — `publish` is a plain function the test supplies
 *      via a recording array (no NATS client, no runtime, no fixture).
 *
 *   6. Idempotency — re-invoking with the same entries publishes the
 *      same logical registrations (same `agent_id` + `capabilities`)
 *      with fresh envelope ids.
 *
 * Note on PR-3 scope: no `sovereignty` / `max_concurrent` payload
 * assertions — those fields land in PR-4 once `AgentRuntimeSchema`
 * grows the corresponding knobs. PR-3 tests stay narrow to PR-3's
 * surface.
 */

import { describe, expect, test } from "bun:test";
import { validateEnvelope, type Envelope } from "../myelin/envelope-validator";
import {
  CAPABILITY_REGISTERED_EVENT_TYPE,
  buildCapabilityRegisteredEnvelope,
  publishCapabilityRegistry,
  type CapabilityRegistryEntry,
  type CapabilityRegistrySource,
  type PublishFn,
} from "../capability-registry";

const SOURCE: CapabilityRegistrySource = {
  principal: "metafactory",
  agent: "cortex",
  instance: "local",
};

const FIXED_AT = new Date("2026-05-16T09:42:11.000Z");
const FIXED_CLOCK = () => FIXED_AT;

/**
 * Recording publisher — captures every envelope handed to `publish`.
 * The function shape matches `MyelinRuntime.publish` exactly
 * (`(Envelope) => Promise<void>`) so the same construction works in
 * production once PR-7 wires the runtime in.
 */
function recordingPublisher(): { publish: PublishFn; sent: Envelope[] } {
  const sent: Envelope[] = [];
  const publish: PublishFn = async (envelope) => {
    sent.push(envelope);
  };
  return { publish, sent };
}

describe("CAPABILITY_REGISTERED_EVENT_TYPE", () => {
  test("matches the spec literal verbatim", () => {
    // Pilot's deferred bucket reader (§13.1) and PR-7's boot wiring
    // both filter by this exact string. A typo here is silent drift
    // against the spec — assert the literal so a future rename has
    // to update both this assertion and the spec at the same time.
    expect(CAPABILITY_REGISTERED_EVENT_TYPE).toBe("agents.capabilities.registered");
  });
});

describe("buildCapabilityRegisteredEnvelope", () => {
  test("produces a schema-valid envelope with the §3.2 payload shape", () => {
    const env = buildCapabilityRegisteredEnvelope({
      source: SOURCE,
      agentId: "echo",
      capabilities: ["code-review.typescript"],
      registeredAt: FIXED_AT,
      instance: "andreas.cortex.local",
    });
    expect(env.type).toBe(CAPABILITY_REGISTERED_EVENT_TYPE);
    expect(env.source).toBe("metafactory.cortex.local");
    expect(env.payload).toEqual({
      agent_id: "echo",
      capabilities: ["code-review.typescript"],
      registered_at: "2026-05-16T09:42:11.000Z",
      instance: "andreas.cortex.local",
    });
    expect(env.sovereignty).toEqual({
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: false,
      model_class: "local-only",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("each invocation produces a fresh envelope id", () => {
    const a = buildCapabilityRegisteredEnvelope({
      source: SOURCE,
      agentId: "echo",
      capabilities: ["code-review.typescript"],
      registeredAt: FIXED_AT,
      instance: "andreas.cortex.local",
    });
    const b = buildCapabilityRegisteredEnvelope({
      source: SOURCE,
      agentId: "echo",
      capabilities: ["code-review.typescript"],
      registeredAt: FIXED_AT,
      instance: "andreas.cortex.local",
    });
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("non-default residency flows into sovereignty.data_residency", () => {
    const env = buildCapabilityRegisteredEnvelope({
      source: { ...SOURCE, dataResidency: "AU" },
      agentId: "echo",
      capabilities: ["code-review.typescript"],
      registeredAt: FIXED_AT,
      instance: "andreas.cortex.local",
    });
    expect(env.sovereignty.data_residency).toBe("AU");
  });

  test("federated classification flows through unchanged", () => {
    const env = buildCapabilityRegisteredEnvelope({
      source: SOURCE,
      agentId: "echo",
      capabilities: ["code-review.typescript"],
      registeredAt: FIXED_AT,
      instance: "andreas.cortex.local",
      classification: "federated",
    });
    expect(env.sovereignty.classification).toBe("federated");
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("capabilities array is copied (caller mutation can't leak in)", () => {
    // Defensive — `[...opts.capabilities]` in the builder means a
    // caller mutating their input array after construction doesn't
    // shift the envelope's payload. Important for the boot path where
    // the same `Agent.runtime.capabilities` reference is reused across
    // multiple subsystems.
    const input: string[] = ["code-review.typescript"];
    const env = buildCapabilityRegisteredEnvelope({
      source: SOURCE,
      agentId: "echo",
      capabilities: input,
      registeredAt: FIXED_AT,
      instance: "andreas.cortex.local",
    });
    input.push("code-review.bun");
    expect((env.payload as { capabilities: string[] }).capabilities).toEqual([
      "code-review.typescript",
    ]);
  });
});

describe("publishCapabilityRegistry", () => {
  test("1 agent × 1 capability → 1 envelope", async () => {
    const { publish, sent } = recordingPublisher();
    const entries: CapabilityRegistryEntry[] = [
      { agentId: "echo", capabilities: ["code-review.typescript"] },
    ];

    const published = await publishCapabilityRegistry({
      source: SOURCE,
      entries,
      publish,
      clock: FIXED_CLOCK,
    });

    expect(sent.length).toBe(1);
    expect(published.length).toBe(1);
    // The returned array IS the same envelopes the mock saw — boot
    // path uses the return value for logging without re-deriving from
    // the mock.
    expect(published[0]).toBe(sent[0]);

    const env = sent[0]!;
    expect(env.type).toBe(CAPABILITY_REGISTERED_EVENT_TYPE);
    expect(env.payload).toMatchObject({
      agent_id: "echo",
      capabilities: ["code-review.typescript"],
      registered_at: "2026-05-16T09:42:11.000Z",
      instance: "local",
    });
    expect(validateEnvelope(env).ok).toBe(true);
  });

  test("2 agents × 3 capabilities each → 2 envelopes (NOT 6)", async () => {
    // Cardinality clarification per §3.2: one envelope per AGENT
    // carries the agent's capability LIST in the payload — we do NOT
    // fan out one envelope per capability. The "6" trap would be a
    // shape regression that wastes wire traffic and confuses the
    // bucket reader (the bucket is keyed by agent_id, not by
    // capability id).
    const { publish, sent } = recordingPublisher();
    const entries: CapabilityRegistryEntry[] = [
      {
        agentId: "echo",
        capabilities: [
          "code-review.typescript",
          "code-review.bun",
          "code-review.generic",
        ],
      },
      {
        agentId: "luna",
        capabilities: [
          "design-review.figma",
          "design-review.tailwind",
          "design-review.generic",
        ],
      },
    ];

    const published = await publishCapabilityRegistry({
      source: SOURCE,
      entries,
      publish,
      clock: FIXED_CLOCK,
    });

    expect(sent.length).toBe(2);
    expect(published.length).toBe(2);

    const byAgent = new Map(
      sent.map((env) => [
        (env.payload as { agent_id: string }).agent_id,
        env,
      ]),
    );

    expect(byAgent.get("echo")?.payload).toMatchObject({
      agent_id: "echo",
      capabilities: [
        "code-review.typescript",
        "code-review.bun",
        "code-review.generic",
      ],
    });
    expect(byAgent.get("luna")?.payload).toMatchObject({
      agent_id: "luna",
      capabilities: [
        "design-review.figma",
        "design-review.tailwind",
        "design-review.generic",
      ],
    });

    // Every envelope is independently schema-valid.
    for (const env of sent) {
      expect(validateEnvelope(env).ok).toBe(true);
    }
  });

  test("agent with empty capabilities → 0 envelopes for that agent", async () => {
    // Per §3.4: only register agents with at least one capability.
    // An agent whose `runtime.capabilities` is `[]` (or whose
    // `runtime` is omitted entirely — projected to `[]` by the boot
    // wiring) MUST emit zero envelopes. This protects against bucket
    // pollution from in-process agents whose capabilities are
    // declared via roles rather than `runtime.capabilities[]`.
    const { publish, sent } = recordingPublisher();
    const entries: CapabilityRegistryEntry[] = [
      { agentId: "echo", capabilities: ["code-review.typescript"] },
      { agentId: "ivy", capabilities: [] },
      { agentId: "holly", capabilities: [] },
    ];

    const published = await publishCapabilityRegistry({
      source: SOURCE,
      entries,
      publish,
      clock: FIXED_CLOCK,
    });

    expect(sent.length).toBe(1);
    expect(published.length).toBe(1);
    expect((sent[0]!.payload as { agent_id: string }).agent_id).toBe("echo");
  });

  test("zero entries → zero envelopes", async () => {
    const { publish, sent } = recordingPublisher();
    const published = await publishCapabilityRegistry({
      source: SOURCE,
      entries: [],
      publish,
      clock: FIXED_CLOCK,
    });
    expect(sent.length).toBe(0);
    expect(published.length).toBe(0);
  });

  test("subject derivation contract — type literal is exactly the spec string", async () => {
    // The runtime derives the wire subject from
    // `(envelope.type, envelope.sovereignty.classification)`. PR-3's
    // contract is the `type` literal; the wire-side derivation lives
    // in `myelin/runtime.ts` and has its own tests. This assertion
    // anchors the contract so a future type rename surfaces here.
    const { publish, sent } = recordingPublisher();
    await publishCapabilityRegistry({
      source: SOURCE,
      entries: [{ agentId: "echo", capabilities: ["code-review.typescript"] }],
      publish,
      clock: FIXED_CLOCK,
    });
    expect(sent[0]!.type).toBe("agents.capabilities.registered");
  });

  test("instance override lands in the payload", async () => {
    const { publish, sent } = recordingPublisher();
    await publishCapabilityRegistry({
      source: SOURCE,
      entries: [{ agentId: "echo", capabilities: ["code-review.typescript"] }],
      publish,
      clock: FIXED_CLOCK,
      instance: "andreas.cortex.local",
    });
    expect((sent[0]!.payload as { instance: string }).instance).toBe(
      "andreas.cortex.local",
    );
  });

  test("instance defaults to source.instance when not overridden", async () => {
    const { publish, sent } = recordingPublisher();
    await publishCapabilityRegistry({
      source: SOURCE,
      entries: [{ agentId: "echo", capabilities: ["code-review.typescript"] }],
      publish,
      clock: FIXED_CLOCK,
    });
    expect((sent[0]!.payload as { instance: string }).instance).toBe("local");
  });

  test("re-invocation with same entries is idempotent at payload level", async () => {
    // Per the publisher's idempotency contract: re-publish produces
    // the same logical registrations (same `agent_id` + `capabilities`
    // payload) with fresh envelope ids. The bucket consumer keys on
    // `agent_id` and overwrites — so re-publish is a bucket no-op even
    // though the wire sees a second envelope.
    const { publish, sent } = recordingPublisher();
    const entries: CapabilityRegistryEntry[] = [
      { agentId: "echo", capabilities: ["code-review.typescript"] },
    ];

    await publishCapabilityRegistry({
      source: SOURCE,
      entries,
      publish,
      clock: FIXED_CLOCK,
    });
    await publishCapabilityRegistry({
      source: SOURCE,
      entries,
      publish,
      clock: FIXED_CLOCK,
    });

    expect(sent.length).toBe(2);
    // Fresh envelope ids per call (idempotency at the *bucket* not
    // the *wire*).
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
    // Same logical registration — payload is byte-identical (we
    // pinned the clock above so `registered_at` is stable).
    expect(sent[0]!.payload).toEqual(sent[1]!.payload);
  });

  test("publish errors propagate to the caller (no swallowing)", async () => {
    // Per the publisher's error-handling contract: publish failures
    // are real signals (bus unreachable, signer fault). Catching here
    // would swallow boot-path diagnostics. Assert the propagation so
    // a future "defensive try/catch" addition fails this test.
    const failing: PublishFn = async () => {
      throw new Error("simulated NATS publish failure");
    };
    await expect(
      publishCapabilityRegistry({
        source: SOURCE,
        entries: [
          { agentId: "echo", capabilities: ["code-review.typescript"] },
        ],
        publish: failing,
        clock: FIXED_CLOCK,
      }),
    ).rejects.toThrow("simulated NATS publish failure");
  });

  test("envelopes publish in entry order (deterministic emission)", async () => {
    // Per the publisher's concurrency rationale: sequential emission
    // gives the boot path a deterministic order for log grepping and
    // integration-test assertions. Assert the order matches `entries`.
    const { publish, sent } = recordingPublisher();
    await publishCapabilityRegistry({
      source: SOURCE,
      entries: [
        { agentId: "echo", capabilities: ["code-review.typescript"] },
        { agentId: "luna", capabilities: ["design-review.figma"] },
        { agentId: "holly", capabilities: ["pr-review.generic"] },
      ],
      publish,
      clock: FIXED_CLOCK,
    });
    const agentIds = sent.map(
      (env) => (env.payload as { agent_id: string }).agent_id,
    );
    expect(agentIds).toEqual(["echo", "luna", "holly"]);
  });
});
