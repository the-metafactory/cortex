/**
 * MIG-5.6 (C-106) — Local HTTP receiver for forwarded GitHub webhooks.
 *
 * Per plan §6.10 + cortex#37 architectural rationale:
 *   - The Cloudflare Worker (`src/taps/gh-webhook/src/index.ts`) is the
 *     internet-facing edge for GitHub webhook delivery — it validates the
 *     HMAC signature, dedupes by `X-GitHub-Delivery`, and Service-Binds to
 *     `grove-api` for cloud persistence today.
 *   - Cortex itself runs as a local process. To get webhook envelopes onto
 *     the local NATS bus (which only cortex can reach), cortex stands up
 *     this small HTTP receiver. The Worker (or any other forwarder) POSTs
 *     a JSON envelope-input to `http://127.0.0.1:{port}/internal/webhook`;
 *     the receiver re-verifies HMAC as defense-in-depth and publishes the
 *     `github.{event}.{action}` envelope.
 *
 * **Why a separate file (not just inline in cortex.ts):**
 *   - cortex.ts is already the integration glue for the whole stack; the
 *     receiver has its own test surface (HMAC failure paths, malformed
 *     body handling, schema validation of the resulting envelope) that
 *     deserves its own module to keep cortex.ts under control.
 *   - The receiver is purely a thin adapter: `Request → envelope → publish`.
 *     The envelope construction is delegated to
 *     `bus/github-events.ts:createGithubEventEnvelope`; the publishing is
 *     delegated to the `MyelinRuntime.publish` callback the caller injects.
 *     Tests can therefore exercise the receiver against an in-memory fake
 *     publish without standing up a real NATS server.
 *
 * **HMAC posture:**
 *   - The receiver re-verifies the signature using `@octokit/webhooks-methods`,
 *     matching the Worker's verification step verbatim. This is
 *     defense-in-depth: the Worker validates upstream, but if an attacker
 *     ever bypasses the Worker (e.g. via a misconfigured local port forward,
 *     a curl probe against `127.0.0.1`, or a future architecture change),
 *     the receiver must not blindly trust forwarded headers.
 *   - Secret resolution: the receiver uses the secret passed at construction
 *     time. Cortex pulls it from `config.github.webhookSecret` (already part
 *     of the BotConfig schema — G-203b). When the secret is empty, the
 *     receiver responds 503 "not configured" rather than starting unsecured.
 *
 * **Hostname posture:**
 *   - Default `127.0.0.1` — never `0.0.0.0`. The receiver carries no auth
 *     beyond HMAC; binding to all interfaces would expose it to LAN
 *     attackers who guess the secret. Operators who *want* to expose the
 *     receiver to a private subnet override `hostname` explicitly, opting
 *     in to the wider attack surface.
 *
 * **What this file is NOT:**
 *   - NOT the CF Worker. That continues to live at `taps/gh-webhook/src/index.ts`
 *     and is bundled separately (`wrangler deploy`). This receiver runs
 *     inside the cortex process.
 *   - NOT a GitHub event router. Subscribers consume envelopes from
 *     `local.{org}.github.*` via the surface-router; this file's job ends
 *     once the envelope is on the bus.
 *   - NOT a CF Worker → cortex forwarder. The actual cross-network glue
 *     (how the Worker reaches `127.0.0.1` on the operator's laptop)
 *     remains an open architectural decision — see cortex#37 follow-up.
 *     In local development the operator can curl the receiver directly:
 *
 *       curl -X POST http://127.0.0.1:8770/internal/webhook \
 *         -H 'X-GitHub-Event: push' \
 *         -H 'X-GitHub-Delivery: <uuid>' \
 *         -H 'X-Hub-Signature-256: sha256=<hmac>' \
 *         -d '<payload>'
 *
 *     This makes the receiver useful immediately for offline GitHub-event
 *     simulation tests; the cloud forwarder can land later without
 *     re-wiring the receiver.
 */

import type { Server } from "bun";
import { verify } from "@octokit/webhooks-methods";
import type { Envelope } from "../../bus/myelin/envelope-validator";
import {
  createGithubEventEnvelope,
  type GithubEventSource,
} from "../../bus/github-events";

/**
 * Lifecycle handle returned by `startGithubWebhookReceiver`. Mirrors the
 * shape `createMattermostServer` returns — `server` is the underlying
 * Bun.Server (for tests that need to introspect address/port); `stop` is
 * the idempotent shutdown call.
 */
export interface GithubWebhookReceiverHandle {
  readonly server: Server<unknown>;
  readonly port: number;
  /**
   * Idempotent stop — calling twice is safe. Returns when the server has
   * stopped accepting new connections. In-flight requests are not awaited
   * here (consistent with `Server.stop()`'s default behaviour); cortex's
   * top-level shutdown timeout (15s) protects against pathological hangs.
   */
  stop(): void;
}

/**
 * Construction options for the local webhook receiver.
 *
 * The receiver is *passive*: it doesn't own the NATS connection, the
 * envelope-construction helpers, or the system-event source — the caller
 * (cortex.ts) constructs all three and injects them. This keeps the
 * receiver unit-testable without standing up a full cortex stack.
 */
export interface GithubWebhookReceiverOptions {
  /**
   * GitHub HMAC secret — must match the secret configured on the GitHub
   * repos. Sourced from `config.github.webhookSecret`. When empty, the
   * receiver refuses to accept any webhook (responds 503) rather than
   * starting in unsecured mode — explicit opt-in by configuration.
   */
  secret: string;
  /**
   * Localhost-only TCP port. Default `8770`. Cortex's other HTTP-listening
   * components use:
   *   - Mattermost outgoing-webhook server: configurable via
   *     `mattermost[].callbackPort` (default 8080)
   *   - Dashboard API: `config.api.port` (default 8766)
   *
   * The default 8770 is far enough above mattermost's default that
   * accidental collision is unlikely; operators with another tenant on
   * 8770 set the port explicitly.
   */
  port?: number;
  /**
   * Hostname to bind. Default `127.0.0.1` — local-only. Operators who
   * expose the receiver to a wider scope (private subnet) set this
   * explicitly. Never default to `0.0.0.0`; HMAC is the only auth and
   * widening the bind surface multiplies guess-the-secret attack
   * geometry.
   */
  hostname?: string;
  /**
   * Envelope source identifier (`{org}.{agent}.{instance}`). Passed
   * through to `createGithubEventEnvelope`; identical to the
   * `systemEventSource` cortex uses for `system.*` envelopes so all
   * envelopes from one cortex process carry the same source segments.
   */
  source: GithubEventSource;
  /**
   * Publish callback — typically `runtime.publish.bind(runtime)`. Called
   * once per valid webhook with the constructed envelope. Errors are
   * logged but not propagated to the HTTP response (the bus is the
   * destination; the HTTP response just acknowledges receipt).
   */
  publish: (envelope: Envelope) => Promise<void>;
  /**
   * Optional override for the HMAC verifier — exposed for tests so we can
   * assert handling of `verify()` throwing on malformed input without
   * standing up real signatures. Production callers omit.
   *
   * @internal
   */
  verifyImpl?: (secret: string, body: string, signature: string) => Promise<boolean>;
  /**
   * Optional override for the envelope builder — exposed for tests so a
   * fake can record the inputs without re-implementing the helper.
   * Production callers omit.
   *
   * @internal
   */
  buildEnvelope?: typeof createGithubEventEnvelope;
}

/**
 * Start the local GitHub webhook receiver.
 *
 * Returns a handle the caller (cortex.ts) registers in its shutdown
 * sequence. The receiver runs on a single Bun.serve instance; no thread
 * pool, no worker — the in-process publish is fast enough that we don't
 * need a queue.
 *
 * **HTTP contract:**
 *   - `GET /health` → `{ status: "ok", service: "github-webhook-receiver" }`
 *   - `POST /internal/webhook` → 200/4xx/5xx per the validation matrix below
 *
 * **Validation matrix for POST `/internal/webhook`** (response codes mirror
 * the CF Worker proxy for symmetric semantics):
 *   - 503 "not configured" — secret is empty (receiver started without auth)
 *   - 400 "missing headers" — missing one of `X-Hub-Signature-256`,
 *         `X-GitHub-Event`, `X-GitHub-Delivery`
 *   - 401 "unauthorized" — HMAC mismatch (or `verify()` threw on malformed
 *         signature)
 *   - 400 "invalid json" — body is not parseable as JSON
 *   - 200 "ok" — envelope built and `publish()` invoked. The receiver
 *         returns 200 even if `publish()` rejects (errors logged) — same
 *         posture as the Worker, which returns the origin response. The
 *         goal is to acknowledge receipt to the forwarder; durability is
 *         the bus's job (JetStream when configured).
 */
export function startGithubWebhookReceiver(
  opts: GithubWebhookReceiverOptions,
): GithubWebhookReceiverHandle {
  const port = opts.port ?? 8770;
  const hostname = opts.hostname ?? "127.0.0.1";
  const verifyFn = opts.verifyImpl ?? verify;
  const buildEnvelope = opts.buildEnvelope ?? createGithubEventEnvelope;

  const server = Bun.serve({
    port,
    hostname,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // Health check — no auth, no body parsing. Lets the operator (or
      // a sidecar) verify the receiver is up before sending real events.
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({
          status: "ok",
          service: "github-webhook-receiver",
        });
      }

      // Method gate — only the webhook POST is supported.
      if (req.method !== "POST" || url.pathname !== "/internal/webhook") {
        return new Response("not found", { status: 404 });
      }

      // 1. Secret gate — refuse to operate without a secret. The same
      //    posture the Worker uses.
      if (!opts.secret) {
        return new Response("not configured", { status: 503 });
      }

      // 2. Required headers. These match the Worker's forwarded
      //    `X-GitHub-*` triplet.
      const signature = req.headers.get("x-hub-signature-256") ?? "";
      const event = req.headers.get("x-github-event") ?? "";
      const deliveryId = req.headers.get("x-github-delivery") ?? "";

      if (!signature || !event || !deliveryId) {
        return new Response("missing headers", { status: 400 });
      }

      // 3. Read body once and verify the signature. The verifier may
      //    throw on malformed inputs (e.g. non-hex `sha256=...`); the
      //    Worker catches that and returns 401, so we do the same.
      const body = await req.text();
      try {
        const ok = await verifyFn(opts.secret, body, signature);
        if (!ok) {
          return new Response("unauthorized", { status: 401 });
        }
      } catch (err) {
        // Don't leak the verifier error to the caller; just 401. The
        // operator sees the underlying cause in the structured log.
        console.error(
          "github-webhook-receiver: HMAC verifier threw:",
          err instanceof Error ? err.message : err,
        );
        return new Response("unauthorized", { status: 401 });
      }

      // 4. Parse JSON. Malformed JSON gets 400; the Worker validates
      //    HMAC over raw bytes regardless of body content type, so we
      //    only fail here after auth has passed.
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(body);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return new Response("invalid json", { status: 400 });
        }
        payload = parsed as Record<string, unknown>;
      } catch (err) {
        console.error(
          "github-webhook-receiver: malformed JSON body:",
          err instanceof Error ? err.message : err,
        );
        return new Response("invalid json", { status: 400 });
      }

      // 5. Extract well-known GitHub fields. `action` may be absent
      //    (push, ping, …); `repository.full_name` and `sender.login`
      //    may be absent for some payload types but are present on
      //    every typical workflow event we care about.
      const action = typeof payload.action === "string"
        ? payload.action
        : undefined;
      const repo = extractRepoFullName(payload);
      const sender = extractSenderLogin(payload);

      // 6. Build the envelope and publish. Publish errors are swallowed
      //    + logged — the contract on `MyelinRuntime.publish` is
      //    fire-and-forget; if NATS is down, the receiver still returns
      //    200 so the forwarder doesn't retry (which would just queue
      //    failures upstream).
      const envelope = buildEnvelope({
        source: opts.source,
        event,
        ...(action !== undefined && { action }),
        deliveryId,
        payload,
        ...(repo !== undefined && { repo }),
        ...(sender !== undefined && { sender }),
      });

      try {
        await opts.publish(envelope);
      } catch (err) {
        // Same swallow-and-log posture as `MyelinRuntime.publish` itself:
        // an emitting webhook event must not break the receiver path. The
        // forwarder sees 200 either way.
        console.error(
          `github-webhook-receiver: publish failed for type=${envelope.type} delivery=${deliveryId}:`,
          err instanceof Error ? err.message : err,
        );
      }

      return new Response("ok", { status: 200 });
    },
  });

  console.log(
    `github-webhook-receiver: listening on ${hostname}:${port} (POST /internal/webhook)`,
  );

  return {
    server,
    port,
    stop: () => {
      try {
        server.stop();
      } catch (err) {
        console.error(
          "github-webhook-receiver: server stop error:",
          err instanceof Error ? err.message : err,
        );
      }
    },
  };
}

/**
 * Best-effort `repository.full_name` extraction. GitHub puts this on
 * almost every event; the helper handles the type-narrowing so the
 * caller doesn't have to. Returns `undefined` when the field is missing
 * or the shape is unexpected — surfaces that filter on repo will simply
 * see "no repo" envelopes and may choose to ignore them.
 */
function extractRepoFullName(payload: Record<string, unknown>): string | undefined {
  const repo = payload.repository;
  if (repo && typeof repo === "object" && !Array.isArray(repo)) {
    const fullName = (repo as Record<string, unknown>).full_name;
    if (typeof fullName === "string" && fullName.length > 0) return fullName;
  }
  return undefined;
}

/**
 * Best-effort `sender.login` extraction. Same posture as
 * `extractRepoFullName` — return the string when present, undefined
 * otherwise.
 */
function extractSenderLogin(payload: Record<string, unknown>): string | undefined {
  const sender = payload.sender;
  if (sender && typeof sender === "object" && !Array.isArray(sender)) {
    const login = (sender as Record<string, unknown>).login;
    if (typeof login === "string" && login.length > 0) return login;
  }
  return undefined;
}
