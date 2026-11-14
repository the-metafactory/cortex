import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskMailListing } from "../../../desk-sdk";
import { CONFORMANCE_CONNECTION_ID, formatReport, runConformance, runFailureScenarios, type ConformanceMailQuery, type ConformanceReport, type MailConnectionBinding, type MailReadSource, type MailSourceListing } from "../../../desk-adapter-sdk/conformance";
import { openConformanceRig } from "../../../desk-adapter-sdk/conformance/rig";
import { DomainAdapterRegistry } from "../registry";
import type { TrustedConnector } from "../../authority";
import { conformanceDomain, MAIL_PEER_CONNECTIONS, writeConformancePackage } from "./fixtures/conformance-build";

const ADAPTER = "tideway";
const SOURCE = "source-example";
const ACCOUNT = "account-example";
const LISTED_AT = Date.parse("2026-11-14T08:00:00.000Z");

const listing: MailSourceListing = {
  id: SOURCE, readAt: LISTED_AT, error: null,
  mail: [
    { id: "<one@example.test>", account: ACCOUNT, from: { address: "sender@example.test" }, subject: "Listed subject one", receivedAt: "2026-11-14T07:00:00.000Z", unread: true, firstParagraph: "Opening line." },
    { id: "<two@example.test>", account: "account-other", from: { address: "other@example.test" }, subject: "Subject under another account", receivedAt: "2026-11-14T07:30:00.000Z", unread: false },
  ],
};
const binding = (extra: Partial<MailConnectionBinding> = {}): MailConnectionBinding => ({ adapterId: ADAPTER, connectionId: CONFORMANCE_CONNECTION_ID, sourceId: SOURCE, account: ACCOUNT, ...extra });
const fakeMail = (bindings: MailConnectionBinding[]): MailReadSource => ({ connections: () => bindings, listings: () => [listing] });
const seenListings = (): (DeskMailListing | null)[] => (globalThis as { __conformanceMailListings?: (DeskMailListing | null)[] }).__conformanceMailListings ?? [];

function expectUnbound(report: ConformanceReport): void {
  expect(report.status).toBe("refused");
  expect(seenListings().length).toBeGreaterThan(0);
  expect(seenListings().every(read => read === null)).toBe(true);
  expect(report.capabilities.some(item => item.probe === "cloud-reader")).toBe(false);
}

let root = "";
let packageDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "conformance-mail-"));
  packageDir = writeConformancePackage(join(root, "mail-read"), conformanceDomain(ADAPTER), "mail-read").dir;
  Object.assign(globalThis, { __conformanceMailListings: [] });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a conformance run given a fake Mail source", () => {
  test("serves the connection's listed mail to the query and observation probes and reports them conformant", async () => {
    const report = await runConformance(packageDir, { mail: fakeMail([binding()]) });

    expect(report.status).toBe("conformant");
    const reads = report.capabilities.filter(item => item.probe === "query" || item.probe === "observation");
    expect(reads.map(item => item.probe).sort()).toEqual(["observation", "query"]);
    expect(reads.every(item => item.verdict === "conformant" && item.released > 0)).toBe(true);
    const seen = seenListings();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const read of seen) {
      expect(read?.connection).toEqual({ adapterId: ADAPTER, connectionId: CONFORMANCE_CONNECTION_ID });
      expect(read?.account).toBe(ACCOUNT);
      expect(read?.health).toEqual({ state: "fresh", listedAt: new Date(LISTED_AT).toISOString() });
      expect(read?.mail.map(mail => mail.subject)).toEqual(["Listed subject one"]);
    }
    expect(report.networkRequests).toBe(0);
  });

  test("without a fake Mail source the package reads no mail and its reads are refused", async () => {
    const report = await runConformance(packageDir);

    expectUnbound(report);
    expect(report.capabilities.find(item => item.probe === "query")).toMatchObject({ verdict: "refused", code: "invalid_query_page" });
    expect(report.mailQueries).toBeUndefined();
  });

  test("a binding for another connection leaves the conformance connection unbound and is read on its own", async () => {
    const report = await runConformance(packageDir, { mail: fakeMail([binding({ connectionId: "connection-other" })]) });

    expect(report.status).toBe("refused");
    expect(report.capabilities.find(item => item.probe === "query")).toMatchObject({ verdict: "refused", code: "invalid_query_page" });
    expect(report.capabilities.some(item => item.probe === "cloud-reader")).toBe(false);
    expect(seenListings().filter(read => read === null).length).toBeGreaterThan(0);
    expect(report.mailQueries?.map(query => [query.connectionId, query.verdict])).toEqual([["connection-other", "conformant"]]);
  });
});

describe("a cloud reader in a conformance run with a fake Mail source", () => {
  test("is denied a connection with no explicit policy, with no group or count, and the package is not called", async () => {
    const report = await runConformance(packageDir, { mail: fakeMail([binding()]) });

    const cloud = report.capabilities.filter(item => item.probe === "cloud-reader");
    expect(cloud).toEqual([{ capabilityId: "tideway.gauge.search", probe: "cloud-reader", verdict: "conformant", released: 0, detail: expect.stringContaining("denied") }]);
    expect(report.status).toBe("conformant");
  });

  test("is released a connection whose policy says cloud", async () => {
    const report = await runConformance(packageDir, { mail: fakeMail([binding({ dataPolicy: "cloud" })]) });

    const [cloud] = report.capabilities.filter(item => item.probe === "cloud-reader");
    expect(cloud).toMatchObject({ verdict: "conformant" });
    expect(cloud?.released).toBeGreaterThan(0);
  });
});

describe("the failure scenarios given a fake Mail source", () => {
  test("serve the connection's listed mail, so a Mail read adapter's companion run is conformant and every scenario isolated", async () => {
    const report = await runFailureScenarios(packageDir, { mail: fakeMail([binding()]) });

    expect(report.companion).toMatchObject({ adapterId: ADAPTER, status: "conformant" });
    expect(report.status).toBe("isolated");
    expect(seenListings().length).toBeGreaterThan(0);
    expect(seenListings().every(read => read?.account === ACCOUNT && read.mail.map(mail => mail.subject).join() === "Listed subject one")).toBe(true);
    expect(report.networkRequests).toBe(0);
  });

  test("without a Mail source read no mail, as before, and the companion run is refused", async () => {
    const report = await runFailureScenarios(packageDir);

    expect(report.companion).toMatchObject({ adapterId: ADAPTER, status: "refused" });
    expect(report.status).toBe("failed");
    expect(seenListings().every(read => read === null)).toBe(true);
  });

  test("still accepts the temporary directory as the second argument", async () => {
    const tempParent = mkdtempSync(join(root, "temp-"));
    const report = await runConformance(packageDir, tempParent);

    expect(report.packageDir).toBe(packageDir);
    expect(report.networkRequests).toBe(0);
  });
});

describe("the read restriction a conformance run publishes for a Mail connection", () => {
  const destination = { adapterId: ADAPTER, connectionId: CONFORMANCE_CONNECTION_ID, objectType: "estuary", canonicalId: "estuary-inner" };
  const connector = {
    writerOwner: "conformance-owner",
    authorizeConnection: () => Promise.resolve({ version: 1, available: true, revision: "conformance-credential-1" }),
    dispatch: () => Promise.reject(new Error("The restriction check dispatches nothing.")),
    support: { lifecycleVersion: "1.0.0", adapterId: ADAPTER, connectionId: CONFORMANCE_CONNECTION_ID, capabilityId: "conformance-writer", declarationId: "conformance-declaration", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" },
  } as unknown as TrustedConnector;

  async function publishedEgress(mailBinding?: MailConnectionBinding): Promise<string[]> {
    const rig = await openConformanceRig({
      dir: root, registry: new DomainAdapterRegistry(), connector, adapterId: ADAPTER, connectionId: CONFORMANCE_CONNECTION_ID, readBindings: [], readCapabilityIds: [],
      writeCapabilityIds: [], writerCapabilityId: "conformance-writer", destinations: [destination], ...(mailBinding ? { mailBinding } : {}),
    });
    try {
      const state = await rig.service.inspectHostRecords();
      return Object.values(state.records).flatMap(records => records.flatMap(record => (record.kind === "restriction" ? [record.value.egress] : [])));
    } finally {
      await rig.close();
    }
  }

  test("is local for a Mail connection with no explicit policy, cloud when it says cloud, and cloud for a run without Mail", async () => {
    expect(await publishedEgress(binding())).toEqual(["local"]);
    expect(await publishedEgress(binding({ dataPolicy: "cloud" }))).toEqual(["cloud"]);
    expect(await publishedEgress()).toEqual(["cloud"]);
  });
});

describe("a conformance run whose Mail source binds several connections", () => {
  const [FRESH, STALE] = MAIL_PEER_CONNECTIONS;
  const SEARCH = `${ADAPTER}.gauge.search`;
  const FRESH_SOURCE = "source-fresh";
  const STALE_SOURCE = "source-stale";
  const freshListing: MailSourceListing = {
    id: FRESH_SOURCE, readAt: LISTED_AT, error: null,
    mail: [
      { id: "<fresh-1@example.invalid>", account: "fresh@example.invalid", from: { name: "Sender One", address: "one@example.invalid" }, subject: "Fresh subject one", receivedAt: "2026-11-14T07:00:00.000Z", unread: true, firstParagraph: "Opening line.\n\nSecond paragraph." },
      { id: "<fresh-2@example.invalid>", account: "fresh@example.invalid", from: { address: "two@example.invalid" }, subject: "Fresh subject two", receivedAt: "2026-11-14T07:10:00.000Z", unread: false },
      { id: "<fresh-3@example.invalid>", account: "fresh@example.invalid", from: { address: "three@example.invalid" }, subject: "Fresh subject three", receivedAt: "2026-11-14T07:20:00.000Z", unread: true },
      { id: "<other@example.invalid>", account: "other@example.invalid", from: { address: "other@example.invalid" }, subject: "Under another account", receivedAt: "2026-11-14T07:30:00.000Z", unread: true },
    ],
  };
  const staleListing: MailSourceListing = {
    id: STALE_SOURCE, readAt: LISTED_AT, error: "provider_failure",
    mail: [{ id: "<stale-1@example.invalid>", account: "stale@example.invalid", from: { address: "kept@example.invalid" }, subject: "Kept subject", receivedAt: "2026-11-13T07:00:00.000Z", unread: false }],
  };
  const fresh = binding({ connectionId: FRESH, sourceId: FRESH_SOURCE, account: "fresh@example.invalid" });
  const stale = binding({ connectionId: STALE, sourceId: STALE_SOURCE, account: "stale@example.invalid", dataPolicy: "cloud" });
  const source = (bindings: MailConnectionBinding[], listings: MailSourceListing[] = [freshListing, staleListing]): MailReadSource => ({ connections: () => bindings, listings: () => listings });
  const searchOn = (queries: ConformanceMailQuery[] | undefined, connectionId: string) => queries?.find(query => query.connectionId === connectionId && query.capabilityId === SEARCH);
  const names = (query: ConformanceMailQuery | undefined) => (query?.objects ?? []).map(object => (object as { name: string }).name);
  const notes = (query: ConformanceMailQuery | undefined) => (query?.objects ?? []).map(object => (object as { note: string }).note);

  test("reads each bound connection's queries through the host query runner and reports what they answered", async () => {
    const report = await runConformance(packageDir, { mail: source([fresh, stale]) });

    const onFresh = searchOn(report.mailQueries, FRESH);
    expect(onFresh).toMatchObject({ verdict: "conformant", dataPolicy: "local" });
    expect(onFresh?.released).toBe(2);
    expect(names(onFresh)).toEqual(["Fresh subject one", "Fresh subject two", "Fresh subject three"]);
    expect(notes(onFresh)).toEqual(Array(3).fill("account fresh@example.invalid; fresh; peer read mail_read_unadmitted"));

    const onStale = searchOn(report.mailQueries, STALE);
    expect(onStale).toMatchObject({ verdict: "conformant", dataPolicy: "cloud" });
    expect(names(onStale)).toEqual(["Kept subject"]);
    expect(notes(onStale)).toEqual(["account stale@example.invalid; stale provider_failure; peer read mail_read_unadmitted"]);

    const read = seenListings().filter(listing => listing !== null);
    expect(read.find(listing => listing.connection.connectionId === FRESH)?.mail[0]).toMatchObject({ ref: { connection: FRESH, messageId: "<fresh-1@example.invalid>" }, account: "fresh@example.invalid", firstParagraph: "Opening line." });
    expect(read.find(listing => listing.connection.connectionId === STALE)?.health).toEqual({ state: "stale", code: "provider_failure" });
    expect(formatReport(report)).toContain(`${SEARCH} on ${FRESH}`);
    expect(report.networkRequests).toBe(0);
  });

  test("serves null to the unbound conformance connection, whose standard probes refuse the run", async () => {
    const report = await runConformance(packageDir, { mail: source([fresh, stale]) });

    expect(seenListings()).toContain(null);
    expect(report.capabilities.find(item => item.probe === "query")).toMatchObject({ verdict: "refused", code: "invalid_query_page" });
    expect(report.status).toBe("refused");
    expect(report.mailQueries?.every(query => query.verdict === "conformant")).toBe(true);
  });

  test("with the conformance connection bound too, every connection is read and the run is conformant", async () => {
    const own = binding({ connectionId: CONFORMANCE_CONNECTION_ID, sourceId: FRESH_SOURCE, account: "fresh@example.invalid" });
    const report = await runConformance(packageDir, { mail: source([own, fresh, stale]) });

    expect(report.status).toBe("conformant");
    expect(seenListings()).not.toContain(null);
    expect(report.mailQueries?.map(query => query.connectionId)).toEqual([CONFORMANCE_CONNECTION_ID, FRESH, STALE]);
  });

  test("a source that has not listed yet reads stale with no mail", async () => {
    const report = await runConformance(packageDir, { mail: source([fresh], []) });

    expect(searchOn(report.mailQueries, FRESH)).toMatchObject({ verdict: "conformant", objects: [] });
    expect(seenListings().find(listing => listing?.connection.connectionId === FRESH)).toMatchObject({ health: { state: "stale", code: "not_listed" }, mail: [] });
  });

  test("a connection bound twice is not read, as the host serves it no mail", async () => {
    const report = await runConformance(packageDir, { mail: source([fresh, { ...fresh, account: "fresh-again@example.invalid" }, stale]) });

    expect(report.mailQueries?.map(query => query.connectionId)).toEqual([STALE]);
  });
});
