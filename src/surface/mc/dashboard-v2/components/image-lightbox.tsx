/**
 * Image lightbox modal.
 *
 * Click-outside or Esc dismisses. Used by F-7's drill-log (MIG-3) for
 * inline `operator.input` image previews and by MIG-3's drill-input chip
 * row for staged-image expansion.
 *
 * CSS lives in styles/global.css under .lightbox / .lightbox-backdrop /
 * .lightbox-img.
 */

import { useEffect } from "react";

export interface ImageLightboxProps {
  /** When `null`, the lightbox is closed and renders nothing. */
  src: string | null;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  // Esc closes — uses capture phase so it preempts other Esc handlers
  // (e.g. the F-7 drill-down close handler) when the lightbox is the
  // foremost modal layer. Pattern preserved from the legacy monolith.
  useEffect(() => {
    if (!src) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
      <div className="lightbox-backdrop" onClick={onClose} />
      <img
        className="lightbox-img"
        src={src}
        alt={alt ?? ""}
        onClick={onClose}
      />
    </div>
  );
}
