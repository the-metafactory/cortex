import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type ConversationHost, type HostOptions } from "../../host";
import type { TurnCall, TurnRequest } from "../../model";

export function scratchDirs(prefix: string): { make: () => Promise<string>; clean: () => Promise<void> } {
  const dirs: string[] = [];
  return {
    make: async () => {
      const dir = await mkdtemp(join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    clean: async () => {
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}

export function scratchHosts(prefix: string): { dirs: ReturnType<typeof scratchDirs>; hosts: { close: () => Promise<void> }[] } {
  const dirs = scratchDirs(prefix);
  const hosts: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    await dirs.clean();
  });
  return { dirs, hosts };
}

export const answering = (answer: (request: TurnRequest) => string | Promise<string>): TurnCall => async request => ({ text: await answer(request), session: request.session, resumed: false });

export async function openHost(hosts: { close: () => Promise<void> }[], options: HostOptions): Promise<ConversationHost> {
  const status = await openConversationHost(options);
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  return status.host;
}
