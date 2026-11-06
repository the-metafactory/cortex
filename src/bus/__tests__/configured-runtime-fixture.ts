import { mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "nkeys.js";
import { stringify } from "yaml";

let dialOptions: unknown;
mock.module("nats", () => ({ connect: async (options: unknown) => { dialOptions = options; return {}; } }));
const scenario = process.argv[2] ?? "valid";
const dir = mkdtempSync(join(tmpdir(), "configured-runtime-"));
try {
const pair = createUser();
const pubkey = pair.getPublicKey();
const declaredPubkey = scenario === "seed-mismatch" ? createUser().getPublicKey() : pubkey;
const seedPath = join(dir, "synthetic.nk");
writeFileSync(seedPath, pair.getSeed(), { mode: 0o600 });
if (scenario === "public-seed") chmodSync(seedPath, 0o644);
if (scenario === "invalid-seed") writeFileSync(seedPath, "synthetic-invalid-seed");
writeFileSync(join(dir, "synthetic.creds"), "synthetic", { mode: 0o600 });
if (scenario === "missing-file") unlinkSync(join(dir, "synthetic.creds"));
if (scenario === "public-creds") chmodSync(join(dir, "synthetic.creds"), 0o644);
const calls: unknown[] = [];
let stopped = false;
mock.module("../myelin/runtime", () => ({ MyelinDurablePublishError: class extends Error {}, startMyelinRuntime: async (config: unknown, options: unknown) => {
  calls.push({ config, options });
  return { publish: async () => {}, publishOnSubject: async () => {}, publishDurable: async () => ({ stream: "SYNTHETIC", seq: 1, duplicate: false }), enabled: !["disabled", "stop-rejects"].includes(scenario), stop: async () => { stopped = true; if (scenario === "stop-rejects") throw new Error("synthetic stop failure"); } };
} }));
const config = {
  claude: { timeoutMs: 120000 },
  principal: { id: "synthetic", displayName: "Synthetic", discordId: "1" },
  stack: { id: "synthetic/work", ...(scenario !== "missing-pin" ? { nkey_pub: declaredPubkey } : {}), ...(scenario !== "missing-signer" ? { nkey_seed_path: seedPath } : {}) },
  agents: [{ id: "helper", displayName: "Helper", persona: "./helper.md", roles: [], trust: [], presence: {} }],
  security: { ...(scenario === "mtls" ? { transport: { mtls: "require" } } : {}), signing: scenario === "off" ? "off" : scenario === "permissive" ? "permissive" : "enforce" },
  nats: { url: scenario === "query" ? "nats://localhost:4222/?query=synthetic" : scenario === "fragment" ? "nats://localhost:4222/#synthetic" : scenario === "schemeless" ? "localhost:4222" : scenario === "http" ? "http://localhost:4222" : scenario === "userinfo" ? "nats://user@localhost:4222" : scenario === "backslash" ? "nats://evil.invalid\\\\@localhost:4222" : scenario === "path" ? "nats://localhost:4222/path" : scenario === "tls" ? "tls://localhost:4222" : scenario === "remote" ? "nats://example.invalid:4222" : scenario === "lookalike" ? "nats://localhost.example.invalid:4222" : scenario === "ipv4" ? "nats://127.0.0.1:4222" : scenario === "ipv6" ? "nats://[::1]:4222" : "nats://localhost:4222", name: "synthetic", subjects: ["local.synthetic.work.private.>"], ...(scenario !== "missing-credentials" ? { credsPath: join(dir, "synthetic.creds") } : {}) },
};
if (scenario === "default-signing") Reflect.deleteProperty(config.security, "signing");
writeFileSync(join(dir, "helper.md"), "Synthetic fixture");
const path = join(dir, "cortex.yaml");
writeFileSync(path, stringify(config), { mode: 0o600 });
try {
  const { startConfiguredMyelinRuntime } = await import("../configured-runtime");
  const options = {
    expectedStackId: scenario === "wrong-stack" ? "synthetic/other" : "synthetic/work",
    expectedNkey: scenario === "wrong-key" ? createUser().getPublicKey() : declaredPubkey,
    ...(scenario !== "no-domain" ? { jetstreamDomain: scenario === "empty-domain" ? "" : "synthetic-domain" } : {}),
  };
  if (scenario === "timeout-low") Object.assign(options, { connectTimeoutMs: 99 });
  if (scenario === "timeout-high") Object.assign(options, { connectTimeoutMs: 30001 });
  if (scenario === "timeout-fraction") Object.assign(options, { connectTimeoutMs: 100.5 });
  if (scenario === "undefined-pin") Reflect.deleteProperty(options, "expectedNkey");
  const runtime = await startConfiguredMyelinRuntime(path, options);
  const call = calls[0];
  if (!call || typeof call !== "object" || !("config" in call) || !("options" in call)) throw new Error("runtime call absent");
  const captured = call as { config: { nats: { subjects: string[]; name: string } }; options: { signer: { rawSeedBytes: Uint8Array; principal: string }; signFailureMode: string; principal: string; stack: string; jetstreamDomain: string; connectImpl: (options: unknown) => Promise<unknown> } };
  await captured.options.connectImpl({ servers: ["nats://evil.invalid"], ignoreClusterUpdates: false });
  console.log(JSON.stringify({ name: captured.config.nats.name, dialOptions, ok: runtime.enabled, calls: calls.length, subjects: captured.config.nats.subjects, signed: captured.options.signer.rawSeedBytes.length === 32, did: captured.options.signer.principal, mode: captured.options.signFailureMode, domain: captured.options.jetstreamDomain }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, calls: calls.length, stopped, error: error instanceof Error ? error.message : "unknown" }));
}
} finally { rmSync(dir, { recursive: true, force: true }); }
