import type { Database } from "bun:sqlite";
import type { AppState } from "../../../balance";
import { BalanceStateSchema } from "./balance-store-schema";

export function loadBalanceState(db: Database): AppState | null {
  const row = db.query<{ data: string }, []>("SELECT data FROM desk_balance WHERE id = 1").get();
  if (!row) return null;
  const data: unknown = JSON.parse(row.data);
  return BalanceStateSchema.parse(data);
}

export function saveBalanceState(db: Database, state: AppState): void {
  const parsed = BalanceStateSchema.parse(state);
  db.query("INSERT INTO desk_balance (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
    .run(JSON.stringify(parsed));
}
