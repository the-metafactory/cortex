// glossary-ignore: run
import { CONFORMANCE_CONNECTION_ID, DESK_ADAPTER_SDK_VERSION, runConformance, type ConformanceReport, type MailConnectionBinding, type MailReadSource } from "@the-metafactory/cortex/desk-adapter-conformance";

const LISTED_AT = Date.parse("2026-11-14T08:00:00.000Z");
const bind = (connectionId: string, sourceId: string, account: string): MailConnectionBinding => ({ adapterId: "tideway", connectionId, sourceId, account });
const mail: MailReadSource = {
  connections: () => [
    bind(CONFORMANCE_CONNECTION_ID, "source-fresh", "fresh@example.invalid"),
    bind("mail-fresh", "source-fresh", "fresh@example.invalid"),
    bind("mail-stale", "source-stale", "stale@example.invalid"),
  ],
  listings: () => [
    { id: "source-fresh", readAt: LISTED_AT, error: null, mail: [{ id: "<fresh-1@example.invalid>", account: "fresh@example.invalid", from: { address: "one@example.invalid" }, subject: "Fresh subject one", receivedAt: "2026-11-14T07:00:00.000Z", unread: true }] },
    { id: "source-stale", readAt: LISTED_AT, error: "provider_failure", mail: [{ id: "<stale-1@example.invalid>", account: "stale@example.invalid", from: { address: "kept@example.invalid" }, subject: "Kept subject", receivedAt: "2026-11-13T07:00:00.000Z", unread: false }] },
  ],
};
const capabilities: ConformanceReport = await runConformance(import.meta.dir, { mail });
console.log(JSON.stringify({ sdkVersion: DESK_ADAPTER_SDK_VERSION, capabilities }));
process.exit(capabilities.status === "conformant" && (capabilities.mailQueries ?? []).length > 0 ? 0 : 1);
