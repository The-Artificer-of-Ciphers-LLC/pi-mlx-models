# mlx-lm configuration gap analysis for pi-mlx-models

Date: 2026-10-17. Branch `refactor/deepen-modules` (HEAD 6d078e5), package version 0.1.4.
Method: primary sources only (source code and official docs, read directly). "F" = fact with citation. "R" = recommendation. "UNVERIFIED" = could not confirm.

## 0. Versions examined

| Thing | Version | Source |
|---|---|---|
| mlx-lm, PyPI latest | 0.32.2 (uploaded 2026-10-16), `Requires-Python >=3.11`, `transformers>=5.7.0` | https://pypi.org/pypi/mlx-lm/json (`info.requires_python`, `requires_dist`) |
| mlx-lm, GitHub `main` | commit 93e6d4a6447b3080861985947f0820e76fcb957d (2026-10-16), tag v0.32.2 | https://github.com/ml-explore/mlx-lm (API: `/commits/main`, `/tags`) |
| main vs PyPI | `mlx_lm/server.py` is byte-identical (2094 lines, `diff` empty) | raw `server.py` @93e6d4a vs the 0.32.2 wheel |
| pi-coding-agent (installed) | 0.73.0 (npm latest is 0.73.1) | `node_modules/@mariozechner/pi-coding-agent/package.json`; https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest |
| pi-ai (installed) | 0.73.0 | `node_modules/@mariozechner/pi-ai/package.json` |
| pi-mlx-models on npm | 0.1.4 (published 2026-05-06) | https://registry.npmjs.org/pi-mlx-models |

Paths below are relative to `node_modules/@mariozechner/pi-coding-agent/` (`PI:`), `mlx_lm/` of the 0.32.2 wheel (`MLX:`), or the repo root.

---

## 1. mlx-lm inputs

### 1.1 `mlx_lm.server` CLI flags (identical on `main` and PyPI 0.32.2)

Source: `MLX:server.py:1922-2079` (argparse in `main()`).

| Flag | Type / default | Meaning | Added in |
|---|---|---|---|
| `--model` | str, none | Local path or HF repo id (1925). Optional: without it the server loads per request. | old |
| `--adapter-path` | str, none | LoRA adapter dir (1930) | old |
| `--host` | `127.0.0.1` | bind address (1935) | old |
| `--port` | int, **8080** | bind port (1941). The extension defaults to 11434. | old |
| `--allowed-origins` | comma list, `*` | CORS (1947) | 0.31.2 |
| `--draft-model` | str, none | speculative decoding draft model (1953) | old |
| `--num-draft-tokens` | int, 3 | draft tokens per step (1959) | 0.28.0 |
| `--trust-remote-code` | flag | passed to `load()` and the tokenizer config (398, 433, 441) | old |
| `--log-level` | DEBUG/INFO/WARNING/ERROR/CRITICAL, INFO | (1970) | old |
| `--chat-template` | str, "" | override tokenizer chat template (1977) | old |
| `--use-default-chat-template` | flag | fall back to tokenizer default (1983, 445-447) | old |
| `--temp` | float, 0.0 | default sampling temperature (1989) | 0.28.0 |
| `--top-p` | float, 1.0 | (1995) | 0.28.0 |
| `--top-k` | int, 0 (off) | (2001) | 0.28.0 |
| `--min-p` | float, 0.0 (off) | (2007) | 0.28.0 |
| `--max-tokens` | int, 512 | default when the request omits it (2013) | 0.28.0 |
| `--chat-template-args` | JSON str, `{}` | extra kwargs for `apply_chat_template`, e.g. `{"enable_thinking":false}` (2019-2023, 650-654) | 0.28.0 |
| `--decode-concurrency` | int, 32 | parallel decode when batchable (2025) | 0.31.0 |
| `--prompt-concurrency` | int, 8 | parallel prefill (2031) | 0.31.0 |
| `--prefill-step-size` | int, 2048 | (2037) | 0.31.0 |
| `--prompt-cache-size` | int, 10 | LRU of distinct KV caches (2043, 1914) | 0.31.0 |
| `--prompt-cache-bytes` | size str (`"2GB"`, `"500M"`), none | KV cache byte cap (2049; parser `MLX:utils.py:86-95`) | 0.31.0 |
| `--kv-bits` | int, none | KV quantisation. **Disables batching** (2054-2059; `SERVER.md`) | 0.32.0 |
| `--kv-group-size` | int, 64 | (2062) | 0.32.0 |
| `--quantized-kv-start` | int, 5000 | token position where quantisation starts (2068; `generate.py:49`) | 0.32.0 |
| `--pipeline` | flag | pipeline instead of tensor parallelism; distributed only (2075, 381-384) | 0.31.0 |

"Added in" comes from diffing the `--flag` literals in each PyPI wheel's `server.py` (0.24.0, 0.28.0, 0.30.0, 0.31.0, 0.31.1, 0.31.2, 0.31.3, 0.32.0-0.32.2). Reading the diffs: 0.24.0 had 9 flags. 0.28.0 added `--num-draft-tokens`, the sampling defaults, `--max-tokens` and `--chat-template-args`. 0.31.0 added the concurrency and prompt-cache flags and `--pipeline`. 0.31.2 added `--allowed-origins`. 0.32.0 added the three KV flags.

**Differences that matter to this repo**

- F: 0.32.0 raised `Requires-Python` from `>=3.8` to `>=3.11` (PyPI metadata, 0.31.3 vs 0.32.0). The extension accepts Python 3.10-3.13 (`src/runtime.ts:40`) and installs `mlx-lm>=0.24.0` (`src/runtime.ts:116`). On 3.10, pip silently resolves to 0.31.x, which lacks the KV flags. R: the README's "Python 3.10-3.13" is stale for the latest mlx-lm.
- F: PyPI has no upper Python bound. The extension rejects Python above 3.13 (`src/runtime.ts:40`) and cannot find 3.14+. The shell on this machine has Python 3.15 (observed from a traceback path; `/opt/homebrew/Cellar/python@3.15`).
- F: the extension launches `python -m mlx_lm.server`, which prints a deprecation notice: use `mlx_lm.server` or `python -m mlx_lm server` (`MLX:server.py:2089-2093`; launch at `src/server.ts:36`). Harmless but noisy.
- F: the server ships a warning that it "is not recommended for production as it only implements basic security checks" (`MLX:server.py:1894-1897`). No auth option exists in argparse.

### 1.2 Per-request parameters honoured (POST `/v1/chat/completions`, `/chat/completions`, `/v1/completions`)

Source: `MLX:server.py:1239-1352` (parse), `1379-1407` (validation), `SERVER.md` "Request Fields".

| Parameter | Behaviour / validation |
|---|---|
| `model` | If not the CLI model, the server **loads that model on demand** (`load()` 477-486, request read at 1301). `"default_model"` maps to `--model`. |
| `messages`, `role_mapping`, `tools` | chat input; tool calling only if the chat template supports it, else a warning (644-649, 1760-1766) |
| `stream`, `stream_options` | 1299-1300 |
| `max_completion_tokens`, then `max_tokens` | first non-null wins; falls back to `--max-tokens`; int >= 1 (1307-1311, 1382) |
| `temperature` | >= 0 (1383) |
| `top_p` | 0..1 (1384); `top_k` int >= 0 (1385); `min_p` 0..1 (1386) |
| `repetition_penalty` (+`_context_size`), `presence_penalty` (+`_context_size`), `frequency_penalty` (+`_context_size`) | 1318-1323, 1388-1393; context size default 20 |
| `xtc_probability`, `xtc_threshold` | 0..1 (1324-1325, 1396-1397) |
| `logit_bias` | dict of int token id to float (1326, 1403-1407) |
| `logprobs` (bool), `top_logprobs` (-1 or 0..11) | 1327-1328, 1394-1395. `SERVER.md` documents `logprobs` as an integer 1-10; the code validates a bool. The docs and code disagree. |
| `seed` | int or null (1329, 1400) |
| `stop` | str or list (1340-1342) |
| `chat_template_kwargs` | merged over `--chat-template-args` (1330, 650-654) |
| `adapters` | str path, loads a LoRA adapter per request (1306, 1399) |
| `draft_model`, `num_draft_tokens` | per-request speculative decoding (1302-1305, 1387) |

Response facts:

- F: reasoning text comes back as `choices[].message|delta.reasoning` (`MLX:server.py:1510-1511`). pi's OpenAI-completions provider reads `reasoning_content`, `reasoning` and `reasoning_text` (`node_modules/@mariozechner/pi-ai/dist/providers/openai-completions.js:184`). The two match.
- F: `GET /v1/models` lists every **HF-cache repo that looks like an MLX model**, not just the loaded one (`MLX:server.py:1821-1852`), plus the CLI `--model` if it is a local path (1854-1864). Entries carry only `id`, `object`, `created`, with no context length or capabilities. This repo's `discoverModelIds()` (`src/index.ts:26-35`) therefore registers every cached model with pi.
- F: `GET /health` returns 200/503 (`MLX:server.py:1793, 1800-1811`). The extension polls `/v1/models` instead (`src/server.ts:91`).
- F: batching is disabled with a draft model or non-mergeable caches (`MLX:server.py:459-463`) and with `--kv-bits` (`SERVER.md`).
- F: the vision registry in `MLX:processors/__init__.py` lists only `muse_spark`. Image input is gated on `vision_config` plus a registered processor, and needs Pillow (`vision` extra in `requires_dist`). UNVERIFIED whether images work for the gemma-4 preset through `mlx_lm.server`.

### 1.3 Environment variables

| Var | Effect | Source |
|---|---|---|
| `HF_HOME` | HF data and cache root; hub cache is `$HF_HOME/hub`. Set by the extension (`src/server.ts:37`) | https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables |
| `HF_HUB_CACHE` | overrides the hub cache dir | same page |
| `HF_TOKEN` | auth for gated or private repos | same page |
| `HF_HUB_OFFLINE` | no network, cache only | same page |
| `HF_HUB_DISABLE_TELEMETRY` | set to 1 by the extension | same page; `src/server.ts:37` |
| `HF_HUB_DOWNLOAD_TIMEOUT` (10 s), `HF_HUB_ETAG_TIMEOUT` (10 s) | slow-link tuning | same page |
| `HF_XET_HIGH_PERFORMANCE` | faster downloads; `HF_HUB_ENABLE_HF_TRANSFER` is deprecated | same page |
| `HF_ENDPOINT` (mirror) | UNVERIFIED: not on the page fetched |  |
| `MLXLM_USE_MODELSCOPE` | `true` switches downloads to ModelScope | `MLX:utils.py:30` |
| `TRANSFORMERS_CACHE` | set by the extension (`src/server.ts:37`). Whether transformers >= 5.7 still honours it is UNVERIFIED. | |

The extension passes `process.env` through (`src/server.ts:37`), so a user's `HF_TOKEN` already reaches the server today; it is just undocumented.

### 1.4 Other entry points (only those relevant to a launcher)

Console scripts (`mlx_lm-0.32.2.dist-info/entry_points.txt`): `mlx_lm.server`, `mlx_lm.generate`, `mlx_lm.chat`, `mlx_lm.convert`, `mlx_lm.cache_prompt`, `mlx_lm.lora`, `mlx_lm.fuse`, `mlx_lm.manage`, `mlx_lm.upload`, and others.

- `mlx_lm.manage` (cache management) could back a future "list or delete downloaded models" command. Its flags were not read; UNVERIFIED.
- `mlx_lm.convert` (quantise HF models to MLX) is out of scope for a launcher.
- `mlx_lm.cache_prompt` (precomputed prompt cache files) does not map onto the server. The server has its own in-memory LRU (`--prompt-cache-size`, `--prompt-cache-bytes`).

---

## 2. pi extension and package interface (pi-coding-agent 0.73.0)

All from `PI:docs/*.md` and `PI:dist/**/*.d.ts` unless noted.

| Capability | Fact | Source |
|---|---|---|
| Extension shape | default-exported factory `(pi: ExtensionAPI) => void \| Promise<void>`. If async, pi awaits it before startup continues. Provider registrations queued in the factory are flushed afterwards. | `docs/extensions.md:153-216`, `dist/core/extensions/types.d.ts` (`ExtensionFactory`) |
| `registerCommand(name, {description, handler(args, ctx), getArgumentCompletions?})` | `args` is one raw string. Duplicate names get `:1` and `:2` suffixes. | `docs/extensions.md:1372-1405` |
| `registerFlag(name, {description?, type: "boolean"\|"string", default?})` and `getFlag(name)` | Only two types. Flags show in `pi --help` (`dist/main.js:484-487`). Unknown `--x` makes pi error "Unknown option" (`dist/core/agent-session-services.js:39-44`). | `docs/extensions.md:1457-1472`, `types.d.ts:823-829` |
| Flag timing | `getFlag` reads `runtime.flagValues` (`dist/core/extensions/loader.js:196-201`). Values are applied only **after** `resourceLoader.reload()` has run the factories (`dist/core/agent-session-services.js:63-81`). So `getFlag` inside the factory body is empty; use it in handlers and events. This is my reading of the code, not documented. | |
| Flag namespace | Flag names are global across extensions. First registration wins in `getFlags()` (`dist/core/extensions/runner.js:239-248`). R: prefix with `mlx-`. | |
| `registerProvider(name, config)` | `name`, `baseUrl`, `apiKey` (env var name or literal), `api` (`openai-completions` etc.), `headers`, `authHeader`, `models[]` (replaces all existing), `oauth`, `streamSimple`. Calls after startup take effect immediately, no `/reload`. `unregisterProvider` exists. | `docs/extensions.md:1541-1624`, `types.d.ts:938-969` |
| `ProviderModelConfig` | `id`, `name`, `api?`, `baseUrl?`, `reasoning`, `thinkingLevelMap?`, `input: ("text"\|"image")[]`, `cost`, `contextWindow`, `maxTokens`, `headers?`, `compat?`. | `types.d.ts:971-1000`, `docs/custom-provider.md:586-646` |
| `compat` fields | `supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `maxTokensField`, `requiresToolResultName`, `requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `requiresReasoningContentOnAssistantMessages`, `thinkingFormat` (`openai`/`deepseek`/`zai`/`qwen`/`qwen-chat-template`), `cacheControlFormat`. | `docs/custom-provider.md:628-645` |
| `qwen-chat-template` | Sends `chat_template_kwargs: {enable_thinking, preserve_thinking: true}` when `model.reasoning`. mlx-lm accepts `chat_template_kwargs`. | `pi-ai/dist/providers/openai-completions.js:417-421`; `MLX:server.py:1330` |
| Compat defaults for unknown local URLs | `supportsDeveloperRole: true`, `supportsStore: true`, `supportsReasoningEffort: true`, `maxTokensField: max_completion_tokens`. | `pi-ai/dist/providers/openai-completions.js:830-858` |
| `before_provider_request` event | Runs after the payload is built; returning a new object replaces it. This lets an extension inject non-standard fields (`top_k`, `min_p`, `repetition_penalty`, `chat_template_kwargs`, `seed`) into requests to this provider. Docs call it "mainly useful for debugging", but it is a supported hook. | `docs/extensions.md:601-616` |
| UI | `ctx.ui.select(title, options, opts?)`, `confirm(title, msg)`, `input(title, placeholder?)`, `editor(title, prefill)`, `notify(msg, "info"\|"warning"\|"error")`, `setStatus(key, text)`, `setWidget(key, lines, {placement})`. Dialogs take a `timeout`/`AbortSignal`. In json and print modes the UI methods are no-ops, so check `ctx.hasUI`. | `docs/extensions.md:2114-2131, 2184-2214, 2506-2514`; `types.d.ts` (`ExtensionUIContext`, lines 68-96) |
| Events used or useful | `session_start`, `session_shutdown` (with `reason`), `model_select`, `before_agent_start`, `before_provider_request`, `after_provider_response`. | `docs/extensions.md:266-336, 452-463, 636-656` |
| Config / settings API for extensions | **None found.** `ExtensionAPI` has no settings accessor (`grep -i settings dist/core/extensions/types.d.ts` hits only a compat comment). `getAgentDir()` is exported (`dist/index.d.ts:1`; used in `docs/sdk.md:133`), and `PI_CODING_AGENT_DIR` overrides it (`dist/config.js:315, 335`). Extensions must read and write their own files. Whether `settings.json` tolerates unknown keys is UNVERIFIED. | |
| pi's own precedence precedent | `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json. Project `.pi/settings.json` overrides global `~/.pi/agent/settings.json`, nested objects merged. | `docs/settings.md:7-8, 170, 260` |
| `models.json` | User-level custom providers and models in `~/.pi/agent/models.json`. `modelOverrides` can override `name`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, `headers`, `compat` per model (documented for built-in providers). Whether it can override models an extension registers is UNVERIFIED. | `docs/models.md:1-60, 300-308` |
| Package manifest | `package.json` `pi: { extensions, skills, prompts, themes, image, video }`, keyword `pi-package`. Paths are relative to the package root, with globs and `!` exclusions. | `docs/packages.md` "Creating a Pi Package", "Gallery Metadata" |
| Gallery | https://pi.dev/packages "lists Extensions, skills, prompt templates, and themes published to npm" (5,334 packages / 107 pages at fetch time). Filter by name/description/author and type, sort by downloads/recent/A-Z. Cards show description, author, monthly figure, link to npm/repo. `docs/packages.md` says it "displays packages tagged with `pi-package`". The page describes no submission step. Whether `pi-mlx-models` is listed is UNVERIFIED (only page 1 was visible). | https://pi.dev/packages (fetched 2026-10-17); `docs/packages.md` |
| Install and config for users | `pi install npm:pkg[@ver]`, `git:`, local path. Writes `packages` into `~/.pi/agent/settings.json` (or `.pi/settings.json` with `-l`). `pi config` toggles resources. Versioned specs are pinned and skipped by `pi update`. | `docs/packages.md` "Install and Manage", "Package Sources" |
| Peer deps | `@mariozechner/pi-coding-agent` etc. go in `peerDependencies` with `"*"`. Matches this repo. | `docs/packages.md` "Dependencies"; `package.json:42-44` |

---

## 3. Gap analysis

### 3.1 mlx-lm input vs extension vs pi's ability

"Limit" says where pi's API, not effort, is the constraint.

| mlx-lm input | Extension today | pi can support exposing it? | Limit / note |
|---|---|---|---|
| `--model` | yes: preset, key, number, or full id (`src/presets.ts:32-50`) | yes | none |
| `--host`, `--port` | env only `PI_MLX_MODELS_HOST`/`PORT` (`src/config.ts:4-5`); defaults 11434, which is Ollama's well-known port | yes | none |
| `--allowed-origins` | no | yes (own config) | low value; server is local |
| `--draft-model`, `--num-draft-tokens` | no | yes (own config, command arg) | none |
| `--trust-remote-code` | no | yes, but needs a `ctx.ui.confirm` gate because it executes remote code | none. Security-sensitive. |
| `--log-level` | no | yes | stderr is already parsed for progress (`src/server.ts:75-84`) and a lower level could change what is emitted |
| `--chat-template`, `--use-default-chat-template` | no | yes | none |
| `--temp`, `--top-p`, `--top-k`, `--min-p`, `--max-tokens` (server defaults) | no | yes | pi sends `temperature` only if set (`openai-completions.js:392-394`) and always sends max tokens (385-389). So `--temp` and `--max-tokens` rarely matter; `--top-k`/`--min-p`/`--top-p` defaults do apply, because pi does not send them. |
| `--chat-template-args` | no | yes | Overlaps pi's `thinkingFormat: "qwen-chat-template"`. Choose one owner to avoid conflicts. |
| `--decode-concurrency`, `--prompt-concurrency`, `--prefill-step-size` | no | yes | version-gated (>= 0.31.0) |
| `--prompt-cache-size`, `--prompt-cache-bytes` | no | yes | version-gated (>= 0.31.0); biggest practical lever for agent loops that resend long prefixes |
| `--kv-bits`, `--kv-group-size`, `--quantized-kv-start` | no | yes | version-gated (>= 0.32.0); disables batching |
| `--pipeline`, distributed | no | not meaningful for a single-Mac launcher | out of scope |
| `--adapter-path` | no | yes | none |
| Per-request `top_k`, `min_p`, `repetition_penalty`, `presence/frequency_penalty`, `xtc_*`, `logit_bias`, `seed`, `stop`, `chat_template_kwargs`, `adapters`, `draft_model` | no | **partly**: `before_provider_request` can inject fields (`docs/extensions.md:601`). | pi has no first-class per-provider "extra body params" field in `ProviderConfig`; the hook is the only route. It also affects every request to the provider, including the warm-up, which is sent directly by the extension (`src/server.ts:109-122`). |
| `HF_TOKEN`, `HF_HUB_OFFLINE`, `HF_ENDPOINT`, `HF_XET_HIGH_PERFORMANCE` | pass-through only; `HF_HOME` forced (`src/server.ts:37`) | yes | `HF_HOME` is not user-configurable today |
| `/v1/models` listing all cached models | registers all of them (`src/index.ts:26-35`) | yes | all cached models appear in `/model`, but a request for a non-loaded one makes the server swap models silently (`MLX:server.py:477-486`) |
| mlx-lm version | `mlx-lm>=0.24.0`, always `--upgrade` on `/mlx-init` (`src/runtime.ts:116`) | yes | version drift: 0.32.0 changed `Requires-Python` and added flags |
| Python selection | hard-coded Homebrew/system candidates, 3.10-3.13 (`src/runtime.ts:21-46`) | yes | mismatch with mlx-lm >= 0.32 (needs >= 3.11) |
| pip index | hard-coded `https://pypi.org/simple/` (`src/runtime.ts:19`) | yes | no mirror or offline option |
| Data dirs | `~/.pi/agent/pi-mlx-models/{venv,models}` (`src/config.ts:10-13`); ignores `PI_CODING_AGENT_DIR` | yes (`getAgentDir()` is exported) | the extension should honour `PI_CODING_AGENT_DIR` (`dist/config.js:335`) |
| Health and warm-up timeouts | 600 s / 1800 s, internal only (`src/server.ts:57-58`) | yes | no user knob |
| Python-side stderr parsing | regexes on tqdm text (`src/server.ts:76-83`) | n/a | brittle: fixed against `huggingface_hub` output formats; UNVERIFIED across the current transformers 5 and hub versions |

### 3.2 Provider model metadata

Current: `reasoning:false`, `input:["text"]`, `contextWindow:128000`, `maxTokens:8192`, zero cost, no `compat` (`src/index.ts:37-47`).

| Field | Hard-coded now | Derivable from the model? | Evidence |
|---|---|---|---|
| `contextWindow` | 128000 for every model | **Yes, mostly.** `config.json` `max_position_embeddings` (top-level, or under `text_config` for multimodal wrappers). Fetched 2026-10-17 for the 5 presets: Qwen3-4B-Instruct-2507 = 262144; DeepSeek-R1-Distill-Qwen-1.5B = 131072; gemma-4-e2b-it = 131072 (nested in `text_config`); Llama-3.2-3B = 131072; SmolLM3-3B = 65536. | https://huggingface.co/mlx-community/<model>/raw/main/config.json. So 128000 is wrong for 2 of 5 presets (too low for Qwen3, too high for SmolLM3). `tokenizer_config.json` `model_max_length` disagrees for some (R1-distill 16384, gemma 1e30), so it is unreliable. |
| `maxTokens` | 8192 | **No.** There is no output cap in `config.json`. | R: make it a user setting, default `min(8192, contextWindow/4)` or similar. The server enforces only `>= 1` (`MLX:server.py:1382`). |
| `reasoning` | false | **Heuristic only.** mlx-lm itself detects thinking from the tokenizer and chat template (`has_thinking`, `MLX:tokenizer_utils.py:450-451`) and returns `reasoning` separately (`server.py:1510`). Not exposed in `/v1/models`. Of the presets, only the DeepSeek-R1 distill's `tokenizer_config.json` template contains "think". Gemma-4 and SmolLM3 templates were not in `tokenizer_config.json`; they probably live in a separate `chat_template.jinja` (UNVERIFIED, not fetched). | Qwen3-4B-**Instruct-2507** is the non-thinking variant: template has no "think", consistent with reasoning=false. |
| `thinkingLevelMap` / `compat.thinkingFormat` | unset | n/a | If `reasoning:true`, pi sends `reasoning_effort` and the `developer` role by default for unknown URLs (`openai-completions.js:830-858`). R: also set `compat.supportsDeveloperRole:false`, `supportsReasoningEffort:false`. Whether mlx-lm templates accept `developer` is UNVERIFIED. For Qwen3-style, `thinkingFormat:"qwen-chat-template"` would send `enable_thinking`. |
| `input` | text | **Weak signal.** `vision_config` present in `config.json`: gemma-4 = true, the other four = false. But mlx-lm's processor registry lists only `muse_spark`, so a `vision_config` is not proof the server can take images. | R: default text-only; image only by explicit opt-in. |
| `cost` | zeros | n/a | fine |
| `name` | `<id> (Local)` | n/a | fine |

Where config.json lives: after download, at `$HF_HOME/hub/models--<org>--<name>/snapshots/<rev>/config.json` (HF cache layout; layout not re-verified in this session, only the env var semantics). Before download, over HTTPS from the hub (gated repos need `HF_TOKEN`). Offline use needs the cache.

### 3.3 Other gaps worth recording

- F: provider `apiKey: "DUMMY"` is a literal (`src/index.ts:57`); pi treats the string as an env var name or literal (`docs/extensions.md:1581`). This is fine for a local, unauthenticated server.
- F: README documents `/mlx-start [hf-model-id]` (README.md:51) while the command accepts a preset number or key too (`src/index.ts:206`).
- F: `PI_MLX_MODELS_BASE_URL` is read once at import (`src/config.ts:6`). Changing it does not change the spawned `--host/--port`, so a non-local base URL cannot be combined with an auto-spawned server. Config is also frozen at import time, which blocks flag-derived values (see flag timing in section 2).
- F: no `.github/` directory, no CHANGELOG, and tests run with `node --test` (`package.json:scripts.test`).

---

## 4. Deployment plan (recommendations)

### 4.0 Config surface and precedence (R)

| Layer | What | Why |
|---|---|---|
| 1. Command args | `/mlx-start <model> [--key value ...]` for per-launch overrides, plus `ctx.ui.select/input/confirm` wizards when no args | commands are the extension's main UI; `registerCommand` already gives raw args |
| 2. CLI flags | A small set only, prefixed `--mlx-*` (e.g. `--mlx-model`, `--mlx-profile`), read in handlers | flags are `boolean\|string` only and global (section 2); keep the surface minimal |
| 3. Env | existing `PI_MLX_MODELS_{PORT,HOST,BASE_URL,DEFAULT_MODEL}` unchanged, plus new `PI_MLX_MODELS_*` names only if cheap | back-compat and pi's own order is flag > env > settings (`docs/settings.md:170`) |
| 4. Project file | `.pi/pi-mlx-models.json` | mirrors pi's project override of global (`docs/settings.md:260`) |
| 5. Global file | `~/.pi/agent/pi-mlx-models/config.json` (under existing `DATA_DIR`, honouring `PI_CODING_AGENT_DIR`) | no pi settings API for extensions; avoids touching pi's `settings.json`, whose tolerance of unknown keys is UNVERIFIED |
| 6. Built-ins | today's defaults | unchanged behaviour when nothing is set |

Precedence: command args > flags > env > project file > global file > preset defaults > built-ins. Merge nested objects (as pi does). Validate with a hand-written schema check (the repo has zero runtime dependencies, `package.json`) and report every bad field in one `ctx.ui.notify(..., "error")` rather than failing at spawn time.

File shape (R): `{ "server": {...mlx flags...}, "request": {...injected sampling params...}, "models": { "<id-or-preset-key>": { "contextWindow", "maxTokens", "reasoning", "input", "server": {...} } }, "runtime": { "mlxLm": "==0.32.2", "python": "...", "pipIndex": "..." } }`. Per-model blocks replace the current preset table as data, so users can add presets.

### Phase 1: groundwork and safe fixes (no new user-facing options)

- Scope: extract a pure `buildServerArgs(spec)` and a `LaunchSpec` type; `ServerHost.spawn(model)` becomes `spawn(spec)`. Make `config.ts` lazy (a `loadConfig()` function instead of import-time constants). Honour `PI_CODING_AGENT_DIR` via `getAgentDir()`. Fix Python gate to 3.11+ for mlx-lm >= 0.32 and decide on the upper bound. Use `mlx_lm.server` module entry that avoids the deprecation print (`python -m mlx_lm server`).
- Files: `src/config.ts`, `src/server.ts`, `src/runtime.ts`, `src/index.ts`, tests `src/server.test.ts`, `src/runtime.test.ts`.
- Tests: existing fake `ServerHost` and `RuntimeHost` seams (`src/server.ts:21-25`, `src/runtime.ts:13-17`) assert argv exactly equals today's for default config (golden test).
- Risk: low; the argv golden test is the safety net. `python -m mlx_lm server` is UNVERIFIED on mlx-lm 0.24-0.31 (it came from the 0.32.2 deprecation text), so guard by version or keep the old form behind a fallback.

### Phase 2: model metadata from config.json

- Scope: new `src/modelinfo.ts`: read `config.json` from the HF cache snapshot, else fetch from the hub (timeout, `HF_TOKEN` header, offline-tolerant); derive `contextWindow` (`text_config.max_position_embeddings ?? max_position_embeddings`); optional reasoning heuristic from `tokenizer_config.json` / `chat_template.jinja`; overrides from config. Replace `asProviderModels`. Also restrict `discoverModelIds` to the launched model plus an opt-in "all cached models" setting.
- Files: new `src/modelinfo.ts`, `src/index.ts`, `src/presets.ts` (preset overrides), tests with fixture `config.json` files for the 5 presets (values in 3.2).
- Test: pure function tests with the fixtures; fetch behind an injected `fetch` as in `ServerHost`.
- Risk: medium. Wrong `contextWindow` makes pi compact too late or too early; clamp with a user cap. Auto reasoning=true changes request shape (`reasoning_effort`, `developer` role), so ship it default-off or only with the `compat` settings in 3.2.

### Phase 3: server flags in config (the table in 1.1)

- Scope: `server` block mapped to flags, with `minMlxLm` gating (skip or warn on a flag the installed version lacks; read the installed version via `python -c "import mlx_lm; print(mlx_lm.__version__)"`, `MLX:_version.py` exists, but the attribute name is UNVERIFIED). Include `trustRemoteCode` behind `ctx.confirm` and never from the project file without confirmation (a cloned repo could otherwise enable remote code execution).
- Files: `src/config.ts` (or new `src/settings.ts`), `src/server.ts`, `src/index.ts` (`/mlx-start` arg parser), README.
- Test: table-driven argv tests per flag; validation tests (bad type, out-of-range, unknown key, flag newer than installed mlx-lm).
- Risk: medium. Flag drift across mlx-lm versions is the main hazard (1.1). `--kv-bits` silently disables batching, so surface that in the notify text.

### Phase 4: per-request parameters

- Scope: `request` block injected through `pi.on("before_provider_request")`, scoped to payloads for this provider only (check model/provider on `ctx`, field names to verify against `types.d.ts` `BeforeProviderRequestEvent`). Whitelist: `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`, `xtc_*`, `seed`, `stop`, `chat_template_kwargs`. Never override a field pi already set.
- Files: `src/index.ts` (or new `src/request.ts`), tests with synthetic payloads.
- Risk: medium. The hook is documented as a debugging tool; payload shape may change between pi versions. Mitigate with a version range in `peerDependencies` once a floor is chosen, plus a payload-shape guard (no-op when unrecognised).

### Phase 5: runtime options and flags

- Scope: `runtime.mlxLm` version spec (default pinned to a tested range instead of unbounded `--upgrade`), `python` path, `pipIndex`, `HF_HOME`/`HF_TOKEN`/`HF_HUB_OFFLINE`/`HF_XET_HIGH_PERFORMANCE` pass-through. Register `--mlx-*` flags (at most a few). Add `/mlx-config` (show effective merged config and where each value came from) and `/mlx-status`.
- Files: `src/runtime.ts`, `src/index.ts`, `src/config.ts`, README.
- Test: runtime fake host asserting pip arguments; precedence tests across the six layers.
- Risk: low-medium. `/mlx-config` doubles as the debugging aid for precedence bugs.

### Phase 6: docs and release

- README: replace the two-section config (README.md:71-85) with a layered config reference, the table of keys, the precedence order, an example file, the Python requirement (3.11+ for mlx-lm >= 0.32), and the security note on `trustRemoteCode`.
- Version: semver minor bump (new options, env vars unchanged) to 0.2.0 via `npm version minor`; `prepack` already builds (`package.json:scripts.prepack`). Publish with `npm publish`. The gallery is described as listing packages published to npm and tagged `pi-package` (`docs/packages.md`; https://pi.dev/packages), and `keywords` already contains `pi-package` and `pi.image` is set (`package.json:21-27, 39-40`). No separate gallery submission step is documented; confirm listing and the install path (`pi install npm:pi-mlx-models`) after publish.
- Add a CHANGELOG.md (none exists) and CI (no `.github/`): at least `npm test` and `npm run build`. Consider a smoke job that installs the packed tarball.
- Risk: low. Test an install into a clean agent dir using `PI_CODING_AGENT_DIR` pointing at a temp directory (`dist/config.js:335`).

### Open decisions for the owner

1. Config file location and format: own JSON under `DATA_DIR` plus project `.pi/pi-mlx-models.json` (recommended), or pi's `settings.json` (needs verification that unknown keys survive).
2. Env vs file precedence: env above files (pi precedent, preserves current behaviour) or file above env.
3. mlx-lm version policy: pin a tested range, or keep floating `>=` with `--upgrade`. Floating already caused a Python-floor change in 0.32.0.
4. Python policy: raise the floor to 3.11 and lift the 3.13 ceiling, or keep 3.10-3.13 and cap mlx-lm below 0.32 on 3.10.
5. Default port: keep 11434 (collides with Ollama's default) or move to mlx-lm's 8080 (breaking for existing users; would need a migration note).
6. Registering every cached model in `/model` vs only the launched one (current behaviour is all cached; see 1.2).
7. Auto-derived `reasoning` and `input:["image"]`: default on, off, or opt-in per model.
8. `trustRemoteCode`: allow at all; if so, global config only, with a confirm dialog.
9. Whether to use `before_provider_request` for sampling params given it is documented for debugging, or to ask pi upstream for a provider-level extra-params field (would remove the pi API limit noted in 3.1).
10. Scope creep control: whether to expose distributed/pipeline, ModelScope, `mlx_lm.manage` model deletion.

## 5. Not verified

- Whether pi `settings.json` and `models.json` overrides apply to extension-registered providers.
- Whether `chat_template.jinja` files contain think tokens for the gemma-4 and SmolLM3 presets.
- Whether image input works through `mlx_lm.server` for the gemma-4 preset.
- Whether mlx-lm 0.24-0.31 accept `python -m mlx_lm server`.
- Whether `HF_ENDPOINT` and `TRANSFORMERS_CACHE` behave as expected with transformers >= 5.7.
- Whether `pi-mlx-models` is currently listed on the gallery (only page 1 of the listing was visible).
- Behaviour of the stderr progress regexes (`src/server.ts:76-83`) against current hub output.
