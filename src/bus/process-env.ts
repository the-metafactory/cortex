import type { ProcessSpec } from "./process-runner";
import type { FiredActivation } from "./reflex-activation-listener";

/** Pulse connection settings pass through even when a spec restricts its env. */
export const PULSE_ENV_KEYS = [
  "PULSE_PRINCIPAL",
  "PULSE_STACK",
  "PULSE_NATS_URL",
  "PULSE_NATS_CREDS",
] as const;

export const MF_SERVES_GOAL = "MF_SERVES_GOAL";
export const MF_SERVES_NODE = "MF_SERVES_NODE";
export const MF_CORRELATION_ID = "MF_CORRELATION_ID";

/** Build a fresh child env; fire metadata never inherits from cortex's env. */
export function buildProcessEnv({ spec, activation, parentEnv }: {
  spec: Pick<ProcessSpec, "env">;
  activation: Pick<FiredActivation, "serves" | "correlationId">;
  parentEnv: Readonly<Record<string, string | undefined>>;
}): Record<string, string> {
  const keys = spec.env === undefined
    ? Object.keys(parentEnv)
    : [...spec.env, ...PULSE_ENV_KEYS];
  const env = Object.fromEntries(
    keys
      .map((key) => [key, parentEnv[key]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );

  delete env[MF_SERVES_GOAL];
  delete env[MF_SERVES_NODE];
  delete env[MF_CORRELATION_ID];
  if (activation.serves?.goal !== undefined) env[MF_SERVES_GOAL] = activation.serves.goal;
  if (activation.serves?.node !== undefined) env[MF_SERVES_NODE] = activation.serves.node;
  if (activation.correlationId !== undefined) env[MF_CORRELATION_ID] = activation.correlationId;
  return env;
}
