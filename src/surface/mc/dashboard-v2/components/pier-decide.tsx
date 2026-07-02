/**
 * MC-B2 (cortex#1279) — the **Tier-2 admit/reject action** on the Pier queue.
 *
 * A thin shell over `pier-decide-lib` (all the load-bearing logic — the
 * typed-confirm gate + the verdict→message mapping — lives there and is
 * unit-tested). Request-id-driven (Option A): the principal supplies the
 * `request_id` (from `cortex network admit --list-pending` / the registry) and
 * re-types it into the confirm box to authorise the mutation, mirroring the CLI
 * `cortex network admit <request-id> --apply` posture the approved scope cites.
 *
 * The decision is signed by the LOCAL daemon with the stack seed (never the
 * browser, never the CF worker); this component only POSTs and renders the
 * registry's verdict. On the not-an-admin case the endpoint returns 403 and we
 * surface the readable `detail` inline (never a silent failure).
 *
 * Auto-populating request_ids onto the pending rows (so these become per-row
 * buttons) needs the admin-list read path (ADR-0020 global-admin-read scoping,
 * admit-lane-adjacent) → documented follow-up.
 */

import { useState } from "react";
import {
  ADMISSION_DECISION_PATH,
  canDecide,
  describeOutcome,
  submitDecision,
  type DecideOutcome,
  type DecideVerb,
  type FetchLike,
} from "../lib/pier-decide-lib";

export interface PierDecideFormProps {
  /** Networks the principal ADMINS (complete-scope) — the decision's `network_id` options. */
  adminNetworks: readonly string[];
  /** Injected transport (tests). Production omits → `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Called after a successful decision (e.g. to trigger a networks refetch). */
  onDecided?: () => void;
}

const defaultFetch: FetchLike = (path, init) => fetch(path, init);

export function PierDecideForm({ adminNetworks, fetchImpl, onDecided }: PierDecideFormProps) {
  const [networkId, setNetworkId] = useState<string>(adminNetworks[0] ?? "");
  const [requestId, setRequestId] = useState<string>("");
  const [confirm, setConfirm] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [outcome, setOutcome] = useState<DecideOutcome | null>(null);

  // No admin networks → no action surface (parent gates too; belt-and-braces).
  if (adminNetworks.length === 0) return null;

  const ready = canDecide({ requestId, confirm, busy });
  const post = fetchImpl ?? defaultFetch;

  async function decide(decision: DecideVerb): Promise<void> {
    if (!canDecide({ requestId, confirm, busy })) return;
    setBusy(true);
    setOutcome(null);
    const result = await submitDecision(
      { network_id: networkId, request_id: requestId, decision, confirm },
      post,
    );
    setBusy(false);
    setOutcome(result);
    if (result.kind === "ok") {
      // Clear the entry so the same id can't be double-submitted by mistake.
      setRequestId("");
      setConfirm("");
      onDecided?.();
    }
  }

  const summary = outcome ? describeOutcome(outcome) : null;

  return (
    <div className="pier-decide" aria-label="Grant or reject an admission request">
      <h4 className="pier-decide-title">
        Grant / reject a request <span className="dim">— by request id</span>
      </h4>
      <p className="dim pier-decide-help">
        Signed locally by your daemon with your stack key (needs your key on the
        network&rsquo;s admins). Get the request id from{" "}
        <code>cortex network admit --list-pending</code>, then type it twice to confirm.
      </p>

      <label className="pier-decide-field">
        <span className="pier-decide-label">Network</span>
        {adminNetworks.length === 1 ? (
          <span className="pier-decide-network-single">{adminNetworks[0]}</span>
        ) : (
          <select
            className="pier-decide-select"
            value={networkId}
            onChange={(e) => setNetworkId(e.target.value)}
            disabled={busy}
          >
            {adminNetworks.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="pier-decide-field">
        <span className="pier-decide-label">Request id</span>
        <input
          className="pier-decide-input"
          type="text"
          value={requestId}
          onChange={(e) => setRequestId(e.target.value)}
          placeholder="req-…"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label className="pier-decide-field">
        <span className="pier-decide-label">Confirm (re-type the request id)</span>
        <input
          className="pier-decide-input pier-decide-confirm"
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="req-…"
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="pier-decide-actions">
        <button
          type="button"
          className="pier-decide-grant"
          onClick={() => void decide("admit")}
          disabled={!ready}
          title={ready ? "Grant this request (admit onto the roster)" : "Enter a request id and re-type it to confirm"}
        >
          Grant
        </button>
        <button
          type="button"
          className="pier-decide-reject"
          onClick={() => void decide("reject")}
          disabled={!ready}
          title={ready ? "Reject this request" : "Enter a request id and re-type it to confirm"}
        >
          Reject
        </button>
        {busy ? <span className="dim pier-decide-busy">deciding…</span> : null}
      </div>

      {summary ? (
        <p
          className={summary.tone === "ok" ? "pier-decide-result tone-ok" : "pier-decide-result tone-error"}
          role={summary.tone === "error" ? "alert" : "status"}
          data-path={ADMISSION_DECISION_PATH}
        >
          {summary.text}
        </p>
      ) : null}
    </div>
  );
}
