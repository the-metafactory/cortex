/**
 * FLG-3 (docs/plan-mc-future-state.md §4.D) — network doctor drill hook.
 *
 * Fetches `GET /api/networks/:net/doctor` (the 8-leg status/fix/owner matrix +
 * aggregate verdict) for ONE network. Unlike the FLG-1 handoff hook, this is
 * ON-DEMAND (a `run()` trigger), NOT fetch-on-mount: the doctor runs a LIVE
 * echo round-trip per configured peer (a real probe with a multi-second
 * per-peer timeout), so auto-running it on every roster-panel mount would fire
 * probes across the fleet on every render. It is the "why is this link red"
 * DRILL — the principal asks for it (matching the plan's "drill from a red
 * edge/node").
 *
 * A failed/unavailable read (503 no-federation, 404 not-joined, network error)
 * surfaces an honest one-line `error` on the drill rather than silently
 * vanishing — the principal explicitly asked to diagnose, so "nothing to show"
 * must be visible, not swallowed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api";
import type { NetworkDoctorDTO } from "../../api/doctor";

export type {
  NetworkDoctorDTO,
  DoctorCheckDTO,
  DoctorCheckStatus,
  DoctorCheckOwner,
  DoctorVerdict,
} from "../../api/doctor";

export interface DoctorHookState {
  /** The latest doctor report, or `null` before the first successful run. */
  report: NetworkDoctorDTO | null;
  /** Whether a run is in flight (the probes take a few seconds). */
  loading: boolean;
  /** An honest one-line failure (unavailable/not-joined/network error), or `null`. */
  error: string | null;
  /** Whether at least one run has been triggered (drives the collapsed vs open UI). */
  hasRun: boolean;
  /** Trigger (or re-run) the doctor. */
  run: () => void;
}

export function useDoctor(networkId: string): DoctorHookState {
  const [report, setReport] = useState<NetworkDoctorDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  // Lifetime + race guard (mirrors use-handoff/use-networks): a stale in-flight
  // response from a superseded run (older gen) or an unmounted component
  // (aliveRef false) is dropped rather than written.
  const genRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = useCallback(() => {
    const myGen = ++genRef.current;
    setHasRun(true);
    setLoading(true);
    setError(null);
    const path = `/api/networks/${encodeURIComponent(networkId)}/doctor`;
    void (async () => {
      try {
        const body = await getJson<NetworkDoctorDTO>(path);
        if (!aliveRef.current || genRef.current !== myGen) return;
        setReport(body);
        setLoading(false);
      } catch (e) {
        if (!aliveRef.current || genRef.current !== myGen) return;
        const msg = e instanceof Error ? e.message : String(e);
        // The principal explicitly asked — surface the failure, don't swallow.
        setError(
          msg.includes("503")
            ? "Doctor unavailable — no federation configured on this stack."
            : msg.includes("404")
              ? "This stack has not joined that network."
              : `Doctor run failed: ${msg}`,
        );
        setLoading(false);
      }
    })();
  }, [networkId]);

  return { report, loading, error, hasRun, run };
}
