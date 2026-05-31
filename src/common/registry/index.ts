/**
 * IAW Phase D.4.3 — Cortex-side RegistryClient consumer.
 *
 * Public surface for the rest of cortex. Consume the reader interface
 * unless wiring lifecycle (cortex.ts boot/shutdown only).
 */

export { RegistryClient } from "./client";
export type {
  Capability,
  PrincipalRecord,
  RegistryClientOptions,
  RegistryClientReader,
  RegistryPubkeyResponse,
  SignedAssertion,
  StackIdentity,
} from "./types";
