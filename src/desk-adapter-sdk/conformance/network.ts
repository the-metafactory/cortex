import { AsyncLocalStorage } from "node:async_hooks";
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
const owner = new AsyncLocalStorage<{ attempts: number }>();
let originals: Originals | undefined;

const refuse = (): never => {
  const run = owner.getStore();
  if (run) run.attempts++;
  return blocked();
};

function install(): void {
  const socketMethods: { connect: typeof net.Socket.prototype.connect } = net.Socket.prototype;
  originals = { fetch: globalThis.fetch, connect: socketMethods.connect, tlsConnect: tls.connect };
  globalThis.fetch = Object.assign(refuse as unknown as typeof fetch, { preconnect: refuse });
  net.Socket.prototype.connect = refuse;
  (tls as { connect: typeof tls.connect }).connect = refuse;
}

function restore(saved: Originals): void {
  globalThis.fetch = saved.fetch;
  net.Socket.prototype.connect = saved.connect;
  (tls as { connect: typeof tls.connect }).connect = saved.tlsConnect;
}

export function guardNetwork(): NetworkGuard {
  if (holders === 0) install();
  holders++;
  const run = { attempts: 0 };
  owner.enterWith(run);
  let released = false;
  return {
    count: () => run.attempts,
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
