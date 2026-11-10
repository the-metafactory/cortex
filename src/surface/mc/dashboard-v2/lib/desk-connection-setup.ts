import { z } from "zod";
import type { ConnectionView, PackageForm } from "../../../../conversations/connection-setup";

export type { ConnectionView, PackageForm };
export type SlotChoice = { token: string } | { reference: string };
export interface SetupSubmission {
  packageId: string;
  connectionId?: string;
  expectedRevision?: number;
  scope: Record<string, string>;
  readCapabilityIds: string[];
  writeCapabilityIds: string[];
  readDestinations: PackageForm["destinations"][number]["ref"][];
  writeDestinations: PackageForm["destinations"][number]["ref"][];
  inputs: Record<string, SlotChoice>;
}
export type SetupFetch = (input: string, init: RequestInit) => Promise<Response>;
export type SetupSnapshot = { ok: true; packages: PackageForm[]; connections: ConnectionView[] } | { ok: false; error: string };
export type SetupOutcome = { ok: true; connection: ConnectionView } | { ok: false; error: string };

const Failure = z.object({ error: z.string() });
const BASE = "/api/desk/connections";
type Answer = { status: number; body: unknown } | string;

async function call(path: string, init: RequestInit, fetchImpl: SetupFetch): Promise<Answer> {
  try {
    const res = await fetchImpl(path, { ...init, credentials: "same-origin", cache: "no-store" });
    return { status: res.status, body: await res.json().catch(() => null) as unknown };
  } catch (err) {
    return `Connection setup is unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function refusal(answer: { status: number; body: unknown }): { ok: false; error: string } {
  const parsed = Failure.safeParse(answer.body);
  return { ok: false, error: parsed.success ? parsed.data.error : `Mission Control answered HTTP ${answer.status} without a connection setup answer.` };
}

export async function requestSetup(fetchImpl: SetupFetch = fetch): Promise<SetupSnapshot> {
  const answer = await call(BASE, { method: "GET" }, fetchImpl);
  if (typeof answer === "string") return { ok: false, error: answer };
  const parsed = answer.body as { ok?: boolean; packages?: PackageForm[]; connections?: ConnectionView[] } | null;
  if (answer.status === 200 && parsed?.ok && parsed.packages && parsed.connections) return { ok: true, packages: parsed.packages, connections: parsed.connections };
  return refusal(answer);
}

async function post(path: string, payload: unknown, fetchImpl: SetupFetch): Promise<SetupOutcome> {
  const answer = await call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, fetchImpl);
  if (typeof answer === "string") return { ok: false, error: answer };
  const parsed = answer.body as { ok?: boolean; connection?: ConnectionView } | null;
  if (answer.status === 200 && parsed?.ok && parsed.connection) return { ok: true, connection: parsed.connection };
  return refusal(answer);
}

export const saveConnection = (submission: SetupSubmission, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(BASE, submission, fetchImpl);
export const retryConnection = (connectionId: string, expectedRevision: number, inputs: Record<string, SlotChoice>, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(`${BASE}/${connectionId}/provision`, { expectedRevision, inputs }, fetchImpl);
export const enableConnection = (connectionId: string, expectedRevision: number, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(`${BASE}/${connectionId}/enable`, { expectedRevision }, fetchImpl);
export const disableConnection = (connectionId: string, expectedRevision: number, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(`${BASE}/${connectionId}/disable`, { expectedRevision }, fetchImpl);
