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
 *     of the AgentConfig schema — G-203b). When the secret is empty, the
 *     receiver responds 503 "not configured" rather than starting unsecured.
 *
 * **Hostname posture:**
 *   - Default `127.0.0.1` — never `0.0.0.0`. The receiver carries no auth
 *     beyond HMAC; binding to all interfaces would expose it to LAN
 *     attackers who guess the secret. Principals who *want* to expose the
 *     receiver to a private subnet override `hostname` explicitly, opting
 *     in to the wider attack surface.
 *
 * **What this file is NOT:**
 *   - NOT the CF Worker. That continues to live at `taps/gh-webhook/src/index.ts`
 *     and is bundled separately (`wrangler deploy`). This receiver runs
 *     inside the cortex process.
 *   - NOT a GitHub event router. Subscribers consume envelopes from
 *     `local.{principal}.github.*` via the surface-router; this file's job ends
 *     once the envelope is on the bus.
 *   - NOT a CF Worker → cortex forwarder. The actual cross-network glue
 *     (how the Worker reaches `127.0.0.1` on the principal's laptop)
 *     remains an open architectural decision — see cortex#37 follow-up.
 *     In local development the principal can curl the receiver directly:
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
import type { Offering } from "../../common/types/offering";
import {
  translatePrOpenedToOffer,
  type PrOpenedMetadata,
} from "../public-offer-translation";

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
   *   - Mission Control embed: `config.mc.port` (0 → MC yaml port, default 8767)
   *
   * The default 8770 is far enough above mattermost's default that
   * accidental collision is unlikely; principals with another tenant on
   * 8770 set the port explicitly.
   */
  port?: number;
  /**
   * Hostname to bind. Default `127.0.0.1` — local-only. Principals who
   * expose the receiver to a wider scope (private subnet) set this
   * explicitly. Never default to `0.0.0.0`; HMAC is the only auth and
   * widening the bind surface multiplies guess-the-secret attack
   * geometry.
   */
  hostname?: string;
  /**
   * Envelope source identifier (`{principal}.{agent}.{instance}`). Passed
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
  /**
   * CO-5 (epic cortex#939) — the **public PR-review marketplace** Stage-1 tap.
   *
   * When provided, a validated `pull_request` `opened`/`reopened` delivery is —
   * in ADDITION to the generic `github.pull_request.opened` event published
   * above — run through the metadata-only Stage-1 admission gate
   * ({@link translatePrOpenedToOffer}, ADR-0010 DD-CO-8): if the stack OFFERS
   * `code-review` at `public` scope AND the surface-asserted metadata clears the
   * accept-predicate, a `public.{principal}.{stack}.tasks.code-review.{flavor}`
   * Offer envelope is published on its explicit subject via
   * {@link PublicOfferTap.publishOnSubject}. No Offer is published for a request
   * that fails Stage-1.
   *
   * **HMAC is the trust anchor:** this hook runs ONLY after the receiver has
   * re-verified the webhook HMAC (the surface trust anchor — ADR-0010). The
   * admission decision reads SURFACE-asserted metadata only (repo, sender),
   * never the PR's attacker-controlled content.
   *
   * **SHIPS DARK:** absent on every live stack today (no public `code-review`
   * offering ⇒ the M3 backend gate blocks the config from booting until #978),
   * so this hook is `undefined` and the receiver behaves exactly as pre-CO-5.
   * Even when wired, {@link translatePrOpenedToOffer} returns `{admit:false}`
   * (publishes nothing) for the default-deny `local`-only resolution.
   *
   * **Errors are swallowed + logged**, identical to the generic publish path:
   * a failure to publish the public Offer must not change the HTTP response to
   * the forwarder (GitHub never retries on 2xx).
   */
  publicOfferTap?: PublicOfferTap;
}

/**
 * CO-5 — the injected dependencies the receiver needs to run the public-offer
 * Stage-1 tap. The receiver stays passive: cortex.ts (the wiring site) injects
 * the offering stack's identity, its offerings list, and the explicit-subject
 * publisher. Kept narrow so the receiver is unit-testable with an in-memory fake.
 */
export interface PublicOfferTap {
  /** The OFFERING stack's principal id (the provider / cryptographic signer). */
  readonly principal: string;
  /** The OFFERING stack's stack segment. */
  readonly stack: string;
  /** The stack's offerings list (`config.policy.offerings`); `undefined` ⇒ none. */
  readonly offerings: readonly Offering[] | undefined;
  /**
   * Publish an envelope on an EXPLICIT subject (`runtime.publishOnSubject`).
   * The public Offer subject (`public.{principal}.{stack}.tasks.code-review.…`)
   * is not derivable from `envelope.type` alone, so the explicit-subject path is
   * required. `undefined` ⇒ the runtime cannot publish on explicit subjects
   * (dormant / stub): the tap is skipped (logged), the generic event still flows.
   */
  readonly publishOnSubject:
    | ((envelope: Envelope, subject: string) => Promise<void>)
    | undefined;
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

      // Health check — no auth, no body parsing. Lets the principal (or
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
        // principal sees the underlying cause in the structured log.
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
        const parsed: unknown = JSON.parse(body);
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

      // 7. CO-5 — the public PR-review marketplace Stage-1 tap. Runs ONLY after
      //    HMAC has been re-verified above (the surface trust anchor, ADR-0010).
      //    Additive: the generic `github.pull_request.opened` event already
      //    flowed; this ADDITIONALLY emits a public `code-review` Offer when the
      //    stack offers it public AND the metadata-only predicate admits. A
      //    failure here never changes the 200 returned to the forwarder.
      if (opts.publicOfferTap !== undefined) {
        await runPublicOfferTap(opts.publicOfferTap, opts.source, {
          event,
          action,
          repo,
          sender,
          payload,
          deliveryId,
        });
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
        void server.stop();
      } catch (err) {
        console.error(
          "github-webhook-receiver: server stop error:",
          err instanceof Error ? err.message : String(err),
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

/**
 * CO-5 — best-effort PR number extraction from a `pull_request` payload.
 * GitHub puts it at both `payload.number` and `payload.pull_request.number`;
 * we prefer the latter (canonical for PR events) and fall back. Returns
 * `undefined` for a non-PR payload — the translation gate then refuses.
 */
function extractPrNumber(payload: Record<string, unknown>): number | undefined {
  const pull = payload.pull_request;
  if (pull && typeof pull === "object" && !Array.isArray(pull)) {
    const n = (pull as Record<string, unknown>).number;
    if (typeof n === "number" && Number.isInteger(n)) return n;
  }
  const top = payload.number;
  if (typeof top === "number" && Number.isInteger(top)) return top;
  return undefined;
}

/**
 * CO-5 — best-effort PR title + head-SHA extraction. The title is
 * REQUESTER-controlled content (carried through to the review payload where
 * CO-7 M1 quarantines it; NEVER used in admission). The head SHA is the diff
 * ref the reviewer fetches. Both undefined-safe.
 */
function extractPrTitleAndDiffRef(
  payload: Record<string, unknown>,
): { title?: string; diffRef?: string } {
  const pull = payload.pull_request;
  if (!pull || typeof pull !== "object" || Array.isArray(pull)) return {};
  const p = pull as Record<string, unknown>;
  const out: { title?: string; diffRef?: string } = {};
  if (typeof p.title === "string" && p.title.length > 0) out.title = p.title;
  const head = p.head;
  if (head && typeof head === "object" && !Array.isArray(head)) {
    const sha = (head as Record<string, unknown>).sha;
    if (typeof sha === "string" && sha.length > 0) out.diffRef = sha;
  }
  return out;
}

/**
 * CO-5 — run the public-offer Stage-1 tap for one validated delivery. Extracts
 * the PR-specific surface metadata, runs {@link translatePrOpenedToOffer}, and
 * — when Stage-1 ADMITS — publishes the public Offer on its explicit subject.
 *
 * Posture (mirrors the generic publish path):
 *   - errors are swallowed + logged (never alter the HTTP response);
 *   - a `{admit:false}` outcome is the common, expected case (not a PR-opened,
 *     not offered public, predicate refused) — logged at debug granularity only
 *     for the cases worth seeing, silent for the default-deny no-op;
 *   - a missing `publishOnSubject` (dormant runtime / stub) skips publish with a
 *     single log line — the generic event already flowed, so the bus is not
 *     wholly silent.
 */
async function runPublicOfferTap(
  tap: PublicOfferTap,
  source: GithubEventSource,
  delivery: {
    event: string;
    action: string | undefined;
    repo: string | undefined;
    sender: string | undefined;
    payload: Record<string, unknown>;
    deliveryId: string;
  },
): Promise<void> {
  try {
    const metadata: PrOpenedMetadata = {
      event: delivery.event,
      action: delivery.action,
      repo: delivery.repo,
      pr: extractPrNumber(delivery.payload),
      sender: delivery.sender,
      ...extractPrTitleAndDiffRef(delivery.payload),
    };
    const result = translatePrOpenedToOffer({
      principal: tap.principal,
      stack: tap.stack,
      offerings: tap.offerings,
      source,
      metadata,
      deliveryId: delivery.deliveryId,
    });
    if (!result.admit) {
      // The common case (not a PR-open, not offered public, predicate refused).
      // Only the predicate-refusal is interesting enough to surface — it means a
      // public offering IS live and a request fell outside it. The rest is the
      // provingly-inert default-deny path; stay quiet to avoid log spam.
      if (result.reason === "accept_predicate_refused") {
        console.log(
          `github-webhook-receiver: public-offer Stage-1 refused ` +
            `(reason=${result.reason} repo=${delivery.repo ?? "?"} delivery=${delivery.deliveryId})`,
        );
      }
      return;
    }
    if (tap.publishOnSubject === undefined) {
      console.log(
        `github-webhook-receiver: public-offer Stage-1 admitted but runtime ` +
          `cannot publish on explicit subjects (dormant) — Offer not published ` +
          `(subject=${result.subject} delivery=${delivery.deliveryId})`,
      );
      return;
    }
    await tap.publishOnSubject(result.envelope, result.subject);
    console.log(
      `github-webhook-receiver: published public code-review Offer ` +
        `(subject=${result.subject} pr=${(result.envelope.payload as { pr?: number }).pr ?? "?"} ` +
        `delivery=${delivery.deliveryId})`,
    );
  } catch (err) {
    // Swallow + log — identical posture to the generic publish path. A public
    // Offer publish failure must not break the receiver or change the HTTP 200.
    console.error(
      `github-webhook-receiver: public-offer tap failed for delivery=${delivery.deliveryId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
