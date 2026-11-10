import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OutlineNode } from "../../../../balance";
import { balanceDrop, balanceMovable, dropZone, type DropTarget, type DropZone } from "../lib/balance-drop";

interface DragOptions {
  outline: OutlineNode;
  studioProjects: ReadonlySet<string>;
  busy: boolean;
  onDrop: (id: string, target: DropTarget) => void;
  onStart: () => void;
}
interface DragHint { id: string; zone: DropZone }

export function useBalanceDrag(options: DragOptions) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<DragHint | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  const canDrag = (id: string): boolean => !options.busy && balanceMovable(options.outline, id, options.studioProjects);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string): void => {
    if (event.button !== 0 || !event.isPrimary || !canDrag(id)) return;
    if ((event.target as HTMLElement).closest(".dbl-toggle")) return;
    if (event.pointerType === "touch" && !(event.target as HTMLElement).closest(".dbl-grip")) return;
    cancel.current?.();
    const row = event.currentTarget;
    const box = row.getBoundingClientRect();
    const pointer = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let preview: HTMLElement | null = null;
    let destination: DropTarget | null = null;
    let frame = 0;
    let x = start.x;
    let y = start.y;
    const locate = (): void => {
      const target = document.elementFromPoint(x, y)?.closest<HTMLElement>(".dbl-row[data-balance-id]");
      const targetId = target?.dataset.balanceId;
      const bounds = target?.getBoundingClientRect();
      const zone = bounds ? dropZone(y - bounds.top, bounds.height) : "inside";
      destination = targetId ? balanceDrop(options.outline, id, targetId, zone, options.studioProjects) : null;
      setHint(destination && targetId ? { id: targetId, zone } : null);
      if (preview) preview.dataset.allowed = String(destination !== null);
    };
    const animate = (): void => {
      if (!preview) return;
      preview.style.left = `${x - start.x + box.left}px`;
      preview.style.top = `${y - start.y + box.top}px`;
      const edge = 60;
      const scroll = y < edge ? -12 : y > window.innerHeight - edge ? 12 : 0;
      if (scroll) { window.scrollBy(0, scroll); locate(); }
      frame = requestAnimationFrame(animate);
    };
    const suppressClick = (click: MouseEvent): void => { click.preventDefault(); click.stopImmediatePropagation(); };
    const cleanup = (): void => {
      cancelAnimationFrame(frame);
      preview?.remove();
      document.body.classList.remove("dbl-dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", abort);
      if (preview) {
        window.addEventListener("click", suppressClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", suppressClick, true), 0);
      }
      setDragging(null);
      setHint(null);
      cancel.current = null;
    };
    const move = (next: PointerEvent): void => {
      if (next.pointerId !== pointer) return;
      x = next.clientX;
      y = next.clientY;
      if (!preview && Math.hypot(x - start.x, y - start.y) < 5) return;
      next.preventDefault();
      if (!preview) {
        preview = row.cloneNode(true) as HTMLElement;
        preview.className = "dbl-row dbl-drag-preview";
        preview.removeAttribute("data-balance-id");
        preview.setAttribute("aria-hidden", "true");
        preview.inert = true;
        preview.style.width = `${box.width}px`;
        preview.style.paddingInlineStart = "12px";
        document.body.append(preview);
        document.body.classList.add("dbl-dragging");
        setDragging(id);
        options.onStart();
        animate();
      }
      locate();
    };
    const up = (next: PointerEvent): void => {
      if (next.pointerId !== pointer) return;
      if (preview) { x = next.clientX; y = next.clientY; locate(); }
      const target = destination;
      cleanup();
      if (target) options.onDrop(id, target);
    };
    const abort = (): void => { destination = null; cleanup(); };
    const key = (next: KeyboardEvent): void => { if (next.key === "Escape") { next.preventDefault(); abort(); } };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", abort);
    cancel.current = abort;
  };
  return { dragging, hint, canDrag, onPointerDown };
}
