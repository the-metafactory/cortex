import type { AuthorityBindings } from "../../../authority";
import { ReadBindings } from "../../reads/bindings";
import type { ReadBinding } from "../../reads/types";
import type { DomainAdapterRegistry } from "../../registry";

export function installReadBindings(registry: DomainAdapterRegistry, bindings: AuthorityBindings, adapterId: string, connectionId: string, readBindings: readonly ReadBinding[]): void {
  const installed = new ReadBindings(registry);
  const connector = { adapterId, connectionId, readCapabilityIds: readBindings.map(binding => binding.capabilityId) };
  for (const binding of readBindings) {
    const added = installed.register(binding, connector);
    if (!added.ok) throw new Error(added.error.code);
  }
  bindings.readBindings = installed;
}
