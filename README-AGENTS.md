# cortex — Install & Configure Guide (for AI agents)

Audience: an AI agent (or human operator) installing, configuring, and
verifying a cortex stack on a principal's machine. For what cortex *is*, read
[`README.md`](README.md). For working on this *codebase*, read `CLAUDE.md`
(generated — never hand-edit).

This guide is deterministic: follow the steps in order, verify each gate before
proceeding, and prefer the dry-run form of every command before `--apply`.

---

## Which mode are you setting up?

cortex runs in layers — start at the bottom; each higher layer is **additive and opt-in**.

| Mode | What it is | Beyond the base, you need |
|---|---|---|
| **Local** | Your own stack, standalone — your assistants, your bus, your machine. No one else involved. | Just the base prerequisites (§1) + an isolated bus (§4). |
| **Federated** | Connect your stack to a *specific peer you trust* — sovereign, two-party federation: your stack runs its own **operator-mode** bus and links to the peer's. | An **operator-mode** bus + the `provision → make-live → join` ladder (§6 + [`sop-onboard-peer-principal.md`](docs/sop-onboard-peer-principal.md)). |

**Local is the starting point** — get a local stack running first; federation is a later, opt-in step.

> **This is about your *agent network* (the bus), not your chat surface.** Discord — a private server or a shared one — is just how you talk to your *own* assistant, and that choice is independent of the mode. **Local** = your stack stands alone (your agents, your bus, your machine; nobody else's stack involved). **Federated** = your bus links to a **specific trusted peer's**, so your agents and theirs can exchange work across the boundary — you choose exactly who you peer with; it is *not* an open or public group. (A public, open-to-anyone mode is not supported yet.)

---

## 1. Prerequisites

Verify each before starting:

| Requirement | Check | Notes |
|---|---|---|
| Bun | `bun --version` | The only supported runtime. Never use npm/yarn/node. |
| NATS server with JetStream | `nats-server --version` | One isolated bus per stack (see §4). **Install:** macOS `brew install nats-server`; Linux — binary from [nats-io/nats-server releases](https://github.com/nats-io/nats-server/releases) or your distro package (JetStream is built in, enabled per-config). |
| Claude Code, authenticated | `claude --version` | Default execution substrate for dispatched work. |
| Discord bot token + guild | — | Bot must already be a **member of the target guild** with the **Message Content intent enabled** (Developer Portal). Only the principal can do this. |
| guild id + channel ids | — | Discord client → Developer Mode → copy id. |
| `arc` (optional) | `arc --version` | metafactory package manager; manages install + launchd lifecycle + signing-seed provisioning. |

**Platform — macOS and Linux both supported.** The runtime is OS-agnostic (Bun,
NATS, and the config `.conf` are identical); only the **service manager** differs:
- **macOS** — launchd. `arc upgrade` renders the plists (`src/services/`) for you.
- **Linux** — systemd **user** units. arc's auto-rendering of systemd units is WIP
  ([arc#140](https://github.com/the-metafactory/arc/issues/140)); for now hand-write a
  user unit mirroring the launchd plist — `ExecStart=<path>/cortex start --config
  <pointer>`, `Restart=always`, `CORTEX_CHANNEL` set, `~/.bun/bin` on `PATH` — then
  `systemctl --user enable --now`. cortex's `daemon-locator` finds it. (Or run directly:
  `bun src/cortex.ts start --config <pointer>`.)

## 2. Install

**Path A — arc-managed (preferred when `arc` is available):**

```bash
arc upgrade cortex
```

This installs the released package and renders + loads the launchd agents
(`ai.meta-factory.cortex.*`). Note: `arc upgrade` tracks **GitHub releases**,
not `main`.

**Ordering:** seed auto-provisioning reads `stack.nkey_seed_path` from the
stack config — which doesn't exist until §3.1 scaffolds it. On a fresh machine:
install (this section) → configure (§3) → re-run `arc upgrade cortex` (or
provision manually per §3.3) so the seed lands at the declared path.

**Path B — from source** (for contributors / the fork-and-PR workflow; Path A is
the managed path for normal operation):

```bash
git clone https://github.com/the-metafactory/cortex
cd cortex
bun install
bun link          # puts `cortex` on PATH via ~/.bun/bin
cortex --version  # confirm it resolves
```

Run the daemon with `cortex start --config <pointer>` (or directly with
`bun src/cortex.ts start --config <pointer>`). Verify with `bun test` and
`bun run lint`.

**Updating a from-source clone:** `cd cortex && git pull && bun install` — a clean
fast-forward if you haven't modified anything. For an arc-managed install, update
with `arc upgrade cortex` instead (Path A).

## 3. Configure a stack

cortex uses the **config-split (multi-file) layout** as the standard. A stack's
config is a directory under `~/.config/cortex/<slug>/`; the daemon's `--config`
points at a **pointer file** inside it. The single-file `cortex.yaml`
(`cortex.yaml.example`) is legacy — it still loads, but do not create new
installs with it.

### 3.1 Scaffold

```bash
# Dry-run FIRST (default — prints the file set, touches nothing):
cortex stack create <slug> --principal <principal>

# Then write:
cortex stack create <slug> --principal <principal> --apply
```

This scaffolds `~/.config/cortex/<slug>/` "born aligned": dir basename == slug
== trailing segment of `stack.id`. It refuses dir collisions and duplicate
`stack.id`s. Manual fallback: `cp -R docs/config-layout ~/.config/cortex/<slug>`
and rename the pointer file to `<slug>.yaml`.

### 3.2 The files and what to fill

| File | Layer | Action |
|---|---|---|
| `<slug>.yaml` | pointer | Nothing. Contents ignored; dirname selects the layout; **basename names the PID file** — must be per-stack, never a uniform `cortex.yaml`, or a second daemon collides on the PID file. |
| `system/system.yaml` | substrate/transport | `nats.url` + identity block. **Leave `nats.subjects: []`** unless you know you need push-mode fan-out — see §3.4. |
| `stacks/<slug>.yaml` | per-deployment | Fill `<REPLACE_ME>`: principal id + Discord id, `stack.id` (`<principal>/<slug>`), `nkey_seed_path`, `policy` block, agents, `github.repos`. Set `nkey_pub` only after §3.3 prints the `U…` key. **`chmod 600`** (carries the bot token if inline). |
| `surfaces/surfaces.yaml` | surface bindings (optional) | Discord `token` / `guildId` / `agentChannelId` / `logChannelId` per agent. Credential surface-of-truth; folds into the matching agent's `presence` block at load. |
| `network/*.yaml` | federation (optional) | Leave absent/commented unless federating (§6). |
| `personas/<assistant>.md` | persona | The assistant's persona; append a repo-scope note listing allowed repo slugs. |

Composition precedence (later wins on leaf keys):
`system/` → `network/*` (sorted) → `surfaces/` → `stacks/*` (sorted).

### 3.3 Signing identity

`arc upgrade cortex` auto-provisions the seed at
`~/.config/nats/cortex-<slug>.nk`. Manual alternative:

```bash
cortex provision-stack generate <principal> \
  --seed-path ~/.config/nats/cortex-<slug>.nk \
  --stack-id <principal>/<slug>
```

Seed stays `chmod 600`. Record the printed `nkey_pub` (`U…`) into
`stacks/<slug>.yaml`. Local-only stacks do NOT need `--register` and may keep
`security.signing: off` — own-stack implicit trust admits the stack's own
envelopes. Registration matters only for federated `signing: enforce`.

### 3.4 The `nats.subjects` landmine

`nats.subjects` lives in **exactly one place**: `system/system.yaml`. A
duplicate declaration in any stack file double-binds the boot subscriber and
double-delivers every envelope (cortex#491). The loader validates loudly, but
never re-declare it. Default `[]` is correct for pull-only capability dispatch.

### 3.5 Policy: principal-only access

For any guild others can join, list **only** the principal (with their Discord
id under `platform_ids.discord`) in `policy.principals[]`. A non-principal's
@mention is hard-blocked silently — a `system.access.denied` audit envelope on
the bus, no channel reply. Size `claude.bashAllowlist` (in `system/system.yaml`)
least-privilege: it gates every command in dispatched sessions, even the
principal's, and the bash-guard auto-approves matching commands so async
dispatch never stalls. Restrict `gh` reach via `bashAllowlist.repos`.

## 4. Stand up the bus

One isolated NATS server per stack. The isolation wall is the **absence** of
any `leafnodes{}` / `cluster{}` / `gateway{}` block. `~/.config/nats/<slug>.conf`:

```hocon
server_name: <slug>-<principal>
listen: 127.0.0.1:<port>            # pick a free port; pair with a free monitor port
http: 127.0.0.1:<monitor-port>
jetstream {
  store_dir: ~/.config/nats/<slug>-jetstream
  max_mem: 64mb
  max_file: 1gb
  domain: <slug>-<principal>
}
```

Run it via your OS's service manager — a **launchd** plist
(`ai.meta-factory.nats.<slug>.plist`) on macOS, or a **systemd user** unit on Linux
(`systemctl --user enable --now`) — or directly while testing: `nats-server -c
~/.config/nats/<slug>.conf`. Verify: `lsof -nP -iTCP:<port> -sTCP:LISTEN | grep nats`.

Point `system/system.yaml` `nats.url` at `nats://127.0.0.1:<port>`.

**Multiple stacks on one machine are first-class** — the port is per-stack; nothing
assumes `:4222`. Each stack picks its own **client + monitor** port and sets them in two
places that must agree: the `.conf` `listen:` / `http:` lines and `system/system.yaml`
`nats.url`. cortex reads `nats.url` — it never hardcodes a port. A second co-located
stack just takes the next free pair — e.g. **stack A `:4222`/`:8222`, stack B
`:4223`/`:8223`** — each its own isolated nats-server. This is how several stacks run
side-by-side under one user account; `systemd --user` units (true user-space) work the
same way — no system-level / one-stack-per-machine fallback needed.

> Gotcha: a stray system-wide `nats-server` (e.g. homebrew, no JetStream) on
> the same port silently hijacks connections — JetStream consumers go dormant.
> Verify which process owns the port before debugging anything else.

## 5. Start and verify

```bash
# Validate schema + agent registry resolution without starting:
cortex start --config ~/.config/cortex/<slug>/<slug>.yaml --dry-run

# Start (launchd/systemd handles this in steady state):
cortex start --config ~/.config/cortex/<slug>/<slug>.yaml
```

Daemonised: `~/Library/LaunchAgents/ai.meta-factory.cortex.<slug>.plist` →
`cortex start --config …/<slug>.yaml`, logs to
`~/.config/cortex/logs/cortex-<slug>.{log,error.log}`.

**Healthy-boot gate** — all of these lines must appear:

```bash
grep -E "Stack:|connected to nats|policy-engine active|connected as|Guild:" \
  ~/.config/cortex/logs/cortex-<slug>.log | tail
```

Expect: `Stack: <principal>/<slug>` · `connected to nats://…:<port>` ·
`policy-engine active — principals=N` · `discord adapter started (… guild: …)`
· `connected as <Bot>#NNNN`.

**Functional gate:**

1. @mention the assistant as the principal → it replies.
2. @mention from a non-principal account → silence (no reply, no refusal
   post). This proves the principal-only gate.

## 6. Federate (optional)

Federation joins the stack's bus to a network of peer principals. Summary —
full procedure in [`docs/sop-network-join.md`](docs/sop-network-join.md) and
[`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) Part 2:

1. **Hard prerequisite:** the local bus must be **operator-mode** (NSC
   operator + system account + resolver blocks defining the leaf account). An
   anonymous bus from §4 **cannot federate** — `cortex network join` refuses
   fail-fast (#794). Convert the bus config first.
2. Obtain a leaf `.creds` for this stack from the hub admin →
   `~/.config/nats/<network>.creds`; note its account NKey (`A…`).
3. Add the `stack.nats_infra` + `policy.federated.registry` blocks to
   `stacks/<slug>.yaml`.
4. Register + join (dry-run first; add `--apply` to write):

```bash
cortex provision-stack register <principal> --seed-path <seed> \
  --registry-url https://network.meta-factory.ai --stack-id <principal>/<slug>
cortex network join <network> --config ~/.config/cortex/<slug>/<slug>.yaml --apply
```

A principal's **2nd+ stack** must pass `--principal-seed <root-seed>` (the
first stack's seed) so the add-stack claim is root-signed and existing stacks
survive the merge (#791).

Verify: `cortex network status --principal <principal>` → leaf `link:`
established + expected peers. Note: federated payloads are cleartext-over-TLS
in v1 — keep dispatch scope tight on public-facing stacks.

## 7. Optional integrations

**Instrument any Claude Code session** onto the Mission Control dashboard:

```bash
CORTEX_CHANNEL=<label> CORTEX_AGENT_NAME=<display> CORTEX_AGENT_ID=<id> \
  CORTEX_PRINCIPAL=<principal> claude
```

`CORTEX_CHANNEL` is the required enabler; `CORTEX_PRINCIPAL` stamps the human
for correlation. Event pipeline: CC hooks → `~/.claude/events/raw/` →
cortex-relay → `~/.claude/events/published/` → daemon → bus → dashboard.

**Discord CLI** from any terminal:

```bash
discord post "message"                      # default channel
discord post --channel <name> "message"
discord read
```

**Dashboard frontend** (only when serving your own): built + deployed
separately from the daemon —
`bun run build:dashboard` then
`bunx wrangler pages deploy dist/dashboard-v2 --project-name <your-cf-project>`
(your own Cloudflare Pages project; `grove-dashboard` is the metafactory's).

**Bus code review:** publishers send `tasks.code-review.*` envelopes; cortex
claims via a JetStream durable and emits verdict + lifecycle envelopes. Tune
via `bus.review`; see [`docs/sop-bus-review.md`](docs/sop-bus-review.md).

## 8. Gotchas (ranked by damage)

| Gotcha | Consequence | Rule |
|---|---|---|
| Duplicate `nats.subjects` | Every envelope delivered twice | Declare in `system/system.yaml` only (§3.4). |
| Uniform pointer filename across stacks | Second daemon kills the first's PID file | Pointer basename = stack slug, always. |
| Anonymous bus + `network join` | Historically: bus down (`cannot find local account`); now: fail-fast refusal | Convert to operator-mode before joining (§6). |
| dir/slug ≠ `stack.id` trailing segment | Stack federates as one identity, labelled another ("drift") | Use `stack create` (born aligned); reconcile drift by renaming the dir, never rewriting `stack.id` (ADR-0004). |
| Stray nats-server on the stack's port | JetStream consumers silently dormant | Verify port ownership; connect via `127.0.0.1`, not `localhost`. |
| Oversized `bashAllowlist` | Dispatched sessions auto-approve too much | Least privilege; scope `gh` with `bashAllowlist.repos`. |
| Secrets in world-readable config | Token leak | `chmod 600` on `stacks/*.yaml` / `surfaces/surfaces.yaml`. |

## 9. Reference index

| Topic | Doc |
|---|---|
| End-to-end stack stand-up | [`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) |
| Config template (canonical) | [`docs/config-layout/`](docs/config-layout/) |
| Config-split rationale + migration | [`docs/migrations/0003-config-split-layout.md`](docs/migrations/0003-config-split-layout.md) |
| Stack signing identity | [`docs/sop-stack-identity.md`](docs/sop-stack-identity.md) |
| Slug authority decision | [`docs/adr/0004-stack-slug-authority.md`](docs/adr/0004-stack-slug-authority.md) |
| Network join / leave / status | [`docs/sop-network-join.md`](docs/sop-network-join.md) |
| Peer-principal onboarding | [`docs/sop-federation-onboarding.md`](docs/sop-federation-onboarding.md) |
| Bus review path | [`docs/sop-bus-review.md`](docs/sop-bus-review.md) |
| Architecture | [`docs/architecture.md`](docs/architecture.md) |
| Domain vocabulary | [`CONTEXT.md`](CONTEXT.md) |
