# mlx-lm thinking / reasoning token budget: upstream status

Date: 2026-10-18. Context: pi-mlx-models Phase 5 (heavy-thinking model `mlx-community/KAT-Coder-V2.5-Dev-OptiQ-4bit`, qwen3_5_moe, needs adjustable thinking tokens).
Method: primary sources only (GitHub issues/PRs of ml-explore/mlx-lm via `gh`, plus the installed `server.py`). "F" = fact with citation. "UNVERIFIED" = could not confirm.

## 0. Bottom line

- F: No merged or open PR/issue in ml-explore/mlx-lm adds a thinking-budget parameter to `mlx_lm.server`. Every attempt found is CLOSED unmerged (section 2). Closure reasons: author withdrawal (#998) and a maintainer bulk-close of "non-essential" PRs/issues on 2026-08-21 (#1196, #1489, #1548, #1556, #1030, #1222). Sources: items below.
- F: The only open issue touching the topic is #914 (per-request thinking toggle, not a budget).
- F: The installed server has no budget parameter. `max_tokens` (and `max_completion_tokens`) is a single cap over reasoning and content together. Per-request `chat_template_kwargs` is honoured.

## 1. Installed version and server behaviour

| Thing | Value | Source |
|---|---|---|
| Installed mlx-lm | 0.32.2 | `/Users/trekkie/.pi/agent/pi-mlx-models/venv/lib/python3.14/site-packages/mlx_lm-0.32.2.dist-info` |
| Server file | `.../site-packages/mlx_lm/server.py` (`S:`) | |

- F: Token cap: `max_completion_tokens` wins, else `max_tokens`, else CLI `--max-tokens` (default 512). One cap, no separate reasoning allowance. `S:1307-1311`; CLI flag `S:2013`.
- F: Per-request `chat_template_kwargs` is read from the body (`S:1330`), passed into the request args (`S:1558`) and merged over the CLI `--chat-template-args` (`S:652-654`), then handed to `apply_chat_template` (`S:655-658`). So `{"enable_thinking": false}` works per request; CLI default via `--chat-template-args` (`S:2018-2023`).
- F: `reasoning_effort`: no occurrence in `server.py` (grep for `reasoning_effort`, `thinking_budget`, `reasoning_budget`, `max_think` returned nothing in any installed `mlx_lm/*.py`). It is only forwarded if a client puts it inside `chat_template_kwargs`, and only a template that reads it would act on it. Same grep on `main` server.py (fetched via `gh api`): no hits.
- F: Reasoning is split out in the response as `message.reasoning` (`S:1510-1511`), driven by a state machine (`S:692-698`, `S:1625-1628`); it only separates the text, it does not limit it.
- F: `tokenizer_utils.py:331-335, 392-393` maps the `enable_thinking` kwarg to a template-specific kwarg name (`thinking`) for custom renderers.
- F: The installed `generate.py` and `sample_utils.py` contain no thinking-budget code (grep for `thinking_budget`, `budget`; only `has_thinking` at `generate.py:1055,1070`). Note: #1308's body claims `mlx_lm.generate` has `--enable-thinking` and `--thinking-budget`; that is not borne out by the installed 0.32.2 source.

## 2. Issues and PRs (ml-explore/mlx-lm)

### 2.1 Would add a budget parameter (all CLOSED, none merged)

| # | Title | State / dates | Proposed parameter | Source |
|---|---|---|---|---|
| PR 998 | Add thinking budget support for reasoning models | CLOSED unmerged; opened 2026-03-14, closed 2026-03-20 by author ("underlying tool call generation issue ... makes this feature incomplete") | CLI `--thinking-budget N` and API `thinking_budget`; `ThinkingBudgetProcessor` forces `</think>` after N tokens inside `<think>`, masks EOS during/just after thinking | https://github.com/ml-explore/mlx-lm/pull/998 |
| PR 1196 | feat: add thinking budget with early-stopping prompt injection | CLOSED unmerged; opened 2026-04-25, closed 2026-08-21 | Request fields `thinking_budget` and `thinking_budget_message`; `make_thinking_budget_processor()` in `sample_utils.py` injects a transition sentence token by token then the think-end tokens (Qwen's recommended early-stop prompt) | https://github.com/ml-explore/mlx-lm/pull/1196 |
| PR 1489 | sample_utils: add make_reasoning_budget logits processor | CLOSED unmerged; opened 2026-07-06, closed 2026-08-21 | Library-only `make_reasoning_budget(think_close_id, max_think_tokens=N, tokenizer=...)`; hard cap plus token-cycle and repeated-line trips; opt-in, "not added to make_logits_processors"; no server flag (serving layer explicitly out of scope) | https://github.com/ml-explore/mlx-lm/pull/1489 |
| PR 1548 | sample_utils: dynamic cost-braked budget (stacks on #1489) | CLOSED unmerged; opened 2026-07-11, closed 2026-08-21 | `max_think_tokens` may be a zero-arg callable returning the live ceiling | https://github.com/ml-explore/mlx-lm/pull/1548 |
| PR 1556 | Commit-steering: a content-blind controller for reasoning run-on | CLOSED unmerged; opened 2026-07-13, closed 2026-08-21 | Opt-in activation-steering controller that shortens reasoning (not a token-count parameter) | https://github.com/ml-explore/mlx-lm/pull/1556 |

- F: Maintainer closing comment on the sibling #1030 (2026-08-21, zcbenz): "the number of PRs is way beyond our capacity to review so I'm closing the non-essential ones". The same date appears as the close date of #1196, #1489, #1548, #1556 and issue #1222, consistent with a bulk close. Only #1030 and #1222 carry the quoted comment in what I read; for the others the reason is UNVERIFIED beyond the matching date.
- F: PR 1196 comments (AirRunner, Thump604, 2026-04-25) note the budget counter drifts under MTP speculative verification because processors have no save/restore state protocol. Source: PR 1196 comments.

### 2.2 Issues

| # | Title | State / dates | Relevance | Source |
|---|---|---|---|---|
| 1308 | Feature Request: Expose `--kv-bits` and thinking parameters in `mlx_lm.server` | CLOSED 2026-09-09 (opened 2026-05-24) | Asks that `--enable-thinking` and `--thinking-budget` be exposed in the server. A 2026-07-26 comment says those two are "not covered by #1353 ... still unclaimed" and suggests a separate issue. Closed after the kv-bits half; no thinking-budget change followed (none in current server.py). | https://github.com/ml-explore/mlx-lm/issues/1308 |
| 1222 | Feature Request: Add native support to skip or block `<think>` reasoning content | CLOSED 2026-08-21 (opened 2026-04-28) | Asks for skipping/limiting thinking via a built-in option or custom stop strings. Closed by maintainer as non-essential. | https://github.com/ml-explore/mlx-lm/issues/1222 |
| 914 | Adjusting thinking/reasoning on a per-message basis? | OPEN (opened 2026-02-21) | Per-request on/off toggle through `chat_template_kwargs`; not a token budget. Ollama-style `think` param cited. | https://github.com/ml-explore/mlx-lm/issues/914 |
| 1352 | Gemma 4 with thinking enabled produces only reasoning field, content is empty | OPEN (opened 2026-06-05) | Workaround is `chat_template_kwargs: {"enable_thinking": false}`; no budget. Cross-links #1308, #914. | https://github.com/ml-explore/mlx-lm/issues/1352 |
| 1803 | per-request `chat_template_kwargs` bypasses the prompt cache (0.31.3) | OPEN (opened 2026-08-29) | Reporter sees no prefix reuse with per-request kwargs; a commenter could not reproduce on 0.31.3 and main. Relevant if the extension sends `enable_thinking` per request. | https://github.com/ml-explore/mlx-lm/issues/1803 |

### 2.3 Related merged / closed PRs on the toggle (not budgets)

- PR 829 "server: support chat_template_kwargs and top_logprobs": MERGED (opened 2026-01-30). Origin of the per-request kwargs. https://github.com/ml-explore/mlx-lm/pull/829
- PR 1030 "Fix per-request enable_thinking toggle in server": CLOSED unmerged 2026-08-21 (fixes #914; state machine and checkpoints use per-request `enable_thinking` first, then CLI args, then tokenizer default). https://github.com/ml-explore/mlx-lm/pull/1030
- PR 1361 "skip channel thinking detection for Gemma 4 (#1352)": CLOSED. PR 1300 "Fix enable_thinking TypeError in deepseek_v32 chat template": CLOSED.

## 3. Searches run (all on ml-explore/mlx-lm unless noted)

- Issues: "thinking budget", "reasoning budget", "max_thinking_tokens", "enable_thinking", "reasoning_effort", "thinking tokens", "think tokens", "max_completion_tokens", "reasoning tokens", "chat_template_kwargs", "thinking limit", "think", "max_think_tokens", "reasoning_budget", "thinking_budget", "early-stopping", "runaway reasoning".
- PRs: "thinking", "reasoning", "think budget", "enable_thinking", "reasoning_effort", "chat_template_kwargs", plus the same budget phrasings above.
- ml-explore/mlx-examples and ml-explore/mlx: "thinking budget" returned no results. A "thinking-budget" re-search hit the GitHub rate limit and was not repeated.
- Source: installed `server.py`, `generate.py`, `sample_utils.py`, `tokenizer_utils.py`; `main` `server.py` and `generate.py` via `gh api` raw contents.

## 4. Limits

- `gh search` returns ranked subsets (limit 10-30 per query); an item with unusual wording could be missed. `reasoning_effort` produced no relevant server hits in issues or PRs (only an unrelated model-support PR text match).
- Merge status of work after 2026-10-17 not checked.
