/**
 * cortex#1935 — REAL-SCHEMA round-trip for the renamed `system.*` families.
 *
 * ## Why this test exists
 *
 * The underscore-typed-envelope bug survived every existing unit test because
 * those tests assert on FAKE runtimes whose `published[]` arrays are captured
 * BEFORE the schema is applied — they never call `validateEnvelope`. But
 * `validateEnvelope` is the SUBSCRIBER-side gate: a real subscriber runs it on
 * delivery, and an underscore-typed envelope fails the vendored `/type` pattern
 * and is **silently dropped**. So a green fake-based suite proved nothing about
 * whether the event would actually be RECEIVED.
 *
 * This suite closes that hole for the families #1935 renamed: it drives each
 * real builder's OUTPUT through the REAL vendored schema (`validateEnvelope`,
 * `src/bus/myelin/vendor/envelope.schema.json`) and asserts:
 *
 *   1. the hyphen-typed envelope PASSES `validateEnvelope` → a subscriber
 *      receives it (this is the delivery gate; passing it == not dropped);
 *   2. flipping its type back to the OLD underscore spelling is REJECTED →
 *      proves the pre-#1935 form was genuinely un-deliverable (the silent drop),
 *      i.e. the rename is what makes the event reach a subscriber at all.
 *
 * One representative per renamed family. If a builder ever regresses its `type`
 * to an underscore, assertion (1) fails here — not silently in production.
 */

import { describe, expect, it } from "bun:test";

import { validateEnvelope } from "../myelin/envelope-validator";
import type { Envelope } from "../myelin/envelope-validator";
import {
  createSystemBusNotifyDiscordEvent,
  createSystemBusPeerDispatchReceivedEvent,
  createSystemBusReflexActivationDispatchedEvent,
  createSystemBusReflexActivationFailedEvent,
  createSystemBusReflexActivationSkippedEvent,
  createSystemGatewayRoutingDecisionEvent,
  createSystemPluginLoadFailedEvent,
} from "../system-events";

const SOURCE = { principal: "andreas", agent: "cortex", instance: "local" };
const UUID = "11111111-1111-4111-8111-111111111111";

/** Return a copy of `env` whose `type` has hyphens flipped back to underscores. */
function toUnderscoreType(env: Envelope): Envelope {
  return {
    ...env,
    type: env.type.replace(/-/g, "_"),
  };
}

/**
 * The renamed families, one representative envelope each. The verifier
 * self-check (`system.verifier.self-check`) is built inline below because its
 * only builder (`runVerifierSelfCheck`) needs live signing infrastructure; the
 * base envelope shape is reproduced field-for-field from `verifier-self-check.ts`.
 */
const RENAMED_FAMILIES: readonly { family: string; envelope: Envelope }[] = [
  {
    family: "system.bus.peer-dispatch-received",
    envelope: createSystemBusPeerDispatchReceivedEvent({
      source: SOURCE,
      receivingAgentId: "luna",
      peerSource: "metafactory.echo.local",
      dispatchEnvelopeId: UUID,
      receivedAt: new Date("2026-07-14T00:00:00.000Z"),
    }),
  },
  {
    family: "system.bus.reflex-activation-dispatched",
    envelope: createSystemBusReflexActivationDispatchedEvent({
      source: SOURCE,
      decisionId: "decision-1",
      target: "@jc/notify-discord",
      capability: "notify.discord",
      via: "handler",
    }),
  },
  {
    family: "system.bus.reflex-activation-failed",
    envelope: createSystemBusReflexActivationFailedEvent({
      source: SOURCE,
      reason: "unknown_target",
      firedEnvelopeId: UUID,
    }),
  },
  {
    family: "system.bus.reflex-activation-skipped",
    envelope: createSystemBusReflexActivationSkippedEvent({
      source: SOURCE,
      decisionId: "decision-1",
      target: "@jc/sage-pr-review",
      capability: "code-review",
      reason: "author_trusted",
      author: "dependabot",
      firedEnvelopeId: UUID,
    }),
  },
  {
    family: "system.bus.notify-discord",
    envelope: createSystemBusNotifyDiscordEvent({
      source: SOURCE,
      outcome: "posted",
      repo: "the-metafactory/cortex",
    }),
  },
  {
    family: "system.gateway.routing-decision",
    envelope: createSystemGatewayRoutingDecisionEvent({
      source: SOURCE,
      outcome: "routed",
      platform: "discord",
      instanceId: "disc-1",
      agent: "luna",
      subject: "local.andreas.meta-factory.tasks.@luna.chat",
    }),
  },
  {
    family: "system.plugin.load-failed",
    envelope: createSystemPluginLoadFailedEvent({
      source: SOURCE,
      bundleName: "metafactory-cortex-renderer-pagerduty",
      stage: "import",
      reason: "module not found",
    }),
  },
  {
    // Reproduces the base shape built in src/bus/verifier-self-check.ts (it
    // does NOT use the production builders on purpose — self-contained audit).
    family: "system.verifier.self-check",
    envelope: {
      id: UUID,
      source: "andreas.cortex.self-check",
      type: "system.verifier.self-check",
      timestamp: "2026-07-14T00:00:00.000Z",
      sovereignty: {
        classification: "local",
        data_residency: "NZ",
        max_hop: 0,
        frontier_ok: false,
        model_class: "any",
      },
      payload: { note: "cortex#480 boot-time self-check" },
    } as unknown as Envelope,
  },
];

describe("cortex#1935 — renamed system.* families round-trip the real schema", () => {
  it("covers every family the #1935 rename touched", () => {
    // Belt against a family being dropped from the table during a future edit.
    expect(RENAMED_FAMILIES.map((f) => f.family).sort()).toEqual([
      "system.bus.notify-discord",
      "system.bus.peer-dispatch-received",
      "system.bus.reflex-activation-dispatched",
      "system.bus.reflex-activation-failed",
      "system.bus.reflex-activation-skipped",
      "system.gateway.routing-decision",
      "system.plugin.load-failed",
      "system.verifier.self-check",
    ]);
  });

  for (const { family, envelope } of RENAMED_FAMILIES) {
    it(`${family}: the builder output has the hyphen type and PASSES validateEnvelope (received, not dropped)`, () => {
      expect(envelope.type).toBe(family);
      expect(envelope.type).not.toContain("_");

      const result = validateEnvelope(envelope);
      if (!result.ok) {
        // Surface AJV errors so any drift is diagnosable.
        throw new Error(
          `validateEnvelope REJECTED canonical ${family}: ${JSON.stringify(result.errors)}`,
        );
      }
      expect(result.ok).toBe(true);
    });

    it(`${family}: the OLD underscore spelling is REJECTED (proves the pre-#1935 silent drop)`, () => {
      const bad = toUnderscoreType(envelope);
      expect(bad.type).toContain("_");
      expect(validateEnvelope(bad).ok).toBe(false);
    });
  }
});
