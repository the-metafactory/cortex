/**
 * Sideband loopback enforcement (P-14 U0.1).
 *
 * The signal cortex-sideband contract (`signal/docs/contract/cortex-sideband.md`
 * §3 "Auth model — loopback only" + §8 "Cortex-side consumer") makes the
 * sideband a LOCAL-ONLY daemon by design: it binds `127.0.0.1`, carries no
 * token, and the security boundary is the host process boundary, not a network
 * one. §8 states the cortex-side consumer "MUST refuse to set a non-loopback
 * host (principals on shared networks could otherwise self-foot-gun)".
 *
 * This module is the fail-CLOSED gate that enforces that invariant. It is the
 * single source of truth for "is this sideband URL loopback?", called BOTH at
 * config-parse time (so a non-loopback `mc.sideband` value is rejected before
 * the daemon ever boots) AND at the proxy request boundary (so a config value
 * that somehow mutated at runtime can never cause MC to proxy off-host). The
 * invariant: **MC NEVER proxies to a non-loopback sideband.** When in doubt,
 * REFUSE — never fall open.
 *
 * ## Accept set (per §3 — the kernel-enforced loopback boundary)
 *
 * - `127.0.0.1` and the whole IPv4 loopback block `127.0.0.0/8` (e.g.
 *   `127.0.0.2`). The kernel routes the entire `/8` to the loopback device.
 * - `::1` (IPv6 loopback), in bracketed URL form `[::1]`, including the
 *   IPv4-mapped form `[::ffff:127.0.0.1]`.
 * - `localhost` — the conventional loopback hostname. We accept the literal
 *   token only; we do NOT perform DNS resolution (resolution is mutable and
 *   spoofable — accepting the literal keeps the gate deterministic and
 *   fail-closed, matching the "refuse non-loopback HOST" framing of §8 which
 *   is about the configured value, not a resolved address).
 *
 * ## Reject set (everything else — fail closed)
 *
 * - `0.0.0.0` / `[::]` — the unspecified "all interfaces" bind; NOT loopback.
 * - Any LAN / public IP (`192.168.*`, `10.*`, `172.16-31.*`, routable IPv4/6).
 * - Any non-`localhost` hostname (`evil.com`, `sideband.internal`, …).
 * - Non-`http:`/`https:` schemes, malformed URLs, userinfo in the URL.
 */

/** Structured outcome of a loopback check. `ok:false` carries a render-safe reason. */
export type LoopbackCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/**
 * The IPv4 loopback block is `127.0.0.0/8` — the kernel routes the entire `/8`
 * to the loopback device, so `127.0.0.2` is as loopback as `127.0.0.1`.
 */
function isIpv4Loopback(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map((s) => Number(s));
  // Reject out-of-range octets (e.g. `127.0.0.999`) — a malformed address is
  // not a valid loopback address; fail closed.
  if (octets.some((o) => o < 0 || o > 255)) return false;
  return octets[0] === 127;
}

/** Parse a 1-2 hextet group into an octet pair. Helper for IPv4-mapped IPv6. */
function hextetToOctets(hex: string): [number, number] {
  const v = parseInt(hex, 16);
  return [(v >> 8) & 0xff, v & 0xff];
}

/**
 * IPv6 loopback: `::1`, plus the IPv4-mapped loopback `::ffff:127.0.0.1`.
 *
 * `url.hostname` for an IPv6 literal keeps the surrounding brackets AND
 * normalizes the address (the WHATWG URL parser compresses zero-runs and
 * lowercases hex): `[0:0:0:0:0:0:0:1]` → `[::1]`, `[::ffff:127.0.0.1]` →
 * `[::ffff:7f00:1]`. We strip the brackets and accept both the canonical
 * `::1` and the IPv4-mapped-loopback hex form `::ffff:7f00:1` (== `127.0.0.1`).
 */
function isIpv6Loopback(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) {
    h = h.slice(1, -1);
  }
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // IPv4-mapped IPv6 dotted form: `::ffff:127.0.0.1`.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (mappedDotted?.[1] !== undefined) return isIpv4Loopback(mappedDotted[1]);
  // IPv4-mapped IPv6 hex form (post-normalization): `::ffff:7f00:1` where the
  // last two hextets encode the 32-bit IPv4 address. `7f00:0001` → 127.0.0.1.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex?.[1] !== undefined && mappedHex[2] !== undefined) {
    const [a, b] = hextetToOctets(mappedHex[1]);
    const [c, d] = hextetToOctets(mappedHex[2]);
    return isIpv4Loopback(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

/**
 * Decide whether a sideband base URL points at a loopback host. Returns a
 * structured result so callers can surface a render-friendly reason rather
 * than a bare boolean.
 *
 * Fail-closed: any parse failure, unexpected scheme, or non-loopback host is a
 * REFUSAL. There is no path that returns `ok:true` for a host the kernel would
 * route off the loopback device.
 */
export function checkLoopbackSideband(raw: string): LoopbackCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "sideband URL is empty" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `sideband URL is not a valid URL: ${raw}` };
  }

  // Only HTTP(S) — the sideband is an HTTP daemon. Reject `file:`, `ws:`,
  // `javascript:`, etc. up front.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `sideband URL must be http(s), got "${url.protocol}"`,
    };
  }

  // Never accept embedded credentials — they have no place pointing at a
  // tokenless loopback daemon, and `user@host` forms are a classic way to
  // smuggle a different effective host past a naive check.
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "sideband URL must not contain userinfo" };
  }

  const host = url.hostname;
  if (host === "") {
    return { ok: false, reason: "sideband URL has no host" };
  }

  const lowered = host.toLowerCase();
  const loopback =
    lowered === "localhost" ||
    isIpv4Loopback(host) ||
    isIpv6Loopback(host);

  if (!loopback) {
    return {
      ok: false,
      reason:
        `sideband host "${host}" is not loopback — MC refuses to proxy to a ` +
        `non-loopback sideband (the sideband is a local-only daemon; see ` +
        `cortex-sideband.md §3/§8)`,
    };
  }

  return { ok: true, url };
}

/**
 * Boolean convenience wrapper for callers that only need yes/no.
 * Prefer {@link checkLoopbackSideband} where the refusal reason is useful
 * (config parse error message, proxy refusal body).
 */
export function isLoopbackSideband(raw: string): boolean {
  return checkLoopbackSideband(raw).ok;
}

/** The contract default — the sideband's loopback bind on its default port (§2, §6.1). */
export const DEFAULT_SIDEBAND_URL = "http://127.0.0.1:9092";
