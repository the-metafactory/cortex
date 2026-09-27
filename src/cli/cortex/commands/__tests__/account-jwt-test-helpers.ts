/**
 * cortex#2534 — shared fixture builder for nsc account JWTs, so the provision
 * lib, CLI and integration tests don't each copy the base64url encoding.
 */

/**
 * An unsigned account JWT whose claims carry `nats.limits` (`undefined` = no
 * `limits` object at all). Only the claims segment is meaningful; the signature
 * is a placeholder.
 */
export function accountJwt(limits: Record<string, unknown> | undefined, sub = "A" + "C".repeat(55)): string {
  const claims = { sub, nats: limits === undefined ? { type: "account" } : { type: "account", limits } };
  const encoded = btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.${encoded}.sig`;
}

/** After `nsc edit account --js-mem-storage -1 --js-disk-storage -1`. */
export const ACCOUNT_JWT_WITH_JETSTREAM = accountJwt({ subs: -1, conn: -1, mem_storage: -1, disk_storage: -1 });

/** What `arc nats add-account` mints today: limits, but none for JetStream. */
export const ACCOUNT_JWT_WITHOUT_JETSTREAM = accountJwt({ subs: -1, conn: -1 });
