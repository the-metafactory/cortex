import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournalFixture } from "../operations/fixtures";
import type { StoredOperation } from "../operations/journal";
import { projectLegacyOperation, readOperationEvidence, UpgradeRequired } from "../operations/legacy";

export function expectLegacyReviewRequired(imported: StoredOperation) {
  expect(imported.journal.state).toBe("succeeded");
  expect(imported.retryBlocked).toBe(true);
  expect(() => projectLegacyOperation(imported)).toThrow(UpgradeRequired);
  return readOperationEvidence(imported);
}

export function journalStoreTestFixture() {
  const hosts: Awaited<ReturnType<typeof openJournalFixture>>[] = [];
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.close())); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  async function open(path?: string) {
    const dir = path ?? await mkdtemp(join(tmpdir(), "operation-journal-"));
    if (!path) dirs.push(dir);
    const host = await openJournalFixture(join(dir, "durable.sqlite"));
    hosts.push(host);
    return { ...host, dir };
  }
  return { hosts, open };
}
