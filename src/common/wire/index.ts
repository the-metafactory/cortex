/**
 * Wire-identity primitives (WP-2, cortex#1878).
 *
 * The single module that owns every principal / stack / agent identity
 * transform on the wire. Import from here, not from the file directly.
 *
 * No production call site consumes this yet — migration is WP-5 (#1881),
 * held behind review.
 */

export {
  AGENT_ID_RE,
  agentDid,
  DID_PREFIX,
  federatedSubject,
  parseDid,
  parseFederatedSubject,
  parsePrincipalId,
  parseStackId,
  parseStackSlug,
  principalDid,
  PRINCIPAL_ID_RE,
  stackDid,
  stackId,
  STACK_SLUG_RE,
  WIRE_DID_RE,
  WireIdentityError,
} from "./identity.ts";

export type {
  AgentDid,
  FederatedSubject,
  ParseResult,
  PrincipalDid,
  PrincipalId,
  StackDid,
  StackId,
  StackScope,
  StackSlug,
} from "./identity.ts";
