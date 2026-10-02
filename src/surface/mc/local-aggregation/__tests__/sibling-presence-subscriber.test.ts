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

import { describe, expect, test, mock, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
import {
  discoverSiblingStacks,
  type SiblingStackDescriptor,
} from "../sibling-discovery";
import {
  writeCredsWithPermissions,
  writeObserverCreds,
  writeStackDir,
} from "./fixtures";

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

  // #2536 — a sibling with no observer creds is NEVER connected; the principal
  // gets one boot-time hint with the exact scope to mint.
  describe("#2536 no-observer siblings", () => {
    test("a no-observer sibling is degraded WITHOUT a connect attempt, and the mint hint is logged", async () => {
      const registry = new AgentPresenceRegistry();
      const connect = mock<SiblingBusConnector>(async () => new FakeBus());
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const handle = await startSiblingPresenceAggregator({
          registry,
          siblings: [
            {
              stack: "work",
              principal: "alice",
              url: "nats://127.0.0.1:4222",
              credential: {
                kind: "no-observer",
                reason: "missing",
                observerUser: "mc-observer-default-to-work",
                observerCredsPath: "/creds/mc-observer-default-to-work.creds",
              },
            },
          ],
          connect,
        });

        expect(connect).not.toHaveBeenCalled();
        expect(handle.degraded.map((d) => d.stack)).toEqual(["work"]);
        expect(handle.degraded[0]!.reason).toContain("no observer creds");

        const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("local.alice.work.agent.>");
        expect(logged).toContain("--deny-pub '>'");
        expect(logged).toContain("/creds/mc-observer-default-to-work.creds");
        // Logged ONCE for the sibling (one boot-time hint, not per retry).
        expect(logged.split("arc nats add-bot").length - 1).toBe(1);
        await handle.stop();
      } finally {
        stderr.mockRestore();
      }
    });

    test("discovery → aggregator: a sibling stack's own creds path never reaches the connect port", async () => {
      const root = mkdtempSync(join(tmpdir(), "cortex-agg-obs-"));
      const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const observerDir = join(root, "observer-creds");
        mkdirSync(observerDir);
        // Four siblings, all with their own stack credsPath (unrestricted user):
        //   work     — scoped observer minted       → connects with the observer path
        //   research — no observer                  → never connected
        //   lab      — observer symlinked to lab's creds → refused
        //   ops      — byte copy of ops's creds as the observer → refused (over-scoped)
        const stackCreds = (s: string): string => join(root, `stack-${s}.creds`);
        for (const s of ["work", "research", "lab", "ops"]) {
          writeCredsWithPermissions(stackCreds(s), {});
          writeStackDir(root, s, {
            principal: "alice",
            stackId: `alice/${s}`,
            url: "nats://127.0.0.1:4222",
            credsPath: stackCreds(s),
          });
        }
        const observer = (s: string): string =>
          join(observerDir, `mc-observer-default-to-${s}.creds`);
        writeObserverCreds(observer("work"), "alice", "work");
        symlinkSync(stackCreds("lab"), observer("lab"));
        writeCredsWithPermissions(observer("ops"), {});

        const siblings = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
        });

        const seen: SiblingStackDescriptor[] = [];
        const connect: SiblingBusConnector = async (sib) => {
          seen.push(sib);
          return new FakeBus();
        };
        const handle = await startSiblingPresenceAggregator({
          registry: new AgentPresenceRegistry(),
          siblings,
          connect,
        });

        // Only `work` reached the connect port — with its OBSERVER creds.
        expect(seen.map((s) => s.stack)).toEqual(["work"]);
        expect(seen[0]!.credential).toEqual({ kind: "creds", credsPath: observer("work") });
        // No sibling stack's own creds path was ever handed to connect.
        const handed = JSON.stringify(seen);
        for (const s of ["work", "research", "lab", "ops"]) {
          expect(handed).not.toContain(stackCreds(s));
        }
        expect(handle.degraded.map((d) => d.stack).sort()).toEqual(["lab", "ops", "research"]);
        await handle.stop();
      } finally {
        stderr.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
