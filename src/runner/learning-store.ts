/**
 * Issue #49: Learning Store
 * Operator-submitted learnings that persist across sessions.
 * Uses bun:sqlite for storage and relevance scoring for context injection.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { initDatabase } from "./db-utils";

export interface Learning {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  isActive: boolean;
  usageCount: number;
}

export interface LearningWithScore extends Learning {
  relevanceScore: number;
}

export class LearningStore {
  private db: Database;
  private readonly STALE_DAYS = 90;

  constructor(dbPath: string) {
    this.db = initDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        usage_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_learnings_active ON learnings(is_active, created_at);
      CREATE INDEX IF NOT EXISTS idx_learnings_usage ON learnings(usage_count, created_at);
    `);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Store a new learning.
   * Returns the generated learning ID.
   */
  create(content: string, authorId: string, authorName: string): string {
    const id = randomUUID().slice(0, 8); // Short IDs like "3f4b2a1c"
    const createdAt = new Date().toISOString();

    this.db.run(
      `INSERT INTO learnings (id, content, author_id, author_name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, content, authorId, authorName, createdAt],
    );

    return id;
  }

  /**
   * Get all active learnings (for /learning list).
   * Returns most recent first.
   */
  listActive(limit = 10): Learning[] {
    const rows = this.db.query(
      `SELECT id, content, author_id, author_name, created_at, is_active, usage_count
       FROM learnings
       WHERE is_active = 1
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(limit) as {
      id: string;
      content: string;
      author_id: string;
      author_name: string;
      created_at: string;
      is_active: number;
      usage_count: number;
    }[];

    return rows.map((r) => this.rowToLearning(r));
  }

  /**
   * Search learnings by substring match (case-insensitive).
   */
  search(query: string): Learning[] {
    const pattern = `%${query}%`;
    const rows = this.db.query(
      `SELECT id, content, author_id, author_name, created_at, is_active, usage_count
       FROM learnings
       WHERE is_active = 1 AND content LIKE ?
       ORDER BY usage_count DESC, created_at DESC`,
    ).all(pattern) as {
      id: string;
      content: string;
      author_id: string;
      author_name: string;
      created_at: string;
      is_active: number;
      usage_count: number;
    }[];

    return rows.map((r) => this.rowToLearning(r));
  }

  /**
   * Soft-delete a learning (set is_active = 0).
   * Returns true if the learning existed and was deactivated.
   */
  remove(id: string): boolean {
    const result = this.db.run(
      `UPDATE learnings SET is_active = 0 WHERE id = ? AND is_active = 1`,
      [id],
    );
    return result.changes > 0;
  }

  /**
   * Get a single learning by ID.
   */
  getById(id: string): Learning | null {
    const row = this.db.query(
      `SELECT id, content, author_id, author_name, created_at, is_active, usage_count
       FROM learnings WHERE id = ?`,
    ).get(id) as {
      id: string;
      content: string;
      author_id: string;
      author_name: string;
      created_at: string;
      is_active: number;
      usage_count: number;
    } | null;

    return row ? this.rowToLearning(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Relevance Scoring & Context Injection
  // ---------------------------------------------------------------------------

  /**
   * Get top N most relevant learnings for a given prompt.
   * Relevance = recency * 0.4 + usage_frequency * 0.3 + keyword_match * 0.3
   */
  getRelevant(prompt: string, limit = 5): LearningWithScore[] {
    const allActive = this.db.query(
      `SELECT id, content, author_id, author_name, created_at, is_active, usage_count
       FROM learnings
       WHERE is_active = 1`,
    ).all() as {
      id: string;
      content: string;
      author_id: string;
      author_name: string;
      created_at: string;
      is_active: number;
      usage_count: number;
    }[];

    if (allActive.length === 0) return [];

    const now = Date.now();
    const maxUsage = Math.max(...allActive.map((l) => l.usage_count), 1);
    const promptLower = prompt.toLowerCase();

    const scored: LearningWithScore[] = allActive.map((row) => {
      const learning = this.rowToLearning(row);
      const ageMs = now - new Date(learning.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      // Recency score: decays from 1.0 at day 0 to 0.1 at day 90
      const recencyScore = Math.max(0.1, 1.0 - ageDays / this.STALE_DAYS);

      // Usage frequency: normalized by max usage count
      const usageScore = learning.usageCount / maxUsage;

      // Keyword match: count words in common (simple substring approach)
      const learningWords = learning.content.toLowerCase().split(/\s+/);
      const promptWords = promptLower.split(/\s+/);
      const matches = learningWords.filter((w) => w.length > 3 && promptWords.some((p) => p.includes(w) || w.includes(p)));
      const keywordScore = Math.min(1.0, matches.length / 5); // Cap at 5 matches = 1.0

      const relevanceScore = recencyScore * 0.4 + usageScore * 0.3 + keywordScore * 0.3;

      return { ...learning, relevanceScore };
    });

    // Sort by relevance descending, take top N
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return scored.slice(0, limit);
  }

  /**
   * Increment usage count for learnings that were injected into a session.
   */
  incrementUsage(ids: string[]): void {
    if (ids.length === 0) return;

    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE learnings SET usage_count = usage_count + 1
       WHERE id IN (${placeholders})`,
      ids,
    );
  }

  // ---------------------------------------------------------------------------
  // Staleness Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Deactivate learnings older than 90 days with 0 usage.
   * Returns count of deactivated learnings.
   */
  deactivateStale(): number {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.STALE_DAYS);
    const cutoffISO = cutoffDate.toISOString();

    const result = this.db.run(
      `UPDATE learnings SET is_active = 0
       WHERE is_active = 1 AND usage_count = 0 AND created_at < ?`,
      [cutoffISO],
    );

    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private rowToLearning(row: {
    id: string;
    content: string;
    author_id: string;
    author_name: string;
    created_at: string;
    is_active: number;
    usage_count: number;
  }): Learning {
    return {
      id: row.id,
      content: row.content,
      authorId: row.author_id,
      authorName: row.author_name,
      createdAt: row.created_at,
      isActive: row.is_active === 1,
      usageCount: row.usage_count,
    };
  }

  close(): void {
    this.db.close();
  }
}
