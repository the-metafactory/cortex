import { scrollBelowDesk } from "../lib/desk-scroll";
import type { OutlineNode } from "../../../../balance";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DeskItem, DeskView } from "../../desk/types";
import {
  ParentProposalSchema,
  type ParentProposal,
} from "../../desk/balance-parent-schema";
import type { MyDayCommand } from "../../desk/my-day-schema";
import { ApiFailure, postJson } from "../lib/api";
import { submitMyDay } from "./desk-my-day";
import { balanceItemSearch } from "../hooks/use-balance-location";
import {
  catchupSearch,
  useCatchupLocation,
  type CardFilter,
} from "../hooks/use-catchup-location";
import "./desk-catch-up.css";

export function needsAction(item: DeskItem): boolean {
  return item.attention !== "update";
}
export function catchupItems(
  items: DeskItem[],
  area: string,
  filter: CardFilter,
): DeskItem[] {
  return items.filter(
    (i) =>
      (!area || i.area === area) &&
      (filter === "all" || needsAction(i) === (filter === "action")),
  );
}
export function CatchupPreview({
  view,
  onOpen,
}: {
  view: DeskView;
  onOpen: (key: string | null) => void;
}) {
  const count = view.items.filter(needsAction).length;
  return (
    <section className="catchup-preview" aria-label="Catch-up preview">
      <header>
        <h3>Catch-up</h3>
        <button
          type="button"
          className="desk-btn ghost"
          onClick={() => onOpen(null)}
        >
          Open inbox · {view.items.length}
        </button>
      </header>
      <p>{count} need an action</p>
      <ul>
        {view.items.slice(0, 3).map((item) => (
          <li key={item.key}>
            <button type="button" onClick={() => onOpen(item.key)}>
              <strong>{item.title}</strong>
              <small>
                {view.areas.find((a) => a.id === item.area)?.label ??
                  "All areas"}{" "}
                · {item.source}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
type Intent = {
  date: string;
  requestId: string;
  command: Extract<MyDayCommand, { op: "source-plan" }>;
};
type Plan =
  | { kind: "loading"; item: DeskItem }
  | {
      kind: "ready";
      item: DeskItem;
      proposal: ParentProposal;
      parent: string | null;
      intent: Intent | null;
      error: string;
      definitive: boolean;
    };
const FILTERS: { id: CardFilter; label: string }[] = [
  { id: "all", label: "All cards" },
  { id: "action", label: "Needs an action" },
  { id: "update", label: "Just updates" },
];
export function DeskCatchUp({
  view,
  renderItem,
  done,
  onChanged,
  active,
  planItem,
}: {
  view: DeskView;
  renderItem: (item: DeskItem, index: number) => ReactNode;
  done: ReactNode;
  onChanged: () => void;
  active: boolean;
  planItem: DeskItem | null;
}) {
  const [location, go] = useCatchupLocation();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<{ id: string; location: string } | null>(
    null,
  );
  const [filed, setFiled] = useState<ReadonlyMap<string, number>>(() => new Map());
  const sourceItems = view.items.filter(
    (i) => (filed.get(i.todoFingerprint ?? "") ?? -1) <= (view.myDay?.revision ?? -1),
  );
  if (plan && !sourceItems.some((i) => i.key === plan.item.key))
    sourceItems.push(plan.item);
  const open = location.card
    ? sourceItems.find((i) => i.key === location.card)
    : null;
  const filtered = catchupItems(sourceItems, location.area, location.filter);
  const shown =
    open && !filtered.some((i) => i.key === open.key)
      ? [open, ...filtered]
      : filtered;
  const areaItems = catchupItems(sourceItems, location.area, "all");
  const root = useRef<HTMLElement>(null);
  const planSection = useRef<HTMLElement>(null);
  useEffect(() => { if (active && plan) scrollBelowDesk(planSection.current); }, [active, plan?.kind]);
  useEffect(() => {
    if (active && location.card) scrollBelowDesk(root.current?.querySelector<HTMLElement>(`[data-catchup-card="${CSS.escape(location.card)}"]`) ?? null);
  }, [active, location.card]);
  const propose = async (item: DeskItem): Promise<void> => {
    if (inFlight.current) return;
    if (plan?.kind === "ready" && plan.intent && !plan.definitive) {
      setNotice("Retry the pending confirmation before starting another plan.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setPlan({ kind: "loading", item });
    setSaved(null);
    try {
      const proposal = ParentProposalSchema.parse(
        await postJson("/api/desk/plan", {
          key: item.key,
          fingerprint: item.todoFingerprint,
        }),
      );
      if (
        proposal.key !== item.key ||
        proposal.fingerprint !== item.todoFingerprint
      )
        throw new Error("The source changed. Refresh and try again.");
      setPlan({
        kind: "ready",
        item,
        proposal,
        parent: proposal.parent,
        intent: null,
        error: "",
        definitive: false,
      });
    } catch (err) {
      setNotice(
        err instanceof Error
          ? err.message
          : "Could not suggest a parent. The card is kept.",
      );
      setPlan(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const previousPlanItem = useRef<DeskItem | null>(null);
  useEffect(() => {
    if (planItem && planItem !== previousPlanItem.current) {
      previousPlanItem.current = planItem;
      void propose(planItem);
    }
  }, [planItem]);
  const confirm = async (): Promise<void> => {
    if (plan?.kind !== "ready" || inFlight.current) return;
    const draft = plan;
    const intent = draft.intent ?? {
      date: draft.proposal.date,
      requestId: crypto.randomUUID(),
      command: {
        op: "source-plan",
        revision: draft.proposal.revision,
        key: draft.proposal.key,
        fingerprint: draft.proposal.fingerprint,
        parent: draft.parent,
      },
    };
    setPlan({ ...draft, intent });
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await submitMyDay(
        intent.date,
        intent.command,
        intent.requestId,
      );
      const link = result.view?.sources.find(
        (s) =>
          s.taskId === result.outlineId &&
          s.fingerprint === intent.command.fingerprint,
      );
      const exists =
        result.outlineId &&
        (result.view.inbox.some((n) => n.id === result.outlineId) ||
          contains(result.view.outline, result.outlineId));
      if (!link || !exists || !result.outlineId || !result.location)
        throw new Error(
          "The saved location could not be verified. Retry the same confirmation to read its receipt.",
        );
      setSaved({ id: result.outlineId, location: result.location });
      setFiled((s) => new Map(s).set(intent.command.fingerprint, result.view.revision));
      setPlan(null);
      onChanged();
    } catch (err) {
      setPlan({
        ...draft,
        intent,
        error:
          err instanceof Error
            ? err.message
            : "Could not confirm. Retry the same request.",
        definitive:
          err instanceof ApiFailure &&
          err.info.status >= 400 &&
          err.info.status < 500,
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <main className="catchup" ref={root} hidden={!active}>
      <header className="catchup-lead">
        <div>
          <p className="catchup-eyebrow">Your inbox</p>
          <h1>Catch-up</h1>
          <p>What happened, what needs you, and what can wait.</p>
        </div>
        <span>
          {shown.length} cards shown · {shown.filter(needsAction).length}{" "}
          need an action
        </span>
      </header>
      <nav className="catchup-areas" aria-label="Catch-up areas">
        <button
          type="button"
          aria-pressed={!location.area}
          onClick={() => go({ area: "", filter: location.filter, card: null })}
        >
          All areas · {catchupItems(sourceItems, "", location.filter).length}
        </button>
        {view.areas.map((a) => (
          <button
            type="button"
            key={a.id}
            aria-pressed={location.area === a.id}
            onClick={() =>
              go({ area: a.id, filter: location.filter, card: null })
            }
          >
            <span style={{ background: a.color }} />
            {a.label} ·{" "}
            {catchupItems(sourceItems, a.id, location.filter).length}
          </button>
        ))}
      </nav>
      <nav className="catchup-types" aria-label="Catch-up card type">
        {FILTERS.map((f) => (
          <button
            type="button"
            key={f.id}
            aria-pressed={location.filter === f.id}
            onClick={() => go({ ...location, filter: f.id, card: null })}
          >
            {f.label} · {catchupItems(areaItems, "", f.id).length}
          </button>
        ))}
      </nav>
      {notice && <p role="status">{notice}</p>}
      {open && !filtered.some((i) => i.key === open.key) && (
        <p role="status">
          Showing the card you opened outside your saved filters.{" "}
          <button
            type="button"
            className="desk-btn ghost"
            onClick={() => go({ area: "", filter: "all", card: open.key })}
          >
            Clear filters
          </button>
        </p>
      )}
      {plan && (
        <section className="catchup-plan" aria-label="Plan this" ref={planSection} tabIndex={-1}>
          <h2>Plan this</h2>
          <p>{plan.item.title}</p>
          {plan.kind === "loading" ? (
            <p role="status">Finding an existing place in Balance…</p>
          ) : (
            <>
              <p>{plan.proposal.reason}</p>
              <label>
                Save in{" "}
                <select
                  value={plan.parent ?? ""}
                  disabled={busy || Boolean(plan.intent)}
                  onChange={(e) =>
                    setPlan({ ...plan, parent: e.target.value || null })
                  }
                >
                  <option value="">Inbox</option>
                  {plan.proposal.parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.path}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                This becomes planned work. Today's confirmed priorities stay as
                they are.
              </p>
              {plan.error && <p role="alert">{plan.error}</p>}
              <button
                type="button"
                className="desk-btn pri"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy
                  ? "Saving…"
                  : plan.intent
                    ? "Retry confirmation"
                    : "Confirm plan"}
              </button>
              {plan.definitive && (
                <button
                  type="button"
                  className="desk-btn"
                  disabled={busy}
                  onClick={() => void propose(plan.item)}
                >
                  Refresh proposal
                </button>
              )}
              <button
                type="button"
                className="desk-btn ghost"
                disabled={busy || Boolean(plan.intent && !plan.definitive)}
                onClick={() => setPlan(null)}
              >
                Cancel
              </button>
            </>
          )}
        </section>
      )}
      {saved && (
        <p className="catchup-receipt" role="status">
          Planned in {saved.location}.{" "}
          <a
            href={balanceItemSearch(
              typeof window === "undefined" ? "" : window.location.search,
              saved.id,
            )}
          >
            Open saved task in Balance
          </a>
        </p>
      )}
      <div className="catchup-stream">
        {shown.map((item, index) => (
          <article
            key={item.key}
            data-catchup-card={item.key}
            tabIndex={-1}
            className={
              location.card === item.key
                ? "catchup-card selected"
                : "catchup-card"
            }
          >
            {renderItem(item, index)}
            <footer>
              <span>
                {view.areas.find((a) => a.id === item.area)?.label ??
                  "All areas"}{" "}
                · {item.source}
              </span>
              <button
                type="button"
                className="desk-btn"
                disabled={
                  busy ||
                  Boolean(
                    plan?.kind === "ready" && plan.intent && !plan.definitive,
                  )
                }
                onClick={() => void propose(item)}
              >
                Plan this
              </button>
            </footer>
          </article>
        ))}
      </div>
      {shown.length === 0 && (
        <section className="catchup-empty">
          <h2>No cards match these filters.</h2>
          <p>
            {view.areas.find((a) => a.id === location.area)?.label ??
              (location.area ? "An unavailable area" : "All areas")}{" "}
            · {FILTERS.find((f) => f.id === location.filter)?.label}
          </p>
          <button
            type="button"
            className="desk-btn"
            onClick={() => go({ area: "", filter: "all", card: null })}
          >
            Clear filters
          </button>
        </section>
      )}
      <aside className="catchup-done">{done}</aside>
    </main>
  );
}
function contains(node: OutlineNode, id: string): boolean {
  return node.id === id || node.children.some((child) => contains(child, id));
}
export const catchupHref = (key: string | null): string =>
  catchupSearch(typeof window === "undefined" ? "" : window.location.search, {
    area: "",
    filter: "all",
    card: key,
  });
