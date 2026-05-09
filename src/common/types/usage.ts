/**
 * G-206: Account-level rate limit usage type.
 *
 * Extracted from grove-v2 `src/dashboard/types.ts` (legacy v2 dashboard tree
 * which retires at MIG-8 and is NOT migrating). Pulled forward into
 * `src/common/types/usage.ts` so cortex consumers (usage-monitor, future
 * dashboards/exporters) can depend on a stable home that survives the
 * v2 dashboard retirement. Precedent: MIG-3a `attachment-types.ts`.
 *
 * No transitive dependencies — pure structural type.
 */
export interface AccountUsage {
  fiveHour: { utilization: number; resetsAt: string } | null;
  sevenDay: { utilization: number; resetsAt: string } | null;
  sevenDayOpus: { utilization: number; resetsAt: string } | null;
  sevenDaySonnet: { utilization: number; resetsAt: string } | null;
  extraUsage: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
  } | null;
  updatedAt: string;
}
