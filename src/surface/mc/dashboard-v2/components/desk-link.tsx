import type { ReactNode } from "react";
import { deskLinkAttributes, sourceLinkLabel } from "../lib/desk-link";

export function DeskLink({ url, className, title, children }: { url: string; className?: string; title?: string; children: ReactNode }) {
  const attributes = deskLinkAttributes(url);
  if (!attributes) return null;
  return <a {...attributes} {...(className ? { className } : {})} {...(title ? { title } : {})}>{children}</a>;
}

export function DeskSourceLink({ source, label }: { source: { kind: string; url?: string | undefined }; label?: string }) {
  const attributes = source.url ? deskLinkAttributes(source.url) : null;
  if (!attributes) return <p>From {source.kind}</p>;
  return <a {...attributes}>{label ?? sourceLinkLabel(source.kind)}</a>;
}
