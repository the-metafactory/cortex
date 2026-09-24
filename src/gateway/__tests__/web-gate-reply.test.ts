/**
 * cortex#2524 — a principal gate on the `web` surface, end to end through the
 * REAL in-tree pieces: `SurfacePrincipalGate` (identity + verdict),
 * `GateReplyRouter` (the live `PrincipalReplySource`), and `SurfaceGateway`
 * with its new pre-route interceptor (the web adapter's ONLY boot path). The
 * adapter is a mock `platform: "web"` `PlatformAdapter` driving `onMessage`
 * exactly as the bundle's `POST /message` handler does (the bundle itself is
 * out-of-tree — the S9b boundary guard forbids importing it here).
 *
 * The interceptor and the `liveSurfaces` web row come from the SAME
 * production helpers `cortex.ts` composes (`createGateReplyInterceptor`,
 * `gatewayHostsSurface`), so a drift in either fails here.
 *
 * Proves, for one gate:
 *   1. the prompt renders with the web task source (wire routing intact);
 *   2. a reply from `authorId === principal.webId` resolves `pass`, and the
 *      gateway's inbound sink is NEVER called for it (consumed, no chat
 *      dispatch);
 *   3. a reply from anyone else is ignored — the gate times out to `fail`;
 *   4. with no `webId` configured the gate fails closed before rendering;
 *   5. a runtime never takes a reply bound to another stack — it routes on.
 */

import { describe, expect, test } from "bun:test";
import { SurfaceGateway, type GatewayInboundDecision, type GatewayInboundSink } from "../surface-gateway";
import { buildBindingIndex } from "../binding-resolver";
import { gatewayHostsSurface } from "../gateway-bootstrap";
import { createGateReplyInterceptor, type GateOwnerStack } from "../gate-reply-bridge";
import { testRegistryWithWeb } from "./test-registry-support";
import { GateReplyRouter } from "../../bus/gate-reply-router";
import {
  SurfacePrincipalGate,
  type GatePromptRenderer,
} from "../../bus/surface-principal-gate";
import type { InboundMessage, PlatformAdapter } from "../../adapters/types";
import type { Surfaces } from "../../common/types/surfaces";
import type { TaskSource } from "../../brain/protocol";

const PRINCIPAL_WEB_ID = "jc@example.org";
const INSTANCE = "web:console";
const CHANNEL = "arve-home";

const WEB_SURFACES: Surfaces = {
  web: [
    {
      agent: "arve",
      stack: "jc/switch",
      binding: {
        instanceId: "console",
        port: 8090,
        host: "127.0.0.1",
        broadcastUrl: "http://127.0.0.1:9090/broadcast",
        authScheme: "header",
        authHeader: "X-Cortex-User-Id",
      },
    },
  ],
};

/** Mock web adapter: stores `onMessage`, exposes `trigger` like the bundle's ingress. */
class MockWebAdapter implements PlatformAdapter {
  readonly platform = "web";
  readonly instanceId = INSTANCE;
  private onMessage: ((msg: InboundMessage) => Promise<void>) | null = null;
  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
  }
  async stop(): Promise<void> {
    this.onMessage = null;
  }
  /** What the bundle's `POST /message` builds — `authorId` from the auth header. */
  async post(authorId: string, body: string, thread?: string): Promise<void> {
    if (!this.onMessage) throw new Error("adapter not started");
    await this.onMessage({
      platform: "web",
      instanceId: INSTANCE,
      authorId,
      authorName: authorId,
      content: body,
      channelId: CHANNEL,
      ...(thread !== undefined && { threadId: thread }),
      attachments: [],
      timestamp: new Date(),
    });
  }
  async getPlatformUserId(): Promise<string> {
    return "arve";
  }
  async fetchContext() {
    return [];
  }
  resolveAccess() {
    return { allowed: false, features: { chat: false, async: false, team: false } };
  }
  async postResponse() {}
  async sendTyping() {}
  async sendProgress() {}
  async clearProgress() {}
  async createThread() {
    return { instanceId: INSTANCE, channelId: CHANNEL };
  }
  async resolveLogicalTarget() {
    return null;
  }
  async notifyPrincipal() {}
}

class RecordingSink implements GatewayInboundSink {
  readonly calls: { decision: GatewayInboundDecision; msg: InboundMessage }[] = [];
  async publish(decision: GatewayInboundDecision, msg: InboundMessage): Promise<void> {
    this.calls.push({ decision, msg });
  }
}

/** The bus-originated tick's task source (FW4 kick shape): wire routing + channel-keyed thread. */
function tickSource(): TaskSource {
  return { surface: "web", channel: CHANNEL, thread: CHANNEL, user: "", adapter_instance: INSTANCE };
}

/** The runtime the binding (`stack: "jc/switch"`) belongs to. */
const OWN_STACK: GateOwnerStack = { principal: "jc", stack: "switch" };

async function compose(opts: { webId?: string; timeoutMs?: number; own?: GateOwnerStack }) {
  const router = new GateReplyRouter();
  const rendered: { prompt: string; source: TaskSource }[] = [];
  const renderer: GatePromptRenderer = {
    render: (r) => {
      rendered.push({ prompt: r.prompt, source: r.source });
    },
  };
  const gate = new SurfacePrincipalGate({
    principalIdentity: opts.webId !== undefined ? { webId: opts.webId } : {},
    // cortex.ts's `surfaceGateMeta` web row, with the gateway flag on.
    liveSurfaces: new Set(
      gatewayHostsSurface({ CORTEX_GATEWAY: "1" }, WEB_SURFACES, "web") ? ["web"] : [],
    ),
    renderer,
    replySource: router,
    timeoutMs: opts.timeoutMs ?? 2_000,
  });
  const adapter = new MockWebAdapter();
  const sink = new RecordingSink();
  const gw = new SurfaceGateway(
    [adapter],
    buildBindingIndex(WEB_SURFACES, testRegistryWithWeb()),
    sink,
    {
      onUnroutable: () => {},
      interceptInbound: createGateReplyInterceptor({ router, own: opts.own ?? OWN_STACK }),
    },
  );
  await gw.start();
  return { gate, adapter, sink, rendered, router, gw };
}

/**
 * Wait until the gate has rendered its prompt, then yield once more so the
 * gate's `awaitReply` (registered right after `render` resolves) is in place
 * before the reply is offered. A reply offered with no waiter and no hot key
 * would route to the sink and fail the test for the wrong reason.
 */
async function untilRendered(rendered: unknown[], n = 1): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (rendered.length < n) {
    if (Date.now() > deadline) throw new Error("gate prompt never rendered");
    await Bun.sleep(1);
  }
  await Bun.sleep(0);
}

const resolveOpts = (source: TaskSource) => ({
  agentId: "arve",
  taskId: "tick-1",
  gate: "deliver-digest",
  prompt: "Send today's digest?",
  source,
});

describe("web surface principal gate (cortex#2524)", () => {
  test("principal reply through the gateway resolves pass; sink never called", async () => {
    const { gate, adapter, sink, rendered } = await compose({ webId: PRINCIPAL_WEB_ID });
    const pending = gate.resolve(resolveOpts(tickSource()));
    await untilRendered(rendered);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.source.surface).toBe("web");
    expect(rendered[0]?.source.adapter_instance).toBe(INSTANCE);

    // The bundle's POST /message with the principal's header identity.
    await adapter.post(PRINCIPAL_WEB_ID, "yes");
    const verdict = await pending;
    expect(verdict.verdict).toBe("pass");
    expect(verdict.principal).toBe(PRINCIPAL_WEB_ID);
    // Consumed by the gate — never became a chat dispatch.
    expect(sink.calls).toHaveLength(0);
  });

  test("an impostor's 'yes' is ignored; the gate times out to fail", async () => {
    const { gate, adapter, sink, rendered } = await compose({ webId: PRINCIPAL_WEB_ID, timeoutMs: 150 });
    const pending = gate.resolve(resolveOpts(tickSource()));
    await untilRendered(rendered);
    await adapter.post("someone-else", "yes");
    const verdict = await pending;
    expect(verdict.verdict).toBe("fail");
    expect(verdict.principal).toBe("");
    expect(verdict.notes).toContain("no reply from principal");
    // The impostor's message was still consumed by the open gate's thread
    // (modal thread) — not routed to chat either.
    expect(sink.calls).toHaveLength(0);
  });

  test("a threaded reply correlates on the thread id, not the channel", async () => {
    const { gate, adapter, rendered } = await compose({ webId: PRINCIPAL_WEB_ID });
    const pending = gate.resolve(
      resolveOpts({ ...tickSource(), thread: "t-77" }),
    );
    await untilRendered(rendered);
    await adapter.post(PRINCIPAL_WEB_ID, "approve", "t-77");
    expect((await pending).verdict).toBe("pass");
  });

  test("no webId configured → fail closed before rendering", async () => {
    const { gate, rendered } = await compose({});
    const verdict = await gate.resolve(resolveOpts(tickSource()));
    expect(verdict.verdict).toBe("fail");
    expect(verdict.notes).toContain('no configured principal id for surface "web"');
    expect(rendered).toHaveLength(0);
  });

  test("a reply bound to another stack is never offered to this runtime's gate", async () => {
    const { gate, adapter, sink, rendered } = await compose({
      webId: PRINCIPAL_WEB_ID,
      timeoutMs: 150,
      own: { principal: "jc", stack: "default" },
    });
    const pending = gate.resolve(resolveOpts(tickSource()));
    await untilRendered(rendered);
    await adapter.post(PRINCIPAL_WEB_ID, "yes");
    // The binding is jc/switch, this runtime is jc/default: the reply routes
    // on to its own stack and the gate here never sees it.
    expect((await pending).verdict).toBe("fail");
    expect(sink.calls).toHaveLength(1);
  });

  test("an unrelated web message still routes to the sink (interceptor is a pass-through without an open gate)", async () => {
    const { adapter, sink } = await compose({ webId: PRINCIPAL_WEB_ID });
    await adapter.post(PRINCIPAL_WEB_ID, "hello arve");
    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]?.decision.responseRouting.adapter_instance).toBe(INSTANCE);
  });
});
