# Conversation tool boundary

Desk conversations discover permitted projects and work graphs with `capabilities` and investigate their working files with `repo_list`, `repo_read`, `repo_find`, and `repo_search`. The Cortex runtime owns the source registry, tool catalog, authorization, and durable activity. Local and cloud model lanes use the same boundary. Forge, graph, and web operations need their individual tool implementations.

## Stack configuration

The optional `mc.desk.conversations.tools` block belongs in the stack YAML. For example:

```yaml
mc:
  desk:
    conversations:
      tools:
        projects:
          - id: sample-project
            root: ~/work/sample-project
            forge:
              kind: github
              repo: example/sample-project
            policy: cloud
            operations: [repo.read, forge.read]
            exclude: [internal, stack/settings.yaml]
          - id: private-project
            root: ~/work/restricted-project
            forge:
              kind: gitlab
              host: git.example.org
              repo: example/private-project
            policy: local
            operations: [repo.read, forge.read]
        graphs:
          - id: desk-work
            policy: cloud
            maps:
              - id: desk
                ref: github:github.com/example/desk#10
                label: The Desk
              - id: conversations
                ref: github:github.com/example/desk#2948
            read:
              repos: [github:github.com/example/desk]
              namespaces: [gitlab:git.example.org/example]
          - id: private-work
            policy: local
            maps:
              - id: private-map
                ref: gitlab:git.example.org/example/private-project#3
            read:
              namespaces: [gitlab:git.example.org/example]
```

A project ID is stable across checkout moves. IDs contain lowercase letters, digits, and dashes, start with a letter, and have at most 64 characters. Each ID appears once. Roots are absolute or start with `~/`. Forge identities contain the provider kind, repository name, and optional hostname. They contain no credentials.

`policy` defaults to `local`. `operations` defaults to an empty list. Supported operation names are `repo.read`, `forge.read`, `graph.read`, and `web.read`. Declaring an operation permits an installed tool to use that source. It does not install a tool or grant mutations.

Without this block, configurations remain valid and discovery returns no projects. A directory, Git remote, authenticated forge account, or repository selected for proposal creation does not grant conversation reads. The proposal repository picker remains a separate grant for proposal creation.

## Discovery and dispatch

`capabilities` accepts an optional `source`, `offset`, and `limit`. The default page contains up to ten sources. `next` contains the next offset or `null`. Each visible source identifies its stable ID under `source`, its kind (`project` or `graph`), policy, operations and tool availability; a project also carries its forge identity. `project` repeats the same ID as a deprecated alias and is still accepted as a filter. Checkout locations and credentials remain in the Cortex runtime.

Availability distinguishes `available`, `not-configured`, `denied`, `dependency-missing`, and `provider-unavailable`. Blocking reasons identify the permitted operation, missing dependency, or provider connection to check. Hidden sources and unknown sources receive the same response. Discovery reveals neither hidden names nor their count.

The Cortex runtime validates tool names and input schemas. It pins the principal, conversation, transport, route, current policy, and registry for the turn. It rechecks authority before execution, after execution, after durable activity recording, before each model request, and before releasing the final answer. Changes invalidate the affected turn. The next turn uses current permissions.

Tool results have an output limit of 20,000 characters by default. The default timeout is 30 seconds, including provider availability checks. Cancellation prevents execution or stops waiting for an active operation. Tool implementations receive the cancellation signal. Results are fenced as retrieved content, with recognized credential formats redacted. Provider exceptions return a generic connection failure instead of exception contents. Tool implementations must return only source content appropriate to their declared policy and must honor cancellation.

## Policy and recovery

A cloud-allowed source works on either model lane. A local-only source requires a local-policy conversation, a local model, and web transport. Discord receives the existing neutral web continuation notice for local-policy conversations.

Durable activity includes tool identity, bounded arguments, outcome, bounded result, and the permitted source's identity and registration revision. Previously read source policies participate in the conversation's strictest policy after restart. Tightening a used source to local prevents subsequent cloud requests and Discord delivery. Removing a used source or changing its checkout, forge identity, or operations refuses history forwarding. A new conversation is required for the changed scope. Restoring a source to cloud never loosens an already local conversation.

`cortex.tool-started` is durable activity metadata containing only `turn`, `callId`, and `tool`. Repeated starts for the same turn and call share one entry. Transcript consumers that render only dialogue must ignore this kind, as they do other custom activity entries; it has no message role and is excluded from model history and Discord replies. The Desk shows it only while its generation is active and no matching `cortex.tool-activity` result exists. An interrupted call can retain its start record without remaining visible as pending work after the turn ends.

The Cortex runtime reconstructs Pi sessions from the durable exchange on each turn. It does not resume tool results cached in an earlier Pi session. It loads only configured extensions and the conversation bridge, and disables ambient MCP and context discovery.

The Pi built-in `read`, `grep`, `find`, and `ls` tools are disabled on both model lanes, including when configured in `pi.tools` or when no `tools` block exists. Startup reports the effective tool catalog and names the disabled settings. Existing configurations keep their `soma_context` setting and policy. Repository file tools require an explicit project registration with `repo.read`.

## Repository file tools

Each tool accepts a configured `project` ID and a project-relative `path`, which defaults to `.`. Absolute paths, parent traversal, backslashes, and NUL bytes are refused. Filesystem operations use the current checkout without executing Git, a shell, or a search executable.

| Tool | Additional input | Result |
| --- | --- | --- |
| `repo_list` | `limit` | Immediate directory entries and file types |
| `repo_read` | `startLine`, `lines` | Numbered UTF-8 text lines |
| `repo_find` | `query`, `caseSensitive`, `depth`, `limit` | File paths containing the literal query |
| `repo_search` | `query`, `caseSensitive`, `depth`, `limit` | Text lines containing the literal query |

Queries contain up to 200 UTF-16 code units. Matching is literal, including shell syntax and regular-expression punctuation. Case-sensitive matching is the default. Read ranges start at line 1 and return 100 lines by default, with a maximum of 200. Directory and search results default to 40 entries or matching lines, with a maximum of 100. Search depth defaults to 4 and cannot exceed 8. A search visits at most 2,000 entries and reads at most 2 MiB, plus one byte to detect growth beyond the limit. Each file is limited to 256 KiB. Returned line text is limited to 1,000 UTF-16 code units, and result entries share a serialized budget of 12,000 UTF-16 code units.

Results identify project-relative canonical paths and one-based line numbers. Each read or search result contains a file's `path`, `provenance`, and `lines` array. Each line contains `line`, `text`, and `truncated`. Provenance includes a SHA-256 hash, byte size, and modification time, recorded once per file. `provenance.source` is `working-tree`; `revision` is `null` because no Git revision is read. The hash identifies the file bytes read, including lines omitted by a range. Results do not claim that working files match a commit. A file that changes during a read is withheld. <!-- glossary-ignore: path -->

Root and candidate paths use native canonical resolution, including on-disk casing. Symlinks may target permitted files inside the same scope, and citations use the target's relative path. Escapes, nested checkouts, and nested worktrees are denied. Register a nested checkout as its own project to read it directly. Overlapping configured sources retain their own scope, exclusions, and policy; a parent project's cloud allowance cannot expose a nested local-only source. Reads through a parent retain the strictest encountered source policy in their durable source record. <!-- glossary-ignore: path -->

Repository reads bind their durable source record to the complete project registry in `projectRegistryRevision`. Changing any registered root, policy, operation, or exclusion refuses forwarding that conversation's history until a new conversation is started. This conservative binding includes unrelated project changes and protects earlier reads through a parent project when a nested project's policy tightens.

`exclude` contains optional project-relative file or directory prefixes. It accepts no glob syntax. Prefix comparisons ignore case on every filesystem. Exclusions apply to both the requested path and its canonical target, and changing exclusions invalidates an active turn and previously read source registrations. Built-in exclusions also apply to configured roots and their ancestors: `.git`, `.worktrees`, `node_modules`, credential directories (`.ssh`, `.aws`, `.gnupg`, `.config`, `.claude`, `.kube`, `.docker`), `.env`, `.env.*`, `*.env`, `.envrc`, `.npmrc`, `.netrc`, `.pypirc`, names beginning with `secret`, `secrets`, `private`, or `credentials` followed by a separator or extension, SSH identity files, and `.pem`, `.key`, `.p12`, and `.pfx` files. macOS system prefixes `/private/tmp` and `/private/var` remain usable. <!-- glossary-ignore: path -->

Structured results distinguish `ok`, `denied`, `missing`, `unreadable`, `binary`, and `truncated`. Oversized files disclose no text. Binary and invalid UTF-8 files disclose no text. `skipped` reports up to 40 skipped entries within a separate budget of 2,000 UTF-16 code units. `skippedCount` counts all encountered skips. Skips consume no match slots and cannot stop traversal. `truncated` and `reasons` identify line, depth, byte, entry, output, and skipped-report limits. `disclosedBytes` counts returned file text before the Cortex runtime's credential redaction. Denied results contain zero file text bytes. Cancellation uses the Cortex runtime's `stopped` outcome and releases no partial content.

## Probe evidence

Execute the focused probes on the machine that runs the Cortex runtime:

```sh
bun run test src/conversations/__tests__/repository-files.test.ts src/conversations/__tests__/repository-files-pi.test.ts src/conversations/__tests__/tools.test.ts src/conversations/__tests__/tools-host.test.ts src/conversations/__tests__/tools-pi.test.ts
```

The installed-Pi probes use a temporary two-policy registry, synthetic checkout files, an isolated Pi configuration directory, and a scripted OpenAI-compatible endpoint. They exercise the real TurnCall, Pi extension, Cortex runtime dispatch, and durable record. Both local and cloud lane probes inspect discovery and tool declarations. They assert that local-only text never appears in cloud requests or cloud conversation records, and check the Discord adapter's delivery records. Revocation during a tool batch denies result release and the next call, then stops before another provider request.

The installed-Pi probes skip when `pi` is absent from PATH. A passing scripted endpoint probe qualifies the Cortex runtime's tool boundary. It does not qualify credentials for a live stack, provider quality, or a production rollout. This slice creates no credentials and does not deploy services.

Graph item #3151 probe, 2026-11-05: the installed Pi bridge ran isolated cloud and local conversations against synthetic configured checkouts. `repo_search` returned `syntheticBeacon` at `beacon.ts:1`, and each conversation answered with that citation. Symlink escape and parent traversal reads were refused with `disclosedBytes: 0`; a cloud attempt to read a local-only project was refused. The provider requests and durable conversation records contained zero bytes of the private fixture marker. This probe used a scripted provider endpoint, not production model credentials. Live Stack behavior remains unverified.

## Repository Git reads

Projects with `repo.read` also expose the following Git tools. Inputs contain a configured `project` ID; `path`, when supported, is a literal project-relative file or directory prefix.

| Tool | Additional input | Evidence |
| --- | --- | --- |
| `repo_git_status` | None | Branch/head, tracked versus untracked changes, separate index and working-tree status codes |
| `repo_git_head` | None | Branch and commit SHA; detached branch is `null`, unborn revision is `null` |
| `repo_git_worktrees` | None | Worktrees registered as separately permitted projects, identified by project ID and relative location |
| `repo_git_log` | `ref`, `path`, `limit` | First-parent commit summaries with SHA, parents, date and permitted changed files |
| `repo_git_show` | `ref`, `path` | Commit summary and bounded patch for permitted regular files |
| `repo_git_diff` | `kind`, `from`, `to`, `path` | Bounded tracked-file patch with comparison provenance |

`ref` defaults to `HEAD`. It accepts bounded branch/tag names, commit hashes and up to four numeric `~`/`^` ancestry steps. Ranges, reflogs, object-path expressions and options are refused. `log.limit` defaults to 10 and cannot exceed 30. The limit bounds commits scanned, so excluded-only commits can produce fewer results. The scan stops at the first summary that exceeds the output budget. `scanned` counts inspected commits, and `hasMore` reports whether more candidates remain. <!-- glossary-ignore: path -->

Diff `kind` is `working` by default (HEAD to current files), `unstaged` (copied index to files), `staged` (HEAD to copied index), or `committed` (requires both `from` and `to`). Refs resolve to commit SHAs before reading committed evidence. Untracked content is excluded from patches; use status and the file tools to inspect it. Working-tree comparisons with no HEAD return `unborn-head`. Reads observe current files and a copied index, rather than claiming an atomic snapshot of concurrently edited files.

File exclusions and overlapping source policies apply to historical and deleted names as well as current files. Symlinks, submodule content and nested checkouts are omitted. Rename detection is disabled so an allowed destination cannot expose an excluded origin's contents. If a changed filename is also a prefix of another changed filename, the ancestor is omitted before patch generation. This prevents a file-to-directory replacement from widening a patch to excluded descendants. Commits with no permitted file changes return no summary. A status with omitted changes never claims that the repository is clean. Credential-bearing URLs and recognized access credentials are redacted from individual string values before JSON serialization. Remote configuration is never returned.

Git runs with fixed argument operations and a clean environment, without a shell or pager. Repository discovery and worktree listing use fixed metadata commands. Other operations use a temporary Git directory with minimal generated config, a copied index and links to the original object/ref stores. Repository and global executable helper settings are absent from that view, including clean/process filters; hooks and fsmonitor are disabled, external diff and textconv are forbidden, optional locks are disabled, and lazy fetching and network protocols are blocked. The view is removed after each call. Index copies are limited to 16 MiB; reftable repositories return `unsupported-reference-format`.

Status honors checkout `.gitignore` files and the repository's `info/exclude`. The isolated view omits `core.excludesFile` settings and global ignore files. Files ignored only by those settings appear as untracked, so `clean` describes this isolated view and can differ from direct Git status.

Each call has a 15-second Git deadline, at most 160 Git commands and a 2 MiB process-output budget. Each command returns at most 256 KiB. Exceeding a process budget terminates the child and withholds all content. Patches return up to 8,000 characters, marked `truncated`. Raw change lists are limited to 100 names before policy checks, and final structured output to 16,000 characters. Missing Git, invalid refs, unreadable repositories, unsupported formats, non-text output and exceeded budgets return explicit status codes with zero disclosed content. Cancellation terminates the active child and uses the Cortex runtime's `stopped` outcome.

Graph item #3152 probe, 2026-11-06: installed Pi ran cloud and local conversations against a synthetic real repository through the actual conversation extension and Cortex runtime. Branch, uncommitted patch and the last change to `beacon.txt` matched direct Git reads. Whole-repository hashes, including working files, index and refs, were identical before and after. Cloud requests and durable records contained no local-only fixture text. The endpoint was scripted. Production Stack behavior and production-provider behavior remain unverified. Reproduce with `bun run test src/conversations/__tests__/repository-git.test.ts src/conversations/__tests__/repository-git-pi.test.ts`.

## GitHub reads

A project with `forge.kind: github` and the `forge.read` operation gets six read-only tools: `github_repository`, `github_search`, `github_item` (issue or pull request with a comment page and reviews), `github_discussion`, `github_pr_diff` and `github_checks`. Each calls the host's `gh` login through fixed `GET` requests (and one fixed discussion query). The model supplies a project ID and bounded identifiers, never a host, path, method, query text for the API or a token.

Before every read the tool re-checks the configured host and `owner/name`, and refuses if the repository now resolves to another name. Every returned URL must lie inside the configured repository. Search text cannot name another `repo:`, `org:` or `user:` scope. Linked content in other repositories is never fetched.

Results carry `fetchedAt`, canonical URLs and, for pull requests, the head SHA. `status` is one of `ok`, `login-required`, `permission-denied`, `not-found`, `rate-limited`, `provider-failure`, `identity-mismatch`, `head-changed` or `invalid-source`. A diff or check read whose pull request head moved during the read is withheld as `head-changed`. The check `rollup` is `passing` only when every run and status was read and finished successfully; otherwise it is `failing`, `pending`, `incomplete`, `stale` or `none`. Pages are bounded; `nextPage` and `nextOffset` continue. `github_checks` pages check runs with `page` and commit statuses with `statusPage`; a commit status `targetUrl` outside the repository is returned as `null`.

## GitLab reads

A project with `forge.kind: gitlab` and `forge.read` offers eight tools: `gitlab_project`, `gitlab_search`, `gitlab_item`, `gitlab_discussions`, `gitlab_mr_changes`, `gitlab_mr_commits`, `gitlab_pipelines`, and `gitlab_jobs`. Configure `forge.host` for self-managed GitLab; its default is `gitlab.com`. Set `forge.repo` to the full project name, including nested groups, such as `group/subgroup/project`. Project names are configured as plain text and encoded once for the API. Encoded separators, traversal segments, and model-supplied GitLab address overrides are refused.

The adapter uses the configured GitLab account's existing `glab` login with fixed project-scoped GET requests. A login grants no additional conversation scope. Every call and result release uses the existing project policy and transport gates. Returned project IDs and canonical URLs must match the configured project. Linked content and fork projects are never followed. This adapter creates no credentials and provides no writes, logs, artifacts, or arbitrary CLI commands. The later laptop bus operation is a separate slice.

`gitlab_item`, `gitlab_search`, and `gitlab_discussions` take `kind: issue` or `kind: mr`; item and discussion reads also take `number`. MR changes, commits, and pipelines take the MR's `number`. Jobs take that number and a project-scoped `pipeline` ID. Search takes literal `query` text and `state: opened`, `closed`, or `all`. Pages use `page` (1–20) and `perPage` (1–10). Discussion threads return three clipped notes each; `notesPage` continues within those threads. Continuation fields and incomplete flags preserve partial results. `mayHaveMore` remains true at a full final page even when the page limit prevents continuing.

Results include `fetchedAt`, canonical URLs, and MR head SHAs. Pipeline entries carry their own SHA and observed status; a page does not imply that all checks passed. Composite MR reads withhold evidence as `head-changed`, `state-changed`, or `stale` when the head or pipeline changes. Missing clients and unreachable GitLab endpoints return `unavailable`; missing login, permission denial, hidden or absent items, rate limits, provider failures, invalid payloads, and identity mismatches remain distinct. Oversized output returns `result-too-large` with no content. Discovery exposes provider failures as `provider-unavailable` with the specific reason. No failure retries on another GitLab address.

`bun scripts/probe-ivy-tools-gitlab.ts` is the portable fixture-based probe required by node #3154. It exercises conversation dispatch in a throwaway durable conversation, verifies one issue and MR, checks scope refusals and unavailable cases, and removes its temporary store. It needs no installed `glab`, login, VPN, or laptop. A PASS proves behavior against the recorded protocol fixtures. It does not validate an installed `glab` version's CLI syntax or error formats, real GitLab responses, or laptop connectivity. An authenticated laptop read is optional after merge and does not gate this node.

## Work graph reads

A `graphs` entry names a Soma work-graph source. Each graph has a stable `id`, a `policy`, one to 100 configured `maps` and an explicit `read` scope. A map has a stable `id`, a fully qualified `ref` (`github:<host>/<owner>/<name>#<n>` or `gitlab:<host>/<group>/<project>#<n>`, `&<n>` for a GitLab epic) and an optional `label`. The `read` scope names exact repositories under `repos` and GitLab namespaces under `namespaces`. Every configured map must lie inside that scope, and a graph needs at least one read entry; an empty scope permits nothing. Graph ids are unique across projects and graphs. A project's `graph.read` operation does not create a graph source.

Graph reads run the installed `soma` CLI with fixed read verbs and validated arguments: `maps`, `node`, `frontier`, `audit` and `decisions`. Configured map references become `--root`; the read scope becomes repeated `--read-repo` and `--read-namespace`. No input field reaches the command line as a flag, and `--repo` is never used. The tool never runs `claim`, `release`, `abandon`, `add`, `link`, `chart`, `close`, `edit`, `rule`, `file-proposal`, `decisions --write`, or any raw tracker write.

| Tool | Input | Result |
| --- | --- | --- |
| `work_graph_maps` | None | Permitted map inventory with each live root node |
| `work_graph_node` | `node`, optional `map`, `bodyLimit` | One live node with source link, typed state, assignees, dependencies, parent and receipt-backed close |
| `work_graph_frontier` | `map`, `offset`, `limit` | A bounded page of open, unassigned, unblocked nodes plus skipped and omitted membership |
| `work_graph_audit` | `map`, optional `scope` | Close-gate findings, optionally only `build-brief-not-ready` |
| `work_graph_decisions` | `map`, `offset`, `limit` | A bounded page of the receipt-derived decision index |

A node reference is either fully qualified or a bare node number together with a configured map id. A qualified reference must lie inside the graph's read scope before the owner is called. Results preserve forge, host and path, including GitLab group identity, in every node, dependency and audit-finding reference.

`state` is `open` or `closed` as the owner reports it. `blocked` is true while any dependency is not a completed close; an abandoned dependency keeps its dependent blocked. `receiptBacked` is true only when the owner proves a current close receipt. `receiptMissing` marks a tracker-side close. A dependency, parent or child outside the read scope has `unavailable: true`, no foreign state, and remains blocking, whatever state the owner reports for it. A node outside the read scope is refused with nothing read. Body text is returned only for `work_graph_node` with `bodyLimit`; it is data and never used to infer progress.

`work_graph_frontier` pages `nodes` with `offset`, `limit` and `next`. Its `notWritable` nodes and `unavailableMembership` edges are bounded to 200 entries each and carry an `omitted` count, so a large map cannot inflate one page. `work_graph_audit` reports each finding as `items` with an `omitted` count; every item is a forge-qualified reference, whether the owner sends bare IDs or `{id}` objects. A full audit must carry every finding list, and a scoped audit must carry its one checked list; a missing, non-array or id-less finding list is refused as `unreadable` rather than reported as no findings.

Map, node and frontier reads are labelled `snapshot: live`. The decision index is labelled `historical: true` and `derivedFrom: close-receipts`; an audit with a `scope` is labelled `uncheckedFindings: true`. Failures stay distinct: `denied`, `not-found`, `identity-mismatch`, `invalid-source`, `owner-timeout`, `owner-unavailable`, `owner-failure` and `unreadable`. A malformed, truncated or wrong-repository owner response releases nothing. Cancellation and the Cortex runtime's output limit apply as for other source tools.

The graph's `policy` applies before the owner is called and again before the result is released. A local-only graph requires a local-policy conversation, a local model and web transport. A graph source used by a conversation is recorded in its durable tool sources; changing or removing it refuses later turns of that conversation.

<!-- glossary-ignore: run -->
<!-- glossary-ignore: node -->
<!-- glossary-ignore: owner -->
<!-- glossary-ignore: host -->
<!-- glossary-ignore: path -->
<!-- glossary-ignore: body -->
<!-- glossary-ignore: data -->

## Web search and page reads

A project with the `web.read` operation gets two tools: `web_search` and `web_fetch`. The stack configures them under `mc.desk.conversations.tools.web`. Nothing is hardwired to a paid service and Cortex creates no account or key.

```yaml
web:
  search:
    kind: searxng          # or brave
    url: http://127.0.0.1:8888
    policy: local          # local or cloud; defaults to cloud
    apiKeyEnv: SEARCH_API_KEY   # optional; the name of an environment variable, never the key
  limits:                  # all optional
    maxResults: 5
    maxBytes: 1000000
    maxRedirects: 5
    timeoutSeconds: 15
    maxChars: 12000
```

Without `web.search`, `web_search` is listed as `dependency-missing` and a call returns an error naming the missing setting. `web_fetch` needs no provider. A missing credential variable is reported as `provider-unavailable`.

**Egress policy.** A `cloud` search provider receives query text, so a local-only conversation is refused before any request. A `local` provider serves both policies. `web_fetch` reveals the address to an outside site, so a local-only conversation cannot use it. The host re-checks this on every call and before releasing a result.

**Search results** carry `rank`, `title`, `url`, `snippet`, the provider kind and `retrievedAt`. Non-http(s) links are dropped and counted in `omittedInvalid`.

**Fetch results** carry the final `url` (fragment removed), `requestedUrl`, `title`, `contentType`, `retrievedAt`, the extracted `text` window, `totalChars`, `nextOffset` and `truncated: { bytes, characters }`. Pass `offset` to read the next window. `status` is `ok`, `invalid-url`, `denied-target`, `dns-failure`, `too-many-redirects`, `invalid-redirect`, `http-error`, `unsupported-media-type`, `unsupported-encoding`, `binary-content`, `network-error` or `timeout`.

**What the fetcher refuses.** Only `http` and `https` on ports 80, 443, 8080 and 8443; no embedded credentials; no `localhost`, single-label, `.local`, `.internal` or similar names. Loopback, private, link-local (including the metadata address), carrier-grade NAT, multicast, documentation, ULA and IPv4-mapped, NAT64 and 6to4 forms of those are refused. A host is resolved once; if any answer is nonpublic the whole host is refused, and the validated address is the one connected to, with the connected peer checked again. Each redirect is validated the same way and the count is bounded. Requests carry no cookies, authorization or host credentials and ask for an uncompressed body. Only text, HTML, Markdown, JSON, XML and CSV are read, the body is cut at `maxBytes`, and a text-labelled body with NUL bytes is refused as binary. A cancelled turn aborts the request, including a pending DNS lookup, and the time limit covers the lookup too.

<!-- glossary-ignore: host -->
<!-- glossary-ignore: body -->
<!-- glossary-ignore: data -->
<!-- glossary-ignore: run -->
<!-- glossary-ignore: path -->
Page and search text is untrusted data. It sits inside the fenced result, cannot change permissions, tool definitions or standing authority, and is never followed as instructions.

Tests drive both tools through the conversation host with controlled DNS, transport and provider fixtures: `bun run test src/conversations/__tests__/tools-web.test.ts`. The live probe (a cloud-allowed throwaway conversation reading a public documentation page, loopback and redirect denial, and a local-only query that never reaches the provider) needs a deployed stack with a configured provider and has not been run from this build.

<!-- glossary-ignore: run -->
<!-- glossary-ignore: host -->
<!-- glossary-ignore: node -->
<!-- glossary-ignore: owner -->
<!-- glossary-ignore: path -->
<!-- glossary-ignore: data -->

## End-to-end probe and live setup

`bun scripts/probe-conversation-tools.ts` drives the actual conversation host, the real tool catalog, the real durable store and the real API confirmation route. It builds a temporary checkout with real Git history, a temporary home and temp directory, and disposable owner fixtures: a recorded `gh` protocol, a recorded `soma` protocol, an injected search requester and fetch transport, and a file-backed Ranger stand-in. It removes everything it created and checks that the temporary root is gone. It needs no credential, account, network or running stack, and it runs in the `test` gate as part of `bun run check`.

The probe prints one row per capability with `PASS`, `FAIL` or `NEEDS`, the basis of the claim and a canonical evidence reference of the form `conversation:<id> cortex.tool-activity:<callId>`. The conversation id is created fresh on every run; the call label is stable.

| Row | Capability | Basis |
| --- | --- | --- |
| C1 | Discovery lists the configured projects and graphs with availability and blocking reasons | actual host, synthetic registry |
| C2 | File evidence with provenance; exclusions, traversal and a nested local-only project refused | real checkout |
| C3 | Git evidence matches direct Git and the repository bytes are unchanged | real Git |
| C4 | GitHub read pins the configured host and repository | recorded `gh` protocol |
| C5 | Work-graph read pins the configured map and scope and runs no write verb | recorded `soma` protocol |
| C6 | Web search and fetch use the configured provider; a local-only conversation is refused | injected provider and transport |
| C7 | A local-only checkout is refused in a cloud conversation and read in a local one | real checkout, both lanes |
| C8 | Each configured lane answers on its own route and the record names the lane | conversation record |
| C9 | Earlier conversations are searchable and readable with conversation and entry citations | durable history owner |
| C10 | A proposal is prepared by the conversation, confirmed once through the API and read back from the owner | real API route |
| C11 | Worker state and cancellation act on the exact recorded generation and never start a second worker | owner-recorded state |
| C12 | A node the owner will not run automatically is reported as awaiting approval | owner refusal |
| C13 | Another principal cannot read this principal's history, worker state or proposals | owner and API gates |
| C14 | Revoking a source during a turn withholds the result and refuses the next call | live registry change |
| C15 | Prompt injection inside a source file stays fenced data and causes no owner effect | fence and instruction boundary |
| C16 | A missing connector is reported as unavailable with its reason | owner failure, missing login, missing setting |
| C17 | A restart reads the owner's recorded state and replays no duplicate effect | host restart, fresh owner fixture |
| X2 | The temporary root is removed | cleanup check |

A PASS on C1-C17 means the Cortex tool boundary holds on the actual host path for the basis named in the row. It does not mean a live owner answered. The probe records seven capabilities as `NEEDS`, and none of them is claimed as passed:

| Row | Capability | What is missing |
| --- | --- | --- |
| P1 | Live GitHub forge read | a `gh` login on the host and a configured real checkout |
| P2 | Live GitLab forge read | a `glab` login and a configured GitLab project |
| P3 | Live work-graph read | the `soma` CLI and a registered map |
| P4 | Live web search and fetch | a configured search provider and public egress |
| P5 | Live Ranger start, status and stop | a configured `mc.desk.workers` block and a running supervisor |
| P6 | Live provider and model quality on each lane | configured provider credentials |
| P7 | Deployed-stack read-only investigation | a running stack and the principal's conversation |

The probe scripts the model turn, so it does not test whether a model obeys the fence, follows the instructions or picks the right tool. It tests that the boundary holds when a turn calls a tool. Model behaviour belongs to the live probe below.

### Live-stack recipe

Run this on the machine that hosts the stack, after the build is installed. It is read-only: it reads a checkout, a forge item, a graph node and a public page, and it creates nothing.

1. Add one `mc.desk.conversations.tools` project for a checkout you may read, with `operations: [repo.read]` and the policy you want. Add a graph source and a `web.search` provider if you want those rows too. Validate with `cortex config validate`.
2. Restart the stack so the conversation host reloads the registry, then open a new conversation in the Desk with the policy that matches the source.
3. Ask the assistant to list what it can read, then to read one named file and cite its path. Confirm the answer names the project and the file, and that the conversation record shows a `cortex.tool-activity` entry with `outcome: done` and a `source` revision.
4. Ask for one forge item and one graph node by number. A missing login or a missing CLI must appear as unavailable with its reason, never as an empty result.
5. Add a second project with `policy: local`, then ask for it from a cloud conversation. The call must be refused and the refusal must say why. A local-policy web conversation may read it.
6. Read the conversation record and confirm no credential, no absolute host path and no private source text reached the answer.
7. Delete the conversation. The probe creates no fixture on a live stack, so there is nothing else to clean up.

Record the provider and model of each answer, the source revision from each tool record, and the cleanup result with the evidence. A row that cannot be exercised stays `NEEDS` with the missing item named.

### Deployed versus preview state

This build is not deployed. The probe above passed on the development host against recorded owner protocols and real local checkouts. The live-stack recipe has not been run from this build, so P1-P7 remain provisioning-needed and no live forge, provider, worker or deployed-stack success is claimed here. Merge, install and a run of the recipe are what turn those rows into evidence.
