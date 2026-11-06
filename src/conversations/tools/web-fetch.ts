import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export interface FetchLimits { maxBytes: number; maxRedirects: number; timeoutMs: number; maxChars: number }
export interface ResolvedAddress { address: string; family: 4 | 6 }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface TransportRequest { url: URL; address: ResolvedAddress; signal: AbortSignal }
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  remoteAddress: string | null;
  read: (maxBytes: number) => Promise<{ bytes: Uint8Array; truncated: boolean }>;
  close: () => void;
}
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type FetchStatus = "ok" | "invalid-url" | "denied-target" | "dns-failure" | "too-many-redirects" | "invalid-redirect" | "http-error" | "unsupported-media-type" | "unsupported-encoding" | "binary-content" | "network-error" | "timeout";
export interface PageResult {
  status: FetchStatus;
  message?: string;
  requestedUrl: string;
  url?: string;
  httpStatus?: number;
  redirects?: number;
  title?: string | null;
  contentType?: string;
  retrievedAt: string;
  text?: string;
  offset?: number;
  totalChars?: number;
  nextOffset?: number | null;
  truncated?: { bytes: boolean; characters: boolean };
}
export interface FetchOptions { signal: AbortSignal; offset?: number; limit?: number }
export interface PublicFetcherOptions {
  limits: FetchLimits;
  resolve?: Resolver;
  transport?: Transport;
  now?: () => Date;
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/xml", "application/xml", "application/json", "text/csv"]);
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const URL_LIMIT = 2048;
const MAX_ADDRESSES = 4;
const BINARY_SNIFF = 4096;
const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed"]);
const BLOCK_ELEMENTS = new Set(["p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "section", "article", "pre", "blockquote", "hr", "header", "footer", "main", "aside", "nav", "dt", "dd", "dl", "figure", "figcaption", "form", "details", "summary"]);
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", copy: "(c)" };
const NONPUBLIC_NAME = /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|corp|intranet|arpa)$/;
const USER_AGENT = "cortex-ivy-web-fetch/1";
const ACCEPT = "text/html,application/xhtml+xml,text/plain,text/markdown,application/json,application/xml;q=0.8,text/xml;q=0.8";

const v4Bytes = (text: string): number[] | null => {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
  return bytes.every(byte => byte >= 0 && byte <= 255) ? bytes : null;
};

const v6Bytes = (input: string): number[] | null => {
  if (input.includes("%")) return null;
  let text = input;
  const tail = text.slice(text.lastIndexOf(":") + 1);
  if (tail.includes(".")) {
    const embedded = v4Bytes(tail);
    if (!embedded) return null;
    const [a = 0, b = 0, c = 0, d = 0] = embedded;
    text = `${text.slice(0, text.lastIndexOf(":") + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const side = (part: string): string[] => part === "" ? [] : part.split(":");
  const head = side(halves[0] ?? "");
  const rest = halves.length === 2 ? side(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every(group => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.flatMap(group => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff]);
};

const publicV4 = (bytes: readonly number[]): boolean => {
  const [a = 0, b = 0, c = 0] = bytes;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

const publicV6 = (b: readonly number[]): boolean => {
  const at = (index: number): number => b[index] ?? 0;
  const zeroUpTo = (end: number): boolean => b.slice(0, end).every(byte => byte === 0);
  if (zeroUpTo(10) && at(10) === 0xff && at(11) === 0xff) return publicV4(b.slice(12));
  if (at(0) === 0 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b && b.slice(4, 12).every(byte => byte === 0)) return publicV4(b.slice(12));
  if (at(0) === 0x20 && at(1) === 0x02) return publicV4(b.slice(2, 6));
  if ((at(0) & 0xe0) !== 0x20) return false;
  if (at(0) === 0x20 && at(1) === 0x01 && (at(2) < 0x02 || (at(2) === 0x0d && at(3) === 0xb8))) return false;
  if (at(0) === 0x3f && at(1) === 0xff && (at(2) & 0xf0) === 0) return false;
  return true;
};

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const bytes = v4Bytes(address);
    return bytes !== null && publicV4(bytes);
  }
  if (kind === 6) {
    const bytes = v6Bytes(address);
    return bytes !== null && publicV6(bytes);
  }
  return false;
}

const literalHost = (hostname: string): string => hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

export function refuseTarget(url: URL): string | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "Only http and https addresses can be fetched.";
  if (url.username !== "" || url.password !== "") return "Addresses with embedded credentials are refused.";
  if (!ALLOWED_PORTS.has(url.port)) return "Only the standard web ports 80, 443, 8080 and 8443 can be fetched.";
  const host = literalHost(url.hostname.toLowerCase().replace(/\.$/, ""));
  if (host === "") return "The address has no host.";
  if (isIP(host) !== 0) return isPublicAddress(host) ? null : "The address is a loopback, private, link-local, metadata or otherwise nonpublic target.";
  if (!host.includes(".") || NONPUBLIC_NAME.test(host)) return "The host name is local or internal, not a public site.";
  return null;
}

const defaultResolver: Resolver = async hostname => {
  const found = await lookup(hostname, { all: true, verbatim: true });
  return found.map(entry => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

const flattenHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined) flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return flat;
};

const sameAddress = (a: string, b: string): boolean => a.replace(/^::ffff:/i, "").toLowerCase() === b.replace(/^::ffff:/i, "").toLowerCase();

export const nodeTransport: Transport = ({ url, address, signal }) => new Promise<TransportResponse>((resolve, reject) => {
  const client = url.protocol === "https:" ? https : http;
  const pinned = (_host: string, options: { all?: boolean }, done: (...args: unknown[]) => void): void => {
    if (options.all) done(null, [{ address: address.address, family: address.family }]);
    else done(null, address.address, address.family);
  };
  const request = client.request({
    protocol: url.protocol, hostname: literalHost(url.hostname), port: url.port === "" ? undefined : Number(url.port), path: `${url.pathname}${url.search}`, method: "GET",
    headers: { "user-agent": USER_AGENT, accept: ACCEPT, "accept-encoding": "identity" }, lookup: pinned as never, agent: false, signal,
  }, response => {
    const remote = response.socket.remoteAddress ?? null;
    if (remote !== null && !sameAddress(remote, address.address)) {
      response.destroy();
      reject(new Error("The connected address differs from the validated address."));
      return;
    }
    resolve({
      status: response.statusCode ?? 0, headers: flattenHeaders(response.headers), remoteAddress: remote,
      close: () => { response.destroy(); },
      read: maxBytes => new Promise((done, fail) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let finished = false;
        const finish = (truncated: boolean): void => {
          if (finished) return;
          finished = true;
          if (truncated) response.destroy();
          done({ bytes: Buffer.concat(chunks), truncated });
        };
        response.on("data", (chunk: Buffer) => {
          if (finished) return;
          const room = maxBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            finish(true);
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        response.on("end", () => { finish(false); });
        response.on("error", fail);
      }),
    });
  });
  request.on("socket", socket => {
    const check = (): void => {
      const remote = socket.remoteAddress;
      if (remote !== undefined && !sameAddress(remote, address.address)) request.destroy(new Error("The connected address differs from the validated address."));
    };
    if (socket.connecting) socket.once("connect", check); else check();
  });
  request.on("error", reject);
  request.end();
});

const decodeEntities = (text: string): string => text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
  if (name.startsWith("#")) {
    const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  }
  return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
});

const tidy = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").split("\n").map(line => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, letter => letter.toLowerCase());

function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let index = from; index < html.length; index += 1) {
    const char = html.charAt(index);
    if (quote) { if (char === quote) quote = ""; }
    else if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const lower = asciiLower(html);
  const out: string[] = [];
  let title: string | null = null;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) { out.push(html.slice(index)); break; }
    out.push(html.slice(index, open));
    const next = html.charAt(open + 1);
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close === -1) break;
      index = close + 3;
    } else if (next === "!" || next === "?") {
      const close = html.indexOf(">", open);
      if (close === -1) break;
      index = close + 1;
    } else if (/[a-zA-Z/]/.test(next)) {
      const close = tagEnd(html, open + 1);
      if (close === -1) break;
      const closing = next === "/";
      const name = /^[a-z][a-z0-9-]*/.exec(lower.slice(open + (closing ? 2 : 1), open + 40))?.[0] ?? "";
      index = close + 1;
      if (!closing && (SKIPPED_ELEMENTS.has(name) || name === "title")) {
        const end = lower.indexOf(`</${name}`, index);
        const stop = end === -1 ? html.length : end;
        if (name === "title" && title === null) title = tidy(decodeEntities(html.slice(index, stop)).replace(/<[^>]*>/g, "")) || null;
        const finish = end === -1 ? -1 : tagEnd(html, end + 2);
        index = finish === -1 ? html.length : finish + 1;
      } else if (BLOCK_ELEMENTS.has(name)) out.push("\n");
    } else {
      out.push("<");
      index = open + 1;
    }
  }
  return { title, text: tidy(decodeEntities(out.join(""))) };
}

const charsetOf = (contentType: string): string => {
  const label = /charset\s*=\s*"?([\w:.-]+)"?/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
  try { new TextDecoder(label); return label; }
  catch (_err) { return "utf-8"; }
};

const clipTitle = (title: string | null): string | null => title === null ? null : title.length > 300 ? `${title.slice(0, 300)}...` : title;

export function createPublicFetcher(options: PublicFetcherOptions): (rawUrl: string, fetchOptions: FetchOptions) => Promise<PageResult> {
  const { limits } = options;
  const resolve = options.resolve ?? defaultResolver;
  const transport = options.transport ?? nodeTransport;
  const now = options.now ?? (() => new Date());

  const validate = async (url: URL): Promise<{ ok: true; addresses: ResolvedAddress[] } | { ok: false; status: FetchStatus; message: string }> => {
    const refusal = refuseTarget(url);
    if (refusal) return { ok: false, status: "denied-target", message: refusal };
    const host = literalHost(url.hostname);
    if (isIP(host) !== 0) return { ok: true, addresses: [{ address: host, family: isIP(host) === 6 ? 6 : 4 }] };
    let addresses: ResolvedAddress[];
    try { addresses = await resolve(host); }
    catch (_err) { return { ok: false, status: "dns-failure", message: "The host name did not resolve." }; }
    if (addresses.length === 0) return { ok: false, status: "dns-failure", message: "The host name did not resolve." };
    if (!addresses.every(entry => isPublicAddress(entry.address))) return { ok: false, status: "denied-target", message: "The host resolves to a loopback, private, link-local, metadata or otherwise nonpublic address. The whole host is refused." };
    return { ok: true, addresses: addresses.slice(0, MAX_ADDRESSES) };
  };

  const connect = async (url: URL, addresses: ResolvedAddress[], signal: AbortSignal): Promise<TransportResponse> => {
    let failure: unknown = new Error("No address could be reached.");
    for (const address of addresses) {
      try { return await transport({ url, address, signal }); }
      catch (err) {
        signal.throwIfAborted();
        failure = err;
      }
    }
    throw failure;
  };

  return async (rawUrl, fetchOptions) => {
    const base = { requestedUrl: rawUrl.slice(0, URL_LIMIT) };
    const stamp = (): string => now().toISOString();
    const fail = (status: FetchStatus, message: string, extra: Partial<PageResult> = {}): PageResult => ({ ...base, status, message, retrievedAt: stamp(), ...extra });
    if (rawUrl.length > URL_LIMIT) return fail("invalid-url", "The address is too long.");
    let current: URL;
    try { current = new URL(rawUrl); }
    catch (_err) { return fail("invalid-url", "The address is not a valid absolute URL."); }

    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const signal = AbortSignal.any([fetchOptions.signal, timeout]);
    let redirects = 0;
    try {
      for (;;) {
        current.hash = "";
        const checked = await validate(current);
        signal.throwIfAborted();
        if (!checked.ok) return fail(redirects > 0 && checked.status === "denied-target" ? "invalid-redirect" : checked.status, redirects > 0 ? `A redirect led to a refused target. ${checked.message}` : checked.message, { redirects });
        const response = await connect(current, checked.addresses, signal);
        if (REDIRECT_CODES.has(response.status)) {
          response.close();
          const location = response.headers.location;
          if (!location) return fail("invalid-redirect", "A redirect carried no destination.", { redirects, httpStatus: response.status });
          if (redirects >= limits.maxRedirects) return fail("too-many-redirects", `The page redirected more than ${limits.maxRedirects} times.`, { redirects });
          try { current = new URL(location, current); }
          catch (_err) { return fail("invalid-redirect", "A redirect carried an invalid destination.", { redirects, httpStatus: response.status }); }
          redirects += 1;
          continue;
        }
        return await interpret(response, current, redirects, signal, fetchOptions);
      }
    } catch (err) {
      if (fetchOptions.signal.aborted) throw err;
      if (timeout.aborted) return fail("timeout", `The page did not answer within ${Math.round(limits.timeoutMs / 1000)} seconds.`);
      return fail("network-error", "The page could not be reached.");
    }

    async function interpret(response: TransportResponse, final: URL, hops: number, abort: AbortSignal, request: FetchOptions): Promise<PageResult> {
      const finalUrl = final.href;
      const head = { url: finalUrl, redirects: hops, httpStatus: response.status };
      if (response.status < 200 || response.status > 299) { response.close(); return fail("http-error", `The page answered with HTTP ${response.status}.`, head); }
      const contentType = (response.headers["content-type"] ?? "").toLowerCase();
      const mime = contentType.split(";")[0]?.trim() ?? "";
      if (!TEXT_TYPES.has(mime)) { response.close(); return fail("unsupported-media-type", `Content of type ${mime || "unknown"} is not read. Only text, HTML, Markdown, JSON and XML are.`, { ...head, contentType: mime }); }
      const encoding = (response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") { response.close(); return fail("unsupported-encoding", "The page used a content encoding that is not read.", { ...head, contentType: mime }); }
      const read = await response.read(limits.maxBytes);
      abort.throwIfAborted();
      if (read.bytes.subarray(0, BINARY_SNIFF).includes(0)) return fail("binary-content", "The content is binary although it was labelled as text.", { ...head, contentType: mime });
      const decoded = new TextDecoder(charsetOf(contentType)).decode(read.bytes);
      const extracted = HTML_TYPES.has(mime) ? htmlToText(decoded) : { title: null, text: tidy(decoded) };
      const offset = Math.min(request.offset ?? 0, extracted.text.length);
      const window = Math.max(1, Math.min(request.limit ?? limits.maxChars, limits.maxChars));
      const text = extracted.text.slice(offset, offset + window);
      const more = offset + text.length < extracted.text.length;
      return {
        ...base, ...head, status: "ok", title: clipTitle(extracted.title), contentType: mime, retrievedAt: stamp(), text, offset, totalChars: extracted.text.length,
        nextOffset: more ? offset + text.length : null, truncated: { bytes: read.truncated, characters: more },
      };
    }
  };
}
