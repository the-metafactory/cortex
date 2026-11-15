import type { ConversationHost } from "../../host";
import type { AuthorityBindings } from "../../authority";
import type { ConnectionRecord, PrincipalBinding } from "../../authority-records";
import type { DomainAdapterRegistry } from "../registry";

export async function openFixtureAuthority(host: ConversationHost, registry: DomainAdapterRegistry, bindings: AuthorityBindings, principal: PrincipalBinding, connection: ConnectionRecord) {
  const authority = host.lifecycleAuthority(registry, bindings);
  await authority.publishHostRecord({ kind: "principal", value: principal }, 0);
  await authority.publishHostRecord({ kind: "connection", value: connection }, 0);
  return authority;
}
