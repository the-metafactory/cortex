import { useEffect, useState } from "react";
import { readGraphSurfaceCard, type GraphSurfaceCard } from "../lib/desk-graph-surfaces";

export type DisplayCardReading = { kind: "loading" } | { kind: "off" } | { kind: "failed" } | { kind: "ready"; card: Exclude<GraphSurfaceCard, { enabled: false }> };

export function useDisplayCard(ref: string | undefined, repository: string, wanted: boolean): DisplayCardReading {
  const [reading, setReading] = useState<DisplayCardReading>({ kind: "loading" });
  useEffect(() => {
    if (!wanted || !ref) return;
    const controller = new AbortController();
    setReading({ kind: "loading" });
    readGraphSurfaceCard(ref, repository, controller.signal).then(card => {
      if (!controller.signal.aborted) setReading(card.enabled ? { kind: "ready", card } : { kind: "off" });
    }).catch(() => {
      if (!controller.signal.aborted) setReading({ kind: "failed" });
    });
    return () => { controller.abort(); };
  }, [ref, repository, wanted]);
  return reading;
}

const label = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

export function DisplayCard({ reading }: { reading: DisplayCardReading }) {
  if (reading.kind === "off") return null;
  if (reading.kind === "loading") return <p className="dcv-quiet" role="status">Loading the saved card…</p>;
  if (reading.kind === "failed") return <p className="dcv-quiet" role="status">The saved card could not be read. The item itself is unchanged.</p>;
  const { card } = reading;
  if (card.state === "withheld") return <aside className="dcv-card withheld" aria-label="Saved card" role="status">Content withheld: its repository is not ticked in Desk Settings.</aside>;
  if (card.state === "unavailable") return <aside className="dcv-card unavailable" aria-label="Saved card" role="status">This item is unavailable. It was created; the owner no longer returns it.</aside>;
  return <aside className="dcv-card" aria-label="Saved card">
    <strong>{card.title}</strong>
    <span className={`dcv-card-status ${card.status ?? ""}`}>{card.status ? label(card.status) : "Status unknown"}</span>
    {card.kind && <span className="dcv-quiet">{label(card.kind)}</span>}
    {card.url && /^https?:\/\//.test(card.url) && <a href={card.url} target="_blank" rel="noreferrer">Open</a>}
  </aside>;
}
