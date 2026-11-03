import { DiscordConversations } from "../../discord";
import type { ConversationHost, HostOptions } from "../../host";
import { FakeThreads } from "./discord-threads";
import { openHost } from "./scratch";

export const RIG = { label: "ai.meta-factory.cortex.test", principal: "111111111111111111", guild: "2222222222222222222", channel: "3333333333333333333", web: "http://127.0.0.1:8767", owner: "principal@example.org" };

export async function bridgeRig(hosts: { close: () => Promise<void> }[], dir: string, host: Pick<HostOptions, "turns" | "resolvers">, now?: () => Date): Promise<{ host: ConversationHost; fake: FakeThreads; lines: string[]; bridge: DiscordConversations }> {
  const opened = await openHost(hosts, { dir, stack: "test", label: RIG.label, expectedLabel: RIG.label, lanes: { local: { provider: "t", model: "l" }, cloud: { provider: "t", model: "c" } }, turns: host.turns, ...(host.resolvers ? { resolvers: host.resolvers } : {}) });
  const fake = new FakeThreads();
  const lines: string[] = [];
  const bridge = new DiscordConversations({ host: opened, adapter: () => fake, config: { channelId: RIG.channel, guildId: RIG.guild, webUrl: RIG.web }, principalId: RIG.principal, ...(now ? { now } : {}), log: line => { lines.push(line); } });
  bridge.setWebPrincipal(RIG.owner);
  return { host: opened, fake, lines, bridge };
}
