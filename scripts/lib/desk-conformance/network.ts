import net from "node:net";
import tls from "node:tls";

export interface NetworkGuard {
  count(): number;
  release(): void;
}

interface Originals {
  fetch: typeof fetch;
  connect: typeof net.Socket.prototype.connect;
  tlsConnect: typeof tls.connect;
}

const blocked = (): never => {
  throw new Error("The conformance harness permits no network request.");
};

let holders = 0;
let totalAttempts = 0;
let originals: Originals | undefined;

const refuse = (): never => {
  totalAttempts++;
  return blocked();
};

function install(): void {
  originals = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, tlsConnect: tls.connect };
  globalThis.fetch = Object.assign(refuse as unknown as typeof fetch, { preconnect: refuse });
  net.Socket.prototype.connect = refuse as unknown as typeof net.Socket.prototype.connect;
  (tls as { connect: typeof tls.connect }).connect = refuse as unknown as typeof tls.connect;
}

function restore(saved: Originals): void {
  globalThis.fetch = saved.fetch;
  net.Socket.prototype.connect = saved.connect;
  (tls as { connect: typeof tls.connect }).connect = saved.tlsConnect;
}

export function guardNetwork(): NetworkGuard {
  if (holders === 0) install();
  holders++;
  const base = totalAttempts;
  let released = false;
  return {
    count: () => totalAttempts - base,
    release() {
      if (released) return;
      released = true;
      holders--;
      if (holders === 0 && originals) {
        restore(originals);
        originals = undefined;
      }
    },
  };
}
