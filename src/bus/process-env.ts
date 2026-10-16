// glossary-ignore: listener, node
import { userInfo } from "node:os";
import type { ProcessSpec } from "./process-runner";
import type { FiredActivation } from "./reflex-activation-listener";

/**
 * Pulse connection settings bypass the spec allow-list, including PULSE_NATS_CREDS,
 * so the child can report its run on the bus. Node #2559 fixes this as the exact
 * output for an allow-listed spec (acceptance criteria, "Child env"), and keeps
 * the spec schema out of scope, so there is no per-spec opt-in or opt-out. An env
 * allow-list therefore does not isolate a process from that credential's
 * permissions. Only run trusted specs. See docs/process-runner.md.
 */
export const PULSE_ENV_KEYS = [
  "PULSE_PRINCIPAL",
  "PULSE_STACK",
  "PULSE_NATS_URL",
  "PULSE_NATS_CREDS",
] as const;

/**
 * Login identity: always set, from cortex's env or else the OS account. launchd
 * starts cortex without USER, and keychain-backed CLIs such as `claude -p` then
 * report "Not logged in" even with an allow-list naming USER.
 */
export const IDENTITY_ENV_KEYS = ["USER", "LOGNAME"] as const;

export const MF_SERVES_GOAL = "MF_SERVES_GOAL";
export const MF_SERVES_NODE = "MF_SERVES_NODE";
export const MF_CORRELATION_ID = "MF_CORRELATION_ID";

/** Fire metadata keys: set only from the activation, never inherited. */
const FIRE_ENV_KEYS: ReadonlySet<string> = new Set([MF_SERVES_GOAL, MF_SERVES_NODE, MF_CORRELATION_ID]);

/** Build a fresh child env; fire metadata never inherits from cortex's env. */
export function buildProcessEnv({ spec, activation, parentEnv, account }: {
  spec: Pick<ProcessSpec, "env">;
  activation: Pick<FiredActivation, "serves" | "correlationId">;
  parentEnv: Readonly<Record<string, string | undefined>>;
  account?: string;
}): Record<string, string> {
  const keys = spec.env === undefined
    ? Object.keys(parentEnv)
    : [...spec.env, ...PULSE_ENV_KEYS];
  const env = Object.fromEntries(
    keys
      .filter((key) => !FIRE_ENV_KEYS.has(key))
      .map((key) => [key, parentEnv[key]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );

  for (const key of IDENTITY_ENV_KEYS) env[key] = parentEnv[key] ?? account ?? userInfo().username;

  if (activation.serves?.goal !== undefined) env[MF_SERVES_GOAL] = activation.serves.goal;
  if (activation.serves?.node !== undefined) env[MF_SERVES_NODE] = activation.serves.node;
  if (activation.correlationId !== undefined) env[MF_CORRELATION_ID] = activation.correlationId;
  return env;
}
