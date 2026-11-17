# Node #3829: can installed Codex establish a pre-inference bound for the scheduled Studio request?

**Answer: no.** `codex-cli 0.169.0` on this machine cannot set a verified pre-inference bound for the complete Studio request plus a reserved output. Three capabilities are missing, and any one of them blocks the contract:

1. **There is no output or reasoning reserve to enforce.** The request Codex sends has no `max_output_tokens` field. The model catalog has no maximum-output bound, and no CLI flag or config key sets one.
2. **There is no authoritative token count before inference.** The binary has no tokenizer. Its own counter is a bytes/4 heuristic, which its source calls "a coarse lower bound, not a tokenizer-accurate count".
3. **A checked request cannot be bound to the run.** `codex debug prompt-input` cannot be given the settings that `codex exec` runs with. Its dump omits request fields that matter (reasoning effort, among others). `codex exec` cannot be handed a precomputed request or a request hash to refuse on mismatch.

The scheduled full-draft handoff therefore stays unspecifiable on the subscription path. No workaround in this note is ready for integration.

## Version-specific evidence

| Item | Value |
|---|---|
| Binary | `/Users/fischer/.local/bin/codex`, `codex --version` → `codex-cli 0.169.0` (2026-11-17) |
| Matching source | `openai/codex` tag `rust-v0.169.0` (tag object `a41fe5b4`, commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`), shallow-cloned outside the repo |
| Auth | Existing subscription login. No API key was introduced, and no inference was run. The only network calls were the model-catalog refresh (`codex debug models`) and `prompt-input` thread startup. |
| Ranger Studio invocation | `ranger` `src/studio-think.ts:182-190` (`7fb2488`, 2026-11-10): `codex exec --ignore-user-config --ignore-rules --ephemeral --sandbox read-only --skip-git-repo-check --model <cfg> --output-last-message <file> -c model_reasoning_effort=… -c approval_policy="never" -c web_search="disabled" -c project_doc_max_bytes=0 -c features.{apps,shell_tool,unified_exec,plugins,multi_agent,multi_agent_v2,computer_use,browser_use,view_image,image_generation}=false`. The default model is `gpt-6.1-sol` (`src/config.ts`). The job is still named `ivy-think` (`src/jobs.ts:64,250,418`). |

### F1. The request has no output bound (decisive)

- `codex-rs/codex-api/src/common.rs:287-314`, `ResponsesApiRequest`: the fields are `model, stream, service_tier, input, tools, tool_choice, parallel_tool_calls, reasoning, store, stream_options, include, prompt_cache_key, prompt_cache_options, text, client_metadata, access_programs`. There is **no `max_output_tokens`**.
- `common.rs:161-171`, `Reasoning`: only `effort`, `summary` and `context`. There is no reasoning-token budget.
- `codex-rs/core/src/client.rs:1295-1313`, `build_responses_request`: no output limit is set anywhere.
- A grep for `max_output_tokens` across `codex-rs` (non-test) finds only tool-output truncation (`exec_command` arguments), the LM Studio client and `guardian_conversation_history_max_output_tokens`. None of these applies to the model turn.
- Catalog: `codex debug models` records carry no output, max-token or compact keys. For `gpt-6.2-astra`, `[keys|select(test("output|token|compact"))]` returns `[]`.

A finite reserve for generated output and reasoning therefore cannot be enforced or even declared. Output can be bounded only after the fact, through server truncation (`incomplete_details.reason = max_output_tokens`, which the tests in `core/tests/suite/client.rs` exercise). The node rules that out.

### F2. Capacity is neither authoritative nor stable

- `codex-rs/protocol/src/openai_models.rs:568-577`: `usable_context_window = (context_window or max_context_window) × effective_context_window_percent / 100`.
- `context_window` can be overridden by user config (`core/src/config/mod.rs:676-677`, `model_context_window`). The client-side number is self-declarable, so it is not an account-verified limit.
- The bundled and refreshed catalogs disagree for Ranger's default model:

  | slug | bundled `context_window` | refreshed `context_window` | `max_context_window` | effective % |
  |---|---|---|---|---|
  | `gpt-6.1-sol` | 272000 | **500000** | 872000 | 95 |
  | `gpt-6.2-astra` | absent | 272000 | 872000 | 95 |

  The catalog is refreshed live (`models-manager/src/manager.rs`, `models_cache.json`, ETag refresh). A capacity read at check time can differ from the one `exec` resolves at run time.

### F3. There is no authoritative token count before inference

- `codex-rs/core/src/context_manager/history.rs:823-856`: `estimate_token_count` is commented "byte-based heuristics … a coarse lower bound, not a tokenizer-accurate count".
- `APPROX_BYTES_PER_TOKEN = 4` (`core/src/realtime_context.rs:45`, `ext/skills/src/render.rs:29`). `utils/output-truncation` uses the same scheme.
- No tokenizer crate appears in any `Cargo.toml`, and the API client exposes no token-count endpoint (`codex-api/src/endpoint/`: images, memories, models, realtime, responses, search, session).
- The only character limit is `MAX_USER_INPUT_TEXT_CHARS = 1 << 20` (`protocol/src/user_input.rs:11`), which the app-server and TUI enforce. It is a character cap, not a token bound.

Exact-fit cannot be decided, because the binary cannot tell N tokens from N+1. An over-limit request is caught only by the server's `ContextWindowExceeded`, after the request is sent. Both outcomes are ruled insufficient.

### F4. `prompt-input` is close to complete for input but cannot be bound to `exec`

What the dump does cover (source `core/src/prompt_debug.rs`, returns `prompt.input`; `core/src/session/turn.rs:1842-1879`; `core/src/client.rs:1161-1226`):

- For models with `use_responses_lite: true` (both `gpt-6.1-sol` and `gpt-6.2-astra` in the refreshed catalog), tools and base instructions are recorded into history in incremental-tools mode. The dump then contains an `additional_tools` item and the base instructions as a developer message: 27 309 characters for `gpt-6.2-astra`, equal to the catalog's `base_instructions` length. On this binary the upstream claim that the dump shows only `prompt.input` is true, but less damaging than it first appears.
- Only hosted tools (`WebSearch`) stay top-level and are absent from the dump. Ranger disables web search.

What the dump does not cover, or cannot match:

- **Request framing outside `input` is missing:** `reasoning.effort`, `reasoning.summary`, `text` (verbosity and output schema), `service_tier`, `include`, `client_metadata` and the WebSocket envelope. In the probe below, `model_reasoning_effort="low"` and `="high"` yield identical dumps once ids and `create_time` are removed.
- **The dump cannot reproduce Ranger's flags.** `prompt-input` accepts only `-c`, `--enable`, `--disable` and `-i` (`codex debug prompt-input --help`). It has no `--ignore-user-config`, `--ignore-rules`, `--ephemeral` or `--sandbox`. Its dump therefore includes user-level instructions and skills that Ranger's `exec` run excludes, and its permissions text reflects a different sandbox. The counted request is not the request that would run.
- **Unknown models fail open.** `-c model="no-such-model-n3829"` exits 0 and dumps 3 items with fallback instructions and no tools. Nothing refuses an unknown model.
- **The dump is not byte-stable.** Item `id`s are UUIDs and `create_time` changes, so a hash of the dump cannot serve as a binding token without normalisation that Codex does not define.
- **`exec` cannot take the checked request.** `codex exec --help` lists no option to supply a prepared request, a prompt hash or a maximum input size, and none to refuse on drift.

### F5. Destructive input reduction cannot be switched off from `exec`

- Auto-compaction is gated by the `AutoCompactionDisabled` thread extension (`core/src/session/turn.rs:242-248`). Only app-server-internal paths insert it (`app-server/src/request_processors/thread_processor.rs:5431`, `app-server/src/thread_sample.rs:212`). `exec` has no flag or config key for it.
- `model_auto_compact_token_limit` can move the threshold (`core/src/session/context_window.rs:53-95`) but cannot disable it. The `token_budget` feature, which turns off summarising compaction, is "under development" (`codex features list`).
- Tool output is truncated to the model's `truncation_policy` (`{"mode":"tokens","limit":10000}` in the catalog; `core/src/tools/mod.rs:94-126`). For a single-turn Studio run with no tool calls this is moot, but nothing guarantees that run makes no tool calls. The code-mode `exec` tool stays declared even with Ranger's feature switches (`additional_tools` is 17 894 bytes in the probe).

## Required cases

| Case | Result on 0.169.0 | Why |
|---|---|---|
| Unicode | The text arrives intact in the dump (`Grüße 日本語 🎉 é`, 43 UTF-8 bytes). It cannot be counted. | No tokenizer (F3) |
| Exact fit | Undecidable | Bytes/4 lower bound only (F3); capacity source unstable (F2) |
| Over limit | Detected only by the server's `ContextWindowExceeded` after sending | No client pre-check (F3) |
| Unknown model | Accepted silently, rc=0, with a fallback prompt | Fails open (F4) |
| Changed settings | Reasoning effort is invisible in the dump; catalog refresh can change capacity between check and run | F2, F4 |
| Output reserve | Cannot be expressed | F1 |

## Runnable no-inference probe

Run it from an empty directory. It uses the existing login and synthetic text only, and it makes no model call.

```bash
#!/usr/bin/env bash
set -u
OUT=$(mktemp -d); cd "$(mktemp -d)"
codex --version
codex debug models --bundled > "$OUT/bundled.json"
codex debug models           > "$OUT/remote.json"
echo "## capacity (bundled vs refreshed), and any output-bound key"
for f in bundled remote; do
  jq -r --arg f "$f" '.models[]|select(.slug=="gpt-6.1-sol")|[$f,.context_window,.max_context_window,.effective_context_window_percent]|@tsv' "$OUT/$f.json"
done
jq -c '[.models[]|keys[]|select(test("output|max_tokens"))]|unique' "$OUT/remote.json"
R=(-c 'approval_policy="never"' -c 'web_search="disabled"' -c project_doc_max_bytes=0)
for f in apps shell_tool unified_exec plugins multi_agent multi_agent_v2 computer_use browser_use view_image image_generation; do R+=(-c "features.$f=false"); done
P='Synthetic draft: Grüße 日本語 🎉 é'
codex debug prompt-input "${R[@]}" -c 'model="gpt-6.1-sol"' -c 'model_reasoning_effort="low"'  "$P" > "$OUT/low.json"
codex debug prompt-input "${R[@]}" -c 'model="gpt-6.1-sol"' -c 'model_reasoning_effort="high"' "$P" > "$OUT/high.json"
codex debug prompt-input "${R[@]}" -c 'model="no-such-model-n3829"' "$P" > "$OUT/unknown.json"; echo "unknown model rc=$?"
echo "## changed settings visible in dump?"
diff <(jq -S 'del(..|.id?, .create_time?)' "$OUT/low.json") <(jq -S 'del(..|.id?, .create_time?)' "$OUT/high.json") >/dev/null \
  && echo "NO: low/high reasoning effort dump identical" || echo "yes"
echo "## unknown model item count: $(jq length "$OUT/unknown.json")"
echo "## prompt-input flags (no --ignore-user-config/--ignore-rules/--ephemeral/--sandbox):"
codex debug prompt-input --help | grep -E '^\s+-' 
```

Observed output on 2026-11-17 (abridged):

```
codex-cli 0.169.0
bundled  272000  872000  95
remote   500000  872000  95
[]                                   # no output-bound key in the catalog
unknown model rc=0
NO: low/high reasoning effort dump identical
## unknown model item count: 3       # vs 7 for a known model
```

Item sizes for `gpt-6.1-sol` with Ranger's switches, in UTF-8 bytes of text: `additional_tools` 17 894 (tool JSON), base-instructions developer message 21 534, then 5 940, 2 400 and 271, then a user context message of 2 130 and the synthetic draft at 43.

## Smallest concrete prerequisites (upstream)

Five capabilities are needed in the Codex CLI, in this order. Each one is small and testable.

1. **An output reserve.** Add a `model_max_output_tokens` config key, or an `exec` flag, that is forwarded as `max_output_tokens` on `ResponsesApiRequest`, with reasoning included. Without it the reserve half of the contract cannot exist. This is the single blocking prerequisite.
2. **An exact token count with no inference.** Either a bundled tokenizer per catalog `slug`, or a subscription-authenticated input-token-count endpoint, returning the token count of the fully framed request (`input` plus top-level `tools`, `reasoning`, `text` and instructions).
3. **A complete, settings-faithful request dump.** `codex debug request` would emit the exact `ResponsesApiRequest` that `exec` would send. It would accept every `exec` flag (`--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--sandbox`, `-m`), and it would refuse an unknown model. This extends [openai/codex#35706](https://github.com/openai/codex/issues/35706), which today is a request and not an implemented capability.
4. **Binding.** `exec --expect-request-sha256 <h>`, or `exec --request-file`, would refuse to send when the freshly built request (ids and timestamps normalised) differs, and would pin the catalog revision (ETag) used for capacity.
5. **No silent reduction.** An `exec` switch would map to `AutoCompactionDisabled` and fail closed on overflow.

With 1 to 4 in place, admission becomes: `count(request) + reserve ≤ context_window × effective% / 100` from the pinned catalog revision, checked and then bound by hash. Until then Ranger's Studio job can only estimate, and the node rules estimates out.

## Scope kept

No inference was run and no API key was used. No configuration, model choice or Studio budget was changed. No private draft or credential appears here; the probe text is synthetic. The source clone and probe outputs live under `/tmp/n3829-*`, outside the repository. This finding returns to the spawning decision, [#3827](https://github.com/the-metafactory/cortex/issues/3827), and files no integration build.
