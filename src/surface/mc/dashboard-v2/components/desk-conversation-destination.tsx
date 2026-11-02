import { useEffect, useState } from "react";
import type { DeskView } from "../../desk/types";
import { getJson } from "../lib/api";
import { balanceDestinations } from "../../desk/balance-destinations";
import { DestinationPicker } from "./desk-destination-picker";

type Reading = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; view: DeskView };
export function ConversationDestination({ fields, onChange, disabled, project = true }: { fields: Record<string, string>; onChange: (fields: Record<string, string>) => void; disabled: boolean; project?: boolean }) {
  const [reading, setReading] = useState<Reading>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReading({ kind: "loading" });
    void getJson<DeskView>("/api/desk", { signal: controller.signal }).then(view => {
      if (!controller.signal.aborted) setReading(view.myDay ? { kind: "ready", view } : { kind: "error", message: "Balance destinations are unavailable. Retry when its owner is ready." });
    }).catch((error: unknown) => { if (!controller.signal.aborted) setReading({ kind: "error", message: error instanceof Error ? error.message : "Balance destinations could not be read." }); });
    return () => { controller.abort(); };
  }, [retry]);
  if (reading.kind === "loading") return <div><p role="status">Loading Balance destinations…</p><DestinationPicker label="Area" value="" options={[]} onChange={() => undefined} disabled empty="Loading areas…" />{project && <DestinationPicker label="Parent project" value="" options={[]} onChange={() => undefined} disabled empty="Loading projects…" />}</div>;
  if (reading.kind === "error") return <div><p role="alert">{reading.message}</p><button className="desk-btn" type="button" onClick={() => { setRetry(value => value + 1); }}>Retry destinations</button></div>;
  const { view } = reading;
  const destinations = view.myDay ? balanceDestinations(view.myDay.outline, view.areas) : [];
  const projects = destinations.filter(option => option.area === fields.area && option.project);
  return <>
    <DestinationPicker label="Area" value={fields.area ?? ""} options={view.areas.map(area => ({ id: area.id, label: area.label }))} disabled={disabled} empty="No configured areas." onChange={area => { onChange({ ...fields, area, project: projects.some(option => option.area === area && option.id === fields.project) ? fields.project ?? "" : "" }); }} />
    {project && <DestinationPicker label="Parent project" value={fields.project ?? ""} options={[{ id: "", label: "Area level — no parent project" }, ...projects]} disabled={disabled || !view.areas.some(area => area.id === fields.area)} empty="No open projects in this area." onChange={value => { onChange({ ...fields, project: value }); }} />}
    {project && projects.length === 0 && <p role="status">No open projects in this area. You can use the area-level destination.</p>}
    <button type="button" className="desk-btn ghost" disabled={disabled} onClick={() => { setRetry(value => value + 1); }}>Refresh destinations</button>
  </>;
}
