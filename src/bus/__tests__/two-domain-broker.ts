import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "nats";

export const natsServerBinary = Bun.which("nats-server");

export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${description}`);
}

async function startServer(root: string, domain: string, remote?: string) {
  if (!natsServerBinary) throw new Error("nats-server binary unavailable on PATH");
  const config = join(root, `${domain}.conf`);
  await writeFile(config, `
server_name: "synthetic-${domain}"
listen: "127.0.0.1:-1"
jetstream {
  domain: "${domain}"
  store_dir: ${JSON.stringify(join(root, domain))}
}
leafnodes {
  ${remote ? `remotes: [{url: "${remote}"}]` : 'listen: "127.0.0.1:-1"'}
}
`);
  const proc = spawn(natsServerBinary, ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  let spawnError: Error | undefined;
  proc.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.once("error", (error) => { spawnError = error; resolve(); });
  });
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null || spawnError) return;
    proc.kill("SIGTERM");
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 2_000);
    try { await exited; } finally { clearTimeout(deadline); }
  };
  try {
    await waitFor(`${domain} broker startup`, () => {
      if (spawnError) throw spawnError;
      if (proc.exitCode !== null) throw new Error(`${domain} broker exited: ${logs}`);
      return logs.includes("Server is ready");
    });
    const port = /Listening for client connections on 127\.0\.0\.1:(\d+)/.exec(logs)?.[1];
    const leafPort = /Listening for leafnode connections on 127\.0\.0\.1:(\d+)/.exec(logs)?.[1];
    if (!port || (!remote && !leafPort)) throw new Error(`Missing broker listeners: ${logs}`);
    return { url: `nats://127.0.0.1:${port}`, leafUrl: `nats://127.0.0.1:${leafPort}`, stop };
  } catch (error) {
    await stop();
    throw new Error(`Could not start ${domain}: ${logs}`, { cause: error });
  }
}

export async function startTwoDomainBroker() {
  const root = await mkdtemp(join(tmpdir(), "cortex-two-domain-"));
  const servers: Awaited<ReturnType<typeof startServer>>[] = [];
  const connections: NatsConnection[] = [];
  const stop = async () => {
    try {
      for (const nc of connections) await nc.close();
    } finally {
      try {
        for (const server of servers.toReversed()) await server.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  try {
    const alpha = await startServer(root, "alpha");
    servers.push(alpha);
    const beta = await startServer(root, "beta", alpha.leafUrl);
    servers.push(beta);
    const nc = await connect({ servers: alpha.url, reconnect: false, timeout: 1_000 });
    connections.push(nc);
    let lastError: unknown;
    await waitFor("beta JetStream API reachable across the leaf connection", async () => {
      try {
        const manager = await nc.jetstreamManager({ domain: "beta", timeout: 250 });
        await manager.getAccountInfo();
        return true;
      } catch (error) {
        lastError = error;
        return false;
      }
    }).catch((error: unknown) => {
      throw new Error("Connected-domain readiness failed", { cause: lastError ?? error });
    });
    const alphaManager = await nc.jetstreamManager({ domain: "alpha" });
    const betaManager = await nc.jetstreamManager({ domain: "beta" });
    return { url: alpha.url, nc, alpha: alphaManager, beta: betaManager, stop, root };
  } catch (error) {
    await stop();
    throw error;
  }
}
