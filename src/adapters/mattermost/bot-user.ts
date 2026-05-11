/**
 * MIG-7.2c-mattermost: shared `/api/v4/users/me` fetch helper.
 *
 * Consolidates the three previously-duplicated call sites:
 *   - `MattermostAdapter.getPlatformUserId` (PresenceBinding contract — must throw)
 *   - `poller.fetchBotUserId` (graceful degradation — wraps + returns null)
 *   - `MattermostAdapter.notifyOperator` (best-effort DM — wraps + early-return)
 *
 * Each caller decides whether to swallow the error or propagate; the helper
 * itself fails closed (throws) so callers that want null-on-failure must
 * explicitly handle the exception. This matches Holly's W1 carry-over from
 * cortex#45 — the inconsistency between three near-identical fetches was
 * the actual smell, not the multiple call sites.
 */

export interface FetchBotUserIdOptions {
  /** Adapter instance id, prefixed onto error messages so multi-instance
   *  deployments can tell which Mattermost server the failure came from. */
  instanceId?: string;
  /** Bound the request so a hung server doesn't block startup-time callers
   *  (`PresenceBinding.startAndBind`) indefinitely. Defaults to 10 seconds —
   *  generous for a single /users/me round-trip; faster failures beat
   *  waiting forever (Holly W2 review on cortex#45). */
  timeoutMs?: number;
}

/**
 * Fetch the bot's own Mattermost user id from `/api/v4/users/me`.
 *
 * Throws with a tagged message on any non-OK response or missing `id`.
 * Returns the raw id string on success.
 */
export async function fetchBotUserId(
  apiUrl: string,
  apiToken: string,
  options: FetchBotUserIdOptions = {},
): Promise<string> {
  const tag = options.instanceId
    ? `mattermost-adapter[${options.instanceId}]`
    : `mattermost`;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Normalise a trailing slash on `apiUrl` so callers can pass either
  // form (`https://mm.example` or `https://mm.example/`) without producing
  // `https://mm.example//api/v4/users/me` (Holly cycle 2 nit).
  const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;

  const res = await fetch(`${base}/api/v4/users/me`, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(
      `${tag}: GET /api/v4/users/me failed with HTTP ${res.status} ${res.statusText}.`,
    );
  }
  const me = (await res.json()) as { id?: string };
  if (!me.id) {
    throw new Error(
      `${tag}: /api/v4/users/me returned no id field.`,
    );
  }
  return me.id;
}
