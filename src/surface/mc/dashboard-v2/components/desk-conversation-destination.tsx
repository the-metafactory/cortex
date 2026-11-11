import { useEffect, useMemo, useState } from "react";
import type { DeskView } from "../../desk/types";
import { getJson } from "../lib/api";
import { areaProjects, balanceDestinations, type BalanceDestination, resolveBalanceProject } from "../../desk/balance-destinations";
import { readBalanceSurfaceDestinations } from "../lib/desk-balance-surfaces";
import { DestinationPicker } from "./desk-destination-picker";

interface DestinationChoices { readonly areas: { id: string; label: string }[]; readonly destinations: BalanceDestination[] }
type Reading = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; choices: DestinationChoices };

const titleOf = (label: string): string => label.split(" / ").at(-1) ?? label;

export function useConversationDestinations(retry: number): Reading {
  const [reading, setReading] = useState<Reading>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setReading({ kind: "loading" });
    void readBalanceSurfaceDestinations(controller.signal).then(surface => {
      if (controller.signal.aborted) return;
      if (surface.enabled) {
        setReading({ kind: "ready", choices: {
          areas: surface.areas.map(area => ({ id: area.ref, label: area.label })),
          destinations: [
            ...surface.areas.map(area => ({ id: area.ref, area: area.ref, label: area.label, title: area.label, project: false })),
            ...surface.projects.map(project => ({ id: project.ref, area: project.area, label: project.label, title: titleOf(project.label), project: true })),
          ],
        } });
        return;
      }
      void getJson<DeskView>("/api/desk", { signal: controller.signal }).then(view => {
        if (controller.signal.aborted) return;
        setReading(view.myDay ? { kind: "ready", choices: { areas: view.areas, destinations: balanceDestinations(view.myDay.outline, view.areas) } } : { kind: "error", message: "Balance destinations are unavailable. Retry when its owner is ready." });
      }).catch((error: unknown) => {
        if (!controller.signal.aborted) setReading({ kind: "error", message: error instanceof Error ? error.message : "Balance destinations could not be read." });
      });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setReading({ kind: "error", message: error instanceof Error ? error.message : "Balance destinations could not be read." });
    });
    return () => { controller.abort(); };
  }, [retry]);
  return reading;
}

export function ConversationDestination({ fields, onChange, disabled, project = true }: { fields: Record<string, string>; onChange: (fields: Record<string, string>) => void; disabled: boolean; project?: boolean }) {
  const [retry, setRetry] = useState(0);
  const reading = useConversationDestinations(retry);
  const projects = useMemo(() => reading.kind === "ready" ? areaProjects(reading.choices.destinations, fields.area ?? "") : [], [reading, fields.area]);
  useEffect(() => {
    if (disabled || !project || reading.kind !== "ready" || !fields.project) return;
    const selected = resolveBalanceProject(projects, fields.project);
    if (selected && selected.id !== fields.project) onChange({ ...fields, project: selected.id });
  }, [reading, projects, fields, onChange, project, disabled]);
  if (reading.kind === "loading") return <div><p role="status">Loading Balance destinations…</p><DestinationPicker label="Area" value="" options={[]} onChange={() => undefined} disabled empty="Loading areas…" />{project && <DestinationPicker label="Parent project" value="" options={[]} onChange={() => undefined} disabled empty="Loading projects…" />}</div>;
  if (reading.kind === "error") return <div><p role="alert">{reading.message}</p><button className="desk-btn" type="button" onClick={() => { setRetry(value => value + 1); }}>Retry destinations</button></div>;
  const { areas } = reading.choices;
  return <>
    <DestinationPicker label="Area" value={fields.area ?? ""} options={areas.map(area => ({ id: area.id, label: area.label }))} disabled={disabled} empty="No configured areas." onChange={area => { onChange({ ...fields, area, project: projects.some(option => option.area === area && option.id === fields.project) ? fields.project ?? "" : "" }); }} />
    {project && <DestinationPicker label="Parent project" value={resolveBalanceProject(projects, fields.project ?? "")?.id ?? fields.project ?? ""} options={[{ id: "", label: "Area level — no parent project" }, ...projects]} disabled={disabled || !areas.some(area => area.id === fields.area)} empty="No open projects in this area." onChange={value => { onChange({ ...fields, project: value }); }} />}
    {project && projects.length === 0 && <p role="status">No open projects in this area. You can use the area-level destination.</p>}
    <button type="button" className="desk-btn ghost" disabled={disabled} onClick={() => { setRetry(value => value + 1); }}>Refresh destinations</button>
  </>;
}
