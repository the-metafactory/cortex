/**
 * Execution backend abstraction for CC session spawning.
 *
 * Currently only LocalBackend (Bun.spawn) is implemented.
 * Future backends: Cloudflare Workers, E2B, SSH devboxes.
 * This interface ensures we don't paint ourselves into a corner.
 */

import { CCSession, type CCSessionOpts } from "./cc-session";

export interface ExecutionBackend {
  /** Backend identifier */
  readonly name: string;
  /** Spawn a new CC session using this backend */
  spawn(opts: CCSessionOpts): CCSession;
}

/**
 * Local execution via Bun.spawn — the default and currently only backend.
 * CCSession already uses Bun.spawn internally, so this is a thin wrapper.
 */
export class LocalBackend implements ExecutionBackend {
  readonly name = "local";

  spawn(opts: CCSessionOpts): CCSession {
    return new CCSession(opts);
  }
}

/** Placeholder config for future remote backends */
export interface RemoteBackendConfig {
  name: string;
  type: "cloudflare" | "e2b" | "ssh" | "custom";
  endpoint: string;
}

/**
 * Backend registry — looks up backends by name.
 * Configured via bot.yaml `execution` section (future).
 */
export class BackendRegistry {
  private backends = new Map<string, ExecutionBackend>();
  private defaultName: string;

  constructor(defaultBackendName = "local") {
    this.defaultName = defaultBackendName;
    // Always register the local backend
    this.register(new LocalBackend());
  }

  /** Register a backend. */
  register(backend: ExecutionBackend): void {
    this.backends.set(backend.name, backend);
  }

  /** Get a backend by name. Throws if not found. */
  get(name: string): ExecutionBackend {
    const backend = this.backends.get(name);
    if (!backend) {
      throw new Error(`Execution backend "${name}" not registered. Available: ${this.list().join(", ")}`);
    }
    return backend;
  }

  /** Get the default backend. */
  default(): ExecutionBackend {
    return this.get(this.defaultName);
  }

  /** List all registered backend names. */
  list(): string[] {
    return Array.from(this.backends.keys());
  }
}
