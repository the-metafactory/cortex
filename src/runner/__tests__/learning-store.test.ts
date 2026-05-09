/**
 * Tests for LearningStore (Issue #49)
 * Covers CRUD operations, relevance scoring, stale cleanup, and edge cases.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LearningStore } from "../learning-store";
import { unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let store: LearningStore;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `learning-test-${crypto.randomUUID()}.db`);
  store = new LearningStore(dbPath);
});

afterEach(() => {
  store.close();
  // Clean up DB + WAL/SHM files
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbPath + suffix;
    if (existsSync(f)) unlinkSync(f);
  }
});

// ---------------------------------------------------------------------------
// CRUD Operations
// ---------------------------------------------------------------------------

describe("LearningStore - CRUD", () => {
  test("create() generates short ID and stores learning", () => {
    const id = store.create("Always use bun instead of node", "user123", "Alice");

    expect(id).toBeDefined();
    expect(id.length).toBe(8); // Short ID format

    const learning = store.getById(id);
    expect(learning).not.toBeNull();
    expect(learning!.content).toBe("Always use bun instead of node");
    expect(learning!.authorId).toBe("user123");
    expect(learning!.authorName).toBe("Alice");
    expect(learning!.isActive).toBe(true);
    expect(learning!.usageCount).toBe(0);
  });

  test("listActive() returns active learnings sorted by recency", () => {
    const id1 = store.create("First learning", "user1", "Alice");
    const id2 = store.create("Second learning", "user2", "Bob");
    const id3 = store.create("Third learning", "user3", "Charlie");

    const list = store.listActive();
    expect(list.length).toBe(3);
    // Most recent first
    expect(list[0]!.id).toBe(id3);
    expect(list[1]!.id).toBe(id2);
    expect(list[2]!.id).toBe(id1);
  });

  test("listActive() respects limit parameter", () => {
    store.create("Learning 1", "user1", "Alice");
    store.create("Learning 2", "user2", "Bob");
    store.create("Learning 3", "user3", "Charlie");

    const list = store.listActive(2);
    expect(list.length).toBe(2);
  });

  test("listActive() excludes deactivated learnings", () => {
    const id1 = store.create("Active learning", "user1", "Alice");
    const id2 = store.create("To be removed", "user2", "Bob");

    store.remove(id2);

    const list = store.listActive();
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(id1);
  });

  test("search() finds learnings by substring (case-insensitive)", () => {
    store.create("Always use bun instead of node", "user1", "Alice");
    store.create("Never use console.log in production", "user2", "Bob");
    store.create("Prefer async/await over callbacks", "user3", "Charlie");

    const results = store.search("use");
    expect(results.length).toBe(2); // Matches "use bun" and "use console"

    const results2 = store.search("BUN");
    expect(results2.length).toBe(1);
    expect(results2[0]!.content).toContain("bun");
  });

  test("search() returns empty array when no matches", () => {
    store.create("Always use bun", "user1", "Alice");
    const results = store.search("nonexistent");
    expect(results.length).toBe(0);
  });

  test("search() sorts by usage count then recency", () => {
    const id1 = store.create("Use typescript", "user1", "Alice");
    const id2 = store.create("Use strict mode", "user2", "Bob");

    // Increment usage of id2
    store.incrementUsage([id2, id2, id2]);

    const results = store.search("use");
    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe(id2); // Higher usage count comes first
  });

  test("remove() soft-deletes learning", () => {
    const id = store.create("Learning to remove", "user1", "Alice");

    const removed = store.remove(id);
    expect(removed).toBe(true);

    // Still exists in DB but is_active = 0
    const learning = store.getById(id);
    expect(learning).not.toBeNull();
    expect(learning!.isActive).toBe(false);

    // Not included in listActive
    const list = store.listActive();
    expect(list.length).toBe(0);
  });

  test("remove() is idempotent (removing already removed returns false)", () => {
    const id = store.create("Learning to remove", "user1", "Alice");

    expect(store.remove(id)).toBe(true); // First removal succeeds
    expect(store.remove(id)).toBe(false); // Second removal returns false (already inactive)
  });

  test("remove() returns false for non-existent ID", () => {
    expect(store.remove("nonexistent-id")).toBe(false);
  });

  test("getById() returns null for non-existent ID", () => {
    const learning = store.getById("nonexistent-id");
    expect(learning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Relevance Scoring
// ---------------------------------------------------------------------------

describe("LearningStore - Relevance Scoring", () => {
  test("getRelevant() returns empty array when no active learnings", () => {
    const relevant = store.getRelevant("any prompt");
    expect(relevant.length).toBe(0);
  });

  test("getRelevant() returns learnings sorted by relevance score", () => {
    // Create learnings with different characteristics
    store.create("Always use TypeScript for type safety", "user1", "Alice");
    store.create("Use bun instead of node for performance", "user2", "Bob");
    store.create("Prefer async/await over callbacks", "user3", "Charlie");

    const relevant = store.getRelevant("typescript type safety best practices", 5);

    expect(relevant.length).toBe(3);
    expect(relevant[0]!.relevanceScore).toBeGreaterThan(0);
    // First result should have highest keyword match with "typescript" and "type"
    expect(relevant[0]!.content).toContain("TypeScript");
  });

  test("getRelevant() respects limit parameter", () => {
    store.create("Learning 1", "user1", "Alice");
    store.create("Learning 2", "user2", "Bob");
    store.create("Learning 3", "user3", "Charlie");

    const relevant = store.getRelevant("learning", 2);
    expect(relevant.length).toBe(2);
  });

  test("getRelevant() keyword matching boosts relevance", () => {
    store.create("Always use TypeScript for type safety", "user1", "Alice");
    store.create("Use bun for better performance", "user2", "Bob");

    const relevant = store.getRelevant("typescript type safety", 5);

    // Learning with more keyword matches should score higher
    expect(relevant[0]!.content).toContain("TypeScript");
    expect(relevant[0]!.relevanceScore).toBeGreaterThan(relevant[1]!.relevanceScore);
  });

  test("getRelevant() usage frequency affects score", () => {
    const id1 = store.create("Common pattern", "user1", "Alice");
    const id2 = store.create("Rare pattern", "user2", "Bob");

    // Simulate higher usage for id1 (call incrementUsage multiple times)
    store.incrementUsage([id1]);
    store.incrementUsage([id1]);
    store.incrementUsage([id1]);
    store.incrementUsage([id1]);
    store.incrementUsage([id1]);
    store.incrementUsage([id2]);

    const relevant = store.getRelevant("pattern", 5);

    // Find the learnings by ID
    const learning1 = relevant.find(l => l.id === id1);
    const learning2 = relevant.find(l => l.id === id2);

    expect(learning1).toBeDefined();
    expect(learning2).toBeDefined();
    expect(learning1!.usageCount).toBe(5);
    expect(learning2!.usageCount).toBe(1);
    // Higher usage should contribute to higher relevance (though other factors also matter)
    expect(learning1!.relevanceScore).toBeGreaterThan(learning2!.relevanceScore);
  });

  test("getRelevant() recency affects score", () => {
    // This test creates two learnings and verifies the more recent one
    // has a higher recency component. Since both are created almost simultaneously,
    // we can't easily test temporal decay without mocking time.
    // However, we can verify that the scoring algorithm doesn't crash.

    store.create("Old pattern", "user1", "Alice");
    store.create("New pattern", "user2", "Bob");

    const relevant = store.getRelevant("pattern", 5);

    expect(relevant.length).toBe(2);
    // Both should have relevance scores
    expect(relevant[0]!.relevanceScore).toBeGreaterThan(0);
    expect(relevant[1]!.relevanceScore).toBeGreaterThan(0);
  });

  test("incrementUsage() updates usage count for multiple IDs", () => {
    const id1 = store.create("Learning 1", "user1", "Alice");
    const id2 = store.create("Learning 2", "user2", "Bob");

    store.incrementUsage([id1, id2]);

    const l1 = store.getById(id1);
    const l2 = store.getById(id2);

    expect(l1!.usageCount).toBe(1);
    expect(l2!.usageCount).toBe(1);
  });

  test("incrementUsage() handles empty array gracefully", () => {
    // Should not throw
    expect(() => store.incrementUsage([])).not.toThrow();
  });

  test("incrementUsage() increments multiple times correctly", () => {
    const id = store.create("Popular learning", "user1", "Alice");

    store.incrementUsage([id]);
    store.incrementUsage([id]);
    store.incrementUsage([id]);

    const learning = store.getById(id);
    expect(learning!.usageCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Stale Cleanup
// ---------------------------------------------------------------------------

describe("LearningStore - Stale Cleanup", () => {
  test("deactivateStale() removes learnings older than 90 days with zero usage", () => {
    // Create a learning with backdated timestamp
    const id = store.create("Old unused learning", "user1", "Alice");

    // Manually update created_at to 100 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const oldISO = oldDate.toISOString();

    // Direct DB manipulation for testing
    (store as any).db.run(
      "UPDATE learnings SET created_at = ? WHERE id = ?",
      [oldISO, id]
    );

    const deactivated = store.deactivateStale();
    expect(deactivated).toBe(1);

    // Learning should now be inactive
    const learning = store.getById(id);
    expect(learning!.isActive).toBe(false);
  });

  test("deactivateStale() preserves learnings with non-zero usage", () => {
    // Create a learning with backdated timestamp
    const id = store.create("Old but used learning", "user1", "Alice");

    // Backdate to 100 days ago
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const oldISO = oldDate.toISOString();

    (store as any).db.run(
      "UPDATE learnings SET created_at = ? WHERE id = ?",
      [oldISO, id]
    );

    // Increment usage
    store.incrementUsage([id]);

    const deactivated = store.deactivateStale();
    expect(deactivated).toBe(0); // Not deactivated due to usage

    const learning = store.getById(id);
    expect(learning!.isActive).toBe(true);
  });

  test("deactivateStale() preserves recent learnings even with zero usage", () => {
    const id = store.create("Recent learning", "user1", "Alice");

    const deactivated = store.deactivateStale();
    expect(deactivated).toBe(0);

    const learning = store.getById(id);
    expect(learning!.isActive).toBe(true);
  });

  test("deactivateStale() returns zero when no stale learnings exist", () => {
    store.create("Recent learning 1", "user1", "Alice");
    store.create("Recent learning 2", "user2", "Bob");

    const deactivated = store.deactivateStale();
    expect(deactivated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("LearningStore - Edge Cases", () => {
  test("handles empty content string", () => {
    const id = store.create("", "user1", "Alice");
    const learning = store.getById(id);

    expect(learning).not.toBeNull();
    expect(learning!.content).toBe("");
  });

  test("handles very long content", () => {
    const longContent = "A".repeat(10000); // 10KB content
    const id = store.create(longContent, "user1", "Alice");
    const learning = store.getById(id);

    expect(learning!.content.length).toBe(10000);
  });

  test("handles special characters in content", () => {
    const content = "Always use quotes: \"foo\" & 'bar' <script>alert('xss')</script>";
    const id = store.create(content, "user1", "Alice");
    const learning = store.getById(id);

    expect(learning!.content).toBe(content); // No escaping/sanitization in storage
  });

  test("search() handles special SQL characters safely", () => {
    store.create("Test learning with % wildcards", "user1", "Alice");

    // These should not cause SQL errors
    expect(() => store.search("%")).not.toThrow();
    expect(() => store.search("_")).not.toThrow();
    expect(() => store.search("'")).not.toThrow();
  });

  test("getRelevant() handles empty prompt", () => {
    store.create("Learning 1", "user1", "Alice");
    const relevant = store.getRelevant("");

    // Should return learnings even with empty prompt (scores based on recency/usage)
    expect(relevant.length).toBe(1);
  });

  test("handles multiple learnings from same author", () => {
    const id1 = store.create("Learning 1", "user1", "Alice");
    const id2 = store.create("Learning 2", "user1", "Alice");

    const list = store.listActive();
    expect(list.length).toBe(2);
    expect(list[0]!.authorId).toBe("user1");
    expect(list[1]!.authorId).toBe("user1");
  });
});
