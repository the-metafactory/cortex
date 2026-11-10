import net from "node:net";
import tls from "node:tls";

export interface NetworkGuard {
  count(): number;
  release(): void;
}

const blocked = (): never => {
  throw new Error("The conformance harness permits no network request.");
};

export function guardNetwork(): NetworkGuard {
  let attempts = 0;
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  const realTlsConnect = tls.connect;
  const refuse = (): never => {
    attempts++;
    return blocked();
  };
  globalThis.fetch = Object.assign(refuse as unknown as typeof fetch, { preconnect: realFetch.preconnect });
  net.Socket.prototype.connect = refuse as unknown as typeof net.Socket.prototype.connect;
  (tls as { connect: typeof tls.connect }).connect = refuse as unknown as typeof tls.connect;
  return {
    count: () => attempts,
    release() {
      globalThis.fetch = realFetch;
      net.Socket.prototype.connect = realConnect;
      (tls as { connect: typeof tls.connect }).connect = realTlsConnect;
    },
  };
}
