/**
 * cortex#1503 — two stacks of one principal on ONE NATS account.
 *
 * Drives the real stream provisioning (`provisionReviewStream`) and the real
 * per-agent wiring (`wireReviewConsumers`) for two stacks against a shared
 * in-memory JetStream, then publishes review requests and pulls each stack's
 * bound durables. Every request must be consumed by exactly one stack — the
 * one its subject addresses.
 *
 * Before #1503 both stacks shared `cortex-review-consumer-{principal}-{agent}`
 * (each boot's filter-drift branch deleted the other's durable) and the second
 * stack's subjects never joined the fixed-name stream, so this test failed on
 * both counts.
 */

import { describe, expect, test } from "bun:test";
import { DeliverPolicy } from "nats";
import { wireReviewConsumers, type ReviewBootAgent } from "../review-consumer-boot";
import { AgentRegistry } from "../../common/agents/registry";
import { TrustResolver } from "../../common/agents/trust-resolver";
import { resolveSigningKnobs } from "../../common/security-posture";
import type { MyelinRuntime, MyelinSubscribePullOpts } from "../../bus/myelin/runtime";
import type { MyelinSubscriber } from "../../bus/myelin/subscriber";
import { provisionReviewStream } from "../../bus/jetstream/provision";
import { reviewScopePatterns } from "../../bus/jetstream/review-subjects";
import { createFakeJetStream, type FakeJetStream } from "../../bus/jetstream/__tests__/fake-jetstream";

const PRINCIPAL = "alice";
const STREAM = "CODE_REVIEW";

const sage: ReviewBootAgent = {
  id: "sage",
  displayName: "Sage",
  trust: [],
  runtime: { substrate: "claude-code", capabilities: ["code-review.typescript"] },
};

function recordingRuntime(): MyelinRuntime & { binds: MyelinSubscribePullOpts[] } {
  const binds: MyelinSubscribePullOpts[] = [];
  return {
    enabled: true,
    binds,
    onEnvelope: () => ({ unregister: () => {} }),
    publish: async () => {},
    stop: async () => {},
    subscribePull: (opts: MyelinSubscribePullOpts): MyelinSubscriber => {
      binds.push(opts);
      return { pattern: opts.pattern, ready: Promise.resolve(), stop: async () => {} } as unknown as MyelinSubscriber;
    },
  };
}

const quietLog = { info: () => {}, warn: () => {} };

/** Boot one stack's review lane (stream + sage's durables) against the shared account. */
async function bootStack(
  js: FakeJetStream,
  stack: string,
  federation: boolean,
): Promise<MyelinSubscribePullOpts[]> {
  const pats = reviewScopePatterns(PRINCIPAL, stack);
  const subjects = federation ? [pats.local, pats.federatedOffer, pats.federatedDirect] : [pats.local];
  await provisionReviewStream({ jsm: js.jsm, name: STREAM, subjects, log: quietLog });
  const runtime = recordingRuntime();
  const { startForAgent } = wireReviewConsumers({
    reviewPrincipalId: PRINCIPAL,
    stack,
    trustResolver: new TrustResolver(AgentRegistry.fromAgents([])),
    signingKnobs: resolveSigningKnobs("off"),
    systemEventSource: { principal: PRINCIPAL, agent: "cortex", instance: "local" },
    runtime,
    buildSessionOpts: () => ({}),
    makeOfferAdmission: () => () => ({ admit: true }),
    federatedNetworks: [],
    reviewConsumers: [],
    reviewOfferingPatterns: [pats.local],
    reviewSubjectPattern: pats.local,
    reviewJsm: js.jsm,
    reviewStream: STREAM,
    reviewConsumerMaxDeliver: 5,
    federationConfigured: federation,
    reviewFederatedSubjectPattern: pats.federatedOffer,
    reviewFederatedDirectSubjectPattern: pats.federatedDirect,
  });
  const origLog = console.log;
  console.log = () => {};
  try {
    await startForAgent(sage);
  } finally {
    console.log = origLog;
  }
  return runtime.binds;
}

function requestsFor(stack: string): string[] {
  return [
    `local.${PRINCIPAL}.${stack}.tasks.code-review.typescript`,
    `federated.${PRINCIPAL}.${stack}.tasks.code-review.typescript`,
    `federated.${PRINCIPAL}.${stack}.tasks.@did-mf-bob.code-review.typescript`,
  ];
}

function drain(js: FakeJetStream, binds: MyelinSubscribePullOpts[]): string[] {
  return binds.flatMap((b) => js.pull(b.stream, b.durable));
}

describe("review lane — two stacks sharing one NATS account (cortex#1503)", () => {
  for (const federation of [false, true]) {
    test(`each request is consumed by exactly one stack (federation=${federation})`, async () => {
      const js = createFakeJetStream();
      // Boot order reproduces the old fight: default, work, then default restarts.
      await bootStack(js, "default", federation);
      const workBinds = await bootStack(js, "work", federation);
      const defaultBinds = await bootStack(js, "default", federation);

      const published = [...requestsFor("default"), ...requestsFor("work")].filter(
        (s) => federation || s.startsWith("local."),
      );
      for (const s of published) expect(js.publish(s)).toBe(STREAM);

      const gotDefault = drain(js, defaultBinds);
      const gotWork = drain(js, workBinds);
      expect(gotDefault.sort()).toEqual(published.filter((s) => s.includes(".default.")).sort());
      expect(gotWork.sort()).toEqual(published.filter((s) => s.includes(".work.")).sort());

      // No durable is shared between the stacks.
      const defaultDurables = new Set(defaultBinds.map((b) => b.durable));
      expect(workBinds.some((b) => defaultDurables.has(b.durable))).toBe(false);
      expect(defaultBinds).toHaveLength(federation ? 3 : 1);
    });
  }

  test("the stack's restart does not recreate the other stack's durable", async () => {
    const js = createFakeJetStream();
    await bootStack(js, "default", true);
    await bootStack(js, "work", true);
    await bootStack(js, "default", true);
    expect(js.consumerDeletes).toEqual([]);
  });
});

describe("review lane — single stack (cortex#1503 migration)", () => {
  test("binds the stack-scoped durable names", async () => {
    const js = createFakeJetStream();
    const binds = await bootStack(js, "default", true);
    expect(binds.map((b) => b.durable).sort()).toEqual(
      [
        "cortex-review-consumer-alice_default-sage",
        "cortex-review-consumer-federated-alice_default-sage",
        "cortex-review-consumer-federated-direct-alice_default-sage",
      ].sort(),
    );
  });

  test("a busy legacy durable (live puller) is bound this boot instead of the scoped one", async () => {
    const js = createFakeJetStream();
    const pats = reviewScopePatterns(PRINCIPAL, "default");
    await provisionReviewStream({ jsm: js.jsm, name: STREAM, subjects: [pats.local], log: quietLog });
    await js.jsm.consumers.add(STREAM, {
      durable_name: "cortex-review-consumer-alice-sage",
      filter_subject: pats.local,
      deliver_policy: DeliverPolicy.All,
    });
    js.setWaiting(STREAM, "cortex-review-consumer-alice-sage", 1);
    const origWarn = console.warn;
    console.warn = () => {};
    let binds: MyelinSubscribePullOpts[];
    try {
      binds = await bootStack(js, "default", false);
    } finally {
      console.warn = origWarn;
    }
    expect(binds.map((b) => b.durable)).toEqual(["cortex-review-consumer-alice-sage"]);
    expect(js.consumerNames(STREAM)).toEqual(["cortex-review-consumer-alice-sage"]);
  });

  test("upgrading replaces each idle legacy durable without replaying what it already processed", async () => {
    const js = createFakeJetStream();
    const pats = reviewScopePatterns(PRINCIPAL, "default");
    await provisionReviewStream({
      jsm: js.jsm,
      name: STREAM,
      subjects: [pats.local, pats.federatedOffer, pats.federatedDirect],
      log: quietLog,
    });
    const legacy: [string, string][] = [
      ["cortex-review-consumer-alice-sage", pats.local],
      ["cortex-review-consumer-federated-alice-sage", pats.federatedOffer],
      ["cortex-review-consumer-federated-direct-alice-sage", pats.federatedDirect],
    ];
    for (const [durable, filter] of legacy) {
      await js.jsm.consumers.add(STREAM, { durable_name: durable, filter_subject: filter, deliver_policy: DeliverPolicy.All });
    }
    const [local, fedOffer, fedDirect] = requestsFor("default");
    js.publish(local!);
    js.publish(fedOffer!);
    js.publish(fedDirect!);
    for (const [durable] of legacy) js.pull(STREAM, durable); // processed by the old version

    const binds = await bootStack(js, "default", true);
    expect(js.consumerNames(STREAM).sort()).toEqual(binds.map((b) => b.durable).sort());
    expect(drain(js, binds)).toEqual([]); // no replay

    js.publish(local!);
    expect(drain(js, binds)).toEqual([local!]); // new traffic flows
  });
});
