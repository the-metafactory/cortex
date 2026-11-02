import type { ReactNode } from "react";
import { deskLinkAttributes, sourceLinkLabel } from "../lib/desk-link";

export function DeskLink({ url, className, title, onClick, children }: { url: string; className?: string; title?: string; onClick?: () => void; children: ReactNode }) {
  const attributes = deskLinkAttributes(url);
  if (!attributes) return null;
  return <a {...attributes} {...(className ? { className } : {})} {...(title ? { title } : {})} {...(onClick ? { onClick } : {})}>{children}</a>;
}

export function DeskSourceLink({ source }: { source: { kind: string; url?: string | undefined } }) {
  const attributes = source.url ? deskLinkAttributes(source.url) : null;
  if (!attributes) return <p>From {source.kind}</p>;
  return <a {...attributes}>{sourceLinkLabel(source.kind)}</a>;
}
