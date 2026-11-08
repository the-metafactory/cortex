import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventFixture, openJournalFixture, prepareOperationFixture, resultFixture } from "../src/conversations/domain-adapters/operations/fixtures";

const dir = await mkdtemp(join(tmpdir(), "desk-operation-journal-"));
let host: Awaited<ReturnType<typeof openJournalFixture>> | undefined;
try {
  host = await openJournalFixture(join(dir, "durable.sqlite"));
  const { approval, attempt } = await prepareOperationFixture(host.journal);
  const acceptance = resultFixture(approval, attempt);
  await host.journal.receive(approval.operationId, 2, acceptance, acceptance.reportedAt);
  await host.journal.receive(approval.operationId, 3, acceptance, acceptance.reportedAt);
  await host.close();
  host = await openJournalFixture(join(dir, "durable.sqlite"));
  const reopened = await host.journal.read(approval.operationId);
  assert.equal(reopened?.journal.state, "pending");
  assert.equal(reopened.journal.events.filter(entry => entry.event.kind === "owner-result").length, 1);
  assert.deepEqual(reopened.journal.events[2]?.event, { kind: "owner-result", response: acceptance });
  await host.journal.append(approval.operationId, 3, eventFixture(4, { kind: "wait-expired", attemptId: attempt.attemptId, reason: { code: "deadline_exceeded", message: "Synthetic wait expired." } }));
  const done = await host.journal.receive(approval.operationId, 4, resultFixture(approval, attempt, "succeeded"), acceptance.reportedAt);
  assert.equal(done.journal.state, "succeeded");
  assert.equal(done.outbox.length, 1);
  assert.equal(done.outbox[0]?.key, `${approval.operationId}:succeeded`);
  const duplicate = await host.journal.receive(approval.operationId, 5, resultFixture(approval, attempt, "succeeded"), acceptance.reportedAt);
  assert.equal(duplicate.journal.sequence, 5);
  assert.equal(duplicate.outbox.length, 1);
  console.log(`${approval.operationId}: pending survived reopen; late success=succeeded; acceptance events=1; outbox=1`);
} finally {
  if (host) await host.close();
  await rm(dir, { recursive: true, force: true });
}
