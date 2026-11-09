import { useEffect, useState } from "react";
import type { FieldSpec } from "../../../../conversations/catalog";
import type { GraphNodeOption, GraphRepository } from "../../desk/graph-repositories";
import { loadGraphNodes, loadTickedGraphRepositories } from "../lib/desk-graph-repositories";

export const GRAPH_TYPES: ReadonlySet<string> = new Set(["graph-node", "graph-map"]);
export const DEFAULT_CHECKPOINT = "The principal reviews the result and accepts it.";
export const GRAPH_DESTINATION_KEY = "cortex.conversation.graph-destination";

export interface GraphDestination { repository?: string; parent?: string }
const NOTHING_REMEMBERED: GraphDestination = {};
const STORAGE_UNAVAILABLE = false;

const store = (): Storage | null => (typeof window === "undefined" ? null : window.localStorage);

export function recallGraphDestination(): GraphDestination {
  try {
    const value: unknown = JSON.parse(store()?.getItem(GRAPH_DESTINATION_KEY) ?? "{}");
    if (typeof value !== "object" || value === null) return NOTHING_REMEMBERED;
    const { repository, parent } = value as Record<string, unknown>;
    return { ...(typeof repository === "string" ? { repository } : {}), ...(typeof parent === "string" ? { parent } : {}) };
  } catch {
    return NOTHING_REMEMBERED;
  }
}

export function rememberGraphDestination(fields: Record<string, string>): boolean {
  try {
    store()?.setItem(GRAPH_DESTINATION_KEY, JSON.stringify({ repository: fields.repository ?? "", parent: fields.parent ?? "" }));
    return true;
  } catch {
    return STORAGE_UNAVAILABLE;
  }
}

/**
 * Fills the empty fields of an editable proposal: a choice field takes its first (default) option, a graph checkpoint a
 * default gate, and the repository and parent the last confirmed graph destination while that repository is still ticked
 * (or the only ticked one). Fields that already hold a value are never touched.
 */
export function prefillFields(type: string | null, fields: Record<string, string>, specs: readonly FieldSpec[], repositories: readonly GraphRepository[] | null, remembered: GraphDestination): Record<string, string> {
  const next = { ...fields };
  const empty = (name: string): boolean => specs.some(f => f.name === name) && !next[name]?.trim();
  for (const f of specs) if (f.options?.[0] && empty(f.name)) next[f.name] = f.options[0];
  if (!type || !GRAPH_TYPES.has(type)) return next;
  if (empty("checkpoint")) next.checkpoint = DEFAULT_CHECKPOINT;
  const ticked = repositories?.map(r => r.ref) ?? [];
  const recalled = remembered.repository && ticked.includes(remembered.repository) ? remembered.repository : ticked.length === 1 ? ticked[0] : undefined;
  if (recalled && empty("repository")) next.repository = recalled;
  if (remembered.parent && next.repository === remembered.repository && empty("parent")) next.parent = remembered.parent;
  return next;
}

export interface GraphChoices { repositories: GraphRepository[] | null; nodes: GraphNodeOption[] | null; note: string | null }

export function useGraphChoices(active: boolean, repository: string): GraphChoices {
  const [repositories, setRepositories] = useState<GraphRepository[] | null>(null);
  const [nodes, setNodes] = useState<GraphNodeOption[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void loadTickedGraphRepositories().then(r => {
      if (!live) return;
      if (r.ok) setRepositories(r.items);
      else setNote(r.text);
    });
    return () => { live = false; };
  }, [active]);
  const ticked = repositories?.some(r => r.ref === repository) ?? false;
  useEffect(() => {
    setNodes(null);
    if (!active || !ticked) return;
    let live = true;
    void loadGraphNodes(repository).then(r => {
      if (!live) return;
      if (r.ok) { setNodes(r.items); setNote(null); }
      else setNote(r.text);
    });
    return () => { live = false; };
  }, [active, ticked, repository]);
  return { repositories, nodes, note };
}

export function GraphDatalists({ id, choices }: { id: string; choices: GraphChoices }) {
  return <>
    <datalist id={`${id}-repositories`}>{(choices.repositories ?? []).map(r => <option key={r.ref} value={r.ref}>{r.label}</option>)}</datalist>
    <datalist id={`${id}-nodes`}>{(choices.nodes ?? []).map(n => <option key={n.id} value={n.id}>{`#${n.id} ${n.title}`}</option>)}</datalist>
  </>;
}

export const graphListFor = (type: string | null, field: string, id: string): string | undefined => {
  if (!type || !GRAPH_TYPES.has(type)) return undefined;
  if (field === "repository") return `${id}-repositories`;
  return field === "parent" ? `${id}-nodes` : undefined;
};
