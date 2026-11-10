import { z } from "zod";
import { CredentialSetupError } from "../../../common/config/desk-credential-broker";
import { ConnectionSetupError, type ConnectionSetupService } from "../../../conversations/connection-setup";
import { ObjectReferenceSchema } from "../../../conversations/domain-adapters/types";
import { fail, isStackPrincipal, notAllowed, reply } from "./conversations";
import { checkRebindGuard, enforceMutationAuth, type MutationGuardContext } from "./mutation-guard";

export const DESK_CONNECTIONS_PATH = "/api/desk/connections";
export type ConnectionSetupAccess = () => ConnectionSetupService | null;


const Input = z.union([z.object({ token: z.string().min(1).max(8192) }).strict(), z.object({ reference: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/) }).strict()]);
const Inputs = z.record(z.string().max(32), Input).optional();
const Scope = z.record(z.string().max(32), z.string().max(256));
const Configure = z.object({
  packageId: z.string().max(128), connectionId: z.uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  scope: Scope, readCapabilityIds: z.array(z.string().max(128)).max(64), writeCapabilityIds: z.array(z.string().max(128)).max(64),
  readDestinations: z.array(ObjectReferenceSchema).max(64), writeDestinations: z.array(ObjectReferenceSchema).max(64), inputs: Inputs,
}).strict();
const Resume = z.object({ expectedRevision: z.number().int().positive(), inputs: Inputs }).strict();
const Revision = z.object({ expectedRevision: z.number().int().positive() }).strict();
const ITEM = /^\/api\/desk\/connections\/([0-9a-f-]{36})\/(provision|enable|disable)$/;

const REFUSALS: Record<string, [number, string]> = {
  unauthenticated: [401, "Sign in as this stack's principal to set up connections."],
  cross_principal: [403, "That connection belongs to another principal."],
  unknown_package: [404, "That package is not registered on this stack."],
  unknown_connection: [404, "That connection is not set up on this stack."],
  stale_head: [409, "The connection changed since you loaded it. Reload and retry."],
  invalid_scope: [400, "The account or resource scope is not valid for this package."],
  invalid_capability: [400, "A selected capability is not offered by this package."],
  invalid_destination: [400, "A selected destination is not offered by this package, or a capability has no destination."],
  setup_incomplete: [409, "Finish credential setup before enabling this connection."],
  package_unavailable: [409, "This package cannot be enabled on this stack."],
  authority_changed: [409, "Connection authority changed during the request. Reload and retry."],
  invalid_input: [400, "The credential input is not valid for this package."],
  slot_collision: [400, "The credential input names a slot twice."],
  reference_not_authorized: [403, "That environment reference is not available to this principal."],
  setup_in_progress: [409, "Another setup for this connection is in progress."],
  unknown_setup: [404, "That package has no registered setup."],
  schema_changed: [409, "The package setup changed. Reload and retry."],
};

async function stackPrincipalOf(req: Request, guard: MutationGuardContext): Promise<string | Response> {
  const foreign = checkRebindGuard(req, guard);
  if (foreign) return foreign;
  const verified = await enforceMutationAuth(req, guard);
  if (verified instanceof Response) return verified;
  return isStackPrincipal(verified.principal, guard) ? verified.principal : fail(403, "Only this stack's principal can set up its connections.");
}

export async function handleDeskConnections(req: Request, url: URL, guard: MutationGuardContext, access: ConnectionSetupAccess | undefined): Promise<Response> {
  const who = await stackPrincipalOf(req, guard);
  if (who instanceof Response) return who;
  const service = access?.() ?? null;
  if (!service) return fail(503, "Connection setup is unavailable on this stack.");
  try {
    if (url.pathname === DESK_CONNECTIONS_PATH) {
      if (req.method === "GET") return reply(200, { ok: true, packages: await service.forms(who), connections: await service.list(who) });
      if (req.method !== "POST") return notAllowed("GET, POST");
      const parsed = Configure.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return fail(400, "The connection setup request is not valid.");
      const { inputs, connectionId, expectedRevision, ...rest } = parsed.data;
      return reply(200, { ok: true, connection: await service.configure(who, { ...rest, ...(connectionId ? { connectionId } : {}), ...(expectedRevision ? { expectedRevision } : {}), ...(inputs ? { inputs } : {}) }) });
    }
    const match = ITEM.exec(url.pathname);
    if (!match?.[1] || !match[2]) return fail(404, "Unknown connection setup route.");
    if (req.method !== "POST") return notAllowed("POST");
    const raw: unknown = await req.json().catch(() => null);
    if (match[2] === "provision") {
      const parsed = Resume.safeParse(raw);
      if (!parsed.success) return fail(400, "The connection setup request is not valid.");
      return reply(200, { ok: true, connection: await service.resume(who, match[1], parsed.data.expectedRevision, parsed.data.inputs) });
    }
    const parsed = Revision.safeParse(raw);
    if (!parsed.success) return fail(400, "The connection setup request is not valid.");
    const connection = match[2] === "enable" ? await service.enable(who, match[1], parsed.data.expectedRevision) : await service.disable(who, match[1], parsed.data.expectedRevision);
    return reply(200, { ok: true, connection });
  } catch (err) {
    if (err instanceof ConnectionSetupError || err instanceof CredentialSetupError) {
      const [status, message] = REFUSALS[err.code] ?? [400, "The connection setup request was refused."];
      return fail(status, message);
    }
    process.stderr.write("[desk-connections] unexpected setup failure\n");
    return fail(500, "Connection setup failed. Reload to see the current state.");
  }
}
