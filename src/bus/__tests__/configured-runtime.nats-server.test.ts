import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOperator, createAccount, createUser } from "@nats-io/nkeys";
import { Algorithms, encodeOperator, encodeAccount, encodeUser, fmtCreds } from "@nats-io/jwt";
import { connect, credsAuthenticator } from "nats";
import { stringify } from "yaml";
import { createInMemoryRegistry, verifyEnvelopeIdentity } from "@the-metafactory/myelin/identity";
import { safeDecodeEnvelope } from "@the-metafactory/myelin/envelope";
import { startConfiguredMyelinRuntime } from "../configured-runtime";
import { nkeyToBase64Pubkey } from "../verify-signed-by-chain";
import { MyelinDurablePublishError } from "../myelin/runtime";
import { validateEnvelope } from "../myelin/envelope-validator";

const executable = Bun.which("nats-server");
test.skipIf(executable === null)("configured runtime coexists with an observer and signs through real authenticated NATS", async () => {
  if (!executable) throw new Error("nats-server unavailable");
  const dir = mkdtempSync(join(tmpdir(), "configured-bus-native-"));
  try {
  const operator = createOperator(); const account = createAccount(); const user = createUser();
  const operatorJwt = await encodeOperator("synthetic", operator, {}, { algorithm: Algorithms.v2 });
  const accountJwt = await encodeAccount("synthetic", account, { limits: { conn: -1, subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, leaf: -1, disallow_bearer: false } }, { signer: operator, algorithm: Algorithms.v2 });
  const userJwt = await encodeUser("synthetic", user, account, { subs: -1, data: -1, payload: -1 }, { algorithm: Algorithms.v2 });
  const credentials = fmtCreds(userJwt, user);
  const credsPath = join(dir, "synthetic.creds");
  writeFileSync(credsPath, credentials, { mode: 0o600 });
  const seedPath = join(dir, "synthetic.nk"); writeFileSync(seedPath, user.getSeed(), { mode: 0o600 });
  const serverConfig = join(dir, "nats.conf");
  writeFileSync(serverConfig, `host: 127.0.0.1\nport: -1\noperator: ${operatorJwt}\nresolver: MEMORY\nresolver_preload: { ${account.getPublicKey()}: ${accountJwt} }\nports_file_dir: ${JSON.stringify(dir)}\n`);
  const serverLog = join(dir, "server.log");
  const server = Bun.spawn([executable, "-c", serverConfig, "-l", serverLog], { stdout: "ignore", stderr: "ignore" });
  let serverStopped = false;
  let observer: Awaited<ReturnType<typeof connect>> | undefined;
  let runtime: Awaited<ReturnType<typeof startConfiguredMyelinRuntime>> | undefined;
  try {
    let url: string | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const file = readdirSync(dir).find((name) => name.endsWith(".ports"));
      if (file) {
        const ports: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (typeof ports === "object" && ports !== null && "nats" in ports && Array.isArray(ports.nats) && typeof ports.nats[0] === "string") url = ports.nats[0];
      }
      if (url) break;
      await Bun.sleep(50);
    }
    if (!url) throw new Error("synthetic server unavailable");
    observer = await connect({ servers: [url], authenticator: credsAuthenticator(credentials), timeout: 2000, maxReconnectAttempts: 0 });
    const sub = observer.subscribe("local.synthetic.work.tasks.synthetic");
    await observer.flush();
    const configPath = join(dir, "cortex.yaml");
    writeFileSync(join(dir, "helper.md"), "Synthetic");
    writeFileSync(configPath, stringify({ principal: { id: "synthetic", displayName: "Synthetic", discordId: "1" }, stack: { id: "synthetic/work", nkey_pub: user.getPublicKey(), nkey_seed_path: seedPath }, agents: [{ id: "helper", displayName: "Helper", persona: "./helper.md", roles: [], trust: [], presence: {} }], claude: {}, security: { signing: "enforce" }, nats: { url, name: "synthetic-daemon", credsPath, subjects: [] } }), { mode: 0o600 });
    runtime = await startConfiguredMyelinRuntime(configPath, { expectedStackId: "synthetic/work", expectedNkey: user.getPublicKey() });
    expect(runtime.enabled).toBe(true);
    await expect(startConfiguredMyelinRuntime(configPath, { expectedStackId: "synthetic/work", expectedNkey: user.getPublicKey(), jetstreamDomain: "" })).rejects.toThrow("jetstreamDomain must be a non-empty string");
    const value = validateEnvelope({ id: crypto.randomUUID(), source: "synthetic.work.helper", type: "tasks.synthetic", timestamp: new Date().toISOString(), sovereignty: { classification: "local", data_residency: "CH", max_hop: 0, frontier_ok: false, model_class: "local-only" }, payload: { synthetic: true } });
    if (!value.ok) throw new Error("fixture envelope invalid");
    await expect(runtime.publish({ ...value.envelope, sovereignty: { ...value.envelope.sovereignty, classification: "federated" } })).rejects.toThrow("refuses non-local classification");
    await expect(runtime.publish({ ...value.envelope, source: "synthetic.other.helper" })).rejects.toThrow("source outside pinned stack");
    const publishOnSubject = runtime.publishOnSubject?.bind(runtime);
    const publishDurable = runtime.publishDurable?.bind(runtime);
    if (!publishOnSubject || !publishDurable) throw new Error("native publish methods absent");
    for (const subject of ["public.outside", "local.synthetic.work.tasks.*", "local.synthetic.work.tasks.", "local.synthetic.work.tasks..invalid", "local.synthetic.work.tasks.bad token", "local.synthetic.work.tasks.bad\r\nPUB public.outside 0\r\n"]) {
      await expect(publishOnSubject(value.envelope, subject)).rejects.toThrow("subject outside pinned stack");
    }
    await expect(publishOnSubject({ ...value.envelope, sovereignty: { ...value.envelope.sovereignty, classification: "federated" } }, "local.synthetic.work.tasks.synthetic")).rejects.toThrow("refuses non-local classification");
    await expect(publishDurable({ ...value.envelope, sovereignty: { ...value.envelope.sovereignty, classification: "federated" } }, { expectedStream: "SYNTHETIC" })).rejects.toBeInstanceOf(MyelinDurablePublishError);
    await expect(publishDurable({ ...value.envelope, source: "synthetic.other.helper" }, { expectedStream: "SYNTHETIC" })).rejects.toMatchObject({ kind: "unroutable" });
    const receive = (async () => { for await (const message of sub) return message.data; return null; })();
    await runtime.publish(value.envelope);
    const bytes = await Promise.race([receive, Bun.sleep(2000).then(() => null)]);
    if (!bytes) throw new Error("signed publish not observed");
    const received = safeDecodeEnvelope(bytes, undefined);
    if (!received) throw new Error("published envelope invalid");
    const publicKey = nkeyToBase64Pubkey(user.getPublicKey());
    if (!publicKey) throw new Error("synthetic key invalid");
    const identities = createInMemoryRegistry(); identities.add({ id: "did:mf:synthetic-work", network: "synthetic", public_key: publicKey, type: "service", created_at: new Date().toISOString() });
    expect((await verifyEnvelopeIdentity(received, identities)).status).toBe("verified");
    expect(observer.isClosed()).toBe(false);
    sub.unsubscribe();
    await runtime.stop(); runtime = undefined; await observer.drain(); observer = undefined;
    server.kill(); await server.exited; serverStopped = true;
    const before = Date.now();
    await expect(startConfiguredMyelinRuntime(configPath, { expectedStackId: "synthetic/work", expectedNkey: user.getPublicKey(), connectTimeoutMs: 100 })).rejects.toThrow("configured bus connection failed");
    expect(Date.now() - before).toBeLessThan(2000);
  } finally { await Promise.allSettled([runtime?.stop(), observer?.drain()]); if (!serverStopped) { server.kill(); await server.exited; } rmSync(dir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
