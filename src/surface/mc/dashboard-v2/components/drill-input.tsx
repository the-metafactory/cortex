/**
 * F-10 drill-input — operator message + image attachments.
 *
 * Faithful port of the legacy monolith input (docs/design-mc-f10-operator-input.md
 * + docs/design-mc-image-input.md). Behavioural parity:
 *  - Active / observed / ended / shadow modes (resolveDrillInputMode)
 *  - 50 KB UTF-8 byte cap (paste-trim + Send disable)
 *  - Per-assignment send queue, released on assignment.state change
 *  - Inline error banner with status-code copy + Retry / Dismiss
 *  - Image paste + drag-drop + chip row + lightbox preview
 *  - Image bounds: PNG/JPEG/WebP/GIF · 5 MB each · 8 per message
 *  - Optimistic clear of textarea+chips on submit; restored on failure
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  byteSize,
  trimToBytes,
  base64DecodedSize,
  formatBytes,
  isoSlug,
  mediaTypeExtension,
  resolveDrillInputMode,
  resolveErrorCopy,
  DRILL_INPUT_MAX_BYTES,
  IMAGE_ALLOWED_MEDIA_TYPES,
  IMAGE_MAX_COUNT_PER_MESSAGE,
  IMAGE_MAX_DECODED_BYTES,
} from "../lib/drill-input";
import { ImageLightbox } from "./image-lightbox";
import { ApiFailure } from "../lib/api";
import type { WsClient, WsMessage } from "../hooks/use-websocket";
import type { AssignmentListItem } from "../../db/assignments";

export interface DrillInputProps {
  assignmentId: string;
  /** May be null momentarily before assignments load. */
  assignment: AssignmentListItem | null;
  /**
   * WebSocket client used to subscribe to `state.transition` frames for
   * the queue-release signal. Each transition for `assignmentId` releases
   * one queued submission (legacy parity, dashboard/index.html:1199).
   */
  ws: WsClient;
  /**
   * Submit operator input. Must throw `ApiFailure` (from lib/api) on a
   * non-2xx response or network failure so the inline banner can render
   * status-coded copy.
   */
  onSend: (
    assignmentId: string,
    text: string,
    images?: Array<{ media_type: string; data: string }>
  ) => Promise<void>;
}

/**
 * Canned-action prompts per migration addendum §"Rich reply surface"
 * (line 54) — fixed text the operator can drop into the textarea, edit,
 * and send. Decoupled from any specific agent — the prompts are framed
 * as universal operator moves.
 */
const CANNED_ACTIONS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "ask for more", text: "Can you walk me through what you've tried so far and what's blocking?" },
  { label: "show test output", text: "Show me the full test output for the failing case." },
  { label: "review PR", text: "Open a PR for the change so I can review the diff." },
  { label: "redirect", text: "Stop the current line of work and switch to: " },
];

interface StagedImage {
  id: number;
  name: string;
  media_type: string;
  data: string;       // raw base64, no `data:` prefix
  decodedSize: number;
}

interface QueueEntry {
  text: string;
  images: Array<{ media_type: string; data: string }>;
}

interface PendingError {
  status: number;
  copy: string;
}

const HINT_FLASH_MS = 3000;

export function DrillInput({ assignmentId, assignment, ws, onSend }: DrillInputProps) {
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<StagedImage[]>([]);
  const [pendingError, setPendingError] = useState<PendingError | null>(null);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const lastSentRef = useRef<{ text: string; images: StagedImage[] }>({ text: "", images: [] });
  const idSeqRef = useRef(0);
  const pendingReadsRef = useRef(0);
  const dragDepthRef = useRef(0);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Latest-committed mirrors used by the WS subscription closure so it
  // can read state without resubscribing every render and without
  // nesting setState updaters (StrictMode would double-invoke them).
  const queueRef = useRef<QueueEntry[]>(queue);
  const busyRef = useRef(busy);
  const doSendRef = useRef<(text: string, images: Array<{ media_type: string; data: string }>) => void>(() => {});

  // Reset per-assignment local state when the operator cycles (`]`/`[`)
  // to a different drill-down. Previous textarea / staged images / queue
  // are discarded — they belong to the previous assignment.
  useEffect(() => {
    setText("");
    setStaged([]);
    setPendingError(null);
    setHint("");
    setBusy(false);
    setQueue([]);
    lastSentRef.current = { text: "", images: [] };
    pendingReadsRef.current = 0;
  }, [assignmentId]);

  const mode = useMemo(() => resolveDrillInputMode(assignment), [assignment]);
  const readonly = mode === "observed" || mode === "ended" || mode === "shadow";

  // Mirror queue + busy into refs so the WS subscription's closure reads
  // the latest committed values without resubscribing per render.
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { busyRef.current = busy; }, [busy]);

  // Queue release — subscribe to `state.transition` WS frames for this
  // assignment. Each transition releases one queued entry (legacy parity,
  // `dashboard/index.html:1199`'s `releaseQueue`). React-state-effect on
  // `assignment.state` would collapse a→b→a back to one render and never
  // drain the queue — the WS frame is the authoritative per-turn signal.
  const subscribe = ws.subscribe;
  useEffect(() => {
    function onTransition(msg: WsMessage) {
      if (msg["assignmentId"] !== assignmentId) return;
      if (!busyRef.current) return;
      const q = queueRef.current;
      if (q.length === 0) {
        setBusy(false);
        return;
      }
      const next = q[0]!;
      // Optimistic shift — keep the ref in sync with the pending setState
      // so a second WS frame arriving in the same tick reads the new head.
      queueRef.current = q.slice(1);
      setQueue(queueRef.current);
      // Schedule the send on a microtask so we exit the WS-handler stack
      // before mutating state via doSend's setBusy(true).
      queueMicrotask(() => doSendRef.current(next.text, next.images));
    }
    return subscribe("state.transition", onTransition);
  }, [subscribe, assignmentId]);

  const showImageNotice = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(""), HINT_FLASH_MS);
  }, []);

  const stageImageFile = useCallback((file: File): boolean => {
    if (!file || typeof file.type !== "string") return false;
    if (!IMAGE_ALLOWED_MEDIA_TYPES.has(file.type)) {
      showImageNotice("PNG, JPEG, WebP, or GIF only.");
      return false;
    }
    const inFlight = staged.length + pendingReadsRef.current;
    if (inFlight >= IMAGE_MAX_COUNT_PER_MESSAGE) {
      showImageNotice(`Maximum ${IMAGE_MAX_COUNT_PER_MESSAGE} images per message.`);
      return false;
    }
    if (typeof file.size === "number" && file.size > IMAGE_MAX_DECODED_BYTES) {
      showImageNotice("Each image must be under 5 MB.");
      return false;
    }
    const name =
      file.name && file.name.length > 0
        ? file.name
        : `paste-${isoSlug()}.${mediaTypeExtension(file.type)}`;

    pendingReadsRef.current++;
    const reader = new FileReader();
    reader.onload = () => {
      pendingReadsRef.current--;
      const result = reader.result;
      if (typeof result !== "string") return;
      const commaIdx = result.indexOf(",");
      const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      const decoded = base64DecodedSize(data);
      // Defensive — `file.size` was the authoritative pre-check; this
      // belt-and-braces fires only for synthetic File objects.
      if (decoded > IMAGE_MAX_DECODED_BYTES) {
        showImageNotice("Each image must be under 5 MB.");
        return;
      }
      setStaged((prev) => [
        ...prev,
        {
          id: ++idSeqRef.current,
          name,
          media_type: file.type,
          data,
          decodedSize: decoded,
        },
      ]);
    };
    reader.onerror = () => {
      pendingReadsRef.current--;
      showImageNotice("Failed to read attachment.");
    };
    reader.readAsDataURL(file);
    return true;
  }, [staged, showImageNotice]);

  const removeChip = useCallback((id: number) => {
    setStaged((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clearError = useCallback(() => setPendingError(null), []);

  const doSend = useCallback(async (
    rawText: string,
    images: Array<{ media_type: string; data: string }>
  ) => {
    setBusy(true);
    // The helper signature returns void on the ref but we still need to
    // await internally for error handling — wrap accordingly.
    try {
      await onSend(assignmentId, rawText, images.length > 0 ? images : undefined);
      lastSentRef.current = { text: "", images: [] };
      setPendingError(null);
      // Stay busy until assignment.state changes — the queue-release
      // effect above will flip busy=false and drain the queue.
    } catch (e) {
      // Restore the operator's text + images so they can Retry or edit.
      // Only restore if the slot is still empty (operator may have started
      // typing a new message during the in-flight request).
      setText((t) => (t === "" ? rawText : t));
      setStaged((s) => {
        if (s.length > 0) return s;
        // Recreate staged images from the snapshot so chip ids stay unique.
        return lastSentRef.current.images.map((img) => ({
          ...img,
          id: ++idSeqRef.current,
        }));
      });
      const status = e instanceof ApiFailure ? e.info.status : 0;
      const message = e instanceof Error ? e.message : String(e);
      setPendingError({ status, copy: resolveErrorCopy(status, message) });
      setBusy(false);
    }
  }, [assignmentId, onSend]);

  // Refresh the queue-release ref each render so the WS subscription's
  // captured closure always invokes the current `doSend`.
  doSendRef.current = (rawText, images) => { void doSend(rawText, images); };

  // Insert a canned-action prompt into the textarea (replaces selection
  // when present, else appends; focus is restored so the operator can
  // immediately edit). Per migration addendum §"Rich reply surface".
  const insertCanned = useCallback((promptText: string) => {
    if (readonly) return;
    const el = textareaRef.current;
    if (!el) {
      setText((t) => t.length > 0 && !t.endsWith(" ") ? `${t} ${promptText}` : t + promptText);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const next = before + promptText + after;
    setText(next);
    // Move caret to the end of the inserted text after the React commit.
    queueMicrotask(() => {
      el.focus();
      const caret = before.length + promptText.length;
      el.setSelectionRange(caret, caret);
    });
  }, [readonly, text]);

  const submit = useCallback(() => {
    if (readonly) return;
    const trimmed = text.trim();
    if (trimmed.length === 0 && staged.length === 0) return;
    if (byteSize(text) > DRILL_INPUT_MAX_BYTES) return;

    const snapshotText = text;
    const snapshotImages = staged.slice();
    lastSentRef.current = { text: snapshotText, images: snapshotImages };

    // Optimistic clear (Decision 8: preserved on failure via doSend catch).
    setText("");
    setStaged([]);

    const apiImages = snapshotImages.map((s) => ({
      media_type: s.media_type,
      data: s.data,
    }));

    if (busy) {
      setQueue((q) => [...q, { text: snapshotText, images: apiImages }]);
      return;
    }
    void doSend(snapshotText, apiImages);
  }, [readonly, text, staged, busy, doSend]);

  const onRetry = useCallback(() => {
    const last = lastSentRef.current;
    if (!last.text && last.images.length === 0) {
      clearError();
      return;
    }
    if (text === "" && last.text) setText(last.text);
    if (staged.length === 0 && last.images.length > 0) {
      setStaged(last.images.map((img) => ({ ...img, id: ++idSeqRef.current })));
    }
    clearError();
    submit();
  }, [text, staged, clearError, submit]);

  // --- Paste handler: text-cap trim + image capture ---
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // Image capture (only in writable modes).
    if (!readonly && e.clipboardData) {
      let stagedAny = false;
      for (const item of e.clipboardData.items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file && stageImageFile(file)) stagedAny = true;
        }
      }
      if (stagedAny) {
        e.preventDefault();
        return;
      }
    }
    // Text cap: defer to next tick so the paste has landed in the textarea.
    setTimeout(() => {
      const el = e.currentTarget as HTMLTextAreaElement | null;
      if (!el) return;
      const value = el.value;
      if (byteSize(value) > DRILL_INPUT_MAX_BYTES) {
        const trimmed = trimToBytes(value, DRILL_INPUT_MAX_BYTES);
        setText(trimmed);
        showImageNotice("Pasted content trimmed to 50 KB.");
      }
    }, 0);
  }, [readonly, stageImageFile, showImageNotice]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      submit();
    }
  }, [submit]);

  // --- Drag-drop wiring on the wrapper ---
  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (readonly || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current++;
    setDragActive(true);
  }, [readonly]);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (readonly || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [readonly]);

  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setDragActive(false);
    if (readonly || !e.dataTransfer.files) return;
    e.preventDefault();
    for (const file of e.dataTransfer.files) stageImageFile(file);
  }, [readonly, stageImageFile]);

  // --- Derived: counter / send button label / placeholder ---
  const size = useMemo(() => byteSize(text), [text]);
  const counterCls = size > DRILL_INPUT_MAX_BYTES
    ? "counter over"
    : size > DRILL_INPUT_MAX_BYTES * 0.9 ? "counter warn" : "counter";

  const placeholder = readonly
    ? readonlyPlaceholder(mode)
    : "Type a message. Enter sends; Shift+Enter = newline.";

  const trimmed = text.trim();
  const hasInput = trimmed.length > 0 || staged.length > 0;
  const sendDisabled = readonly || !hasInput || size > DRILL_INPUT_MAX_BYTES;

  let sendLabel = "Send";
  if (busy && queue.length > 0) sendLabel = `Queued (+${queue.length})`;
  else if (busy) sendLabel = "Sending…";

  let hintText = hint;
  if (!hintText) {
    if (busy && queue.length > 0) hintText = `Queued: ${queue.length}`;
    else if (busy) hintText = "Sending…";
  }

  const wrapperCls = `drill-input${readonly ? " readonly" : ""}${dragActive ? " drop-active" : ""}`;

  return (
    <div
      className={wrapperCls}
      role="region"
      aria-label="Principal input"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {pendingError && (
        <div className="err-banner" role="alert">
          <span>{pendingError.copy}</span>
          <span className="actions">
            <button type="button" onClick={onRetry}>Retry</button>
            <button type="button" onClick={clearError}>Dismiss</button>
          </span>
        </div>
      )}

      {staged.length > 0 && (
        <div className="chip-row">
          {staged.map((chip) => {
            const src = `data:${chip.media_type};base64,${chip.data}`;
            return (
              <span
                key={chip.id}
                className="chip"
                title={`${chip.name} · ${chip.media_type} · ${formatBytes(chip.decodedSize)}`}
                onClick={() => setLightbox({ src, alt: chip.name })}
              >
                <img src={src} alt={chip.name} />
                <span className="name">{chip.name}</span>
                <button
                  type="button"
                  className="x"
                  aria-label={`Remove ${chip.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    removeChip(chip.id);
                  }}
                >
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      )}

      {dragActive && <div className="drop-overlay">Drop image here</div>}

      <textarea
        ref={textareaRef}
        rows={2}
        placeholder={placeholder}
        aria-label="Principal message"
        value={text}
        disabled={readonly}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      />

      {!readonly && (
        <div className="canned-row" aria-label="Canned principal actions">
          {CANNED_ACTIONS.map((c) => (
            <button
              key={c.label}
              type="button"
              className="canned-btn"
              title={c.text}
              onClick={() => insertCanned(c.text)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <div className="meta-row">
        <div className="meta-left">
          {hintText && <span className="queue">{hintText}</span>}
        </div>
        <div className="meta-left">
          {size > 0 && (
            <span className={counterCls}>
              {size.toLocaleString()} / {DRILL_INPUT_MAX_BYTES.toLocaleString()}
            </span>
          )}
          <button
            type="button"
            className="send-btn"
            disabled={sendDisabled}
            onClick={submit}
          >
            {sendLabel}
          </button>
        </div>
      </div>

      <ImageLightbox
        src={lightbox?.src ?? null}
        alt={lightbox?.alt}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}

function readonlyPlaceholder(mode: ReturnType<typeof resolveDrillInputMode>): string {
  if (mode === "observed") {
    return "This session is observed. Input ships when you open it in a controlled Grove session.";
  }
  if (mode === "shadow") {
    return "This task has no active session yet. Click Dispatch to start one.";
  }
  return "Session ended. History is read-only.";
}
