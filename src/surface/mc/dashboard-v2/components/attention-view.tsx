/**
 * G-1113.E.3 — attention queue surface (design §7.4). Lists open attention
 * items (severity-ordered by the projection), each deep-linking to the exact
 * work item (→ work-item-detail) or session (→ drill-down) that needs action.
 */
import type { AttentionEntry } from "../../api/attention";
import type { AttentionKind } from "../../types";

const KIND_LABEL: Record<AttentionKind, string> = {
  input_needed: "input needed",
  permission: "permission",
  review: "review",
  failed_dispatch: "failed dispatch",
  stale: "stale",
  blocked: "blocked",
};

export interface AttentionViewProps {
  entries: AttentionEntry[];
  loaded: boolean;
  /** Open the work-item-detail surface (E.3 deep-link). */
  onOpenWorkItem?: (workItemId: string) => void;
  /** Open the drill-down for an assignment (E.3 deep-link for session items). */
  onOpenAssignment?: (assignmentId: string) => void;
}

export function AttentionView({ entries, loaded, onOpenWorkItem, onOpenAssignment }: AttentionViewProps) {
  return (
    <section className="scaffold-section attention-view" aria-label="Attention">
      <h2>
        Attention {loaded && entries.length > 0 ? <span className="dim">({entries.length})</span> : null}
      </h2>
      {!loaded ? (
        <p className="dim">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="dim">Nothing needs your attention.</p>
      ) : (
        <ul className="attention-list">
          {entries.map(({ item, link }) => {
            const deepLink =
              link.kind === "work-item" && onOpenWorkItem
                ? { label: link.label, onClick: () => onOpenWorkItem(link.workItemId) }
                : link.kind === "session" && link.assignmentId && onOpenAssignment
                  ? { label: "open session", onClick: () => onOpenAssignment(link.assignmentId as string) }
                  : null;
            return (
              <li key={item.id} className={`attention-item sev-${item.severity}`}>
                <span className={`badge kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                <span className={`badge sev-${item.severity}`}>{item.severity}</span>
                {deepLink ? (
                  <button type="button" className="attention-link" onClick={deepLink.onClick}>
                    {deepLink.label}
                  </button>
                ) : (
                  <span className="dim faint">{link.kind === "work-item" ? link.label : "—"}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
