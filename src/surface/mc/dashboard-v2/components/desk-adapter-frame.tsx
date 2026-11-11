import { useEffect, useRef, useState, type ReactNode } from "react";
import { mountAdapterFrame, type FrameNavigation } from "../lib/desk-adapter-frame";
import { draftTargets, readDraft, type DraftEditorView, type DraftTarget } from "../lib/desk-drafts";
import { DeskDraftEditor } from "./desk-draft-editor";

export function DeskAdapterFrame({ mountId, fallback, onNavigate }: { mountId: string | null; fallback: ReactNode; onNavigate?: (target: FrameNavigation) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("loading");
  const [review, setReview] = useState<{ editor: DraftEditorView; targets: DraftTarget[]; token: symbol } | null>(null);
  useEffect(() => {
    setReview(null);
    if (!container.current || !mountId) { setState("unavailable"); return; }
    let active = true;
    let reviewEpoch = 0;
    const stop = mountAdapterFrame(container.current, mountId, {
      state: next => { if (active) { setState(next); if (next === "unavailable") { reviewEpoch++; setReview(null); } } },
      navigate: onNavigate,
      review: (draftId, revision) => {
        const epoch = ++reviewEpoch;
        void Promise.all([readDraft(draftId), draftTargets()]).then(([editor, targets]) => {
          if (active && epoch === reviewEpoch && editor.view.draft.revision === revision) setReview({ editor, targets: targets.targets, token: Symbol() });
        }).catch(() => { if (active && epoch === reviewEpoch) { reviewEpoch++; setReview(null); setState("unavailable"); } });
      },
    });
    return () => { active = false; stop(); };
  }, [mountId, onNavigate]);
  return <section aria-label="Adapter object" data-adapter-state={state}>
    <div hidden={state === "ready"}>{fallback}</div>
    <div ref={container} hidden={state !== "ready"} />
    {review && <section aria-label="Review proposed action"><h3>Review proposed action</h3><DeskDraftEditor editor={review.editor} targets={review.targets} onChanged={editor => { setReview(current => current?.token === review.token && editor.view.draft.revision >= current.editor.view.draft.revision ? { ...current, editor } : current); }} /></section>}
  </section>;
}
