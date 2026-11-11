#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { probeChecks } from "./lib/probe-checks";
import { preflight, redactor, type HostedProbeConfig } from "./desk-adapter-hosted/preflight";
import { runHostedChecks } from "./desk-adapter-hosted/checks";
import { openSyntheticStack } from "./desk-adapter-hosted/stack";

export { preflight } from "./desk-adapter-hosted/preflight";

const NOT_RUN_EXIT = 2;
const READY_TIMEOUT_MS = 45_000;
const ACCESS_REFUSED_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308, 401, 403]);
const defaultConfigPath = () => process.env["DESK_PROBE_CONFIG"] ?? join(homedir(), ".config", "metafactory", "cortex", "desk-probe", "probe.yaml");

function notRun(reason: string): never {
  console.error(`Not run: ${reason}.`);
  process.exit(NOT_RUN_EXIT);
}

async function waitUntilReady(send: (path: string) => Promise<Response>): Promise<string | undefined> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await send("/__probe/ready").catch(() => undefined);
    if (response?.status === 200) return undefined;
    if (response && ACCESS_REFUSED_STATUSES.has(response.status)) return "Access refused the service token (invalid, expired or not in the probe policy)";
    await Bun.sleep(1000);
  }
  return `the tunnel did not become reachable within ${READY_TIMEOUT_MS / 1000} seconds`;
}

async function main(): Promise<never> {
  const targetFlag = process.argv.indexOf("--target");
  const configPath = defaultConfigPath();
  const rawConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined;
  const checked = preflight({ rawConfig, target: targetFlag >= 0 ? process.argv[targetFlag + 1] ?? "" : undefined, now: new Date() });
  if (!checked.ok) notRun(checked.reason);
  const config: HostedProbeConfig = checked.config;
  const redact = redactor(config);
  const probe = probeChecks();
  const stack = await openSyntheticStack(config.hostname);
  const origin = Bun.serve({ hostname: "127.0.0.1", port: config.localPort, fetch: request => stack.handle(request) });
  const tunnel = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "run"], { env: { ...process.env, TUNNEL_TOKEN: config.tunnelToken }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const route = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(`https://${config.hostname}${path}`, { method, redirect: "manual", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const send = (method: string, path: string, body?: unknown) => route(method, path, body, { "cf-access-client-id": config.clientId, "cf-access-client-secret": config.clientSecret });
  const sendWithoutToken = (method: string, path: string, body?: unknown) => route(method, path, body);
  let unready: string | undefined;
  try {
    unready = await waitUntilReady(path => send("GET", path));
    if (!unready) await runHostedChecks(stack, send, sendWithoutToken, probe);
  } catch (error) {
    probe.check(false, redact(`the probe stopped on an error: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    tunnel.kill();
    await origin.stop(true);
    await stack.close();
  }
  if (unready) notRun(redact(unready));
  return probe.finish("hosted-route check(s) failed.", "Desk hosted-route probe passed: approve, edit, denied destination and matched generation through Access; the tokenless request was refused. Synthetic stack only.");
}

if (import.meta.main) await main();
