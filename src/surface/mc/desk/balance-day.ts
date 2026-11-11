import type { ObservationView } from "../../../conversations/domain-adapters/reads/observation-types";
import type { OutlineNode } from "../../../balance";

export type BalanceDayHealth = "fresh" | "stale" | "unavailable" | "conflicted";

export interface BalanceProjectedTask {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly dueDate: string | null;
  readonly note?: string;
  readonly effort?: 1 | 2 | 4;
}

export interface BalanceDayProjection {
  readonly status: BalanceDayHealth;
  readonly observedAt: string | null;
  readonly tasks: readonly BalanceProjectedTask[];
}

export interface BalanceDayReader {
  projection(refresh?: boolean): Promise<BalanceDayProjection | null>;
}

export type BalanceDayAccess = () => BalanceDayReader | null;

export interface BalanceDayObservation {
  readonly status: "ok" | "denied" | "unavailable";
  readonly views: readonly ObservationView[];
}

export interface BalanceDaySource {
  check(mode: "poll" | "reconcile"): Promise<Pick<BalanceDayObservation, "status">>;
  views(): Promise<readonly ObservationView[] | null>;
}

export function releasedObservationViews(value: unknown): readonly ObservationView[] | null {
  if (!isRecord(value) || !Array.isArray(value.objects)) return null;
  return value.objects as ObservationView[];
}

export function createBalanceDayReader(source: BalanceDaySource): BalanceDayReader {
  return {
    async projection(refresh = false) {
      const checked = await source.check(refresh ? "reconcile" : "poll");
      if (checked.status === "denied") return null;
      const views = await source.views();
      return views === null ? null : balanceDayProjection({ status: checked.status, views });
    },
  };
}

const HEALTH: readonly BalanceDayHealth[] = ["fresh", "stale", "unavailable", "conflicted"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

function healthOf(value: unknown): BalanceDayHealth {
  return value === "stale" || value === "unavailable" || value === "conflicted" ? value : "fresh";
}

function taskOf(view: ObservationView): BalanceProjectedTask | null {
  if (view.kind !== "present" || !isRecord(view.value)) return null;
  const title = text(view.value.title);
  if (title === null || title.length === 0) return null;
  const note = text(view.value.note);
  const effort = view.value.effort === 1 || view.value.effort === 2 || view.value.effort === 4 ? view.value.effort : undefined;
  return {
    id: view.ref.canonicalId,
    title,
    done: view.value.status === "done",
    dueDate: text(view.value.dueDate),
    ...(note === null ? {} : { note }),
    ...(effort === undefined ? {} : { effort }),
  };
}

export function balanceDayProjection(observation: BalanceDayObservation): BalanceDayProjection | null {
  if (observation.status === "denied") return null;
  if (observation.views.length === 0 && observation.status !== "ok") return { status: "unavailable", observedAt: null, tasks: [] };
  const status = observation.views.reduce<BalanceDayHealth>((held, view) => {
    const current = healthOf(view.status);
    return HEALTH.indexOf(current) > HEALTH.indexOf(held) ? current : held;
  }, "fresh");
  const observedAt = observation.views.reduce<string | null>((held, view) => held === null || view.observedAt > held ? view.observedAt : held, null);
  return { status, observedAt, tasks: observation.views.flatMap(view => { const task = taskOf(view); return task === null ? [] : [task]; }) };
}

export function applyBalanceDayProjection(outline: OutlineNode, tasks: readonly BalanceProjectedTask[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visit = (node: OutlineNode): void => {
    const task = byId.get(node.id);
    if (task) {
      node.title = task.title;
      if (task.done) node.done = true;
      else delete node.done;
      if (task.dueDate === null) delete node.dueDate;
      else node.dueDate = task.dueDate;
      if (task.note === undefined) delete node.note;
      else node.note = task.note;
      if (task.effort === undefined) delete node.effort;
      else node.effort = task.effort;
    }
    for (const child of node.children) visit(child);
  };
  visit(outline);
}
