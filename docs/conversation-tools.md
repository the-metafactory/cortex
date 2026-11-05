# Conversation tool boundary

Ivy conversations discover permitted projects with `capabilities`. The Cortex host owns the project registry, tool catalog, authorization, and durable activity. Local and cloud model lanes use the same boundary. This foundation ships discovery. Repository, forge, graph, and web operations need their individual tool implementations.

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
          - id: private-project
            root: ~/work/private-project
            forge:
              kind: gitlab
              host: git.example.org
              repo: example/private-project
            policy: local
            operations: [repo.read, forge.read, graph.read]
```

A project ID is stable across checkout moves. IDs contain lowercase letters, digits, and dashes, start with a letter, and have at most 64 characters. Each ID appears once. Roots are absolute or start with `~/`. Forge identities contain the provider kind, repository path, and optional host. They contain no credentials.

`policy` defaults to `local`. `operations` defaults to an empty list. Supported operation names are `repo.read`, `forge.read`, `graph.read`, and `web.read`. Declaring an operation permits an installed tool to use that source. It does not install a tool or grant mutations.

Without this block, configurations remain valid and discovery returns no projects. A directory, Git remote, authenticated forge account, or repository selected for proposal creation does not grant conversation reads. The proposal repository picker remains a separate grant for its existing owner operations.

## Discovery and dispatch

`capabilities` accepts an optional `project`, `offset`, and `limit`. The default page contains up to ten projects. `next` contains the next offset or `null`. Each visible source identifies its stable project ID, policy, forge identity, and tool availability. Checkout paths and credentials remain in the host.

Availability distinguishes `available`, `not-configured`, `denied`, `dependency-missing`, and `provider-unavailable`. Blocking reasons identify the permitted operation, missing dependency, or provider connection to check. Hidden sources and unknown sources receive the same response. Discovery reveals neither hidden names nor their count.

The host validates tool names and input schemas. It pins the principal, conversation, transport, route, current policy, and registry for the turn. It rechecks authority before execution, after execution, after durable activity recording, before each model request, and before releasing the final answer. Changes invalidate the affected turn. The next turn uses current permissions.

Tool results have an output limit of 20,000 characters by default. The default timeout is 30 seconds, including provider availability checks. Cancellation prevents execution or stops waiting for an active operation. Tool implementations receive the cancellation signal. Results are fenced as retrieved data, with recognized credential formats redacted. Provider exceptions return a generic connection failure instead of exception contents. Tool implementations must return only source data appropriate to their declared policy and must honor cancellation.

## Policy and recovery

A cloud-allowed source works on either model lane. A local-only source requires a local-policy conversation, a local model, and web transport. Discord receives the existing neutral web continuation notice for local-policy conversations.

Durable activity includes tool identity, bounded arguments, outcome, bounded result, and the permitted source's identity and registration revision. Previously read source policies participate in the conversation's strictest policy after restart. Tightening a used source to local prevents subsequent cloud requests and Discord delivery. Removing a used source or changing its checkout, forge identity, or operations refuses history forwarding. A new conversation is required for the changed scope. Restoring a source to cloud never loosens an already local conversation.

Host conversations reconstruct Pi sessions from the durable exchange on each turn. They do not resume tool results cached in an earlier Pi session. The host loads only configured extensions and the conversation bridge, disables ambient MCP and context discovery, and removes unscoped built-in file tools. Existing `pi.tools` configurations still parse. Soma context remains subject to its existing tool setting and policy.

## Probe evidence

Run the focused probes on the host:

```sh
bun run test src/conversations/__tests__/tools.test.ts src/conversations/__tests__/tools-host.test.ts src/conversations/__tests__/tools-pi.test.ts
```

The installed-Pi probes use a temporary two-policy registry, synthetic checkout files, an isolated Pi agent directory, and a scripted OpenAI-compatible endpoint. They exercise the real TurnCall, Pi extension, host dispatch, and durable record. Both local and cloud lane probes inspect discovery and tool declarations. They assert that local-only text never appears in cloud requests or cloud conversation records, and check the Discord adapter's delivery records. Revocation during a tool batch denies result release and the next call, then stops before another provider request.

The installed-Pi probes skip when `pi` is absent from PATH. A passing scripted endpoint probe qualifies host integration. It does not qualify deployment credentials, provider quality, or a production rollout. This slice creates no credentials and does not deploy services.
