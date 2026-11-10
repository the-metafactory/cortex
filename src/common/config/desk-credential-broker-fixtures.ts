import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost, type ConversationHost } from "../../conversations/host";
import { createArcFileSecretStore, type ArcSecretStore } from "./desk-credential-arc-file-store";
import type { ConnectionHead, DeskCredentialBroker, SetupContext, SetupDescriptor, SetupPrincipal } from "./desk-credential-broker";

export const SYNTHETIC_TOKEN = "synthetic-token-value-1f3a9c";
export const TOKEN_DESCRIPTOR: SetupDescriptor = { packageId: "example-package", setupSchemaId: "example-setup", version: "1.0.0", authKind: "token", slots: [{ slot: "primary", kind: "token" }, { slot: "backup", kind: "api-key" }] };
export const LOCAL_DESCRIPTOR: SetupDescriptor = { packageId: "example-package", setupSchemaId: "example-local", version: "1.0.0", authKind: "local", slots: [] };

export function syntheticLive<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Synthetic rig is closed.");
  return value;
}

export async function openSyntheticHost(dir: string): Promise<ConversationHost> {
  const status = await openConversationHost({ dir: join(dir, "host"), stack: "test", label: "test", expectedLabel: "test", lanes: {}, turns: request => Promise.resolve({ text: "synthetic", session: request.session, resumed: false }) });
  if (status.state !== "ready") throw new Error(status.reason);
  return status.host;
}

export async function removeSyntheticRig(dir: string, host: ConversationHost | undefined): Promise<void> {
  await host?.close();
  await rm(dir, { recursive: true, force: true });
}

export interface BrokerRig {
  dir: string;
  configRoot: string;
  env: Record<string, string>;
  published: ConnectionHead[];
  hooks: { publish?: () => Promise<void>; writeAfter?: () => void; unavailable?: boolean; existingUnrelated?: boolean; revokeReferences?: boolean };
  principals: Map<string, SetupPrincipal>;
  host(): ConversationHost;
  broker(): DeskCredentialBroker;
  session(name: string): Promise<SetupContext>;
  store: ArcSecretStore;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

export async function brokerRig(): Promise<BrokerRig> {
  const dir = await mkdtemp(join(tmpdir(), "desk-credential-"));
  const configRoot = join(dir, "arc");
  const inner = createArcFileSecretStore({ configRoot });
  const hooks: BrokerRig["hooks"] = {};
  const store: ArcSecretStore = {
    id: inner.id,
    available: async () => !hooks.unavailable && inner.available(),
    writeIfAbsent: async (identity, value) => {
      if (hooks.existingUnrelated) return "exists";
      const outcome = await inner.writeIfAbsent(identity, value);
      if (hooks.writeAfter) { hooks.writeAfter(); throw new Error("synthetic interruption after broker write"); }
      return outcome;
    },
    matches: (identity, value) => hooks.existingUnrelated ? Promise.resolve(false) : inner.matches(identity, value),
    present: identity => inner.present(identity),
  };
  const env: Record<string, string> = { EXAMPLE_API_KEY: "synthetic-env-secret" };
  const published: ConnectionHead[] = [];
  const principals = new Map<string, SetupPrincipal>();
  let host: ConversationHost | undefined;
  let broker: DeskCredentialBroker | undefined;
  const live = syntheticLive;
  const open = async (): Promise<void> => {
    host = await openSyntheticHost(dir);
    broker = host.credentialBroker({
      store,
      authenticate: sessionRef => Promise.resolve(principals.get(sessionRef) ?? null),
      publishConnection: async head => { await hooks.publish?.(); if (!published.some(item => item.connectionId === head.connectionId && item.connectionRevision === head.connectionRevision)) published.push(head); },
      references: { authorized: (principalRef, name) => !hooks.revokeReferences && principals.get("owner")?.principalRef === principalRef && name === "EXAMPLE_API_KEY", present: name => name in env },
      approvedBrokers: new Set(["approved-broker"]),
    });
    broker.registerSetup(TOKEN_DESCRIPTOR);
    broker.registerSetup(LOCAL_DESCRIPTOR);
    broker.registerSetup({ packageId: "example-package", setupSchemaId: "example-oauth", version: "1.0.0", authKind: "oauth", broker: "unknown-broker", slots: [{ slot: "grant", kind: "token" }] });
    broker.registerSetup({ packageId: "example-package", setupSchemaId: "example-approved-oauth", version: "1.0.0", authKind: "oauth", broker: "approved-broker", slots: [{ slot: "grant", kind: "token" }] });
    broker.registerSetup({ packageId: "example-package", setupSchemaId: "example-saml", version: "1.0.0", authKind: "saml", slots: [] });
  };
  principals.set("owner", { principalRef: randomUUID(), principal: "principal-example", stack: "test", expiresAt: "2999-01-01T00:00:00.000Z" });
  principals.set("other", { principalRef: randomUUID(), principal: "principal-other", stack: "test", expiresAt: "2999-01-01T00:00:00.000Z" });
  await open();
  const rig: BrokerRig = {
    dir, configRoot, env, published, hooks, principals, store,
    host: () => live(host),
    broker: () => live(broker),
    async session(name) { const context = await live(broker).authenticate(name); if (!context) throw new Error("synthetic session rejected"); return context; },
    async reopen() { await host?.close(); await open(); },
    close: () => removeSyntheticRig(dir, host),
  };
  return rig;
}
