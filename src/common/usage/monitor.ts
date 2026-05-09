/**
 * G-206b: Usage Monitor — Tiered account usage data source
 *
 * Tiered approach (in priority order):
 *   1. Event pipeline — agent.usage.update events from EventLogger hook
 *   2. Cache file — ~/.claude/MEMORY/STATE/usage-cache.json (written by status line)
 *   3. API poll — Direct Anthropic OAuth API call (last resort)
 *
 * Every update is persisted as a time-series snapshot in SQLite.
 */

import { existsSync, readFileSync, watchFile, unwatchFile, statSync } from "fs";
import { join } from "path";
import type { AccountUsage } from "../types/usage";
import { fetchWithTimeout } from "../timeout";

const CACHE_PATH = join(process.env.HOME ?? "~", ".claude", "MEMORY", "STATE", "usage-cache.json");
const API_URL = "https://api.anthropic.com/api/oauth/usage";
const CACHE_POLL_MS = 30_000;   // Check cache file every 30s
const API_POLL_MS = 5 * 60_000; // API fallback every 5 min (conservative)

export interface UsageSnapshot {
  source: string;
  fiveHourPct: number | null;
  fiveHourResets: string | null;
  sevenDayPct: number | null;
  sevenDayResets: string | null;
  sevenDayOpusPct: number | null;
  sevenDaySonnetPct: number | null;
  extraUsageEnabled: boolean | null;
}

type OnUpdate = (usage: AccountUsage, snapshot: UsageSnapshot) => void;

export class UsageMonitor {
  private onUpdate: OnUpdate;
  private cacheTimer: Timer | null = null;
  private apiTimer: Timer | null = null;
  private lastCacheMtime = 0;
  private lastEventAt = 0;

  constructor(onUpdate: OnUpdate) {
    this.onUpdate = onUpdate;
  }

  /** Start all tiers. Event-based updates are handled via receiveEvent(). */
  start(): void {
    // Tier 2: Poll cache file for changes
    this.checkCache(); // immediate
    this.cacheTimer = setInterval(() => this.checkCache(), CACHE_POLL_MS);

    // Tier 3: API fallback — only if no events/cache updates in a while
    this.apiTimer = setInterval(() => this.apiFallback(), API_POLL_MS);

    console.log("usage-monitor: started (event → cache → api)");
  }

  /** Stop all timers. */
  stop(): void {
    if (this.cacheTimer) { clearInterval(this.cacheTimer); this.cacheTimer = null; }
    if (this.apiTimer) { clearInterval(this.apiTimer); this.apiTimer = null; }
  }

  /**
   * Tier 1: Receive an agent.usage.update event from the pipeline.
   * This is the preferred data source — emitted by EventLogger hook.
   */
  receiveEvent(payload: Record<string, unknown>): AccountUsage {
    this.lastEventAt = Date.now();
    const usage = this.parseRawUsage(payload);
    const snapshot = this.toSnapshot("event", payload);
    this.onUpdate(usage, snapshot);
    return usage;
  }

  /** Tier 2: Check if the cache file has been updated. */
  private checkCache(): void {
    try {
      if (!existsSync(CACHE_PATH)) return;
      const stat = statSync(CACHE_PATH);
      if (stat.mtimeMs <= this.lastCacheMtime) return;
      this.lastCacheMtime = stat.mtimeMs;

      // Skip if we got an event recently (event is fresher)
      if (Date.now() - this.lastEventAt < CACHE_POLL_MS) return;

      const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
      if (!raw || (!raw.five_hour && !raw.seven_day)) return;

      const usage = this.parseRawUsage(raw);
      const snapshot = this.toSnapshot("cache", raw);
      this.onUpdate(usage, snapshot);
    } catch (err) {
      console.error("usage-monitor: cache read failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Tier 3: Poll the API directly (only if no recent updates from tiers 1/2). */
  private async apiFallback(): Promise<void> {
    // Skip if we got a recent update from event or cache
    if (Date.now() - this.lastEventAt < API_POLL_MS) return;
    if (Date.now() - this.lastCacheMtime < API_POLL_MS) return;

    try {
      const token = await this.getOAuthToken();
      if (!token) return;

      const response = await fetchWithTimeout("usage_monitor", 5_000, API_URL, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
      });

      if (!response.ok) return;

      const raw = await response.json() as Record<string, any>;
      const usage = this.parseRawUsage(raw);
      const snapshot = this.toSnapshot("api", raw);
      this.onUpdate(usage, snapshot);
      this.lastEventAt = Date.now(); // Treat API response as a "recent update"
    } catch (err) {
      console.error("usage-monitor: API fallback failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Parse raw Anthropic usage response into AccountUsage. */
  private parseRawUsage(raw: Record<string, any>): AccountUsage {
    const mapBucket = (b: any) =>
      b ? { utilization: b.utilization ?? 0, resetsAt: b.resets_at ?? "" } : null;

    return {
      fiveHour: mapBucket(raw.five_hour),
      sevenDay: mapBucket(raw.seven_day),
      sevenDayOpus: mapBucket(raw.seven_day_opus),
      sevenDaySonnet: mapBucket(raw.seven_day_sonnet),
      extraUsage: raw.extra_usage ? {
        isEnabled: raw.extra_usage.is_enabled ?? false,
        monthlyLimit: raw.extra_usage.monthly_limit ?? null,
        usedCredits: raw.extra_usage.used_credits ?? null,
      } : null,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Convert raw usage data to a DB-ready snapshot. */
  private toSnapshot(source: string, raw: Record<string, any>): UsageSnapshot {
    return {
      source,
      fiveHourPct: raw.five_hour?.utilization ?? null,
      fiveHourResets: raw.five_hour?.resets_at ?? null,
      sevenDayPct: raw.seven_day?.utilization ?? null,
      sevenDayResets: raw.seven_day?.resets_at ?? null,
      sevenDayOpusPct: raw.seven_day_opus?.utilization ?? null,
      sevenDaySonnetPct: raw.seven_day_sonnet?.utilization ?? null,
      extraUsageEnabled: raw.extra_usage?.is_enabled ?? null,
    };
  }

  /** Extract OAuth access token. Tries: macOS Keychain → credentials file → env var. */
  private async getOAuthToken(): Promise<string | null> {
    if (process.platform === "darwin") {
      try {
        const result = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        if (result.exitCode === 0) {
          const creds = JSON.parse(result.stdout.toString());
          const token = creds?.claudeAiOauth?.accessToken;
          if (token) return token;
        }
      } catch (err) {
        console.error("usage-monitor: keychain credential read failed:", err instanceof Error ? err.message : err);
      }
    }

    try {
      const credPath = `${process.env.HOME}/.claude/.credentials.json`;
      const file = Bun.file(credPath);
      if (await file.exists()) {
        const creds = await file.json();
        const token = creds?.claudeAiOauth?.accessToken;
        if (token) return token;
      }
    } catch (err) {
      console.error("usage-monitor: credentials file read failed:", err instanceof Error ? err.message : err);
    }

    return process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
  }
}
