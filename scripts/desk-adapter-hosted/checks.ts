import { assetUrl, type AssetCatalogEntry } from "../../src/surface/mc/desk/adapter-assets";
import { ASSET_CONNECTION } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-asset-fixtures";
import type { ProbeChecks } from "../lib/probe-checks";
import type { SyntheticStack } from "./stack";

export type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

const ACCESS_REFUSALS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308, 401, 403]);
const MAKE_BODY = (stack: SyntheticStack, extra: object = {}) => ({ ...stack.drafts.makeInput, ...extra });

interface DraftView { view: { draft: { draftId: string; revision: number; fields: Record<string, { value: unknown }> } }; withheld?: unknown[] }
type Confirmation = { confirmation: { kind: string; operationId?: string; reason?: string } };

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

export async function runHostedChecks(stack: SyntheticStack, send: Send, sendWithoutToken: Send, { check }: ProbeChecks): Promise<void> {
  const before = stack.originHits;
  const refused = await sendWithoutToken("GET", "/api/desk/drafts");
  check(ACCESS_REFUSALS.has(refused.status) && stack.originHits === before, "Access refuses a request without the token before it reaches the stack");

  const targets = await send("GET", "/api/desk/drafts");
  check(targets.status === 200, "the authenticated route lists the drafting destinations");

  const made = await send("POST", "/api/desk/drafts", MAKE_BODY(stack));
  const draft = await json<DraftView>(made);
  const id = draft.view?.draft?.draftId ?? "";
  check(made.status === 200 && id !== "", "Make opens a draft through the authenticated route");

  const edited = await send("PATCH", `/api/desk/drafts/${encodeURIComponent(id)}`, { revision: draft.view.draft.revision, pointer: "/headline", change: { kind: "set", value: "Probe headline" } });
  const editedView = await json<DraftView>(edited);
  check(edited.status === 200 && editedView.view?.draft?.fields["/headline"]?.value === "Probe headline", "Edit saves the headline through the route");

  const approve = async () => json<Confirmation>(await send("POST", `/api/desk/drafts/${encodeURIComponent(id)}/confirm`, { revision: editedView.view.draft.revision }));
  const mutationsBefore = stack.drafts.owner.mutations;
  const first = await approve();
  const second = await approve();
  check(first.confirmation?.kind === "accepted" && JSON.stringify(first) === JSON.stringify(second) && stack.drafts.owner.mutations === mutationsBefore + 1, "Approve is accepted and a repeated Approve returns the same result without a second owner mutation");

  const admissions = stack.drafts.owner.admissions;
  stack.drafts.state.localOnly.add("turn-1");
  const reopened = await json<DraftView>(await send("POST", "/api/desk/drafts", MAKE_BODY(stack, { newDraft: true })));
  const deniedId = reopened.view?.draft?.draftId ?? "";
  const denied = await json<Confirmation>(await send("POST", `/api/desk/drafts/${encodeURIComponent(deniedId)}/confirm`, { revision: reopened.view?.draft?.revision }));
  check(denied.confirmation?.kind === "blocked" && stack.drafts.owner.admissions === admissions, "a denied destination is blocked and the owner is never called");

  const catalog = await json<{ adapters: AssetCatalogEntry[] }>(await send("GET", "/api/desk/adapters/catalog"));
  const entry = catalog.adapters?.[0];
  const current = entry ? await send("GET", assetUrl(entry.releaseDigest, ASSET_CONNECTION, entry.entry)) : undefined;
  check(current?.status === 200, "the catalog entry and its asset are served as one matched generation");
  const stale = await send("GET", assetUrl("f".repeat(64), ASSET_CONNECTION, entry?.entry ?? "app.js"));
  check(stale.status === 409 && (await json<{ recovery?: string }>(stale)).recovery === "refresh", "an asset of another generation is refused with refresh recovery");
}
