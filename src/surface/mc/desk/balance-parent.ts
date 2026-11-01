import {
  type BalanceParent,
  type ParentProposal,
} from "./balance-parent-schema";
import { z } from "zod";
import type { OutlineNode } from "../../../balance";
import type { MyDayView } from "./my-day";
import type { DeskOptions } from "./compose";
import type { ParserRunner } from "./ask";
import {
  ParserRoutingSchema,
  parserUnavailable,
  type ParserRouting,
} from "./parser-routing";
import { parserPermissions } from "./parser-permissions";
import type { DeskItem } from "./types";
import { sourceIdentity } from "./source-task";

export function balanceParents(
  day: Pick<MyDayView, "outline">,
  areas: Pick<DeskOptions, "areas">["areas"],
): BalanceParent[] {
  const parents: BalanceParent[] = [];
  const visit = (
    node: OutlineNode,
    area: string,
    path: string[],
    root = false,
  ): void => {
    const next = [...path, node.title];
    if (
      !node.done &&
      !node.id.startsWith("studio-response:") &&
      (root || node.children.length > 0)
    )
      parents.push({ id: node.id, area, path: next.join(" / ") });
    if (!node.done) for (const child of node.children) visit(child, area, next);
  };
  for (const area of areas) {
    const node = day.outline.children.find((n) => n.id === `area:${area.id}`);
    if (node) visit(node, area.id, [], true);
  }
  return parents;
}
const AnswerSchema = z.object({
  kind: z.literal("balance-parent"),
  parent: z.string().nullable(),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s)),
  routing: ParserRoutingSchema,
});
export async function proposeBalanceParent({
  desk,
  day,
  source,
  run,
}: {
  desk: DeskOptions;
  day: MyDayView;
  source: DeskItem;
  run: ParserRunner;
}): Promise<ParentProposal> {
  const parents = balanceParents(day, desk.areas);
  const base = {
    key: source.key,
    fingerprint: sourceIdentity(source),
    revision: day.revision,
    date: day.date,
    parents,
  };
  const fallback = (
    reason: string,
    routing: ParserRouting = parserUnavailable("invalid-output"),
  ): ParentProposal => ({ ...base, parent: null, reason, routing });
  const scopes = [
    ...new Set([
      ...parents.map((p) => p.area),
      ...(source.area ? [source.area] : []),
    ]),
  ];
  const permissions = parserPermissions(desk, scopes);
  if (permissions.kind === "denied")
    return fallback(
      "Suggestions are unavailable under these area permissions. Choose a parent or keep this in Inbox.",
      parserUnavailable("provider-policy"),
    );
  if (!desk.ask?.parser.length || !permissions.routing)
    return fallback(
      "Routed suggestions are unavailable. Choose an existing parent or keep this in Inbox.",
      parserUnavailable("integration-unavailable"),
    );
  const request = {
    operation: "balance-parent",
    version: 1,
    revision: day.revision,
    source: {
      key: source.key,
      fingerprint: base.fingerprint,
      text: `${source.title}\n${source.detail.summary}`.slice(0, 4000),
    },
    parents,
    routing: permissions.routing,
  };
  try {
    const raw: unknown = JSON.parse(
      await run(
        desk.ask.parser,
        JSON.stringify(request),
        desk.ask.timeoutSeconds * 1000,
      ),
    );
    const answer = AnswerSchema.safeParse(raw);
    if (!answer.success) {
      const unavailable = z
        .object({ kind: z.literal("none"), routing: ParserRoutingSchema })
        .safeParse(raw);
      return fallback(
        "No validated suggestion is available. Choose a parent or keep this in Inbox.",
        unavailable.success && unavailable.data.routing.kind === "unavailable"
          ? unavailable.data.routing
          : parserUnavailable("invalid-output"),
      );
    }
    const { routing, parent, reason } = answer.data;
    if (
      routing.kind !== "selected" ||
      !permissions.routing.permitted.includes(routing.provider) ||
      (parent !== null && !parents.some((p) => p.id === parent))
    )
      return fallback(
        "The suggestion was invalid. Choose an existing parent or keep this in Inbox.",
      );
    return { ...base, parent, reason, routing };
  } catch {
    return fallback(
      "The suggestion could not finish. Choose a parent or keep this in Inbox.",
      parserUnavailable("integration-unavailable"),
    );
  }
}
