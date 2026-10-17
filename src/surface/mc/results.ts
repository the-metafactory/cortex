import type { Database } from "bun:sqlite";
import { readSomaOutput } from "../../vigil/soma-output";
import { readResult, type ResultReadLedger } from "../../vigil/result-read";

export interface ResultRouteOptions {
  somaHome?: string;
  ledger?: ResultReadLedger;
}

const SAFE_TAGS = new Set("p h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code em strong del hr br a table thead tbody tr th td".split(" "));
const unsafeLink = (): false => false;
const invalidResultRef = (): Response => new Response("Not Found", { status: 404 });

function safeLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return unsafeLink();
  }
}

function renderMarkdown(content: string): string {
  const html = Bun.markdown.html(content, { noHtmlBlocks: true, noHtmlSpans: true });
  return new HTMLRewriter().on("*", {
    element(element) {
      if (!SAFE_TAGS.has(element.tagName)) {
        element.remove();
        return;
      }
      for (const [name, value] of [...element.attributes]) {
        if (element.tagName === "a" && name === "href" && safeLink(value)) continue;
        element.removeAttribute(name);
      }
      if (element.tagName === "a") element.setAttribute("rel", "noreferrer noopener");
    },
  }).transform(html);
}

export async function handleResult(db: Database, encodedRef: string, options: ResultRouteOptions = {}): Promise<Response> {
  let ref: string;
  try {
    ref = decodeURIComponent(encodedRef);
  } catch {
    return invalidResultRef();
  }
  const content = await readSomaOutput(ref, options.somaHome);
  if (content === null) return new Response("Not Found", { status: 404 });
  const html = renderMarkdown(content);
  await readResult(db, ref, options.ledger);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Result</title></head><body><main>${html}</main></body></html>`, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
