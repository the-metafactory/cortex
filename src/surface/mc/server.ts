import { handleDeskPlan } from "./api/desk-plan";
import { handleDeskRoutineEvidence } from "./api/desk-routine-evidence";
import { WaitingTasks } from "./desk/sources/waiting";
import { handleDeskMyDay } from "./api/desk-my-day";
import { handleDeskCalendars } from "./api/desk-calendars";
import { handleDeskRoutines } from "./api/desk-routines";
import { handleDeskRoutineOccurrences } from "./api/desk-routine-occurrences";
import { handleDeskRoutineEditor } from "./api/desk-routine-editor";
import { handleDeskRoutineRemoval } from "./api/desk-routine-removal";
import { handleDeskRoutineLifecycle } from "./api/desk-routine-lifecycle";
import { handleDeskRoutineSchedule } from "./api/desk-routine-schedule";
import { RoutineReadLoop } from "./desk/routine-read";
import { localRoutineCapabilities } from "./desk/routine-providers";
import type { Server, ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { Config } from "./types";
import type { WsData } from "./ws/types";
import { WS_PROTOCOL_VERSION } from "./ws/types";
import { WsClientRegistry } from "./ws/client-registry";
import { generateId } from "./db/events";
import type { ApiDeps } from "./api/handlers";
import type { MaybeNotifyDeps } from "./notifications";
import {
  handleAbandonAssignment,
  handleAbandonTask,
  handleAttachTaskToIteration,
  handleCreateIteration,
  handleCreateSession,
  handleCreateTask,
  handleDetachTaskFromIteration,
  handleGetAssignmentMetrics,
  handleGetFleetMetrics,
  handleGetIteration,
  handleGithubWebhook,
  handleHandoffAssignment,
  handleImportIterationFromGithub,
  handleListAssignments,
  handleListEvents,
  handleListFocusArea,
  handleListInbox,
  handleListIterations,
  handleListTasks,
  handleListWorkingAgents,
  handleListWorkingAggregation,
  handlePatchIteration,
  handlePreviewTask,
  handleRequeueAssignment,
  handleSendInput,
  IMAGE_BODY_MAX_BYTES,
} from "./api/handlers";
import { handleListGitLinks } from "./api/git-links";
import { handleListAgents, type AgentPresenceView } from "./api/agents";
import { handleListNetworks, type NetworksView } from "./api/networks";
import { handleGetHandoff, type HandoffView } from "./api/handoff";
import { handleGetDoctor, type DoctorView } from "./api/doctor";
import {
  handleAdmissionDecision,
  CF_ACCESS_EMAIL_HEADER,
  CF_ACCESS_JWT_HEADER,
  isLoopbackBind,
  type AdmissionDecider,
  type AdmissionAuthContext,
} from "./api/networks-admission";
import {
  handleAuthorize,
  AUTHORIZE_PATH,
  type Authorizer,
} from "./api/networks-authorize";
import { verifyCfAccessJwt } from "../../common/auth/cf-access-jwt";
import type { DegradedInfo } from "../../common/config/degraded-state";
import type {
  LocalAggregationContext,
  LocalAggregationProvider,
} from "./local-aggregation/sibling-db-reader";
import { handleListRepositories } from "./api/git-repos";
import { handleListPlans } from "./api/plans";
import { handleGetPhaseDetail } from "./api/phase-detail";
import { handleGetWorkItemDetail } from "./api/work-item-detail";
import { handleListAttention, handleAttentionLifecycle } from "./api/attention";
import { handleGetDesk } from "./api/desk";
import { handleDeskSenders, handleDeskVips } from "./api/desk-vips";
import { handleDeskMail } from "./api/desk-mail";
import { handleDeskMailRules } from "./api/desk-mail-rules";
import { handleDeskDmarc } from "./api/desk-dmarc";
import { DmarcLoop } from "./desk/mail-dmarc";
import { DEFAULT_MAIL_RULES, MailRuleLoop } from "./desk/mail-rules";
import { handleDeskCorrections } from "./api/desk-corrections";
import { handleDeskAction, handleDeskAutonomy } from "./api/desk-action";
import { handleDeskCaptureUndo, handleDeskAsk, handleDeskCreate, handleDeskNoteDone } from "./api/desk-ask";
import { handleDeskSpeak, handleDeskTranscribe } from "./api/desk-voice";
import { handleDeskGoal } from "./api/desk-goal";
import { handleDeskRuling } from "./api/desk-ruling";
import { handleGetDeskStudio } from "./api/desk-studio";
import { handleDeskStudioAct } from "./api/desk-studio-act";
import { handleDeskStudioSession } from "./api/desk-studio-session";
import { GoalChecks, GoalStatuses } from "./desk/goals";
import { RulingExplainLoop, RulingLedger, rulingExplainer } from "./desk/ruling";
import { DigestFlagger } from "./desk/mail-digest";
import { MailSimilarity } from "./desk/mail-similar";
import { RecentCalendarWrites, spawnWithStdin } from "./desk/create";
import { HandledLedger } from "./desk/actions";
import type { DeskOptions, DeskRuntime } from "./desk/compose";
import { SourceCache, spawnCommand, type SourceReading } from "./desk/sources/command";
import { ClientMailLog } from "./desk/mail-client-log";
import { DEFAULT_MAIL_LOG_RETENTION_DAYS } from "./desk/mail-log";
import { startDeskAutonomy, startDeskPushes } from "./desk/push";
import { MailClassifier } from "./desk/classify";
import type { DeskTransport } from "./desk/interrupt";
import { handleListVigilSubjects, type VigilSubjectsOptions } from "./api/vigil";
import { handleResult, type ResultRouteOptions } from "./results";
import {
  MUTATING_METHODS,
  buildAllowedHostnames,
  checkRebindGuard,
  enforceMutationAuth,
  isIdentityGatedMutation,
  isRebindExempt,
  type MutationGuardContext,
} from "./api/mutation-guard";
import { enforceStepUp, requiresStepUp } from "./api/step-up-mfa";
import {
  defaultStepUpSecretPath,
  loadEnrollment,
  type StepUpEnrollment,
} from "../../common/step-up/enrollment";
import { expandTilde } from "../../common/config/loader";
import { handleGetGovernance } from "./api/governance";
import { handleGetObservability } from "./api/observability-tab";
import { proxySideband } from "../../common/sideband/proxy";
import type { ProcessManager } from "./session/process-manager";
import type { SpawnFn } from "./session/endpoint-resolver";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const VERSION = "0.1.0";
const startTime = Date.now();

export const DASHBOARD_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "dist",
  "dashboard-v2"
);

const DASHBOARD_ASSET_EXT = /^\/[\w.-]+\.(js|css|svg|png|jpe?g|gif|webp|ico|map|woff2?)$/;

const SERVER_PING_INTERVAL_MS = 30_000;

export interface ServerContext {
  server: Server<WsData>;
  port: number;
  wsRegistry: WsClientRegistry;
  stop: (closeActive?: boolean) => void;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  wsClients: number;
  degraded?: DegradedInfo;
}

/** The read views and providers Mission Control serves, shared by startServer and startMissionControl. */
export interface MissionControlViews {
  results?: ResultRouteOptions;
  vigil?: VigilSubjectsOptions;
  desk?: DeskOptions;
  deskTransport?: () => DeskTransport | null;
  agentPresence?: () => AgentPresenceView | null;
  localAggregation?: LocalAggregationProvider;
  networks?: () => NetworksView | null;
  admissionDecider?: () => AdmissionDecider | null;
  authorizer?: () => Authorizer | null;
  handoffView?: () => HandoffView | null;
  doctorView?: () => DoctorView | null;
  sidebandUrl?: string;
}

export interface StartServerOptions extends MissionControlViews {
  processManager?: ProcessManager;
  degraded?: DegradedInfo;
  spawn?: SpawnFn;
  notify?: MaybeNotifyDeps;
  defaultGithubRepo?: string;
  ghSpawn?: import("./adapters/github").GhSpawnFn;
  iterationLabel?: string;
  githubWebhookSecret?: string;
}

export function startServer(
  config: Config,
  db: Database,
  options: StartServerOptions = {}
): ServerContext {
  const wsRegistry = new WsClientRegistry();
  const deskLedger = new HandledLedger();
  const deskClientMail = options.desk ? new ClientMailLog({ db, config: options.desk.mailActions, ledger: deskLedger, run: spawnWithStdin, now: Date.now, retentionDays: options.desk.mailLog?.retentionDays ?? DEFAULT_MAIL_LOG_RETENTION_DAYS }) : undefined;
  const deskMailRules: MailRuleLoop | undefined = options.desk?.mailActions?.move?.length
    ? new MailRuleLoop({ db, mailActions: options.desk.mailActions, ledger: deskLedger, run: spawnWithStdin, now: Date.now, config: options.desk.mailRules ?? DEFAULT_MAIL_RULES, ownDomains: options.desk.mailOwnDomains ?? [] }, (): SourceReading[] => deskSourceCache.cached())
    : undefined;
  const deskDmarc: DmarcLoop | undefined = deskMailRules && options.desk?.mailDmarc
    ? new DmarcLoop({ db, config: options.desk.mailDmarc, mailActions: options.desk.mailActions, ledger: deskLedger, run: spawnWithStdin, now: Date.now, log: console.error }, (): SourceReading[] => deskSourceCache.cached())
    : undefined;
  const deskSourceCache: SourceCache = new SourceCache(spawnCommand, deskClientMail || deskMailRules ? (prev, next) => {
    void deskClientMail?.observe(prev, next);
    void deskMailRules?.kick().then(() => deskDmarc?.kick());
  } : undefined);
  const deskRecentWrites = new RecentCalendarWrites();
  const deskRuntime: DeskRuntime = { waitingTasks: new WaitingTasks(), routineRead: new RoutineReadLoop(), options: options.desk, sourceCache: deskSourceCache, ledger: deskLedger, recentWrites: deskRecentWrites, goalChecks: new GoalChecks(), goalStatuses: new GoalStatuses(), rulings: new RulingLedger(), ...(deskMailRules ? { mailRules: deskMailRules } : {}), ...(deskDmarc ? { dmarc: deskDmarc } : {}), ...(options.desk?.mailClassifier ? { mailClassifier: new MailClassifier(options.desk.mailClassifier, undefined, undefined, undefined, new MailSimilarity(options.desk.mailEmbedder)) } : {}), ...(options.desk?.rulingExplainer ? { rulingExplain: new RulingExplainLoop(rulingExplainer(options.desk.rulingExplainer)) } : {}), ...(options.desk?.mailDigest?.model ? { digestFlagger: new DigestFlagger(options.desk.mailDigest.model) } : {}) };
  const maxClients = config.ws.maxClients;

  const isLoopback = isLoopbackBind(config.hostname);
  const cfAccess = config.cfAccess;
  const cfAccessVerifier: AdmissionAuthContext["verifyJwt"] = cfAccess
    ? (token: string): Promise<Record<string, unknown> | null> =>
        verifyCfAccessJwt(token, {
          aud: cfAccess.aud,
          teamDomain: cfAccess.teamDomain ?? "metafactory",
        })
    : undefined;

  const guardBase: Omit<MutationGuardContext, "listenPort"> = {
    isLoopback,
    allowedHostnames: buildAllowedHostnames(config.hostname),
    principals: new Set(
      (config.governance?.principals ?? []).map((p) => p.trim().toLowerCase()),
    ),
    ...(config.governance?.localPrincipal
      ? { localPrincipal: config.governance.localPrincipal }
      : {}),
    ...(cfAccessVerifier ? { verifyJwt: cfAccessVerifier } : {}),
  };

  const stepUpSecretPath = expandTilde(
    config.governance?.stepUp?.secretPath ?? defaultStepUpSecretPath(),
  );

  const apiDeps: ApiDeps | null = options.processManager
    ? {
        processManager: options.processManager,
        wsRegistry,
        spawn: options.spawn,
        ...(options.notify ? { notify: options.notify } : {}),
        ...(options.defaultGithubRepo
          ? { defaultGithubRepo: options.defaultGithubRepo }
          : {}),
        ...(options.ghSpawn ? { ghSpawn: options.ghSpawn } : {}),
        ...(options.iterationLabel
          ? { iterationLabel: options.iterationLabel }
          : {}),
        ...(options.githubWebhookSecret
          ? { githubWebhookSecret: options.githubWebhookSecret }
          : {}),
        ...(options.sidebandUrl ? { sidebandUrl: options.sidebandUrl } : {}),
      }
    : null;

  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.hostname,

    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname.startsWith("/results/") || url.pathname.startsWith("/proposals/")) {
        if (!isLoopback) return new Response("Not Found", { status: 404 });
        if (req.method !== "GET") return methodNotAllowed(["GET"]);
        const denial = checkRebindGuard(req, { ...guardBase, listenPort: server.port ?? config.port });
        if (denial) return denial;
        const directory = url.pathname.startsWith("/proposals/") ? "proposals" : "outputs";
        const prefix = directory === "proposals" ? "/proposals/" : "/results/";
        return handleResult(db, url.pathname.slice(prefix.length), options.results, directory);
      }

      if (req.method === "GET" && url.pathname === "/ws") {
        if (maxClients > 0 && wsRegistry.size >= maxClients) {
          return new Response("Too many WebSocket clients", { status: 503 });
        }

        const clientId = generateId();
        const upgraded = server.upgrade(req, {
          data: { clientId },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        const body: HealthResponse = {
          status: options.degraded !== undefined ? "degraded" : "ok",
          version: VERSION,
          uptime: Math.floor((Date.now() - startTime) / 1000),
          wsClients: wsRegistry.size,
          ...(options.degraded !== undefined && { degraded: options.degraded }),
        };
        return Response.json(body);
      }

      if (url.pathname.startsWith("/api/")) {
        if (req.method === "POST" && ["/api/desk/ask", "/api/desk/create", "/api/desk/routines", "/api/desk/routine-editor"].includes(url.pathname)) server.timeout(req, 0);
        if (req.method === "POST" && /^\/api\/attention\/[^/]+\/resolve$/.test(url.pathname)) {
          server.timeout(req, 0);
        }
        const agentPresence = options.agentPresence?.() ?? null;
        const localAggregation = options.localAggregation?.() ?? null;
        const networks = options.networks?.() ?? null;
        const admissionDecider = options.admissionDecider?.() ?? null;
        const authorizer = options.authorizer?.() ?? null;
        const handoffView = options.handoffView?.() ?? null;
        const doctorView = options.doctorView?.() ?? null;
        const guard: MutationGuardContext = {
          ...guardBase,
          listenPort: server.port ?? config.port,
        };
        return handleApi(
          req,
          url,
          db,
          apiDeps,
          agentPresence,
          localAggregation,
          networks,
          admissionDecider,
          guard,
          handoffView,
          doctorView,
          stepUpSecretPath,
          authorizer,
          options.vigil ? { ...options.vigil, somaHome: options.results?.somaHome ?? options.vigil.somaHome } : undefined,
          deskRuntime,
        );
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(Bun.file(join(DASHBOARD_DIST, "index.html")), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "GET" && DASHBOARD_ASSET_EXT.test(url.pathname)) {
        const rel = url.pathname.slice(1);
        if (rel.includes("..") || rel.length === 0) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(Bun.file(join(DASHBOARD_DIST, rel)));
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      idleTimeout: config.ws.idleTimeoutSec,

      maxPayloadLength: config.ws.maxPayloadLength,

      open(ws: ServerWebSocket<WsData>) {
        wsRegistry.add(ws);
        ws.send(
          JSON.stringify({
            type: "connected",
            clientId: ws.data.clientId,
            serverVersion: VERSION,
            protocolVersion: WS_PROTOCOL_VERSION,
          })
        );
      },

      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        const raw = typeof msg === "string" ? msg : msg.toString();

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (_err) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }

        const typeField =
          typeof parsed === "object" && parsed !== null && "type" in parsed
            ? parsed.type
            : undefined;

        if (typeField === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (typeField === "pong") {
          return;
        }

        if (typeField === "subscribe") {
          const assignmentIds = (parsed as { assignmentIds?: unknown }).assignmentIds;
          ws.send(
            JSON.stringify({
              type: "subscribed",
              assignmentIds: Array.isArray(assignmentIds) ? assignmentIds : [],
            })
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "error",
            message:
              typeof typeField === "string"
                ? `Unknown message type: '${typeField}'`
                : "Message missing string 'type' field",
          })
        );
      },

      close(ws: ServerWebSocket<WsData>) {
        wsRegistry.remove(ws);
      },
    },
  });

  const pingInterval = setInterval(() => {
    wsRegistry.broadcast({ type: "ping" });
  }, SERVER_PING_INTERVAL_MS);

  const deskTransport = options.deskTransport ?? ((): DeskTransport | null => null);
  const deskPushes = startDeskPushes(db, deskRuntime, options.vigil, deskTransport);
  deskRuntime.autonomy = startDeskAutonomy(db, deskRuntime);

  const stop = (closeActive = false) => {
    clearInterval(pingInterval);
    deskPushes?.stop();
    deskRuntime.autonomy?.stop();
    void server.stop(closeActive);
  };

  return { server, port: server.port ?? config.port, wsRegistry, stop };
}

async function handleApi(
  req: Request,
  url: URL,
  db: Database,
  deps: ApiDeps | null,
  agentPresence: AgentPresenceView | null,
  localAggregation: LocalAggregationContext | null,
  networks: NetworksView | null = null,
  admissionDecider: AdmissionDecider | null = null,
  guard: MutationGuardContext,
  handoffView: HandoffView | null = null,
  doctorView: DoctorView | null = null,
  stepUpSecretPath: string = expandTilde(defaultStepUpSecretPath()),
  authorizer: Authorizer | null = null,
  vigil?: VigilSubjectsOptions,
  desk?: DeskRuntime,
): Promise<Response> {
  const { pathname } = url;

  if (MUTATING_METHODS.has(req.method) && !isRebindExempt(pathname)) {
    const rebindDenial = checkRebindGuard(req, guard);
    if (rebindDenial) return rebindDenial;
  }
  if (isIdentityGatedMutation(req.method, pathname) || requiresStepUp(req.method, pathname)) {
    const authResult = await enforceMutationAuth(req, guard);
    if (authResult instanceof Response) return authResult;
  }
  if (requiresStepUp(req.method, pathname)) {
    let enrollment: StepUpEnrollment | null;
    try {
      enrollment = loadEnrollment(stepUpSecretPath);
    } catch (err) {
      process.stderr.write(
        `[step-up] failed to load enrollment: ${(err as Error).message}\n`,
      );
      return new Response(
        JSON.stringify({
          error: "step_up_load_failed",
          detail:
            "the step-up MFA enrollment could not be read (malformed or wrong " +
            "permissions). Refusing the control verb fail-closed. Re-enroll with " +
            "`cortex step-up enroll`.",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    const stepUpDenial = enforceStepUp(req, { enrollment });
    if (stepUpDenial) return stepUpDenial;
  }

  if (pathname === "/api/desk") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    return handleGetDesk(db, desk, vigil);
  }

  if (pathname === "/api/desk/plan") return handleDeskPlan(req, db, desk, vigil);

  if (pathname === "/api/desk/my-day") return handleDeskMyDay(req, db, desk, vigil);

  if (pathname === "/api/desk/action") return handleDeskAction(req, desk);

  if (pathname === "/api/desk/autonomy") return handleDeskAutonomy(req, db, desk);

  if (pathname === "/api/desk/calendars") return handleDeskCalendars(req, db);

  if (pathname === "/api/desk/vips") return handleDeskVips(req, url, db);

  if (pathname === "/api/desk/unimportant") return handleDeskSenders(req, url, db, "unimportant");

  if (pathname === "/api/desk/mail") return handleDeskMail(req, db, desk);

  if (pathname === "/api/desk/mail/rules") return handleDeskMailRules(req, db, desk);

  if (pathname === "/api/desk/mail/dmarc") return handleDeskDmarc(req, db, desk);

  if (pathname === "/api/desk/corrections") return handleDeskCorrections(req, url, db);

  if (pathname === "/api/desk/ask") return handleDeskAsk(req, desk, { routineCapabilities: () => localRoutineCapabilities(agentPresence) }, db);

  if (pathname === "/api/desk/capture/undo") return handleDeskCaptureUndo(req, db, desk);

  if (pathname === "/api/desk/create") return handleDeskCreate(req, db, desk, { routineCapabilities: () => localRoutineCapabilities(agentPresence) });
  if (pathname === "/api/desk/routines") return handleDeskRoutines(req, db, desk, undefined, () => localRoutineCapabilities(agentPresence));
  if (pathname === "/api/desk/routine-history") return handleDeskRoutineEvidence(req, db, desk);
  if (pathname === "/api/desk/routine-log") return handleDeskRoutineEvidence(req, db, desk, true);
  if (pathname === "/api/desk/routine-occurrences") return handleDeskRoutineOccurrences(req, desk);
  if (pathname === "/api/desk/routine-editor") return handleDeskRoutineEditor(req, desk, undefined, db);
  if (pathname === "/api/desk/routine-removal") return handleDeskRoutineRemoval(req, desk);
  if (pathname === "/api/desk/routine-lifecycle") return handleDeskRoutineLifecycle(req, desk);
  if (pathname === "/api/desk/routine-schedule") return handleDeskRoutineSchedule(req, desk);

  if (pathname === "/api/desk/voice/speak") return handleDeskSpeak(req, desk);

  if (pathname === "/api/desk/voice/transcribe") return handleDeskTranscribe(req, desk);

  if (pathname === "/api/desk/notes/done") return handleDeskNoteDone(req, db);

  if (pathname === "/api/desk/goal") return handleDeskGoal(req, desk);

  if (pathname === "/api/desk/ruling") return handleDeskRuling(req, desk);

  if (pathname === "/api/desk/studio") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    return handleGetDeskStudio(desk);
  }

  if (pathname === "/api/desk/studio/act") return handleDeskStudioAct(req, desk, { db });
  if (pathname === "/api/desk/studio/session") return handleDeskStudioSession(req, db, desk);

  if (pathname === "/api/vigil/subjects") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);
    if (!vigil?.enabled) return Response.json({ subjects: [], enabled: false });
    return handleListVigilSubjects(db, vigil.resolveGoalWording, vigil.cadence);
  }

  if (pathname === "/api/assignments") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListAssignments(db);
  }

  if (pathname === "/api/focus-area") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListFocusArea(db);
  }

  if (pathname === "/api/git/links") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListGitLinks(db, url);
  }

  if (pathname === "/api/git/repositories") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListRepositories(db);
  }

  if (pathname === "/api/plans") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListPlans(db);
  }

  if (pathname.startsWith("/api/phases/")) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const phaseId = decodeURIComponent(pathname.slice("/api/phases/".length));
    if (!phaseId || phaseId.includes("/")) {
      return new Response(JSON.stringify({ error: "invalid phase id" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return handleGetPhaseDetail(db, phaseId);
  }

  if (pathname === "/api/work-items") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const id = url.searchParams.get("id");
    if (!id) {
      return new Response(JSON.stringify({ error: "missing id query param" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return handleGetWorkItemDetail(db, id);
  }

  if (pathname === "/api/attention") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListAttention(db, vigil);
  }

  const attentionLifecycleMatch =
    /^\/api\/attention\/([^/]+)\/(resolve|dismiss)$/.exec(pathname);
  if (attentionLifecycleMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    const captured = attentionLifecycleMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const id = decodeURIComponent(captured);
    const action = attentionLifecycleMatch[2] as "resolve" | "dismiss";
    return handleAttentionLifecycle(db, id, action, vigil);
  }

  if (pathname === "/api/governance") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleGetGovernance(db);
  }

  if (pathname === "/api/observability-events") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleGetObservability(db);
  }

  if (pathname.startsWith("/api/observability/")) {
    if (!deps?.sidebandUrl) {
      return new Response(
        JSON.stringify({
          code: "backend_unavailable",
          message:
            "interior capture not available — no sideband endpoint configured for this Mission Control",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    const suffix = pathname.slice("/api/observability".length);
    return proxySideband(req.method, suffix, url.search.replace(/^\?/, ""), {
      baseUrl: deps.sidebandUrl,
    });
  }

  if (pathname === "/api/tasks") {
    if (req.method === "GET") {
      return handleListTasks(db, url);
    }
    if (req.method === "POST") {
      if (!deps) {
        return sessionDepsUnavailable();
      }
      const body = await parseJsonBody(req);
      if (body.error) return body.error;
      return handleCreateTask(db, deps, body.value);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  if (pathname === "/api/tasks/preview") {
    return postJsonWithSessionDeps(req, deps, (d, body) => handlePreviewTask(db, d, body));
  }

  const abandonTaskMatch = /^\/api\/tasks\/([^/]+)\/abandon$/.exec(pathname);
  if (abandonTaskMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return sessionDepsUnavailable();
    }
    const captured = abandonTaskMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const taskId = decodeURIComponent(captured);
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleAbandonTask(db, deps, taskId, body.value);
  }

  if (pathname === "/api/working-agents") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListWorkingAgents(db, localAggregation);
  }

  if (pathname === "/api/working-aggregation") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListWorkingAggregation(db);
  }

  if (pathname === "/api/agents") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListAgents(db, agentPresence, localAggregation);
  }

  if (pathname === "/api/networks") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListNetworks(networks, agentPresence);
  }

  const networkHandoffMatch = /^\/api\/networks\/([^/]+)\/handoff\/([^/]+)$/.exec(pathname);
  if (networkHandoffMatch) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const netCaptured = networkHandoffMatch[1];
    const memberCaptured = networkHandoffMatch[2];
    if (!netCaptured || !memberCaptured) {
      return new Response("Not Found", { status: 404 });
    }
    const networkId = decodeURIComponent(netCaptured);
    const member = decodeURIComponent(memberCaptured);
    const confirmed = url.searchParams.get("confirmed") === "true";
    return handleGetHandoff(handoffView, { networkId, member, confirmed });
  }

  const networkDoctorMatch = /^\/api\/networks\/([^/]+)\/doctor$/.exec(pathname);
  if (networkDoctorMatch) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const netCaptured = networkDoctorMatch[1];
    if (!netCaptured) {
      return new Response("Not Found", { status: 404 });
    }
    const networkId = decodeURIComponent(netCaptured);
    return handleGetDoctor(doctorView, { networkId });
  }

  if (pathname === "/api/networks/admission-decision") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    const emailHeader = req.headers.get(CF_ACCESS_EMAIL_HEADER) ?? undefined;
    const jwtAssertion = req.headers.get(CF_ACCESS_JWT_HEADER) ?? undefined;
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    const auth: AdmissionAuthContext = {
      isLoopback: guard.isLoopback,
      emailHeader,
      jwtAssertion,
      ...(guard.localPrincipal ? { localPrincipal: guard.localPrincipal } : {}),
      ...(guard.verifyJwt ? { verifyJwt: guard.verifyJwt } : {}),
    };
    return handleAdmissionDecision(admissionDecider, auth, body.value);
  }

  if (pathname === AUTHORIZE_PATH) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleAuthorize(authorizer, body.value);
  }

  if (pathname === "/api/iterations/from-github") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return iterationDepsUnavailable();
    }
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleImportIterationFromGithub(db, deps, body.value);
  }

  if (pathname === "/api/github/webhook") {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return iterationDepsUnavailable();
    }
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const event = req.headers.get("x-github-event") ?? "";
    const deliveryId = req.headers.get("x-github-delivery") ?? "";
    const limited = await readBodyWithCap(req, WEBHOOK_BODY_MAX_BYTES);
    if (limited.error) return limited.error;
    return handleGithubWebhook(db, deps, limited.text, {
      signature,
      event,
      deliveryId,
    });
  }

  if (pathname === "/api/iterations") {
    if (req.method === "GET") {
      return handleListIterations(db, url);
    }
    if (req.method === "POST") {
      if (!deps) {
        return iterationDepsUnavailable();
      }
      const body = await parseJsonBody(req);
      if (body.error) return body.error;
      return handleCreateIteration(db, deps, body.value);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  const detachTaskMatch =
    /^\/api\/iterations\/([^/]+)\/tasks\/([^/]+)$/.exec(pathname);
  if (detachTaskMatch) {
    if (req.method !== "DELETE") {
      return methodNotAllowed(["DELETE"]);
    }
    if (!deps) {
      return iterationDepsUnavailable();
    }
    const iterationId = decodeURIComponent(detachTaskMatch[1] ?? "");
    const taskId = decodeURIComponent(detachTaskMatch[2] ?? "");
    return handleDetachTaskFromIteration(db, deps, iterationId, taskId);
  }

  const attachTaskMatch =
    /^\/api\/iterations\/([^/]+)\/tasks$/.exec(pathname);
  if (attachTaskMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return iterationDepsUnavailable();
    }
    const iterationId = decodeURIComponent(attachTaskMatch[1] ?? "");
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return handleAttachTaskToIteration(db, deps, iterationId, body.value);
  }

  const iterationByIdMatch = /^\/api\/iterations\/([^/]+)$/.exec(pathname);
  if (iterationByIdMatch) {
    const iterationId = decodeURIComponent(iterationByIdMatch[1] ?? "");
    if (req.method === "GET") {
      return handleGetIteration(db, iterationId);
    }
    if (req.method === "PATCH") {
      if (!deps) {
        return iterationDepsUnavailable();
      }
      const body = await parseJsonBody(req);
      if (body.error) return body.error;
      return handlePatchIteration(db, deps, iterationId, body.value);
    }
    return methodNotAllowed(["GET", "PATCH"]);
  }

  if (pathname === "/api/inbox") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleListInbox(db, url);
  }

  if (pathname === "/api/metrics/fleet") {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    return handleGetFleetMetrics(db, url);
  }

  const metricsAssignmentMatch =
    /^\/api\/metrics\/assignment\/([^/]+)$/.exec(pathname);
  if (metricsAssignmentMatch) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const captured = metricsAssignmentMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    return handleGetAssignmentMetrics(db, assignmentId);
  }

  if (pathname === "/api/sessions") {
    return postJsonWithSessionDeps(req, deps, (d, body) => handleCreateSession(db, d, body));
  }

  const eventsMatch = /^\/api\/assignments\/([^/]+)\/events$/.exec(pathname);
  if (eventsMatch) {
    if (req.method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    const captured = eventsMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    return handleListEvents(db, assignmentId, url);
  }

  const assignmentActionMatch =
    /^\/api\/assignments\/([^/]+)\/(requeue|abandon|handoff)$/.exec(pathname);
  if (assignmentActionMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return sessionDepsUnavailable();
    }
    const captured = assignmentActionMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    const action = assignmentActionMatch[2] as AssignmentAction;
    const body = await parseJsonBody(req);
    if (body.error) return body.error;
    return ASSIGNMENT_ACTION_HANDLERS[action](db, deps, assignmentId, body.value);
  }

  const inputMatch = /^\/api\/assignments\/([^/]+)\/input$/.exec(pathname);
  if (inputMatch) {
    if (req.method !== "POST") {
      return methodNotAllowed(["POST"]);
    }
    if (!deps) {
      return sessionDepsUnavailable();
    }
    const captured = inputMatch[1];
    if (!captured) return new Response("Not Found", { status: 404 });
    const assignmentId = decodeURIComponent(captured);
    const body = await parseJsonBody(req, { maxBytes: IMAGE_BODY_MAX_BYTES });
    if (body.error) return body.error;
    return handleSendInput(db, deps, assignmentId, body.value);
  }

  return new Response("Not Found", { status: 404 });
}

type AssignmentAction = "requeue" | "abandon" | "handoff";

const ASSIGNMENT_ACTION_HANDLERS: Record<
  AssignmentAction,
  (db: Database, deps: ApiDeps, assignmentId: string, rawBody: unknown) => Response | Promise<Response>
> = {
  requeue: handleRequeueAssignment,
  abandon: handleAbandonAssignment,
  handoff: handleHandoffAssignment,
};

function methodNotAllowed(allow: string[]): Response {
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: {
      "content-type": "application/json",
      allow: allow.join(", "),
    },
  });
}

async function postJsonWithSessionDeps(
  req: Request,
  deps: ApiDeps | null,
  handle: (deps: ApiDeps, body: unknown) => Promise<Response>,
): Promise<Response> {
  if (req.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  if (!deps) {
    return sessionDepsUnavailable();
  }
  const body = await parseJsonBody(req);
  if (body.error) return body.error;
  return handle(deps, body.value);
}

function sessionDepsUnavailable(): Response {
  return jsonError("REST session endpoints are unavailable (no ProcessManager configured)", 503);
}

function iterationDepsUnavailable(): Response {
  return jsonError("REST iteration mutation endpoints are unavailable (no ProcessManager configured)", 503);
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MAX_JSON_BODY_BYTES = 128 * 1024;

async function parseJsonBody(
  req: Request,
  opts?: { maxBytes?: number }
): Promise<{ value: unknown; error?: undefined } | { value?: undefined; error: Response }> {
  const cap =
    opts && typeof opts.maxBytes === "number" && opts.maxBytes > 0
      ? opts.maxBytes
      : MAX_JSON_BODY_BYTES;
  const advertised = req.headers.get("content-length");
  if (advertised !== null) {
    const n = Number(advertised);
    if (Number.isFinite(n) && n > cap) {
      return { error: jsonError("Request body exceeds the size limit.", 413) };
    }
  }
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > cap) {
    return { error: jsonError("Request body exceeds the size limit.", 413) };
  }
  if (text.length === 0) {
    return { value: null };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (_err) {
    return { error: jsonError("Invalid JSON body", 400) };
  }
}

const WEBHOOK_BODY_MAX_BYTES = 1 * 1024 * 1024;

async function readBodyWithCap(
  req: Request,
  cap: number
): Promise<{ text: string; error?: undefined } | { text?: undefined; error: Response }> {
  const advertised = req.headers.get("content-length");
  if (advertised !== null) {
    const n = Number(advertised);
    if (Number.isFinite(n) && n > cap) {
      return { error: jsonError("webhook body exceeds 1 MB cap", 413) };
    }
  }

  const stream = req.body;
  if (stream === null) {
    return { error: jsonError("missing request body", 400) };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return { error: jsonError("webhook body exceeds 1 MB cap", 413) };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf) };
  } catch (_err) {
    return { error: jsonError("invalid UTF-8 in request body", 400) };
  }
}
