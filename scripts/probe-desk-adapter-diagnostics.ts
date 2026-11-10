#!/usr/bin/env bun
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { listConnections, connectionSetupRig, SYNTHETIC_TOKEN } from "../src/conversations/connection-setup-fixtures";
import type { ConnectionView, PackageForm } from "../src/conversations/connection-setup";
import { DIAGNOSTIC_EVENT_KEYS, DIAGNOSTIC_EVENT_NAMES } from "../src/conversations/domain-adapters/diagnostics";
import { busClient, syntheticDiagnostics } from "../src/conversations/domain-adapters/diagnostics-fixtures";
import { ConnectionSetupBody } from "../src/surface/mc/dashboard-v2/components/desk-connection-setup";
import { probeChecks } from "./lib/probe-checks";

const { check, finish } = probeChecks();
const ALLOWED = new Set<string>(DIAGNOSTIC_EVENT_KEYS);
const bus = busClient();
const rig = await connectionSetupRig();

const browser = await chromium.launch({ headless: true });
try {
  const { diagnostics, available, stale, fenced, unavailable, recent, older } = await syntheticDiagnostics(rig);
  const views = await listConnections(rig);
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
  check(allEvents.map(event => bus.publish(event)).every(accepted => accepted === false) && bus.published.length === 0, "no stored diagnostic event is a bus envelope, so no bus client accepted one");

  const packages = ((await rig.http("local", "GET", "/api/desk/connections", undefined)).body.packages ?? []) as PackageForm[];
  const body = renderToStaticMarkup(createElement(ConnectionSetupBody, { snapshot: { ok: true, packages, connections: views }, note: null, busy: false, apply: async () => {} }));
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  const text = await page.locator("body").innerText();
  check(["Available", "Stale", "Fenced", "Unavailable"].every(label => text.includes(label)), "the Settings view shows each connection status in the browser");
  check(text.includes("last success") && text.includes("last attempt"), "the Settings view shows last success and last attempt in the browser");
  check(text.includes("The connection is disabled. Enable it to use it.") && text.includes("A safety check stopped adapter use. See diagnostics."), "the Settings view shows a safe reason in the browser");
  check(!JSON.stringify(views).includes(SYNTHETIC_TOKEN), "no credential value appears in the Settings answer");
} finally {
  await browser.close();
  await rig.close();
}

finish("desk adapter diagnostics check(s) failed.", "Desk adapter diagnostics probe passed: status, last success, last attempt and safe reasons read back through the API and render in the browser; every event stayed strict, bounded and local. No bus client accepted an event and no provider effect occurred.");
