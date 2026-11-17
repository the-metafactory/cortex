import type { Database } from "bun:sqlite";
import type { BalanceDestinationsResponse } from "../../../desk-api/wire/balance";
import { areaProjects, balanceDestinations, resolveBalanceProject } from "../desk/balance-destinations";
import { loadBalanceState } from "../desk/balance-store";
import type { DeskRuntime } from "../desk/compose";

export const DESK_BALANCE_DESTINATIONS_PATH = "/api/desk/balance/destinations"; // glossary-ignore: path

const noStore = { "Cache-Control": "no-store" };

const refuse = (status: number, code: string, error: string): Response => Response.json({ ok: false, code, error }, { status, headers: noStore });

export function handleDeskBalanceDestinations(req: Request, db: Database, runtime: DeskRuntime | undefined): Response {
  if (req.method !== "GET") return Response.json({ error: "Use GET." }, { status: 405, headers: { ...noStore, Allow: "GET" } });
  const desk = runtime?.options;
  if (!desk?.enabled) return refuse(409, "desk_off", "The Desk is turned off.");
  const params = new URL(req.url).searchParams;
  const state = loadBalanceState(db);
  const tasks = params.get("tasks") === "1";
  const area = params.get("area");
  const projectsOnly = state ? balanceDestinations(state.outline, desk.areas, false) : [];
  const projects = area === null ? projectsOnly : areaProjects(projectsOnly, area);
  const withTasks = state && tasks ? balanceDestinations(state.outline, desk.areas, true) : [];
  const destinations = !tasks ? projects : area === null ? withTasks : withTasks.filter(destination => destination.area === area);

  const match = params.get("match");
  const body: BalanceDestinationsResponse = { destinations };
  if (match !== null) {
    const resolution = resolveBalanceProject(projects, match);
    body.resolved = "project" in resolution ? { id: resolution.project.id } : resolution;
  }
  return Response.json(body, { headers: noStore });
}
