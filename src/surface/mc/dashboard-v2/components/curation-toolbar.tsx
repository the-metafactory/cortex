/**
 * F-12 curation toolbar — sits inside the F-7 drill-down between the
 * event log and the F-10 input affordance (Decision 2).
 *
 * Buttons are a pure function of `assignment.state` per Decision 3 (the
 * matrix lives in `lib/curation-enablement.ts`). Destructive verbs
 * (Abandon, Hand off) open an inline confirm panel per Decision 4;
 * Dispatch and Requeue fire-and-forget.
 *
 * The toolbar does NOT trigger refetches — it relies on the WS
 * `state.transition` and `operator.curation` frames to flip the parent's
 * `assignment.state`, which re-renders the buttons with the new
 * enablement set (no manual round-trip).
 *
 * Endpoints (matched against `src/mission-control/server.ts`):
 *  - POST /api/sessions                      — Dispatch (existing)
 *  - POST /api/assignments/:id/requeue       — Requeue
 *  - POST /api/assignments/:id/abandon       — Abandon-the-assignment
 *  - POST /api/tasks/:taskId/abandon         — Abandon-the-task (terminal)
 *  - POST /api/assignments/:id/handoff       — Hand off
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./curation-toolbar.css";
import {
  abandonTargetKind,
  curationMatrixFor,
  DESTRUCTIVE_VERBS,
  isEnabled,
  labelForVerb,
  VERBS_REQUIRING_CONFIRM,
  type CurationVerb,
} from "../lib/curation-enablement";
import type { AssignmentListItem } from "../../db/assignments";

const VERBS: readonly CurationVerb[] = ["dispatch", "requeue", "handoff", "abandon"];

interface AgentOption {
  id: string;
  name: string;
}

export interface CurationToolbarProps {
  assignment: AssignmentListItem | null;
  /**
   * Callback invoked after a successful curation action. The parent
   * usually doesn't need to do anything — the WS will deliver the
   * updated state — but the hook lets the parent close confirm panels
   * or surface a toast if it wants to.
   */
  onActionApplied?: (verb: CurationVerb) => void;
}

interface ConfirmConfig {
  verb: CurationVerb;
  prompt: string;
  showAgentPicker: boolean;
  agents: AgentOption[];
  defaultAgentId: string | null;
  showReason: boolean;
  confirmLabel: string;
  destructive: boolean;
  /**
   * Returns true on success (panel closes), false on failure (panel
   * stays open, error banner shows the message).
   */
  onConfirm: (payload: { agentId: string | null; reason: string }) => Promise<boolean>;
}

export function CurationToolbar({ assignment, onActionApplied }: CurationToolbarProps) {
  const [confirm, setConfirm] = useState<ConfirmConfig | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[] | null>(null);

  const state = assignment?.state ?? null;
  const matrix = useMemo(() => curationMatrixFor(state), [state]);

  // Auto-clear inline error after a few seconds (legacy parity).
  useEffect(() => {
    if (!errMsg) return;
    const t = setTimeout(() => setErrMsg(null), 5000);
    return () => clearTimeout(t);
  }, [errMsg]);

  // Lazy-load the agents list for Dispatch / Hand-off pickers. The
  // legacy harvested from `state.assignments.values()` + a `/api/working-agents`
  // fall-back; we mirror the latter here. Cached for the lifetime of the
  // drill-down (the parent unmounts the toolbar on close, which clears
  // this cache for free).
  const fetchAgents = useCallback(async (): Promise<AgentOption[]> => {
    if (agents) return agents;
    try {
      const res = await fetch("/api/working-agents");
      if (!res.ok) return [];
      const body = await res.json() as { agents?: Array<{ id: string; name?: string }> };
      const list: AgentOption[] = (body.agents ?? []).map((a) => ({
        id: a.id, name: a.name ?? a.id,
      }));
      list.sort((a, b) => a.name.localeCompare(b.name));
      setAgents(list);
      return list;
    } catch {
      // Best-effort — pickers will render an empty dropdown which the
      // operator can recover from by using `+ Add task` or trying again.
      return [];
    }
  }, [agents]);

  const closeConfirm = useCallback(() => {
    setConfirm(null);
    setErrMsg(null);
  }, []);

  // ------- Verb handlers -------

  const onClickDispatch = useCallback(async () => {
    if (!assignment) return;
    closeConfirm();
    const list = await fetchAgents();
    setConfirm({
      verb: "dispatch",
      prompt: "Dispatch a new assignment on this task to:",
      showAgentPicker: true,
      agents: list,
      defaultAgentId: assignment.agent_id,
      showReason: false,
      confirmLabel: "Dispatch",
      destructive: false,
      onConfirm: async ({ agentId }) => {
        if (!agentId) {
          setErrMsg("Pick an agent");
          return false;
        }
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: assignment.task.id, agentId }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({} as { error?: string }));
          setErrMsg(body.error || `Dispatch failed (${res.status})`);
          return false;
        }
        onActionApplied?.("dispatch");
        return true;
      },
    });
  }, [assignment, closeConfirm, fetchAgents, onActionApplied]);

  const onClickRequeue = useCallback(async () => {
    if (!assignment) return;
    closeConfirm();
    const res = await fetch(
      `/api/assignments/${encodeURIComponent(assignment.id)}/requeue`,
      { method: "POST" }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as { error?: string }));
      setErrMsg(body.error || `Requeue failed (${res.status})`);
      return;
    }
    onActionApplied?.("requeue");
  }, [assignment, closeConfirm, onActionApplied]);

  const onClickAbandon = useCallback(() => {
    if (!assignment) return;
    closeConfirm();
    const targetKind = abandonTargetKind(assignment.state);
    setConfirm({
      verb: "abandon",
      prompt: `Cancel this ${targetKind}?`,
      showAgentPicker: false,
      agents: [],
      defaultAgentId: null,
      showReason: true,
      confirmLabel: "Confirm Abandon",
      destructive: true,
      onConfirm: async ({ reason }) => {
        // Per F-12 D5: assignment-keyed when active, task-keyed when
        // terminal. Both endpoints accept `{ reason }` shape.
        const path = targetKind === "task"
          ? `/api/tasks/${encodeURIComponent(assignment.task.id)}/abandon`
          : `/api/assignments/${encodeURIComponent(assignment.id)}/abandon`;
        const body: { reason?: string } = {};
        if (reason) body.reason = reason;
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const respBody = await res.json().catch(() => ({} as { error?: string }));
          setErrMsg(respBody.error || `Abandon failed (${res.status})`);
          return false;
        }
        onActionApplied?.("abandon");
        return true;
      },
    });
  }, [assignment, closeConfirm, onActionApplied]);

  const onClickHandoff = useCallback(async () => {
    if (!assignment) return;
    closeConfirm();
    const list = await fetchAgents();
    setConfirm({
      verb: "handoff",
      prompt: "Hand this off — pick a new agent:",
      showAgentPicker: true,
      agents: list,
      defaultAgentId: null, // Decision 6 — no implicit default
      showReason: true,
      confirmLabel: "Confirm Hand-off",
      destructive: true,
      onConfirm: async ({ agentId, reason }) => {
        if (!agentId) {
          setErrMsg("Pick a new agent");
          return false;
        }
        const body: { newAgentId: string; reason?: string } = { newAgentId: agentId };
        if (reason) body.reason = reason;
        const res = await fetch(
          `/api/assignments/${encodeURIComponent(assignment.id)}/handoff`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) {
          const respBody = await res.json().catch(() => ({} as { error?: string }));
          setErrMsg(respBody.error || `Hand-off failed (${res.status})`);
          return false;
        }
        onActionApplied?.("handoff");
        return true;
      },
    });
  }, [assignment, closeConfirm, fetchAgents, onActionApplied]);

  const onVerbClick = useCallback((verb: CurationVerb) => {
    if (verb === "dispatch") return void onClickDispatch();
    if (verb === "requeue") return void onClickRequeue();
    if (verb === "abandon") return onClickAbandon();
    if (verb === "handoff") return void onClickHandoff();
  }, [onClickDispatch, onClickRequeue, onClickAbandon, onClickHandoff]);

  if (!assignment) {
    return (
      <div className="curation-toolbar" role="toolbar" aria-label="Task curation">
        <div className="row"><span className="hint">Loading assignment…</span></div>
      </div>
    );
  }

  return (
    <div className="curation-toolbar" role="toolbar" aria-label="Task curation">
      <div className="row">
        {VERBS.map((verb) => {
          const enabled = isEnabled(state, verb);
          const cell = matrix[verb];
          const tooltip = typeof cell === "string" ? cell : "";
          const cls = ["verb"];
          if (DESTRUCTIVE_VERBS.has(verb)) cls.push("destructive");
          return (
            <button
              key={verb}
              type="button"
              className={cls.join(" ")}
              disabled={!enabled}
              title={tooltip || undefined}
              onClick={() => enabled && onVerbClick(verb)}
            >
              {labelForVerb(verb)}
              {VERBS_REQUIRING_CONFIRM.has(verb) ? " ▾" : ""}
            </button>
          );
        })}
      </div>

      {confirm && (
        <ConfirmPanel
          config={confirm}
          onClose={closeConfirm}
        />
      )}

      {errMsg && (
        <div className="err-msg" role="alert">{errMsg}</div>
      )}
    </div>
  );
}

/**
 * Inline confirm panel — replaces the legacy `openCurationConfirm`
 * imperative DOM builder with a declarative React component.
 *
 * Esc closes the panel; Enter confirms. Capture-phase listener so a
 * parent drill-down's Esc handler doesn't close the whole overlay
 * (legacy fix at `dashboard/index.html:3815-3835`).
 */
function ConfirmPanel({
  config,
  onClose,
}: {
  config: ConfirmConfig;
  onClose: () => void;
}) {
  const [agentId, setAgentId] = useState<string>(config.defaultAgentId ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<HTMLSelectElement | null>(null);

  // Auto-focus the most useful input.
  useEffect(() => {
    const t = setTimeout(() => {
      if (config.showReason) reasonRef.current?.focus();
      else if (config.showAgentPicker) pickerRef.current?.focus();
    }, 10);
    return () => clearTimeout(t);
  }, [config.showReason, config.showAgentPicker]);

  // Capture-phase keydown so Esc closes the panel without bubbling up
  // to the drill-down's Esc handler. Enter confirms (matches F-10
  // submit semantics).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void doConfirm();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
    // doConfirm captures `agentId` / `reason` via closure; re-attach
    // each render so the freshest values get used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const doConfirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await config.onConfirm({
        agentId: agentId || null,
        reason: reason.trim(),
      });
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  }, [busy, config, agentId, reason, onClose]);

  return (
    <div className="confirm-panel">
      <div className="prompt">{config.prompt}</div>

      {config.showAgentPicker && (
        <select
          ref={pickerRef}
          className="agent-picker"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={busy}
        >
          {!config.defaultAgentId && (
            <option value="">(pick an agent)</option>
          )}
          {config.agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      )}

      {config.showReason && (
        <input
          ref={reasonRef}
          type="text"
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          disabled={busy}
        />
      )}

      <div className="actions">
        <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          type="button"
          className={config.destructive ? "destructive" : ""}
          onClick={() => void doConfirm()}
          disabled={busy}
        >
          {config.confirmLabel}
        </button>
      </div>
    </div>
  );
}
