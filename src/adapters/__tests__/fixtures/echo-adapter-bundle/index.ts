/**
 * cortex#1792 (S6) — adapter-kind happy-path load fixture. ZERO cortex
 * runtime code — the only cortex-adjacent import is `import type` from
 * `surface-sdk`, erased at runtime. Implements the minimal `PlatformAdapter`
 * surface (mirrors `src/adapters/mock.ts`'s shape, independently, without
 * importing it — a real bundle has no access to cortex-internal test
 * doubles) so the loader's shape-validator accepts it and registers it.
 */

import { z } from "zod/v4";
import type {
  AccessDecision,
  AdapterPlugin,
  ContextMessage,
  InboundMessage,
  OutboundFile,
  PlatformAdapter,
  ResponseTarget,
} from "../../../../surface-sdk";

const ALLOW_ALL: AccessDecision = {
  allowed: true,
  features: { chat: true, async: true, team: true },
};

class FixtureEchoAdapter implements PlatformAdapter {
  readonly platform = "fixture-echo";
  readonly instanceId: string;

  constructor(instanceId = "fixture-echo-instance") {
    this.instanceId = instanceId;
  }

  async start(_onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {}
  async stop(): Promise<void> {}
  async getPlatformUserId(): Promise<string> {
    return "fixture-echo-bot";
  }
  async fetchContext(_msg: InboundMessage, _depth: number): Promise<ContextMessage[]> {
    return [];
  }
  resolveAccess(_msg: InboundMessage): AccessDecision {
    return ALLOW_ALL;
  }
  async postResponse(_target: ResponseTarget, _text: string, _files?: OutboundFile[]): Promise<void> {}
  async sendTyping(_target: ResponseTarget): Promise<void> {}
  async sendProgress(_target: ResponseTarget, _text: string): Promise<void> {}
  async clearProgress(_target: ResponseTarget): Promise<void> {}
  async createThread(_msg: InboundMessage, _name: string): Promise<ResponseTarget> {
    return { instanceId: this.instanceId, channelId: "fixture-channel" };
  }
  async resolveLogicalTarget(_addr: {
    surface: string;
    channel: string;
    thread?: string;
  }): Promise<ResponseTarget | null> {
    return null;
  }
  async notifyPrincipal(_text: string): Promise<void> {}
}

const FixtureEchoBindingSchema = z.object({ token: z.string().min(1) }).catchall(z.unknown());

const fixtureEchoAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "fixture-echo",
  platform: "fixture-echo",
  bindingSchema: FixtureEchoBindingSchema,
  foldsIntoPresence: false,
  secretFields: ["token"],
  demuxKey: (binding) => {
    const token = (binding as { token?: unknown }).token;
    return typeof token === "string" ? token : "default";
  },
  buildGatewayConstructArgs: (group, base) => ({
    instanceId: base.instanceId,
    binding: group.entries[0]?.binding,
  }),
  createAdapter: (args) => new FixtureEchoAdapter((args as { instanceId?: string }).instanceId),
};

export default fixtureEchoAdapterPlugin;
