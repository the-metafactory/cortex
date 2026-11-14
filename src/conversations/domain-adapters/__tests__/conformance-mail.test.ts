import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskMailListing } from "../../../desk-sdk";
import { CONFORMANCE_CONNECTION_ID, runConformance, type MailConnectionBinding, type MailReadSource, type MailSourceListing } from "../../../desk-adapter-sdk/conformance";
import { openConformanceRig } from "../../../desk-adapter-sdk/conformance/rig";
import { DomainAdapterRegistry } from "../registry";
import type { TrustedConnector } from "../../authority";
import { conformanceDomain, writeConformancePackage } from "./fixtures/conformance-build";

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

    expect(report.status).toBe("refused");
    expect(seenListings().length).toBeGreaterThan(0);
    expect(seenListings().every(read => read === null)).toBe(true);
    expect(report.capabilities.find(item => item.probe === "query")).toMatchObject({ verdict: "refused", code: "invalid_query_page" });
  });

  test("a binding for another connection leaves the conformance connection unbound", async () => {
    const report = await runConformance(packageDir, { mail: fakeMail([binding({ connectionId: "connection-other" })]) });

    expect(report.status).toBe("refused");
    expect(seenListings().length).toBeGreaterThan(0);
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
