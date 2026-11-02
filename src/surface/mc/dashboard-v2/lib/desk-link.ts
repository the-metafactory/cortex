export type DeskLinkMode = "tab" | "here";

export type DeskLinkAttributes = { href: string; target?: "_blank"; rel?: "noopener noreferrer" };

type LinkWindow = { open: (url: string, target: string, features: string) => unknown; location: { assign: (url: string) => void } };

export function deskLinkMode(url: string): DeskLinkMode | null {
  if (/^https?:\/\/\S+$/i.test(url)) return "tab";
  if (/^(message|mailto):\S+$/i.test(url)) return "here";
  return null;
}

export function deskLinkAttributes(url: string): DeskLinkAttributes | null {
  const mode = deskLinkMode(url);
  if (mode === "tab") return { href: url, target: "_blank", rel: "noopener noreferrer" };
  if (mode === "here") return { href: url };
  return null;
}

export function openDeskLink(url: string, win: LinkWindow = window): boolean {
  const mode = deskLinkMode(url);
  if (mode === "tab") win.open(url, "_blank", "noopener");
  else if (mode === "here") win.location.assign(url);
  return mode !== null;
}

export function sourceLinkLabel(kind: string): string {
  return kind === "mail" ? "Open in Mail" : "Open original source";
}
