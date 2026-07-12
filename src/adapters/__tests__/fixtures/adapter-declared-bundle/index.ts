/**
 * cortex#1794 (S9a) — first-party ADAPTER exemption happy-path fixture.
 * ZERO cortex runtime code — mirrors `echo-adapter-bundle/index.ts`'s shape
 * exactly (only cortex-adjacent import is `import type` from `surface-sdk`,
 * erased at runtime) under a distinct id/platform so it cannot collide with
 * any in-tree platform or the other adapter fixtures.
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

class FixtureDeclaredAdapter implements PlatformAdapter {
  readonly platform = "fixture-declared-adapter";
  readonly instanceId: string;

  constructor(instanceId = "fixture-declared-adapter-instance") {
    this.instanceId = instanceId;
  }

  async start(_onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {}
  async stop(): Promise<void> {}
  async getPlatformUserId(): Promise<string> {
    return "fixture-declared-adapter-bot";
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
    return { instanceId: this.instanceId, channelId: "fixture-declared-channel" };
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

const FixtureDeclaredBindingSchema = z.object({ token: z.string().min(1) }).catchall(z.unknown());

const fixtureDeclaredAdapterPlugin: AdapterPlugin = {
  kind: "adapter",
  id: "fixture-declared-adapter",
  platform: "fixture-declared-adapter",
  bindingSchema: FixtureDeclaredBindingSchema,
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
  createAdapter: (args) => new FixtureDeclaredAdapter((args as { instanceId?: string }).instanceId),
};

export default fixtureDeclaredAdapterPlugin;
