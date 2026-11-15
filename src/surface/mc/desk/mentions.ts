import { formatGraphRepoRef, parseGraphRepoRef, type GraphRepoRef } from "../../../common/graph-ref";
import type { ToolProject } from "../../../common/types/desk-conversations";
import { somaRepo } from "./ruling";
import type { RangerState } from "./sources/ranger";
import type { DeskItem, DeskMention } from "./types";

const REFERENCE = /(?<![\p{L}\p{N}_./:#&%+@-])(?:(?<repo>[\w.-]+(?:\/[\w.-]+)*)#|node\s+#?|[Nn][Oo][Dd][Ee]\s+#|#)(?<num>[1-9]\d*)(?![\p{L}\p{N}_/#&-])/gu;
const MAIL_KINDS = new Set<DeskItem["kind"]>(["mail", "mail-rule", "mail-waiting", "mail-handoff", "dmarc"]);

function repository(ref: string): GraphRepoRef | null {
  const qualified = somaRepo(ref);
  return parseGraphRepoRef(ref) ?? (qualified ? parseGraphRepoRef(qualified) : null);
}

export function mentionRepositories(areas: readonly { repos: readonly string[] }[], projects: readonly Pick<ToolProject, "forge">[], ranger: RangerState | null): GraphRepoRef[] {
  const refs = [
    ...areas.flatMap(area => area.repos),
    ...projects.flatMap(project => project.forge ? [`${project.forge.kind}:${project.forge.host ?? (project.forge.kind === "github" ? "github.com" : "gitlab.com")}/${project.forge.repo}`] : []),
    ...(ranger?.maps ?? []).map(map => map.repo),
    ...(ranger?.needsYou ?? []).map(node => node.repo),
    ...(ranger?.current ?? []).map(node => node.repo),
  ];
  return uniqueRepositories(refs.flatMap(ref => repository(ref) ?? []));
}

function uniqueRepositories(repositories: readonly GraphRepoRef[]): GraphRepoRef[] {
  return [...new Map(repositories.map(repo => [formatGraphRepoRef(repo).toLowerCase(), repo])).values()];
}

function ownRepository(item: DeskItem): GraphRepoRef | null {
  const ref = item.detail.refs[0] ?? "";
  const node = /^(.+)#[1-9]\d*$/.exec(ref);
  return node?.[1] ? repository(node[1]) : null;
}

function resolveRepository(name: string, repositories: readonly GraphRepoRef[]): GraphRepoRef | null {
  const matches = repositories.filter(repo => (name.includes("/") ? repo.path : repo.path.split("/").at(-1))?.toLowerCase() === name.toLowerCase());
  if (matches.length > 0) return matches.length === 1 ? matches[0] ?? null : null;
  return name.includes("/") ? repository(name) : null;
}

function issueUrl(repo: GraphRepoRef, number: string): string | null {
  const safe = parseGraphRepoRef(formatGraphRepoRef(repo));
  if (safe?.path !== repo.path || safe.host !== repo.host.toLowerCase() || !Number.isSafeInteger(Number(number))) return null;
  const path = `/${safe.path}/${safe.forge === "gitlab" ? "-/issues" : "issues"}/${number}`;
  const url = URL.parse(`https://${safe.host}${path}`);
  return url?.protocol === "https:" && url.host === safe.host && !url.username && !url.password && url.pathname === path ? url.href : null;
}

export function itemMentions(item: DeskItem, knownRepositories: readonly GraphRepoRef[]): DeskMention[] {
  if (MAIL_KINDS.has(item.kind) || item.source === "mail") return [];
  const own = ownRepository(item);
  const repositories = uniqueRepositories([...knownRepositories, ...(own ? [own] : [])]);
  const fields = [item.title, item.why, item.detail.summary, item.question?.reason, item.explanation?.sentence, ...(item.explanation?.choices ?? []).flatMap(choice => [choice.label, choice.consequence])];
  const mentions = new Map<string, DeskMention>();
  for (const field of fields) {
    for (const match of field?.matchAll(REFERENCE) ?? []) {
      const text = match[0];
      const name = match.groups?.repo;
      const repo = name ? resolveRepository(name, repositories) : own;
      const number = match.groups?.num;
      const url = repo && number ? issueUrl(repo, number) : null;
      if (url) mentions.set(text, { text, url });
    }
  }
  return [...mentions.values()];
}

export function withMentions(item: DeskItem, repositories: readonly GraphRepoRef[]): DeskItem {
  const mentions = itemMentions(item, repositories);
  return mentions.length > 0 ? { ...item, mentions } : item;
}
