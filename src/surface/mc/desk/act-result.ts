import type { DeskPhrase } from "./phrases";

export const noStore = { "Cache-Control": "no-store" };

export interface ActWording {
  messagePhrase?: DeskPhrase;
  detail?: string;
}

export type ActOk = ActWording & { ok: true; message: string };
export type ActRefusal = ActWording & { ok: false; status: number; error: string };
export type ActResult = ActOk | ActRefusal;

const PHRASE_FOR_STATUS: Record<number, DeskPhrase> = {
  400: { code: "act.invalid" },
  403: { code: "act.forbidden" },
  404: { code: "act.unknown-target" },
  405: { code: "act.method" },
  409: { code: "act.closed-item" },
  422: { code: "act.invalid" },
  429: { code: "act.busy" },
  500: { code: "act.failed" },
  502: { code: "act.failed" },
  503: { code: "act.unavailable" },
  504: { code: "act.failed" },
};

export const phraseForStatus = (status: number): DeskPhrase => PHRASE_FOR_STATUS[status] ?? { code: "act.failed" };

export const wording = (messagePhrase: DeskPhrase, detail?: string): ActWording =>
  detail === undefined ? { messagePhrase } : { messagePhrase, detail };

export const refuse = (status: number, error: string, messagePhrase: DeskPhrase = phraseForStatus(status), detail?: string): ActRefusal =>
  ({ ok: false, status, error, ...wording(messagePhrase, detail) });

export const done = (message: string, messagePhrase: DeskPhrase = { code: "act.done" }, detail?: string): ActOk =>
  ({ ok: true, message, ...wording(messagePhrase, detail) });

export const failed = (status: number, error: string, detail: string, kind?: string): ActRefusal =>
  refuse(status, error, kind === undefined ? { code: "act.failed" } : { code: "act.failed", params: { kind } }, detail);

export const refused = (status: number, error: string, detail: string, kind?: string): ActRefusal =>
  refuse(status, error, kind === undefined ? { code: "act.refused" } : { code: "act.refused", params: { kind } }, detail);

export const fillWording = <T extends ActWording>(result: T): T & { messagePhrase: DeskPhrase } =>
  result.messagePhrase === undefined
    ? { ...result, messagePhrase: "status" in result && typeof result.status === "number" ? phraseForStatus(result.status) : { code: "act.done" } }
    : (result as T & { messagePhrase: DeskPhrase });

export const failResponse = (status: number, error: string, messagePhrase: DeskPhrase = phraseForStatus(status), detail?: string): Response =>
  Response.json({ ok: false, error, ...wording(messagePhrase, detail ?? (messagePhrase.code === "act.failed" ? error : undefined)) }, { status, headers: noStore });

export const answer = (result: ActResult): Response => {
  const filled = fillWording(result);
  return filled.ok
    ? Response.json(filled, { headers: noStore })
    : failResponse(filled.status, filled.error, filled.messagePhrase, filled.detail);
};

const ACT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Adds `messagePhrase` to a `/api/desk*` act answer whose route composed no code of its own. */
export async function withActPhrase(req: Request, pathname: string, response: Response): Promise<Response> {
  if (!pathname.startsWith("/api/desk") || !ACT_METHODS.has(req.method)) return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const body: unknown = await response.clone().json().catch((): null => null);
  if (typeof body !== "object" || body === null || Array.isArray(body) || "messagePhrase" in body) return response;
  const record = body as Record<string, unknown>;
  const composed = record.ok === true ? typeof record.message === "string" : record.ok === false && typeof record.error === "string";
  if (!composed) return response;
  const phrase = record.ok === true ? { code: "act.done" } : phraseForStatus(response.status);
  const detail = record.ok === false && phrase.code === "act.failed" && record.detail === undefined ? { detail: record.error } : {};
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ ...record, messagePhrase: phrase, ...detail }), { status: response.status, statusText: response.statusText, headers });
}
