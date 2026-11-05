import { useRef, useState } from "react";
import { postJson } from "../lib/api";
import { ProposalCard } from "./desk-proposal";
import type { RoutineAction, RoutineResult } from "../../desk/routine-store";
import type { BuildState, DraftNodeView, RoutineDraftView } from "../../desk/routine-capability-contract";
import { submitCapabilityInstall } from "../lib/desk-capability-install";

const prLabel = (pr: string): string => (/^\d+$/.test(pr) ? `PR #${pr}` : pr);

export function buildStateText(build: BuildState | null): string {
  if (!build) return "";
  switch (build.state) {
    case "filed": return "Filed, waiting to start";
    case "building": return "Building";
    case "in-review": return "In review";
    case "merged": return "Merged";
    case "live": return "Live";
    case "failed": return `Failed: ${build.reason ?? "no reason was reported"}`;
    case "unknown": return `State unknown: ${build.error}`;
  }
}

export function BuildStateLine({ node }: { node: DraftNodeView }) {
  const { build } = node;
  const pr = build && build.state !== "unknown" ? build.pr : undefined;
  return <p role={build?.state === "failed" || build?.state === "unknown" ? "alert" : "status"}>
    <strong>{node.capability}</strong>
    {build && <>: {node.canInstall ? "Merged, install?" : buildStateText(build)}</>}
    {node.install?.state === "failed" && <> · install failed: {node.install.error}</>}
    {node.install?.state === "running" && <> · Installing; waiting for the pack command to confirm</>}
    {node.install?.state === "undoing" && <> · Uninstalling; waiting for the pack command to confirm</>}
    {node.install?.state === "installed" && build?.state !== "live" && <> · {node.presenceLate ? "installed, not in presence yet" : "Installed, waiting for local presence"}</>}
    {pr && <> ({prLabel(pr)})</>}
    {node.notStarted && <> · Not started: {node.notStarted}</>}
    {" "}<a href={node.url} target="_blank" rel="noreferrer">{node.ref}</a>
  </p>;
}

function InstallCapability({ draft, node, onChanged }: { draft: RoutineDraftView; node: DraftNodeView; onChanged: () => void }) {
  const requestId = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await submitCapabilityInstall({ action: "capability.install", requestId: requestId.current, proposalId: draft.proposalId, capability: node.capability });
      if (!result.ok) {
        setError(result.error);
        if (!result.uncertain) requestId.current = crypto.randomUUID();
      }
      setConfirm(false);
      onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : "The install command did not answer. Retry this same action."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return <div>
    {confirm ? <><p>Install the configured capability pack and reload its agents?</p><button className="desk-btn desk-btn--primary" type="button" disabled={busy} onClick={() => { void install(); }}>Confirm install</button><button className="desk-btn" type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button></>
      : <button className="desk-btn desk-btn--primary" type="button" disabled={busy} onClick={() => setConfirm(true)}>Install</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function RoutineDraft({ draft, onChanged }: { draft: RoutineDraftView; onChanged: () => void }) {
  const requests = useRef({ install: crypto.randomUUID(), discard: crypto.randomUUID() });
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: "install" | "discard"): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await postJson<RoutineAction, RoutineResult>("/api/desk/routines", { action, target: draft.proposalId, requestId: requests.current[action] });
      if (!result.ok) { setError(result.error); return; }
      onChanged();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The routine action did not answer. Retry this same action.");
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <li><div>
    <strong>{draft.proposal ? `Ready: ${draft.title}` : draft.title}</strong>
    {draft.missing.length > 0 && <p>Still missing: {draft.missing.map((missing) => missing.capability).join(", ")}.</p>}
    {draft.error && <p role="alert">{draft.error}</p>}
    {draft.nodes.map((node) => <div key={node.capability}><BuildStateLine node={node} />{node.canInstall && <InstallCapability draft={draft} node={node} onChanged={onChanged} />}</div>)}
    {draft.proposal ? <ProposalCard proposal={draft.proposal} said={draft.title} maps={[]} now={Date.now()} busy={busy} onConfirm={() => { void act("install"); }} onCancel={() => { void act("discard"); }} cancelLabel="Discard" onGoto={() => undefined} onFieldsChange={() => undefined} />
      : <button className="desk-btn" type="button" disabled={busy} onClick={() => { void act("discard"); }}>Discard</button>}
    {error && <p role="alert">{error}</p>}
  </div></li>;
}

export function RoutineDrafts({ drafts, onChanged }: { drafts: RoutineDraftView[] | undefined; onChanged: () => void }) {
  if (!drafts?.length) return null;
  return <section aria-label="Routine drafts">
    <h4>Routine drafts</h4>
    <ul className="desk-sub">
      {drafts.map((draft) => <RoutineDraft key={draft.proposalId} draft={draft} onChanged={onChanged} />)}
    </ul>
  </section>;
}
