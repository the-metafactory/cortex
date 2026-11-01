import type { ParserPermissions } from "../../../common/types/desk-parser";
import type { DeskOptions } from "./compose";
import { effectivePolicy } from "./studio/view";

export function parserPermissions(
  desk: DeskOptions,
  areas: string[],
  restriction?: ParserPermissions,
):
  | { kind: "allowed"; routing?: ParserPermissions }
  | { kind: "denied"; reason: string } {
  const policy = effectivePolicy(areas, desk.areas);
  if (policy.unknown.length)
    return {
      kind: "denied",
      reason: "Choose an area configured on this Desk.",
    };
  if ((restriction || policy.policy === "local") && !desk.ask?.routing)
    return {
      kind: "denied",
      reason:
        "This request needs provider restrictions. Ask the person who manages this stack to set up routed parsing first.",
    };
  const permitted = desk.ask?.routing?.permitted.filter(
    (p) =>
      (!restriction || restriction.permitted.includes(p)) &&
      (policy.policy !== "local" || p === "pi"),
  );
  return permitted
    ? { kind: "allowed", routing: { permitted } }
    : { kind: "allowed" };
}
