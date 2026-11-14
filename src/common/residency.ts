/** Where content may live: on this machine only, or also with a cloud model or service. */
export type Residency = "local" | "cloud";

/** Fail-closed read of a stored or configured residency: only the literal `"cloud"` is cloud. Missing, unknown and malformed values are local. */
export const residencyOf = (value: unknown): Residency => value === "cloud" ? "cloud" : "local";

/** Where content would go: a conversation (or other sink) with its transport, model route and own policy. */
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
  if (to.route !== "local") return "cloud-model";
  if (residencyOf(to.policy) !== "local") return "cloud-conversation";
  return null;
}

export const mayEnter = (content: unknown, to: Destination): boolean => releaseRefusal(content, to) === null;

declare const released: unique symbol;
/** Content the residency gate cleared for one destination. Only `release` makes one. */
export type Released<T> = T & { readonly [released]: true };

export type Release<T> = { readonly released: Released<T> } | { readonly refusal: ReleaseRefusal };

export function release<T>(value: T, content: unknown, to: Destination): Release<T> {
  const refusal = releaseRefusal(content, to);
  return refusal === null ? { released: value as Released<T> } : { refusal };
}
