import { useEffect, useState } from "react";
import type { FlowSavedCard } from "../../desk/flow-surface-schema";
import { loadSavedFlowCard } from "../lib/desk-flows";
import { formatRelativeTime } from "../lib/agents-display";

type ShownCard = Extract<FlowSavedCard, { enabled: true }>;
export type SavedFlowReading = { kind: "waiting" } | { kind: "failed" } | { kind: "ready"; card: ShownCard };

export function useSavedFlowCard(ref: string | undefined, operation: string | undefined, wanted: boolean): SavedFlowReading {
  const [reading, setReading] = useState<SavedFlowReading>({ kind: "waiting" });
  useEffect(() => {
    if (!wanted || !ref || !operation) return;
    const controller = new AbortController();
    setReading({ kind: "waiting" });
    loadSavedFlowCard(ref, operation, controller.signal).then(card => {
      if (!controller.signal.aborted && card.enabled) setReading({ kind: "ready", card });
    }).catch(() => {
      if (!controller.signal.aborted) setReading({ kind: "failed" });
    });
    return () => { controller.abort(); };
  }, [ref, operation, wanted]);
  return reading;
}

const short = (sha256: string): string => sha256.slice(0, 12);

export function SavedFlowCard({ reading, now = Date.now() }: { reading: SavedFlowReading; now?: number }) {
  if (reading.kind === "failed") return <p className="dcv-quiet" role="status">The saved flow's card could not be read. The receipt stands.</p>;
  if (reading.kind === "waiting" || reading.card.state === "unrecorded") return null;
  const { card } = reading;
  if (card.state === "withheld") return <aside className="dcv-card withheld" aria-label="Saved flow card" role="status">Content withheld: this connection cannot read the saved flow. The receipt stands: sha256 <code>{short(card.receipt.sha256)}</code>.</aside>;
  if (card.state === "unavailable") return <aside className="dcv-card unavailable" aria-label="Saved flow card" role="status">This saved flow is no longer available in the library. The receipt stands: {card.receipt.name} · sha256 <code>{short(card.receipt.sha256)}</code>.</aside>;
  return <aside className="dcv-card" aria-label="Saved flow card">
    <strong>{card.name}</strong>
    <span className={`dcv-card-status ${card.changed ? "changed" : "created"}`}>{card.changed ? "Changed since the receipt" : "Saved"}</span>
    <span className="dcv-quiet">Saved {formatRelativeTime(Date.parse(card.savedAt), now)} · {card.origin === "conversation" ? "from a conversation" : "from the command line"}</span>
    {card.changed
      ? <p className="dcv-quiet" role="status">Different content is saved under this name now: its sha256 <code>{short(card.sha256)}</code> differs from the receipt <code>{short(card.receipt.sha256)}</code>.</p>
      : <p className="dcv-quiet">The saved content still matches the receipt <code>{short(card.receipt.sha256)}</code>.</p>}
  </aside>;
}
