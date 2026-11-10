import { createHash } from "node:crypto";
import { posix } from "node:path";
import { sha256Bytes } from "../../../common/registry/arc-package-inventory";
import type { AssetBody, AssetFailure } from "./adapter-assets";

type ReadAsset = (path: string) => Promise<AssetBody | AssetFailure>;

const notInlinable = (): AssetFailure => ({ ok: false, status: 422, code: "ui_not_inlinable", message: "The adapter UI entry cannot be delivered as a self-contained document." });
class InlineFailure extends Error {
  constructor(readonly failure: AssetFailure = notInlinable()) {
    super(failure.code);
  }
}

const reject = (): never => { throw new InlineFailure(); };
const hash = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const textOf = (asset: AssetBody): string => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes).replace(/\r\n?/g, "\n");
  if (text.includes("\0")) reject();
  return text;
};
const dataUri = (asset: AssetBody): string => `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
function invalidPathText(value: string): boolean {
  if (/[\\?#]/.test(value)) return true;
  for (const character of value) if (character.charCodeAt(0) < 32) return true;
  return false;
}

function referencePath(entry: string, reference: string): string {
  if (reference.length === 0) reject();
  if (reference !== reference.trim() || /^\/|^[a-z][a-z\d+.-]*:/i.test(reference) || invalidPathText(reference)) reject();
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch (_err) {
    return reject();
  }
  if (invalidPathText(decoded) || decoded.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(decoded)) reject();
  return posix.normalize(posix.join(posix.dirname(entry), decoded));
}

function cssUnescape(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\(\r\n|[\n\r\f])|\\([\s\S])/gi, (_match, hex: string | undefined, newline: string | undefined, character: string | undefined) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
    }
    return newline ? "" : character ?? "";
  });
}

async function inlineCss(css: string, read: (reference: string) => Promise<AssetBody>): Promise<string> {
  if (/<\/style[\s/>]/i.test(css)) reject();
  const tokens = /\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|@?(?:[-\w]|\\(?:[0-9a-f]{1,6}[\t\n\f\r ]?|[^\n\r\f]))+/gi;
  let output = "";
  let cursor = 0;
  for (let token = tokens.exec(css); token; token = tokens.exec(css)) {
    const name = cssUnescape(token[0]).toLowerCase();
    if (name === "@import") reject();
    if (name !== "url" || css[tokens.lastIndex] !== "(") continue;
    const url = /^\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|((?:[^\s'"()\\]|\\(?:[0-9a-f]{1,6}[\t\n\f\r ]?|[^\n\r\f]))*))\s*\)/i.exec(css.slice(tokens.lastIndex));
    if (!url) return reject();
    output += css.slice(cursor, token.index) + `url("${dataUri(await read(cssUnescape(url[1] ?? url[2] ?? url[3] ?? "")))}")`;
    cursor = tokens.lastIndex + url[0].length;
    tokens.lastIndex = cursor;
  }
  return output + css.slice(cursor);
}

function inlineCsp(scripts: Set<string>, styles: Set<string>): string {
  return [
    "default-src 'none'",
    `script-src ${[...scripts].join(" ") || "'none'"}`,
    `style-src ${[...styles].join(" ") || "'none'"}`,
    "img-src data:", "font-src data:", "media-src 'none'", "connect-src 'none'",
    "worker-src 'none'", "child-src 'none'", "frame-src 'none'", "manifest-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'", "sandbox allow-scripts",
  ].join("; ");
}

function assertAllowedAttributes(element: HTMLRewriterTypes.Element, script: boolean, stylesheet: boolean): void {
  const type = element.getAttribute("type");
  if (script && type !== null && type.toLowerCase() !== "text/javascript") reject();
  if (stylesheet && type !== null && type.toLowerCase() !== "text/css") reject();
  if (script && ["defer", "async", "nomodule"].some(name => element.hasAttribute(name))) reject();
  if (stylesheet && (element.getAttribute("rel") ?? "").trim().toLowerCase() !== "stylesheet") reject();
  if (element.tagName === "meta" && element.hasAttribute("http-equiv")) reject();
  for (const [name, value] of element.attributes) {
    if (stylesheet && !["rel", "href", "media", "type"].includes(name)) reject();
    if (name === "style" || name.startsWith("on") || name === "srcdoc") reject();
    if (!["src", "href", "xlink:href", "srcset", "poster", "data", "action"].includes(name)) continue;
    if ((name === "src" && (script || element.tagName === "img")) || (name === "href" && stylesheet)) continue;
    if (!value.startsWith("#")) reject();
    if (name === "srcset" && value.split(",").some(candidate => !candidate.trim().startsWith("#"))) reject();
  }
}

function stylesheetHtml(text: string, media: string | null): string {
  const escapedMedia = media?.replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<style${escapedMedia === undefined ? "" : ` media="${escapedMedia}"`}>${text}</style>`;
}

export async function inlineAdapterEntry(entry: string, asset: AssetBody, read: ReadAsset): Promise<AssetBody | AssetFailure> {
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const referenced = async (reference: string): Promise<AssetBody> => {
    const result = await read(referencePath(entry, reference));
    if (!result.ok) throw new InlineFailure(result.code === "asset_not_listed" ? notInlinable() : result);
    return result;
  };
  try {
    const rewriter = new HTMLRewriter().on("*", {
      async element(element) {
        const tag = element.tagName;
        const script = tag === "script";
        const stylesheet = tag === "link" && (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("stylesheet");
        assertAllowedAttributes(element, script, stylesheet);
        const src = element.getAttribute("src");
        if (script && src !== null) {
          const text = textOf(await referenced(src));
          if (/<\/script[\s/>]|<!--|<script[\s/>]/i.test(text)) reject();
          scripts.add(hash(text));
          element.removeAttribute("src").setInnerContent(text, { html: true });
        } else if (stylesheet) {
          const text = await inlineCss(textOf(await referenced(element.getAttribute("href") ?? "")), referenced);
          styles.add(hash(text));
          element.replace(stylesheetHtml(text, element.getAttribute("media")), { html: true });
        } else if (tag === "img" && src !== null) {
          element.setAttribute("src", dataUri(await referenced(src)));
        }
      },
    }).on("script, style", {
      text(chunk) { if (chunk.text.length > 0) reject(); },
      comments() { reject(); },
    });
    const document = await rewriter.transform(new Response(asset.bytes)).arrayBuffer();
    const bytes = new Uint8Array(document);
    return { ok: true, bytes, mediaType: "text/html", sha256: sha256Bytes(bytes), csp: inlineCsp(scripts, styles) };
  } catch (error) {
    return error instanceof InlineFailure ? error.failure : notInlinable();
  }
}
