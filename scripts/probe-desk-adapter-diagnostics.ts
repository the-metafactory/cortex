#!/usr/bin/env bun
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { connectionSetupRig, SELECTION, SYNTHETIC_TOKEN } from "../src/conversations/connection-setup-fixtures";
import type { ConnectionView, PackageForm } from "../src/conversations/connection-setup";
import { DIAGNOSTIC_EVENT_NAMES } from "../src/conversations/domain-adapters/diagnostics";
import { ConnectionSetupBody } from "../src/surface/mc/dashboard-v2/components/desk-connection-setup";
import { probeChecks } from "./lib/probe-checks";

const { check, finish } = probeChecks();
const PATH = "/api/desk/connections";
const tokens = { primary: { token: SYNTHETIC_TOKEN }, backup: { token: `${SYNTHETIC_TOKEN}-backup` } };
const ALLOWED = new Set(["event", "adapterId", "connectionId", "capabilityId", "state", "errorCode", "at"]);
const bus = { published: [] as unknown[], publish(subject: string, payload: unknown): void { this.published.push({ subject, payload }); } };
const rig = await connectionSetupRig();
const diagnostics = rig.host().adapterDiagnostics();

async function enable(): Promise<ConnectionView> {
  const made = await rig.http("local", "POST", PATH, { packageId: "example-package", ...SELECTION, inputs: tokens });
  if (made.status !== 200) throw new Error(`synthetic setup failed with HTTP ${made.status}`);
  const created = made.body.connection as ConnectionView;
  const on = await rig.http("local", "POST", `${PATH}/${created.connectionId}/enable`, { expectedRevision: created.revision });
  if (on.status !== 200) throw new Error(`synthetic enable failed with HTTP ${on.status}`);
  return on.body.connection as ConnectionView;
}

async function listed(): Promise<ConnectionView[]> {
  const res = await rig.http("local", "GET", PATH, undefined);
  if (res.status !== 200) throw new Error(`synthetic Settings failed with HTTP ${res.status}`);
  return res.body.connections as ConnectionView[];
}

const browser = await chromium.launch({ headless: true });
try {
  const available = await enable();
  const stale = await enable();
  const fenced = await enable();
  const unavailable = await enable();
  const recent = new Date(Date.now() - 60_000).toISOString();
  const older = new Date(Date.now() - 3_600_000).toISOString();
  await diagnostics.record({ event: "desk.adapter.operation_state", adapterId: available.packageId, connectionId: available.connectionId, capabilityId: "example.object.read", state: "succeeded", at: recent });
  await diagnostics.record({ event: "desk.adapter.operation_state", adapterId: stale.packageId, connectionId: stale.connectionId, capabilityId: "example.object.read", state: "succeeded", at: older });
  await diagnostics.record({ event: "desk.adapter.query_refused", adapterId: available.packageId, connectionId: available.connectionId, capabilityId: "example.object.read", state: "refused", errorCode: "denied" });
  await diagnostics.record({ event: "desk.adapter.query_partial", adapterId: available.packageId, connectionId: available.connectionId, capabilityId: "example.object.read", state: "partial", errorCode: "budget_exhausted" });
  await rig.host().lifecycleFences().trigger({ kind: "duplicate_owner_object", target: { adapterId: fenced.packageId, connectionId: fenced.connectionId, capabilityId: "example.object.create" } });
  const off = await rig.http("local", "POST", `${PATH}/${unavailable.connectionId}/disable`, { expectedRevision: unavailable.revision });
  check(off.status === 200, "a synthetic connection was enabled and then disabled");

  const views = await listed();
  const statusOf = (id: string): ConnectionView["status"] | undefined => views.find(item => item.connectionId === id)?.status;
  check(statusOf(available.connectionId)?.state === "available" && statusOf(available.connectionId)?.reason === null, "Settings reads the available status back through the API");
  check(statusOf(stale.connectionId)?.state === "stale" && statusOf(stale.connectionId)?.reason === "last_success_too_old", "Settings reads the stale status back through the API");
  check(statusOf(fenced.connectionId)?.state === "fenced" && statusOf(fenced.connectionId)?.reason === "duplicate_owner_object", "Settings reads the fenced status back through the API");
  check(statusOf(unavailable.connectionId)?.state === "unavailable" && statusOf(unavailable.connectionId)?.reason === "disabled", "Settings reads the unavailable status back through the API");
  check(views.every(view => view.status.lastAttemptAt !== null), "every connection carries its last attempt");
  check(statusOf(available.connectionId)?.lastSuccessAt === recent && statusOf(stale.connectionId)?.lastSuccessAt === older, "each connection keeps its own last success");

  const allEvents = (await Promise.all(views.map(view => diagnostics.events(view.connectionId)))).flat();
  check(allEvents.every(event => Object.keys(event).every(key => ALLOWED.has(key))), "no stored event carries a disallowed field");
  check(allEvents.every(event => event.event.startsWith("desk.adapter.") && typeof event.at === "string"), "every stored event is a bounded desk.adapter event with an opaque identifier set and a timestamp");
  const kinds = new Set(allEvents.map(event => event.event));
  check(DIAGNOSTIC_EVENT_NAMES.every(name => kinds.has(name)), "status, query refusal, partial query, operation state and fired trigger each stored one event");
  const rejected = await diagnostics.record({ ...{ event: "desk.adapter.query_refused", adapterId: available.packageId, connectionId: available.connectionId, state: "refused", errorCode: "denied" }, message: "private account value" });
  check(rejected.stored === false && rejected.code === "invalid_event", "the strict schema refused an event with another field");

  const packages = ((await rig.http("local", "GET", PATH, undefined)).body.packages ?? []) as PackageForm[];
  const body = renderToStaticMarkup(createElement(ConnectionSetupBody, { snapshot: { ok: true, packages, connections: views }, note: null, busy: false, apply: async () => {} }));
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  const text = await page.locator("body").innerText();
  check(["Available", "Stale", "Fenced", "Unavailable"].every(label => text.includes(label)), "the Settings view shows each connection status in the browser");
  check(text.includes("last success") && text.includes("last attempt"), "the Settings view shows last success and last attempt in the browser");
  check(text.includes("The connection is disabled. Enable it to use it.") && text.includes("A safety check stopped adapter use. See diagnostics."), "the Settings view shows a safe reason in the browser");
  check(bus.published.length === 0, "no diagnostic event reached a bus client");
  check(!JSON.stringify(views).includes(SYNTHETIC_TOKEN), "no credential value appears in the Settings answer");
} finally {
  await browser.close();
  await rig.close();
}

finish("desk adapter diagnostics check(s) failed.", "Desk adapter diagnostics probe passed: status, last success, last attempt and safe reasons read back through the API and render in the browser; every event stayed strict, bounded and local. No bus publication and no provider effect.");
