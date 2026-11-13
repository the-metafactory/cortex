import { parseGraphRepoRef } from "../../../../common/graph-ref";
import type { CommandResult } from "../../common/spawn";

export const GLAB_STATUS_ARGV = ["glab", "auth", "status"];
const LOGGED_IN = /✓\s+Logged in to (\S+) as /;

export function loggedInGitlabHosts(result: CommandResult): string[] {
  const hosts = new Set<string>();
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const host = LOGGED_IN.exec(line)?.[1];
    const ref = host === undefined ? null : parseGraphRepoRef(`gitlab:${host}/group/project`);
    if (ref) hosts.add(ref.host);
  }
  return [...hosts].sort();
}
