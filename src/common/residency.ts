/** Where content may live: on this machine only, or also with a cloud model or service. */
export type Residency = "local" | "cloud";

/** Fail-closed read of a stored or configured content residency: only the literal `"cloud"` is cloud. Missing, unknown and malformed values are local. */
export const residencyOf = (value: unknown): Residency => value === "cloud" ? "cloud" : "local";

/** A model route keeps content local only when it is the literal `"local"` route; every other route reaches a cloud model. */
export const routeResidency = (route: string): Residency => route === "local" ? "local" : "cloud";

const destinationResidency = (value: unknown): Residency => value === "local" ? "local" : "cloud";

/** Where content would go: a conversation or another destination, with its transport, model route and own policy. */
export interface Destination {
  readonly transport: string;
  readonly route: string;
  readonly policy: unknown;
}

/** Why local-only content may not enter a destination. */
export type ReleaseRefusal = "not-web" | "cloud-model" | "cloud-conversation";

/** A destination keeps content local only when it is a web conversation on the local model and itself local-only. */
export function releaseRefusal(content: unknown, to: Destination): ReleaseRefusal | null {
  if (residencyOf(content) === "cloud") return null;
  if (to.transport !== "web") return "not-web";
  if (routeResidency(to.route) !== "local") return "cloud-model";
  if (destinationResidency(to.policy) !== "local") return "cloud-conversation";
  return null;
}

export const mayEnter = (content: unknown, to: Destination): boolean => releaseRefusal(content, to) === null;

declare const released: unique symbol;
/** Content the residency gate cleared for one destination, judged by the content's own `policy`. Only `release` makes one. */
export type Released<T extends { readonly policy: unknown }> = T & { readonly [released]: true };

export type Release<T extends { readonly policy: unknown }> = { readonly released: Released<T> } | { readonly refusal: ReleaseRefusal };

export function release<T extends { readonly policy: unknown }>(value: T, to: Destination): Release<T> {
  const refusal = releaseRefusal(value.policy, to);
  return refusal === null ? { released: value as Released<T> } : { refusal };
}
