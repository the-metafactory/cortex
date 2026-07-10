/**
 * WebSocket transport bootstrap — force `@discordjs/ws` onto the robust `ws`
 * package on Bun.
 *
 * Root cause (cortex#546/#581/#590/#591/#593 — the recurring
 * `ClientConnectionResetError … Attempting a reconnect` flapping, same class
 * as the 2026-05-09 8.4h outage): `@discordjs/util`'s
 * `shouldUseGlobalFetchAndWebSocket()` keys on `"bun" in process.versions`,
 * so on Bun it returns true and `@discordjs/ws` binds
 *
 *   WebSocketConstructor = shouldUseGlobalFetchAndWebSocket()
 *     ? globalThis.WebSocket        // ← Bun's native WebSocket (drops: "Connection ended")
 *     : import_ws.WebSocket;        // ← the battle-tested `ws` package (a hard dep, installed, unused)
 *
 * (`@discordjs/ws/dist/index.js:602`). discord.js on Node always uses `ws`;
 * only Bun/Deno opt into native. We restore the Node-tested transport by
 * overriding `globalThis.WebSocket` with the `ws` implementation BEFORE
 * `@discordjs/ws` evaluates that module-level constructor.
 *
 * Placement contract: this module MUST be imported before any transitive
 * `discord.js` import. cortex runs UNBUNDLED from source under Bun
 * (`~/.local/bin/cortex` → `src/cortex.ts`), so there is no tree-shake/bundle step
 * to defeat the override — being the first import of the entry module is
 * sufficient. ESM evaluates imported modules depth-first in source order, so
 * `import "./bootstrap/ws-transport"` on line 1 runs its side effect before
 * the discord.js subtree is evaluated.
 *
 * Scope: Bun only. On Node `shouldUseGlobalFetchAndWebSocket()` is already
 * false (so @discordjs/ws uses `ws` regardless) and we leave the global
 * untouched. Opt-out via `CORTEX_WS_NATIVE=1` to A/B against Bun's native
 * transport while validating this fix.
 */
import { WebSocket as WsWebSocket } from "ws";

/** True when running under Bun (where the native-WebSocket opt-in bites). */
function runningUnderBun(): boolean {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return true;
  const versions = (typeof process !== "undefined" ? process.versions : undefined);
  return typeof versions?.bun === "string";
}

/**
 * Apply the override. Exported (rather than run purely as an import side
 * effect) so the unit test can assert behaviour deterministically against an
 * injected target object without mutating the real global. The module-load
 * side effect below calls it against `globalThis`.
 */
export function installWsTransport(
  target: Record<string, unknown> = globalThis,
  opts: { isBun?: boolean; nativeOptOut?: boolean; log?: (msg: string) => void } = {},
): { applied: boolean; reason: string } {
  const isBun = opts.isBun ?? runningUnderBun();
  const nativeOptOut = opts.nativeOptOut ?? process.env.CORTEX_WS_NATIVE === "1";

  if (!isBun) return { applied: false, reason: "not-bun" };
  if (nativeOptOut) return { applied: false, reason: "opt-out:CORTEX_WS_NATIVE" };

  // Preserve the native impl for diagnostics / explicit fallback, then swap
  // in `ws`. Idempotent: a second call sees `ws` already installed and no-ops.
  if (target.WebSocket === (WsWebSocket as unknown)) {
    return { applied: false, reason: "already-applied" };
  }
  target.__cortexNativeWebSocket = target.WebSocket;
  target.WebSocket = WsWebSocket;
  const log = opts.log ?? ((m: string) => process.stderr.write(m));
  log(
    "cortex/ws-transport: Bun detected — forcing @discordjs/ws onto the `ws` package " +
      "(set CORTEX_WS_NATIVE=1 to keep Bun's native WebSocket)\n",
  );
  return { applied: true, reason: "applied:ws" };
}

// Module-load side effect: apply against the real global immediately.
installWsTransport();
