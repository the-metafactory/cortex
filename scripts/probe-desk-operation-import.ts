import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationUuid, studioRequestId } from "../src/conversations/conversation-ids";
import { graphMarker } from "../src/surface/mc/desk/graph-conversation-writer";
import { AT, openJournalFixture } from "../src/conversations/domain-adapters/operations/fixtures";
import { legacyContext, legacyFixture } from "../src/conversations/domain-adapters/operations/legacy-fixtures";
import { importLegacyOperation, readOperationEvidence } from "../src/conversations/domain-adapters/operations/legacy";

const dir = await mkdtemp(join(tmpdir(), "desk-operation-import-"));
const ids = (operationId: string) => [operationUuid(operationId), studioRequestId(operationId), graphMarker(operationId)];
let host: Awaited<ReturnType<typeof openJournalFixture>> | undefined;
try {
  for (const state of ["created", "running", "uncertain"] as const) {
    const path = join(dir, `${state}.sqlite`);
    host = await openJournalFixture(path);
    const source = legacyFixture(state);
    const before = JSON.stringify(source);
    const identity = ids(source.record.operationId);
    const imported = await importLegacyOperation(host.journal, source, legacyContext(source), AT);
    assert.deepEqual(await importLegacyOperation(host.journal, source, legacyContext(source), AT), imported);
    await host.close();
    host = await openJournalFixture(path);
    const stored = await host.journal.read(source.record.operationId);
    assert.deepEqual(stored, imported);
    const evidence = readOperationEvidence(stored);
    assert.equal(evidence.kind, "legacy");
    if (evidence.kind !== "legacy") throw new Error("Legacy evidence missing.");
    assert.equal(JSON.stringify(evidence.source), before);
    assert.deepEqual(ids(evidence.source.record.operationId), identity);
    assert.equal(evidence.retryAllowed, false);
    assert.equal(evidence.dispatchAllowed, false);
    assert.equal(stored?.retryBlocked, true);
    assert.equal(stored.journal.state, state === "created" ? "succeeded" : "uncertain");
    console.log(`Synthetic ${state}: preserved raw records, receipts and owner IDs; repeated import and reopen passed; dispatch=false; retry=false.`);
    await host.close();
    host = undefined;
  }
} finally {
  if (host) await host.close();
  await rm(dir, { recursive: true, force: true });
}
