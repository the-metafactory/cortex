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

async function send(path: string, init: RequestInit, fetchImpl: SetupFetch): Promise<{ status: number; body: unknown }> {
  const res = await fetchImpl(path, { ...init, credentials: "same-origin", cache: "no-store" });
  return { status: res.status, body: await res.json().catch(() => null) as unknown };
}

function failure(status: number, body: unknown): string {
  const parsed = Failure.safeParse(body);
  return parsed.success ? parsed.data.error : `Mission Control answered HTTP ${status} without a connection setup answer.`;
}

export async function requestSetup(fetchImpl: SetupFetch = fetch): Promise<SetupSnapshot> {
  try {
    const { status, body } = await send(BASE, { method: "GET" }, fetchImpl);
    const parsed = body as { ok?: boolean; packages?: PackageForm[]; connections?: ConnectionView[] } | null;
    if (status === 200 && parsed?.ok && parsed.packages && parsed.connections) return { ok: true, packages: parsed.packages, connections: parsed.connections };
    return { ok: false, error: failure(status, body) };
  } catch (err) {
    return { ok: false, error: `Connection setup is unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function post(path: string, payload: unknown, fetchImpl: SetupFetch): Promise<SetupOutcome> {
  try {
    const { status, body } = await send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, fetchImpl);
    const parsed = body as { ok?: boolean; connection?: ConnectionView } | null;
    if (status === 200 && parsed?.ok && parsed.connection) return { ok: true, connection: parsed.connection };
    return { ok: false, error: failure(status, body) };
  } catch (err) {
    return { ok: false, error: `Connection setup is unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const saveConnection = (submission: SetupSubmission, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(BASE, submission, fetchImpl);
export const retryConnection = (connectionId: string, expectedRevision: number, inputs: Record<string, SlotChoice>, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(`${BASE}/${connectionId}/provision`, { expectedRevision, inputs }, fetchImpl);
export const enableConnection = (connectionId: string, expectedRevision: number, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(`${BASE}/${connectionId}/enable`, { expectedRevision }, fetchImpl);
export const disableConnection = (connectionId: string, expectedRevision: number, fetchImpl: SetupFetch = fetch): Promise<SetupOutcome> => post(`${BASE}/${connectionId}/disable`, { expectedRevision }, fetchImpl);
