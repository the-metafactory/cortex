import { useRef, useState } from "react";
import { postJson } from "../lib/api";
import { ProposalCard } from "./desk-proposal";
import type { RoutineAction, RoutineResult } from "../../desk/routine-store";
import type { BuildState, DraftNodeView, RoutineDraftView } from "../../desk/routine-capability-contract";

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
    {build && <>: {buildStateText(build)}</>}
    {pr && <> ({prLabel(pr)})</>}
    {node.notStarted && <> · Not started: {node.notStarted}</>}
    {" "}<a href={node.url} target="_blank" rel="noreferrer">{node.ref}</a>
  </p>;
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
    {draft.nodes.map((node) => <BuildStateLine key={node.capability} node={node} />)}
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
