/**
 * #989 part-1 — sibling-bus PRESENCE SUBSCRIBER tests (TDD, RED-first).
 *
 * For each discovered sibling, the aggregator opens a read-only NATS connection
 * to that sibling's bus and subscribes to its
 * `local.{siblingPrincipal}.{siblingStack}.agent.>` subtree, folding inbound
 * presence into the SHARED registry tagged with the sibling's
 * `{principal}/{stack}` origin (so /api/agents groups it under its own hub).
 *
 * Coverage axes:
 *   1. Multi-bus fold — N siblings each delivering an `agent.online` ⇒ the
 *      shared registry has N agents, each tagged foreign by its origin stack.
 *   2. Origin tagging — a sibling agent's record carries
 *      `origin: { kind: "foreign", principal, stack }` matching the SIBLING's
 *      identity (not the serving stack's).
 *   3. Subject scoping — the subscriber binds the SIBLING's local subtree
 *      (`local.{sibPrincipal}.{sibStack}.agent.>`), so a stray non-presence /
 *      wrong-subject message is ignored.
 *   4. Graceful degrade — a sibling whose connection FAILS (bus down) is absent
 *      (no record), logged, and NEVER throws; other siblings still fold.
 *   5. noauth credential — a sibling with `credential.kind: "noauth"` IS
 *      connected (no pre-judging); an open bus folds, a locked one degrades via
 *      the connect-failure path.
 *   6. Lifecycle — `stop()` closes every sibling link + drains; idempotent.
 *   7. Malformed bytes on a sibling bus are dropped (not thrown).
 */

import { describe, expect, test, mock } from "bun:test";
import {
  AgentPresenceRegistry,
  isForeignOrigin,
} from "../../../../bus/agent-network/registry";
import {
  createAgentOnlineEvent,
  type AgentPresenceSource,
} from "../../../../bus/agent-network/builders";
import type { Envelope } from "../../../../bus/myelin/envelope-validator";
import {
  startSiblingPresenceAggregator,
  type SiblingBusConnection,
  type SiblingBusConnector,
} from "../sibling-presence-subscriber";
import type { SiblingStackDescriptor } from "../sibling-discovery";

/** Build an `agent.online` envelope for `{principal}/{stack}` + `agentId`. */
function onlineEnvelope(
  principal: string,
  stack: string,
  agentId: string,
): Envelope {
  const source: AgentPresenceSource = { principal, stack, instance: "local" };
  return createAgentOnlineEvent({
    source,
    identity: {
      nkey_public_key: `NKEY_${agentId}`,
      agent_id: agentId,
      assistant_name: agentId,
    },
    scope: { principal, stack },
    capabilities: ["chat"],
    startedAt: new Date(),
  });
}

/**
 * A fake sibling bus: records its subscribed pattern, lets the test push
 * envelopes, and tracks close(). The connector hands one out per sibling.
 */
class FakeBus implements SiblingBusConnection {
  subscribedPattern: string | null = null;
  closed = false;
  private handler: ((subject: string, data: Uint8Array) => void) | null = null;

  subscribe(
    pattern: string,
    onMessage: (subject: string, data: Uint8Array) => void,
  ): void {
    this.subscribedPattern = pattern;
    this.handler = onMessage;
  }

  /** Test helper — deliver an envelope on a subject as raw JSON bytes. */
  deliver(subject: string, envelope: Envelope): void {
    this.handler?.(subject, new TextEncoder().encode(JSON.stringify(envelope)));
  }

  /** Test helper — deliver raw (possibly malformed) bytes. */
  deliverRaw(subject: string, text: string): void {
    this.handler?.(subject, new TextEncoder().encode(text));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function descriptor(
  stack: string,
  url: string,
  principal = "andreas",
): SiblingStackDescriptor {
  return {
    stack,
    principal,
    url,
    credential: { kind: "creds", credsPath: `~/.config/nats/${stack}.creds` },
  };
}

describe("#989 sibling-presence-subscriber", () => {
  test("folds presence from N sibling buses into the shared registry, tagged by origin", async () => {
    const registry = new AgentPresenceRegistry();
    const buses = new Map<string, FakeBus>();
    const connector: SiblingBusConnector = async (sib) => {
      const bus = new FakeBus();
      buses.set(sib.stack, bus);
      return bus;
    };

    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [
        descriptor("work", "nats://127.0.0.1:4222"),
        descriptor("halden", "nats://127.0.0.1:4223"),
      ],
      connect: connector,
    });

    // Each sibling delivers its own agent.online on its own local subtree.
    buses
      .get("work")!
      .deliver(
        "local.andreas.work.agent.online",
        onlineEnvelope("andreas", "work", "luna"),
      );
    buses
      .get("halden")!
      .deliver(
        "local.andreas.halden.agent.online",
        onlineEnvelope("andreas", "halden", "sage"),
      );

    const agents = registry.getAgents();
    expect(agents.length).toBe(2);
    const work = agents.find((a) => a.stack === "work");
    const halden = agents.find((a) => a.stack === "halden");
    expect(work?.agentId).toBe("luna");
    expect(halden?.agentId).toBe("sage");
    // Origin is foreign (sibling), tagged with the SIBLING's identity.
    expect(isForeignOrigin(work!.origin)).toBe(true);
    expect(work!.origin).toEqual({
      kind: "foreign",
      principal: "andreas",
      stack: "work",
    });

    await handle.stop();
  });

  test("binds each sibling's own local presence subtree", async () => {
    const registry = new AgentPresenceRegistry();
    let captured: FakeBus | null = null;
    const connector: SiblingBusConnector = async () => {
      captured = new FakeBus();
      return captured;
    };
    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [descriptor("work", "nats://127.0.0.1:4222")],
      connect: connector,
    });
    expect(captured!.subscribedPattern).toBe("local.andreas.work.agent.>");
    await handle.stop();
  });

  test("a sibling whose connection fails degrades to absent (no throw, logged)", async () => {
    const registry = new AgentPresenceRegistry();
    const good = new FakeBus();
    const connector: SiblingBusConnector = async (sib) => {
      if (sib.stack === "halden") {
        throw new Error("ECONNREFUSED 127.0.0.1:4223");
      }
      return good;
    };

    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [
        descriptor("work", "nats://127.0.0.1:4222"),
        descriptor("halden", "nats://127.0.0.1:4223"),
      ],
      connect: connector,
    });

    // work folded; halden absent (connection threw).
    good.deliver(
      "local.andreas.work.agent.online",
      onlineEnvelope("andreas", "work", "luna"),
    );
    const agents = registry.getAgents();
    expect(agents.map((a) => a.stack)).toEqual(["work"]);

    // The failed sibling is reported on the handle for observability.
    expect(handle.degraded.map((d) => d.stack)).toContain("halden");

    await handle.stop();
  });

  test("a noauth sibling IS connected (open bus folds)", async () => {
    const registry = new AgentPresenceRegistry();
    const bus = new FakeBus();
    const connect = mock<SiblingBusConnector>(async () => bus);

    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [
        {
          stack: "halden",
          principal: "andreas",
          url: "nats://127.0.0.1:4223",
          credential: { kind: "noauth" },
        },
      ],
      connect,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(handle.degraded.length).toBe(0);
    bus.deliver(
      "local.andreas.halden.agent.online",
      onlineEnvelope("andreas", "halden", "sage"),
    );
    expect(registry.getAgents().map((a) => a.stack)).toEqual(["halden"]);
    await handle.stop();
  });

  test("a noauth sibling on a LOCKED bus degrades to absent (connect throws)", async () => {
    const registry = new AgentPresenceRegistry();
    const connect = mock<SiblingBusConnector>(async () => {
      throw new Error("Authorization Violation");
    });

    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [
        {
          stack: "community",
          principal: "andreas",
          url: "nats://127.0.0.1:4224",
          credential: { kind: "noauth" },
        },
      ],
      connect,
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(handle.degraded.map((d) => d.stack)).toContain("community");
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("malformed bytes on a sibling bus are dropped, not thrown", async () => {
    const registry = new AgentPresenceRegistry();
    const bus = new FakeBus();
    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [descriptor("work", "nats://127.0.0.1:4222")],
      connect: async () => bus,
    });
    expect(() =>
      bus.deliverRaw("local.andreas.work.agent.online", "{not json"),
    ).not.toThrow();
    expect(registry.getAgents().length).toBe(0);
    await handle.stop();
  });

  test("stop() closes every sibling link and is idempotent", async () => {
    const registry = new AgentPresenceRegistry();
    const buses: FakeBus[] = [];
    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [
        descriptor("work", "nats://127.0.0.1:4222"),
        descriptor("halden", "nats://127.0.0.1:4223"),
      ],
      connect: async () => {
        const b = new FakeBus();
        buses.push(b);
        return b;
      },
    });
    await handle.stop();
    await handle.stop(); // idempotent
    expect(buses.every((b) => b.closed)).toBe(true);
  });

  test("empty sibling list is a no-op (no connects)", async () => {
    const registry = new AgentPresenceRegistry();
    const connect = mock<SiblingBusConnector>(async () => new FakeBus());
    const handle = await startSiblingPresenceAggregator({
      registry,
      siblings: [],
      connect,
    });
    expect(connect).not.toHaveBeenCalled();
    await handle.stop();
  });
});
