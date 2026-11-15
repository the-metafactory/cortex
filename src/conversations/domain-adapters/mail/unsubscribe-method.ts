export type UnsubscribeMethod = { kind: "one-click"; url: string } | { kind: "page"; url: string };

const ONE_CLICK = "list-unsubscribe=one-click";
const URI_RE = /<([^>]{1,2000})>/g;

const uriOf = (raw: string): URL | null => {
  const text = raw.replace(/\s+/g, "");
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  return ["https:", "http:", "mailto:"].includes(url.protocol) ? url : null;
};

export function unsubscribeMethod(headers: { listUnsubscribe?: string; listUnsubscribePost?: string } | undefined): UnsubscribeMethod | null {
  const raw = headers?.listUnsubscribe;
  if (!raw) return null;
  const uris: URL[] = [];
  URI_RE.lastIndex = 0;
  for (let match = URI_RE.exec(raw); match !== null; match = URI_RE.exec(raw)) {
    const url = match[1] === undefined ? null : uriOf(match[1]);
    if (url) uris.push(url);
  }
  const secure = uris.find(url => url.protocol === "https:");
  const post = headers.listUnsubscribePost?.replace(/\s+/g, "").toLowerCase();
  if (secure && post === ONE_CLICK) return { kind: "one-click", url: secure.href };
  const page = secure ?? uris.find(url => url.protocol === "http:") ?? uris.find(url => url.protocol === "mailto:");
  return page ? { kind: "page", url: page.href } : null;
}
