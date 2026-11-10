import { afterEach } from "bun:test";
import { openBalanceReadRig, type BalanceReadRig } from "./balance-read-fixtures";

const opened: BalanceReadRig[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(rig => rig.close())); });
export async function openBalanceReadRigForTest(): Promise<BalanceReadRig> {
  const rig = await openBalanceReadRig();
  opened.push(rig);
  return rig;
}
