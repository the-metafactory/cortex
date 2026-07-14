/**
 * cortex#596 — no-binding-match routing-decision emit tests (TDD Red→Green).
 *
 * Covers the UPSTREAM unroutable case PR #1667 left as stdout-only: an inbound
 * that matches NO binding. Mirrors the emit-assertion shape of
 * `bus-inbound-sink.test.ts` (the publish-refusal twin).
 *
 * Tests:
 *   1. no-binding inbound → emits system.gateway.routing-decision
 *      { outcome: "unroutable", reason, platform, instanceId } and NO agent.
 *   2. source undefined → no emit, no throw (optional-dep guard).
 *   3. runtime undefined → no emit, no throw.
 *   4. runtime without publish (stub `{}`) → no emit, no throw.
 *   5. makeEmittingUnroutable → runs the base breadcrumb AND emits (deps live).
 *   6. makeEmittingUnroutable → still runs the base breadcrumb when deps are
 *      absent (emit skipped) — the console.warn fallback survives a bus outage.
 */

import { describe, expect, test } from "bun:test";
import {
  emitUnroutableRoutingDecision,
  makeEmittingUnroutable,
} from "../gateway-unroutable-emit";
import type { InboundMessage } from "../../adapters/types";
import type { MyelinRuntime } from "../../bus/myelin/runtime";
import type { SystemEventSource } from "../../bus/system-events";
import type { Envelope } from "../../bus/myelin/envelope-validator";

// =============================================================================
// Fixtures
// =============================================================================

const STUB_SOURCE: SystemEventSource = {
  principal: "andreas",
  agent: "gateway",
  instance: "gateway-0",
  dataResidency: "NZ",
};

/** A no-binding inbound — DM on Discord (no guildId), or an unbound guild. */
function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "discord",
    instanceId: "discord:999888777",
    authorId: "user-discord-55555",
    authorName: "Stranger",
    channelId: "channel-zzz",
    content: "hello?",
    attachments: [],
    timestamp: new Date("2026-07-08T00:00:00.000Z"),
    ...overrides,
  };
}

/** Runtime stub that captures every published envelope. */
function makeCapturingRuntime(): {
  runtime: MyelinRuntime;
  published: Envelope[];
} {
  const published: Envelope[] = [];
  const runtime = {
    publish: (env: Envelope): Promise<void> => {
      published.push(env);
      return Promise.resolve();
    },
  } as unknown as MyelinRuntime;
  return { runtime, published };
}

const REASON = 'no binding for discord guildId "111222333"';

// =============================================================================
// Tests
// =============================================================================

describe("emitUnroutableRoutingDecision", () => {
  test("no-binding inbound → emits system.gateway.routing-decision { unroutable, reason }, no agent", () => {
    const { runtime, published } = makeCapturingRuntime();

    emitUnroutableRoutingDecision(
      { runtime, source: STUB_SOURCE },
      makeMsg(),
      REASON,
    );

    const evt = published.find(
      (e) => e.type === "system.gateway.routing-decision",
    );
    expect(evt).toBeDefined();
    const payload = evt!.payload;
    expect(payload.outcome).toBe("unroutable");
    expect(payload.reason).toBe(REASON);
    expect(payload.platform).toBe("discord");
    expect(payload.instance_id).toBe("discord:999888777");
    // No binding matched → no agent / stack / principal / subject stamped.
    expect(payload.agent).toBeUndefined();
    expect(payload.stack).toBeUndefined();
    expect(payload.principal).toBeUndefined();
    expect(payload.subject).toBeUndefined();
  });

  test("source undefined → emit skipped, no throw", () => {
    const { runtime, published } = makeCapturingRuntime();
    expect(() =>
      emitUnroutableRoutingDecision(
        { runtime, source: undefined },
        makeMsg(),
        REASON,
      ),
    ).not.toThrow();
    expect(published).toHaveLength(0);
  });

  test("runtime undefined → emit skipped, no throw", () => {
    expect(() =>
      emitUnroutableRoutingDecision(
        { runtime: undefined, source: STUB_SOURCE },
        makeMsg(),
        REASON,
      ),
    ).not.toThrow();
  });

  test("runtime without publish (stub {}) → emit skipped, no throw", () => {
    const stubRuntime = {} as MyelinRuntime;
    expect(() =>
      emitUnroutableRoutingDecision(
        { runtime: stubRuntime, source: STUB_SOURCE },
        makeMsg(),
        REASON,
      ),
    ).not.toThrow();
  });
});

describe("makeEmittingUnroutable", () => {
  test("live deps → runs the base breadcrumb AND emits the event", () => {
    const { runtime, published } = makeCapturingRuntime();
    const baseCalls: { msg: InboundMessage; reason: string }[] = [];
    const base = (msg: InboundMessage, reason: string): void => {
      baseCalls.push({ msg, reason });
    };

    const handler = makeEmittingUnroutable(base, {
      runtime,
      source: STUB_SOURCE,
    });
    const msg = makeMsg();
    handler(msg, REASON);

    // Breadcrumb ran with the same args…
    expect(baseCalls).toHaveLength(1);
    expect(baseCalls[0]?.msg).toBe(msg);
    expect(baseCalls[0]?.reason).toBe(REASON);
    // …and the event was emitted.
    const evt = published.find(
      (e) => e.type === "system.gateway.routing-decision",
    );
    expect(evt).toBeDefined();
    expect(evt!.payload.outcome).toBe("unroutable");
    expect(evt!.payload.reason).toBe(REASON);
  });

  test("deps absent → breadcrumb still runs, emit skipped, no throw", () => {
    let baseRan = false;
    const base = (): void => {
      baseRan = true;
    };

    const handler = makeEmittingUnroutable(base, {
      runtime: undefined,
      source: undefined,
    });

    expect(() => handler(makeMsg(), REASON)).not.toThrow();
    expect(baseRan).toBe(true);
  });
});
