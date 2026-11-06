import type { Envelope } from "./myelin/envelope-validator";
import { connect } from "nats";
import { expandTilde, loadConfigWithAgents } from "../common/config/loader";
import { enforceChmod600 } from "../common/config/file-permissions";
import { buildStackEnvelopeSignerFromConfig } from "./configured-signer";
import { deriveStackId } from "../common/types/cortex-config";
import { startMyelinRuntime, MyelinDurablePublishError, type MyelinRuntime, type MyelinRuntimeOptions } from "./myelin/runtime";

const LOCAL_BUS_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export interface ConfiguredMyelinRuntimeOptions {
  expectedStackId: string;
  expectedNkey: string;
  jetstreamDomain?: string;
  connectTimeoutMs?: number;
}
function assertLocalTransport(url: string, credsPath: string | undefined): void {
  try {
    const parsed = new URL(url);
    if (url.includes("\\") || parsed.username || parsed.password || parsed.pathname || parsed.search || parsed.hash || parsed.protocol !== "nats:" || !LOCAL_BUS_HOSTS.has(parsed.hostname) || !credsPath) throw new Error();
    enforceChmod600(expandTilde(credsPath));
  } catch { throw new Error("configured bus requires authenticated localhost transport with private credentials"); }
}
export async function startConfiguredMyelinRuntime(configPath: string, options: ConfiguredMyelinRuntimeOptions): Promise<MyelinRuntime> {
  if (typeof options.expectedStackId !== "string" || options.expectedStackId.length === 0 || typeof options.expectedNkey !== "string" || !/^U[A-Z2-7]{55}$/.test(options.expectedNkey)) throw new Error("configured bus requires explicit expected identity pins");
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 30000) throw new Error("configured bus connection timeout invalid");
  const loaded = loadConfigWithAgents(configPath);
  if (loaded.config.security.transport.mtls !== "off") throw new Error("configured bus mTLS posture unsupported; refusing to weaken policy");
  const derived = deriveStackId({ ...(loaded.principal ? { principal: { id: loaded.principal.id } } : {}), ...(loaded.stack ? { stack: loaded.stack } : {}) });
  if (derived.id !== options.expectedStackId || !loaded.stack?.nkey_pub || loaded.stack.nkey_pub !== options.expectedNkey) throw new Error("configured bus identity differs from expected stack");
  const nats = loaded.config.nats;
  if (!nats) throw new Error("configured bus requires authenticated localhost transport with private credentials");
  assertLocalTransport(nats.url, nats.credsPath);
  const signer = await buildStackEnvelopeSignerFromConfig(loaded);
  if (!signer) throw new Error("configured bus signer unavailable; unsigned fallback refused");
  const runtimeOptions: MyelinRuntimeOptions = {
    principal: derived.principal,
    stack: derived.stack,
    signer,
    signFailureMode: "drop",
    connectImpl: async (options) => {
      try { return await connect({ ...options, servers: [nats.url], ignoreClusterUpdates: true, waitOnFirstConnect: false, maxReconnectAttempts: -1, timeout: connectTimeoutMs }); }
      catch (error) { throw new Error("configured bus connection failed", { cause: error }); }
    },
    ...(options.jetstreamDomain !== undefined ? { jetstreamDomain: options.jetstreamDomain } : {}),
  };
  const runtime = await startMyelinRuntime({ ...loaded.config, nats: { ...nats, name: nats.name + "-sdk", subjects: [] } }, runtimeOptions);
  if (!runtime.enabled) {
    try { await runtime.stop(); } catch { process.stderr.write("cortex: configured bus cleanup failed\n"); }
    throw new Error("configured bus runtime unavailable");
  }
  const publishOnSubject = runtime.publishOnSubject?.bind(runtime);
  const publishDurable = runtime.publishDurable?.bind(runtime);
  const assertLocal = (envelope: Envelope): void => {
    if (envelope.sovereignty.classification !== "local") throw new Error("configured local bus refuses non-local classification");
    if (!envelope.source.startsWith(`${derived.principal}.${derived.stack}.`)) throw new Error("configured local bus source outside pinned stack");
  };
  return {
    ...runtime,
    publish: async (envelope) => { assertLocal(envelope); await runtime.publish(envelope); },
    ...(publishOnSubject ? { publishOnSubject: async (envelope, subject) => {
      assertLocal(envelope);
      if (!subject.startsWith(`local.${derived.principal}.${derived.stack}.`) || !subject.split(".").every((token) => /^[A-Za-z0-9_@:-]+$/.test(token))) throw new Error("configured local bus subject outside pinned stack");
      await publishOnSubject(envelope, subject);
    } } satisfies Pick<MyelinRuntime, "publishOnSubject"> : {}),
    ...(publishDurable ? { publishDurable: async (envelope, publishOptions) => {
      try { assertLocal(envelope); } catch (error) { throw new MyelinDurablePublishError("unroutable", envelope.id, "configured local bus policy refused envelope", { cause: error }); }
      return await publishDurable(envelope, publishOptions);
    } } satisfies Pick<MyelinRuntime, "publishDurable"> : {}),
  };

}
