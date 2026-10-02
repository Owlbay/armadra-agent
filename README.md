# ama

[![CI](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@armadra/agent)](https://www.npmjs.com/package/@armadra/agent)
[![license](https://img.shields.io/npm/l/@armadra/agent)](LICENSE)

English · [简体中文](README.zh-CN.md)

A coding agent for the terminal that can also be embedded in the [Armadra](https://github.com/yovinchen/Armadra) canvas as a coordinator. Written in TypeScript with zero runtime dependencies, and also shipped as a single-file build.

```sh
npm i -g @armadra/agent
export ANTHROPIC_API_KEY=sk-...       # a key from any supported provider works
ama
```

## Contents

- [Why ama](#why-ama)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Relays and gateways](#relays-and-gateways)
- [Tools and presets](#tools-and-presets)
- [Caching](#caching)
- [Safety](#safety)
- [Sandbox](#sandbox)
- [Plan](#plan)
- [Sub-agents](#sub-agents)
- [External agents](#external-agents)
- [Rewind](#rewind)
- [Interfaces and entry points](#interfaces-and-entry-points)
- [Embedding in Armadra](#embedding-in-armadra)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)
- [Development](#development)

## Why ama

- **An agent built to be called**: ama is driven by other programs as often as by people. One-shot `-p` runs, `--mode rpc`, the SDK and host adapters are all first-class entry points; exit codes and JSON shapes are contracts.
- **Clean layering**: following Pi's layering, protocol implementations are separate from provider data. Four protocol lines (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Google Generative AI) are written once; a provider is just "baseUrl + key + model table + compat switches".
- **Minimal configuration**: one environment variable is enough to start; the common settings are five keys and everything else has a default. API keys only (official or relay), Skills and built-in tools only, no MCP.
- **Cache first**: most of the usage in long tasks is cache reads. ama keeps the request prefix byte-stable, places cache breakpoints the way each provider expects, and shows whether the cache works and why it missed.
- **Two ways to use it**: standalone it is a terminal coding agent; embedded in Armadra it is the coordinator on the canvas, dispatching work to CLI agents such as Claude Code, Codex and OpenCode, collecting their reports and summarizing.

## Features

| Area                    | What you get                                                                                                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocols and providers | 4 protocol lines, 17 built-in providers (Anthropic, OpenAI, Google, DeepSeek, Moonshot, Zhipu, Qwen, OpenRouter, Groq, xAI, Mistral, MiniMax, StepFun, Volcengine Ark, Tencent, Ollama, LM Studio), built-in channels (Messages / Responses preferred, Chat as fallback), custom providers, per-model protocols |
| Zero config and relays  | With a key present, the first available provider is picked (relays pick a default model by price rules); `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` are recognized; `ama providers add` connects a relay from just a baseUrl and key: lists models, probes channels and writes the config back                    |
| Model metadata          | Context window, output limit, image input, reasoning and prices come from a bundled models.dev snapshot (no network at startup or runtime; `ama models refresh` updates explicitly); one provider can mount several channels (Chat / Responses / Messages), `provider/model@channel`                            |
| Image input             | `-p --image`, `@image-path` in the interface, `Ctrl+V` / `/paste` for clipboard images; per-endpoint size tiers with automatic resizing; models without image input refuse up front and suggest switching                                                                                                       |
| Tools and presets       | read / edit / write / bash / grep / glob, plus ls, todo, task / task_ctl (sub-agents) and codemode; four presets `default` / `minimal` / `codemode-only` / `coordinator`                                                                                                                                        |
| Plan and sub-agents     | Plan mode researches read-only, proposes a plan and executes after approval; `task` delegates to sub-agents (built-in general / explore / plan, custom types, foreground / background / follow-up / worktree isolation)                                                                                         |
| External agents         | `task(agent="claude" \| "codex" \| "acp:<program>")` drives external coding agents with each CLI's own login, and approvals go to a human only; `ama --mode acp` exposes ama as an ACP agent                                                                                                                    |
| Rewind and sandbox      | A checkpoint per turn; `/rewind` / double Esc returns to before any message (code, conversation or both); an OS sandbox on macOS / Linux isolates codemode and (optionally) bash                                                                                                                                |
| codemode                | The model writes a piece of JS that orchestrates many tool calls in a child process constrained by the Node permission model; only the output goes back to the model                                                                                                                                            |
| Skills                  | `SKILL.md` directories; the model reads them from an index, users invoke them with `/skill:<name>`; prompt templates too                                                                                                                                                                                        |
| Two hook layers         | Command hooks (`hooks.json`, 11 events, user policy) and the in-process host adapter HostApi (for embedders)                                                                                                                                                                                                    |
| Permissions             | Four modes, allow / deny rules, dangerous-command detection (sees through `sh -c` / `eval` / `xargs` / `find -exec`), project trust, a pre-execution preview in approvals                                                                                                                                       |
| Caching                 | A stable prefix, cache fields and compat switches, miss attribution, a three-state "reports / does not report cache" model, warming during long tool runs, compaction summaries that continue the session prefix                                                                                                |
| Sessions                | A JSONL entry tree with forks and `/tree` navigation; two-tier compaction (prune large tool results → summarize) with a circuit breaker; budgets (`--max-turns` / `--max-cost`), repeated-call detection, model fallback                                                                                        |
| Entry points            | A differential-rendering terminal UI, `--no-tui` line mode, `-p` (text / json / stream-json), `--mode rpc`, `--mode acp`, the SDK                                                                                                                                                                               |

## Install

Requires **Node ≥ 22**.

### npm

```sh
npm i -g @armadra/agent
ama --version
```

### Single-file release

[Releases](https://github.com/Owlbay/armadra-agent/releases) ship `ama.cjs`, `ama-sandbox.cjs`, `package.tgz` and `SHA256SUMS`. `ama.cjs` is a fully inlined single file and `ama-sandbox.cjs` is the codemode sandbox child-process entry; keep both in the **same directory**:

```sh
sha256sum -c --ignore-missing SHA256SUMS   # macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
node ama.cjs --version
alias ama="node /path/to/ama.cjs"
```

`package.tgz` has the same content as the npm package and can be installed offline: `npm i -g ./package.tgz`.

### Build from source

```sh
git clone https://github.com/Owlbay/armadra-agent.git && cd armadra-agent
corepack enable && pnpm install
pnpm build                 # produces dist/ and dist/bundle/ama.cjs, dist/bundle/ama-sandbox.cjs
node dist/bundle/ama.cjs --version
```

### Node version, codemode and sandbox

| Node / platform                              | codemode                                                                                                                                                                                                                                                | bash sandbox (`sandbox.bash: "auto"`)                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ≥ 25                                         | File system and network both isolated; `codemode` counts as a read-only tool and needs no approval in `default` permission mode; the `default` preset **enables** codemode by default                                                                   | Depends on the platform (next two rows)                                            |
| 22 / 24 + OS sandbox (macOS, most Linux)     | The child process starts through `sandbox-exec` / bubblewrap and the kernel denies network; same as Node ≥ 25: read-only class, enabled by default in the `default` preset                                                                              | Available with macOS `sandbox-exec` or Linux bubblewrap (`unshare` does not count) |
| 22 / 24 without an OS sandbox (e.g. Windows) | File system isolated, **network not isolated**; `codemode` counts as an execute-class tool and needs approval every time (red `net!` in the status bar); the `default` preset does **not** enable codemode, with a one-time notice per config directory | Not available; bash asks for approval as usual                                     |

Everything else works the same from Node 22 on. `ama doctor` shows the OS sandbox capabilities of the machine ([docs/sandbox.md](docs/sandbox.md), Chinese); `sandbox.enabled: "off"` or `AMA_SANDBOX=off` turns it off. To use codemode without network isolation, enable it explicitly: `--codemode on` or `"codemode": { "mode": "on" }` in the config. `codemode.requireStrict: true` disables codemode outright when the network is not isolated.

## Quick start

**Zero config**: set the standard environment variable of any provider and go. ama picks the first provider with a key in built-in order, and that provider's default model (`ama config show` explains which and why). Without any key, startup tells you how to configure one instead of silently using the test `fake` provider.

```sh
export ANTHROPIC_API_KEY=sk-...        # or OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY …
cd your-project
ama                                    # terminal UI
```

**Store a key**: if you prefer not to keep it in the environment, store it in `~/.config/ama/auth.json` (0600). The key is read from stdin, never from command-line arguments, so it stays out of shell history:

```sh
ama auth set deepseek                  # type it in the terminal (not echoed)
ama auth list                          # lists providers and key shapes only, never the key
ama auth remove deepseek
```

**One-shot runs**: `-p` exits when done, for scripts and pipes.

```sh
ama -p "explain src/index.ts"
git diff | ama -p "review this change"         # the prompt can come from stdin too
ama -p "list the TODOs" --model deepseek/deepseek-v4-pro --output-format json
```

**Common flags**:

| Flag                                                    | Effect                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| `--model provider/id`                                   | Pick a model (same syntax in config, command line, `/model` and the SDK)    |
| `--thinking off\|minimal\|low\|medium\|high\|xhigh`     | Thinking level (default `medium`)                                           |
| `--permission-mode plan\|default\|auto-edit\|full-auto` | Permission mode (default `default`)                                         |
| `-c` / `-r [id]`                                        | Continue the latest session in this directory / pick a session to resume    |
| `--tools-preset <name>`                                 | Tool preset (see below)                                                     |
| `--allow <rule>` / `--deny <rule>`                      | Add permission rules; repeatable                                            |
| `--max-turns N` / `--max-cost USD`                      | Turn / USD limit per run (`-p` exits with 8 when reached)                   |
| `--agent-dir <dir>`                                     | Extra sub-agent definition directory; repeatable                            |
| `--lang zh\|en`                                         | Interface language (also `AMA_LANG` and `ui.language`)                      |
| `--mode rpc` / `--mode acp`                             | Speak RPC (JSONL) / ACP (JSON-RPC) on stdio, for hosts and editors to drive |

**Built-in providers** (17): Anthropic, OpenAI, Google, DeepSeek, Moonshot (Kimi), Zhipu, Qwen (DashScope), OpenRouter, Groq, xAI, Mistral, MiniMax, StepFun, Volcengine Ark, Tencent TokenHub, Ollama, LM Studio. Multi-protocol providers ship built-in channels with Messages / Responses preferred and Chat as fallback: OpenAI, xAI and Volcengine Ark use Responses; Qwen, MiniMax, StepFun and Tencent use Messages; DeepSeek, Zhipu and Kimi use Chat for now (`@messages` is optional). `provider/model@channel` picks a channel. The full table is in [docs/en/providers.md](docs/en/providers.md) "Built-in providers".

Local Ollama / LM Studio need no key: `ama --model ollama/<model>`. `ama --help` lists every flag and subcommand; for tests and troubleshooting use the free `--model fake/echo` (echoes the last user message; the model picker, `models list` and `doctor` hide this test provider unless `AMA_SHOW_FAKE=1`).

## Configuration

One file: `~/.config/ama/config.json`. The first time you enter a conversation (interactive, `-p`, RPC) or run `ama providers add`, ama creates the directory (0700), a minimal `config.json` and a `config.schema.json` for editors; read-only commands such as `config show`, `doctor` and `models list` never write the config directory. You can also run `ama init` by hand (existing files are not overwritten). The generated `config.json` holds only `$schema`, `version` and empty `providers`, with no hard-coded defaults, so old configs follow when defaults change later. `ama config path` prints where each file lives, `ama config edit` opens it with `$VISUAL` / `$EDITOR`, and `config.schema.json` carries a description and default for every key, visible on hover in editors. The common settings are just five keys:

```json
{
  "$schema": "./config.schema.json",
  "version": 1,
  "defaultModel": "anthropic/<model-id>",
  "thinkingLevel": "medium",
  "permission": { "mode": "default", "allow": ["bash(git status*)"], "deny": ["write(**/.env*)"] },
  "tools": { "preset": "default" },
  "providers": {}
}
```

Everything else (`compaction`, `retry`, `codemode`, `hooks`, `ui`, `skills`, `cache`, `request`) has defaults. `ama config show` lists the effective value and source (default / user / profile / project / cli) of every key, and also accepts `--tools-preset` / `--codemode` to preview overrides.

**Request timeout**: model requests have an idle timeout, 300 s by default. Waiting longer than that for response headers, or between two chunks of the stream, counts as stuck and is retried with `retry` backoff as a retryable error (any byte received resets the timer, so long answers are unaffected). Adjust with `request.idleTimeoutMs` (user level only) or the `AMA_IDLE_TIMEOUT_MS` environment variable; 0 disables it.

**Interface language**: choose it with `ui.language` (`auto` / `zh` / `en`, default `auto`), `--lang zh|en` or the `AMA_LANG` environment variable. `auto` decides from `LC_ALL` / `LC_MESSAGES` / `LANG`: `zh*` is Chinese, anything else English. It affects the interface and config descriptions only (`config.schema.json` is written in the current language; run `ama init` again after switching to rewrite it); text sent to the model is always English. To have the model reply in a given language, set `ui.replyLanguage`. See [docs/i18n.md](docs/i18n.md) (Chinese).

**Proxy**: when `HTTPS_PROXY` / `HTTP_PROXY` is set (`NO_PROXY` excludes), ama enables Node's built-in environment proxy at startup (equivalent to `NODE_USE_ENV_PROXY=1`, zero dependencies). It works directly on Node 24+; on Node 22 only 22.21+ with `NODE_USE_ENV_PROXY=1` works, older versions print a one-time notice and connect directly. The "Proxy" section of `ama doctor` shows the current state (credentials in the proxy URL are masked).

### File locations and layers

| Location              | Contents                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/ama/`      | User level: `config.json`, `config.schema.json` (generated by ama), `auth.json` (0600), `hooks.json`, `keybindings.json`, `trust.json`, `AGENTS.md`, `skills/`        |
| `~/.local/share/ama/` | Data: `sessions/` (session JSONL), `plans/` (plan files), `file-history/` (checkpoint backups), `models-dev.json` (override from `ama models refresh`), input history |
| `<project>/.ama/`     | Project level: `config.json` (can only tighten), `hooks.json` / `skills/` / `prompts/` (require trust)                                                                |
| `<project>/AGENTS.md` | Project conventions, looked up from cwd upwards and added to the system prompt automatically                                                                          |
| `--profile <file>`    | Host profile (for embedders, see "Embedding in Armadra")                                                                                                              |

`AMA_CONFIG_DIR` / `AMA_DATA_DIR` change the two directories; `XDG_CONFIG_HOME` / `XDG_DATA_HOME` are honored too, and on Windows they are `%APPDATA%\ama` and `%LOCALAPPDATA%\ama`.

Layers merge as **built-in defaults ← user ← profile ← project**, but the project level can only tighten: it can add deny rules, make the permission mode stricter, narrow the tool preset and turn codemode off. Loosening items such as `allow` rules, laxer modes, `cache` and `tools.default` are ignored with a warning. Cloning an unfamiliar repository therefore never widens permissions through its config.

### Checking

```sh
ama config show          # effective value and source of every key, providers, the model to be used, tools
ama config show --json
ama doctor               # config layers, project trust, key sources, hooks, terminal capabilities
```

## Relays and gateways

**One-step setup**: give just a baseUrl and a key.

```sh
export PACKY_API_KEY=sk-...
ama providers add packy --base-url https://proxy.example/v1 --key-env PACKY_API_KEY --probe --limit 8 --yes
ama -p "hi" --model packy/kimi-k2.5               # preferred channel
ama -p "hi" --model packy/kimi-k2.5@messages      # a specific channel (Anthropic Messages)
ama -p "what colors are in this picture" --image shot.png --model packy/kimi-k2.5
ama providers list                                 # provider → channels → model count, key source
```

`add` lists the models from `GET {baseUrl}/models`, derives three candidate channels (chat / responses / messages) from the baseUrl, and with `--probe` sends a minimal request per channel and writes the working channels into each model's `channels`. Context window, output limit, images, reasoning and prices are not written to the config; at runtime they come from the bundled models.dev snapshot (`ama models list` marks where each field comes from). Without `--key-env` the key is read from stdin (not echoed) and stored in `auth.json`. The resulting config:

```json
{
  "providers": {
    "packy": {
      "apiKey": "$PACKY_API_KEY",
      "channels": {
        "chat": { "api": "openai-completions", "baseUrl": "https://proxy.example/v1" },
        "responses": { "api": "openai-responses", "baseUrl": "https://proxy.example/v1" },
        "messages": { "api": "anthropic-messages", "baseUrl": "https://proxy.example" }
      },
      "defaultChannel": "chat",
      "models": [
        { "id": "kimi-k2.5", "channels": ["chat", "messages"] },
        { "id": "grok-4.7", "channels": ["responses"] }
      ]
    }
  }
}
```

**Zero config**: the built-in `openai` / `anthropic` providers recognize `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`. When the baseUrl is not an official host, model ids outside the catalog are accepted and cache-related fields use conservative defaults.

```sh
OPENAI_BASE_URL=https://proxy.example/v1 OPENAI_API_KEY=$PACKY_API_KEY \
  ama -p "hi" --model openai/qwen3.8-flash
```

**One provider, per-model protocols**: under one relay, different models often support different protocols. Instead of a provider per protocol, put `api` on the model:

```json
{
  "version": 1,
  "providers": {
    "packy": {
      "baseUrl": "https://proxy.example/v1",
      "apiKey": "$PACKY_API_KEY",
      "models": [
        { "id": "deepseek-v4-flash" },
        { "id": "grok-4.7", "api": "openai-responses" },
        { "id": "MiniMax-M2.7", "api": "anthropic-messages" }
      ]
    }
  }
}
```

- `api` defaults to `openai-completions`; also `openai-responses`, `anthropic-messages`, `google-generative-ai`.
- `apiKey` supports `$ENV` / `${ENV}` (read an environment variable) and `!command` (run a command for the value); never put a key in the config in plain text.
- Custom model metadata defaults to the bundled models.dev snapshot (no network at startup; `ama models refresh` refreshes explicitly into the data directory, `refresh-catalog` is the old name). Without a match `contextWindow` is not guessed and automatic compaction is off; add it to the model entry when needed, or point to an entry with `"modelsDev": "provider/model"`.

**Don't want to write the model table by hand**: let ama ask the relay.

```sh
ama models discover packy                              # list GET {baseUrl}/models
ama models discover packy --probe --write --limit 8    # probe each model's protocols and write back to the config
ama models check packy/grok-4.7                        # one minimal request to confirm connectivity
ama models cache-probe packy/grok-4.7                  # does this endpoint report cache usage
```

`--probe` tries a few protocols per model and records the first that works; `--write` merges into the user-level `config.json` (the original is backed up as `config.json.bak`, existing entries are not overwritten). Both `--probe` and `cache-probe` send real requests: they print an estimate first and stop on 401 / 403 / 429; `cache-probe` needs `--yes` when not interactive. Details in [docs/en/providers.md](docs/en/providers.md).

## Tools and presets

| Preset          | Tools the model sees directly                                               | Good for                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`       | read, edit, write, bash, grep, glob; plus `codemode` with network isolation | The default (for todo, set `tools.default: ["+todo"]`)                                                                                                        |
| `minimal`       | read, edit, write, bash                                                     | Small models, small contexts; `full-auto`                                                                                                                     |
| `codemode-only` | only `codemode`                                                             | Long workflows heavy on tool calls                                                                                                                            |
| `coordinator`   | read and the canvas tools registered by the host                            | The coordinator embedded in Armadra: writes no files, runs no bash; codemode is off by default, and when enabled explicitly scripts can call only these tools |

- Pick a preset with `--tools-preset <name>` or `tools.preset`. `codemode` is the old name of `codemode-only` (0.3.0); config, command line, RPC and SDK still accept it, and `ama config show` shows the canonical name with a hint.
- `tools.default` tweaks the preset: `["+task", "+todo", "-glob"]`; bare names replace the whole set. `task` and `task_ctl` go together (`+task` adds both).
- There are also `--tools a,b,c` (enable only these), `--exclude-tools a,b` and `/tools` in interactive mode.

**codemode** lets the model write a piece of JavaScript that orchestrates many tool calls with `tools.<name>(args)` (concurrently with `Promise.all`); only the script's output goes back to the model. The script runs in a vm inside a `node --permission` child process: no `require` / `import` / `process` / `fetch`, and every inner call still goes through hooks, permissions and approval one by one.

**Default exposure**: when `codemode.mode` is unset it follows the preset: `default` → `on` (six tools + codemode, only inside a network-isolating sandbox: Node ≥ 25, or Node 22 / 24 + an OS sandbox; otherwise `off`), `codemode-only` → `only`, `minimal` / `coordinator` → `off`. An explicit `--codemode off|on|only` or `codemode.mode` wins; the project level can only write `off`. In `on` mode the codemode description lists, in one line, the direct tools callable from scripts (same parameters) and the script-only tool names, without re-declaring them, adding only about 400 tokens to the prefix (the [three-preset benchmark](https://github.com/Owlbay/armadra-agent/blob/main/docs/benchmarks/presets-2026-10-02.md) measured the codemode preset before deduplication: about 45% more input on small tasks, no fewer turns). Long workflows with many read-only lookups and many calls can use `codemode-only`.

## Caching

Most usage in long tasks is cache reads: once the prefix changes, every later request re-reads it at full price. ama handles this in three layers:

- **Protocol layer**: the system prompt sections have a fixed order and no timestamps, tools are sorted by name, and mid-session changes are only appended at the end; cache breakpoints follow each provider's style (Anthropic `cache_control`, OpenAI `prompt_cache_key`, …), and when an endpoint rejects a cache field with 400 it is dropped and the request resent.
- **Session layer**: every request records a prefix fingerprint to detect and attribute misses (idle timeout, sub-task, model switch, system prompt / tool table change, server eviction), decides whether the endpoint reports cache usage, and warms the cache during long tool runs.
- **Display layer**: the status bar, `/session`, `/cache`, RPC stats and `ama models cache-probe`.

### Reading the status bar

A standalone terminal shows two lines by default (`Ctrl+G` / `/statusline` switches to one; embedding hosts default to one):

```
tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)    ↑412k ↓8.1k · cache 83% ♨ · rebill $0.11 · [-]
Accept edits     claude-opus-5-5 medium | Ctx 34.0% | proj ⎇ main 5ae9e54 (+12,-3) | $0.84 | 2h24m
```

The top line is throughput and usage; the bottom line is permission mode, model and thinking level, context, directory and git branch (with working-tree line changes), cost and session duration. The cache-related items:

| Item                   | How to read it                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache 83%`            | Hit rate of the **latest** request; the session total is in `/session`                                                                                      |
| `cache —`              | The endpoint has not reported cache usage yet (no long enough comparable request so far)                                                                    |
| `cache` "not reported" | The endpoint does not report cache usage (reads and writes were 0 three times in a row); such requests are left out of the hit rate rather than shown as 0% |
| `♨`                    | Warming timer running                                                                                                                                       |
| `rebill $0.11`         | Extra spend in this session caused by cache misses (tokens for models without prices); hidden when 0                                                        |
| `Ctx 34.0%`            | Context usage; yellow at ≥ 70%, red at ≥ 90%, with an "about N turns left" note in the message area when crossed                                            |

When one miss re-bills ≥ 20k tokens or ≥ $0.10, the message area gets one line with the reason. `/cache` shows cache stats and `/cache fingerprint` the prefix fingerprint (if the hash changed between two requests, the system prompt or tool table was modified).

### Three states, warming and summary continuation

- **Three states**: each endpoint (provider + host + model) is classified as `unknown` / `reported` / `silent`. Only `reported` shows a hit rate, detects misses and warms; relays that do not report cache usage are never misreported as 0%. For models known not to report on a relay, set `compat.cacheReporting: "silent"`.
- **Warming**: while a tool runs for a long time (long tests, `task` sub-tasks, codemode scripts), the previous request is replayed once before the cache TTL expires (`maxTokens: 1`), paying only the read price to keep the cache alive. `cache.warming` is `off` / `streaming` (default, only while running) / `idle` (also while idle, for expensive models); `/cache warm …` switches it for the session; nothing is sent when the expected saving is below `cache.minSavingsUsd` (default $0.05).
- **Summary continuation**: the compaction summary request follows a prefix byte-identical to the last real request, so the whole history is billed at the read price; on failure it falls back to a standalone summary request.

### Measurements

[Cache acceptance experiment](https://github.com/Owlbay/armadra-agent/blob/main/docs/benchmarks/cache-2026-10-02.md) (2026-10-02, through one test relay):

| Scenario                               | Result                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kimi summary continuation              | The summary request read 20.2k / 20.5k from cache, **98.8% hit** (0% before the fix: sending `tool_choice` broke the prefix at the tools section) |
| DeepSeek reporting cache in 2048 units | False misses 3 → **0** (cache granularity inferred per endpoint)                                                                                  |
| Baseline hit rate (5-turn coding task) | Kimi 86% cumulative, MiniMax 75%, 0 misses each                                                                                                   |

All cache settings and the fields for each protocol are in [docs/en/providers.md](docs/en/providers.md) "Caching".

## Safety

**Permission modes** (`--permission-mode`, config `permission.mode`, the `/permission` picker, and in interactive mode `Shift+Tab`, or `Tab` on an empty input, to cycle):

| Mode        | Display name       | Read | Write                                                                                   | Execute (bash etc.)                 |
| ----------- | ------------------ | ---- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| `default`   | Manual             | ✓    | ask                                                                                     | ask                                 |
| `auto-edit` | Accept edits       | ✓    | ✓                                                                                       | ask                                 |
| `plan`      | Plan               | ✓    | deny                                                                                    | deny                                |
| `auto`      | Auto               | ✓    | ✓ ¹                                                                                     | safe ones allowed, risky ones ask ² |
| `full-auto` | Bypass permissions | ✓    | ✓                                                                                       | ✓                                   |
| `allowlist` | Allowlist only     | ✓    | only calls matching allow rules pass, everything else is denied without asking (for CI) | same                                |

¹ Secret files (`.env`, private keys, `.ssh/` …), `.git/` and `.ama/`, and writes outside the project directory still ask.
² Three tiers: the rule tier (dangerous commands, network, deletion, protected paths → ask) → static judgement (a safe list: `ls`, `cat`, `grep`, `git status/diff/log`, `npm test`, `tsc --noEmit`, `cargo test` … → allow) → when neither decides, one question to a model classifier (a separate request that leaves the main session cache untouched; `permission.autoModel` can name a cheap model). Details in [docs/en/permissions.md](docs/en/permissions.md).

**Decision order**: deny rules (including hook deny) → dangerous commands → (auto's rule tier) → mode / static judgement → allow rules turn "ask" into "allow" → (auto's classifier). A later step can never loosen an earlier decision. When unattended (`-p`, RPC without approvals) "ask" always means deny. Project config can only make the mode stricter and cannot set `auto` / `full-auto`.

- **Rules**: `bash(git push*)`, `write(src/**)`, `read(**)`, `canvas_*`; `--allow` / `--deny` are repeatable. Built-in deny: writes to `.git/**`, reads and writes to `.ssh/**`.
- **Dangerous commands**: `rm -rf /`, `sudo`, `git push --force`, `git reset --hard`, `git clean -f`, `curl … | sh`, `chmod -R 777`, `npm publish`, `shutdown` and so on ask even with an allow rule. Detection sees through `sh -c '…'`, `eval`, `xargs`, `find -exec` and git global options.
- **bash sandbox** (off by default): see "Sandbox" below.
- **Project trust**: `.ama/hooks.json`, `.ama/skills/` and `.ama/prompts/` execute or inject content from the project, so the directory must be trusted first (asked once in interactive mode, can be remembered; `--trust` / `--no-trust`; untrusted by default when non-interactive). `AGENTS.md` and `.ama/config.json` need no trust, since the latter can only tighten.
- **Pre-execution preview**: besides an input summary, the approval dialog lists what the step will touch: for `rm` / `mv` / `git clean` / `git reset --hard` / redirections in bash, whether the target paths exist, their size and how many files a directory holds; for write, the path and line count; for edit, a −/+ summary per change. `y` allows, `n` denies, `a` stops asking for the same kind this session, `v` shows the full input.
- **Hooks**: `hooks.json` runs shell commands on 11 events such as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PostCompact` and `PostRewind`; hooks can veto tool calls, rewrite input, add context or make the run go another round. See [docs/hooks.md](docs/hooks.md) (Chinese).
- **Approval origin**: approvals raised by sub-agents and external agents show their origin in the dialog title (`[task:explore]`, `[claude · session abc12345]`, "first run of an external agent"); see [docs/en/permissions.md](docs/en/permissions.md) "Origin labels in the approval dialog".

## Sandbox

macOS uses `sandbox-exec` and Linux uses bubblewrap (falling back to `unshare -r -n`, which isolates the network only). At startup a minimal probe runs with the target profile to confirm it really works (degrading for nested sandboxes or missing user namespaces), and `ama doctor` shows the result. Windows has no OS sandbox.

- **codemode**: the child process starts inside the sandbox and the kernel denies network and all writes; with a sandbox, Node 22 / 24 behaves like Node ≥ 25: read-only class and enabled by default in the `default` preset (see "Node version, codemode and sandbox" above).
- **bash** (off by default): with `"sandbox": { "bash": "auto" }`, bash (including background bash) runs in the sandbox. It can only write the workspace, the system temp directory and directories added via `sandbox.writable`; the workspace's `.ama/`, `.git/hooks` and `.git/config` are read-only; credentials such as `~/.ssh` cannot be read; and there is no network by default (`sandbox.network: "allow"` opens it). In `default` / `auto-edit`, sandboxed commands need no approval (dangerous commands, deny rules and hook asks still apply); when the sandbox blocks something the model may ask to rerun with `sandbox: false` outside it, which is approved as usual and denied when unattended. The status bar shows an extra sandbox marker.
- `sandbox.*` is user level / profile only; the project level can only write the tightening `network: "deny"`. `sandbox.enabled: "off"` or `AMA_SANDBOX=off` turns it all off.

Details, per-platform policies and known bypasses are in [docs/sandbox.md](docs/sandbox.md) (Chinese).

## Plan

In Plan mode (`Shift+Tab`, `/permission plan`, `/plan <goal>`, `--permission-mode plan`) the model researches read-only: only read tools, read-only commands (`ls`, `rg`, `git log / diff` …) and read-only sub-agents are allowed. It ends with a `<proposed_plan>` block. ama extracts the steps, saves the plan under `<data dir>/plans/` and opens an approval dialog:

- **Approve and execute** / **Approve, execute in a fresh context** (a new session that opens with the full plan), then pick the execution mode (back to the previous mode / Accept edits / Auto); steps become todos and are worked through one by one (with `todo update` when the todo tool exists, otherwise the model writes a `[DONE:S1]` line per finished step);
- **Keep revising** (feedback goes to the model to rewrite the plan) / **Discard and leave Plan**; `e` edits the plan in an external editor, Esc discards but stays in Plan.

Line mode uses `/plan approve [mode|fresh]` / `/plan reject`; RPC clients approve after declaring the `plans` capability; the SDK uses `createAgentSession({ plan: { onProposed } })`. **ama never approves on a person's behalf**: `-p` stops at "plan awaiting approval" and exits with 9 by default; only the user-level config `"plan": { "unattended": "approve" }` approves and executes automatically when unattended. `plan.model` lets planning and execution use different models. See [docs/plan.md](docs/plan.md) (Chinese).

## Sub-agents

The `task` tool hands a sub-task to a sub-agent with a fresh context (same process, its own session file, depth 1); the result returns to the parent session as a tool result. Under the `default` preset `task` is only available inside codemode scripts; expose it directly with `--tools …,task` or `tools.default: ["+task"]`.

- Built-in types `general` (default), `explore` and `plan` (the last two are forced read-only and never prompt for approval); define your own types (tool allowlist, model, permissions, turns, worktree isolation) in `~/.config/ama/agents/*.md`, `.ama/agents/*.md` (requires trust) or `--agent-dir`.
- Several tasks in one reply run in parallel (`subagents.maxConcurrent`, default 4); `background: true` returns a `taskId` immediately and the parent session receives a `<task-notification>` when done; `task{taskId}` continues the conversation; `task_ctl` lists / waits / stops / reads output; `isolation: "worktree"` runs in a separate git worktree.
- The sub-session's tool table is byte-identical to the parent's, so its first request reuses the parent's cache prefix. In the interface the task tool line folds and shows progress; `/tasks` shows output or stops tasks, `/agents` lists the available types.

See [docs/agents.md](docs/agents.md) (Chinese) "Sub-agents".

## External agents

`task(agent="claude")`, `"codex"` or `"acp:<program>"` (any ACP agent: Gemini CLI, OpenCode, Kimi, ama itself …) drives an external coding agent with your **existing login** in that CLI. Foreground / background / follow-up / `task_ctl` work as with ama's own sub-agents, and results are treated as reference material.

- **Approvals go to a human only**: operations the external agent wants confirmed go to the interface / host; neither the auto classifier nor the model takes part, and unattended runs always deny. The first run of a given external agent in each session is confirmed once (the allow rule `task(claude)` or `full-auto` lets it through).
- An external agent's mode is never wider than ama's current mode (read-only under plan / allowlist). By default the child process is stripped of provider keys, `*_BASE_URL` and `AMA_*`, so subscriptions are never switched to API billing; it only starts in trusted directories; there is a concurrency pool, a USD budget and a watchdog.
- When embedded in a host, ama does not start external CLIs itself; it only uses runners injected by the host through `HostApi.runners`.
- **ama as an ACP agent**: `ama --mode acp` can be driven by Zed, JetBrains and Armadra's ACP nodes; `@armadra/agent/acp` exports a client, a driver and a fake agent.

See [docs/agents.md](docs/agents.md) "External agents" and [docs/acp.md](docs/acp.md) (both Chinese).

## Rewind

Every user message that starts a new turn is a rewind point: edit / write back up a file before writing it the first time, and each new turn re-snapshots tracked files (with `checkpoints.mode: "shadow-git"` the whole working directory goes into a shadow repository, so bash changes can be rolled back too).

- `/rewind`, or double Esc while idle, opens the list; the confirmation panel offers: restore code and conversation / restore conversation / restore code / summarize from here / summarize up to here, each with a preview. Files changed by hand outside the turn are listed as conflicts and skipped by default, with an option to overwrite; if git HEAD moved, ama only suggests commands and never touches git.
- When Esc interrupts a run before this turn produced any output, the message is withdrawn and put back into the input box (`ui.restoreOnCancel`).
- Line mode `/rewind <n> [both|conversation|code] [overwrite]`; RPC `get_rewind_points` / `rewind`; SDK `session.rewind()`; hook `PostRewind`.

See [docs/en/tui.md](docs/en/tui.md) "Rewind", [docs/rewind-plan.md](docs/rewind-plan.md) (Chinese) and [docs/en/sessions.md](docs/en/sessions.md).

## Interfaces and entry points

### Terminal UI

Running `ama` (with stdin / stdout both TTYs) enters interactive mode. The interface uses the main screen only; the conversation history stays in the terminal scrollback, so tmux `capture-pane` can read the whole conversation.

| Key                  | Effect                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------- |
| Enter                | Send; while running, steer                                                              |
| Alt+Enter            | While running, queue after this turn (followUp)                                         |
| Shift+Enter / Ctrl+J | New line                                                                                |
| Esc                  | Interrupt the current run                                                               |
| Esc Esc (idle)       | Empty input: open the rewind list (same as `/rewind`); with text: clear it into history |
| Shift+Tab / Tab      | Cycle permission modes (Tab only on an empty input; entering Bypass asks to confirm)    |
| Ctrl+O               | Expand / collapse tool output                                                           |
| Ctrl+L / Ctrl+T      | Pick model / thinking level                                                             |
| Ctrl+G               | Bottom info line, two lines ↔ one (same as `/statusline`)                               |
| Ctrl+V               | Paste an image from the clipboard and insert `@<path>` (same as `/paste`)               |
| Ctrl+C               | Clear the input; on an empty input, press again within 1.5 s to quit                    |
| Tab                  | Complete: `/` commands, templates and Skills, `@` file paths                            |

Common commands: `/model`, `/thinking`, `/permission`, `/tools`, `/compact`, `/tree` (branch again from before a message), `/fork`, `/resume`, `/new`, `/session`, `/cache`, `/hooks`, `/skill:<name>`, `/help`; wave 5 added `/plan` (plan panel and approval; `/plan <goal>` enters Plan), `/tasks` (sub-agent tasks), `/agents` (available types and external agents), `/paste` (clipboard image), `/rewind` and `/statusline [full|compact]`. An `@image-path` in the input (or a pasted / dropped image path) is sent to the model as an image attachment; `/model` groups models by "provider · channel" and marks context size and `img`. Key bindings can be overridden in `~/.config/ama/keybindings.json`. See [docs/en/tui.md](docs/en/tui.md).

`--no-tui` (or when stdin / stdout is not a TTY, or `TERM=dumb`) enters line mode: readline with bracketed paste and the same commands.

### One-shot `-p`

| `--output-format` | stdout                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| `text` (default)  | The text of the final answer                                                           |
| `json`            | One `result` object: session id, model, `stopReason`, `text`, usage, cost, cache stats |
| `stream-json`     | One event per line, same shapes as RPC events                                          |

**stdin**: piped content is appended after the prompt (`git diff | ama -p "review"`); without a prompt argument the piped content is the prompt. With a prompt argument ama waits only 2 seconds for the pipe's first byte (`AMA_STDIN_WAIT_MS` adjusts it, 0 = don't wait): if not a single byte arrives, stdin is ignored, the run continues and stderr gets one line, so a pipe a parent process leaves open never hangs `-p`; once the first byte arrives it reads to EOF. When the upstream command runs a long time before printing, add a trailing `-` to wait for EOF (`npm test 2>&1 | ama -p "find why it fails" -`); `--no-stdin` never reads. A `< file` redirect is always read.

`--image <file>` is repeatable and sends images with the prompt (PNG / JPEG / GIF / WebP; the per-image limit is tiered by endpoint and measured after base64: official Anthropic 10 MB, Gemini / OpenAI 20 MB, relays 5 MB; oversized images are resized with sips / ImageMagick when possible); `@image-path` in the prompt is attached too. When the current model does not accept images, ama exits with 2 without sending a request.

`--max-turns N` caps a run at N turns (one model request plus its tool executions is one turn), and `--max-cost USD` caps a run's USD spend (config `limits.maxTurns / maxCostUsd` mean the same). When a limit is reached the run ends early (event `limit_reached`) with **exit code 8** (`--max-turns` exited with 1 in 0.4.x), and the `json` result carries `limitReached{kind, value, limit}` (plus `maxTurnsReached: true` for the turn limit). In Plan mode a plan awaiting approval exits with 9 (see "Plan" above).

`--system-prompt <text|@file>` adds to the system prompt (in every mode): by default it is appended as the last rule, keeping the preamble and tool table, the longest cache prefix, unchanged; `--system-prompt-mode replace` replaces the opening role description instead, while the tool table, rules and AGENTS.md stay.

`--no-session` keeps the session in memory only and writes no session file (for CI and one-off calls; `--resume` is impossible afterwards); new sessions started with `/new` in interactive mode are not saved either.

**Unattended**: `-p` has nobody to approve, so calls that would ask under the default permission mode (writing files, running commands) are always denied. When something is denied, stderr summarizes the denied tools and reasons in one line, the `json` result carries `deniedTools`, `stream-json`'s `tool_execution_end` carries `denied: true`, and the exit code is 7. To allow them use `--permission-mode auto-edit` (allows writes) / `auto` (ama judges each step), or allow by rule with `--allow "bash(npm test*)"`.

| Exit code | Meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| 0         | Success                                                                           |
| 1         | Runtime error (the model ultimately failed, etc.)                                 |
| 2         | Usage error; the current model does not accept images                             |
| 3         | Config / profile / path error                                                     |
| 4         | No usable model or key                                                            |
| 5         | Session missing / corrupted                                                       |
| 6         | Host / hook startup failure                                                       |
| 7         | `-p` had tool calls denied (no approver, deny rules, plan, …)                     |
| 8         | `-p` reached a budget limit (`--max-turns` / `--max-cost` / `limits`)             |
| 9         | `-p` produced a plan that was saved and awaits approval (`plan.unattended: stop`) |
| 78        | Host API version mismatch                                                         |
| 130       | SIGINT; 143 = SIGTERM                                                             |

### Session stats, search and reuse

Sessions are JSONL files under `<data dir>/sessions`. These commands only read (by default they look at sessions of the current directory; `--all` looks at all):

```sh
ama stats --since 7d --by model           # requests, tokens, cache hit rate, cost, top N tool calls (--json available)
ama sessions search "parser" --role user  # full-text search across sessions; /regex/ works too
ama sessions show 3f9a1c2e                # lists user message numbers at the end
ama -p --from 3f9a1c2e#2 --model packy/kimi-k2.5   # ask that message (images included) again with another model
ama sessions export 3f9a1c2e --format md --output s.md   # md / json / jsonl, redacted before export
```

How the numbers are computed (hit rate only over endpoints that report cache usage, cost only over priced requests, …) and the export formats are in [docs/en/sessions.md](docs/en/sessions.md).

### RPC

`ama --mode rpc` speaks JSONL on stdin / stdout: it first sends `hello` and `session_start`, then accepts commands such as `prompt`, `steer`, `abort`, `set_model`, `get_session_stats` and `fork`, and pushes stream events and approval requests.

```sh
printf '{"id":"1","type":"prompt","message":"hi"}\n' | ama --mode rpc --model fake/echo
```

`hello.capabilities` lists server capabilities (`approvals`, `images`, `hooks`, `plans`); clients declare with `set_client_capabilities` which approvals and plan approvals they take over. Wave 5 added plan (`plan_response` / `get_plan` / `get_todos`), task (`get_tasks` / `get_agents`) and rewind (`get_rewind_points` / `rewind` / `summarize_*`) commands, plus events such as `subagent_*`, `plan_*`, `limit_reached` and `telemetry_tick`. The protocol is in [docs/en/rpc.md](docs/en/rpc.md); import the types from `@armadra/agent/rpc`.

`ama --mode acp` speaks ACP (JSON-RPC over NDJSON); see [docs/acp.md](docs/acp.md) (Chinese).

### SDK

```sh
npm i @armadra/agent
```

```ts
import { createAgentSession } from "@armadra/agent";

const session = await createAgentSession({
  cwd: process.cwd(),
  model: "anthropic/<model-id>", // "fake/echo" for a dry run
  auth: { kind: "env" },
  permission: {
    mode: "default",
    ask: async (request) => (request.toolName === "read" ? "allow" : "deny"),
  },
});
session.subscribe((event) => {
  if (event.type === "tool_execution_start") console.error(`→ ${event.toolName}`);
});
await session.prompt("list the entry files under src");
console.log(session.getLastAssistantText());
console.log(session.getStats().cache?.hitRate);
await session.dispose();
```

- `createAgentSession` does not read file-system config: an in-memory session, explicit tools and callback approvals, suited for embedding in other programs.
- Rewind: `session.rewindPoints()` lists the user messages on the active path that start new turns; `session.rewind({ entryId, mode: "both" | "conversation" | "code", dryRun?, onConflict? })` returns to before that message (returning the original message as a draft and the code restore result; in-memory sessions support conversation only); `session.summarizeFrom(entryId, instructions?)` / `session.summarizeUpTo(entryId, instructions?)` correspond to "summarize from here" / "summarize up to here". Design in [docs/rewind-plan.md](docs/rewind-plan.md) (Chinese).
- Plans: `createAgentSession({ plan: { onProposed } })` calls back for approval once a plan is proposed (return `{ decision: "approve" | "approve_fresh" | "revise" | "reject", mode?, feedback? }`), or use `session.plan.respond()` later; `session.plan.current()` / `todos()` read the current plan and todos. Types such as `SessionPlanOptions` and `PlanDecision` are exported from the package entry; see [docs/plan.md](docs/plan.md) (Chinese) "Interfaces".
- `createRuntime({ argv })` runs the same startup sequence as the `ama` command line (config, AGENTS.md, Skills, hooks.json, auth.json).
- Subpaths: `@armadra/agent/host` (host adapter types), `@armadra/agent/rpc` (RPC types), `@armadra/agent/tui` (terminal component library), `@armadra/agent/acp` (ACP types, client, driver and fake agent), `@armadra/agent/bundle` (the single-file `ama.cjs`; `require.resolve` gives its path to start with `node` or `ELECTRON_RUN_AS_NODE=1`).

A complete example is [examples/sdk-demo.ts](https://github.com/Owlbay/armadra-agent/blob/main/examples/sdk-demo.ts) (custom tools, streaming output, usage stats).

## Embedding in Armadra

Armadra starts ama with `ama --profile <path>`. The profile is a JSON file naming the host adapter (`host`), instructions (`instructions`), Skill and prompt template directories, the hook file, the key file (`authFile`; `authEnv: false` skips environment variables), the session directory and `trustProject`.

The host adapter is a local JS module exporting `hostApi` and `create(api)`; through `HostApi` it registers canvas tools (`canvas_*` / `context_*`), appends to the system prompt, takes over approvals, injects messages and shows status. When the same profile runs outside the canvas the adapter stays inactive and ama falls back to plain standalone mode. With the `coordinator` preset the coordinator only reads files and calls canvas tools, never changing code itself.

- ama's side of the interface: [docs/en/host-api.md](docs/en/host-api.md)
- Coordinator design and contract: [docs/design/coordinator-agent.md](https://github.com/yovinchen/Armadra/blob/main/docs/design/coordinator-agent.md) in the Armadra repository

## Documentation

English versions exist for six user docs; the rest are in Chinese.

| Document                                                                       | Contents                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/en/providers.md](docs/en/providers.md) ([中文](docs/providers.md))       | Built-in providers and channels, API keys, custom providers and relays, model metadata snapshot, image input, compat, caching                   |
| [docs/en/tui.md](docs/en/tui.md) ([中文](docs/tui.md))                         | Terminal UI: layout, status bar, keys, commands, rewind, approvals, Plan approval, sub-agents, clipboard images, component library              |
| [docs/en/permissions.md](docs/en/permissions.md) ([中文](docs/permissions.md)) | Permission modes, read-only commands in plan, decision order, approval-free sandboxed commands, auto's three tiers, approval origin labels      |
| [docs/en/host-api.md](docs/en/host-api.md) ([中文](docs/host-api.md))          | Host adapter API                                                                                                                                |
| [docs/en/rpc.md](docs/en/rpc.md) ([中文](docs/rpc.md))                         | RPC protocol (stdio JSONL)                                                                                                                      |
| [docs/en/sessions.md](docs/en/sessions.md) ([中文](docs/sessions.md))          | Session stats, search, `--from` reuse, export, checkpoints and shadow git                                                                       |
| [docs/plan.md](docs/plan.md)                                                   | Plan mode: flow, plan format, approval, separate models, config and persistence (Chinese)                                                       |
| [docs/agents.md](docs/agents.md)                                               | Sub-agents (types, definition files, background, follow-up, worktree) and external agents (drivers, permissions, environment, budget) (Chinese) |
| [docs/acp.md](docs/acp.md)                                                     | ACP: `ama --mode acp` and ama as an ACP client (Chinese)                                                                                        |
| [docs/sandbox.md](docs/sandbox.md)                                             | OS sandbox: codemode and bash, per-platform implementation, config and known bypasses (Chinese)                                                 |
| [docs/codemode.md](docs/codemode.md)                                           | codemode scripts, sandbox and permissions (Chinese)                                                                                             |
| [docs/hooks.md](docs/hooks.md)                                                 | Command hooks (hooks.json) (Chinese)                                                                                                            |
| [docs/session-format.md](docs/session-format.md)                               | Session file format (Chinese)                                                                                                                   |
| [docs/rewind-plan.md](docs/rewind-plan.md)                                     | Checkpoint and rewind design (Chinese)                                                                                                          |
| [docs/tui-design.md](docs/tui-design.md)                                       | Terminal UI visual spec and screen-by-screen mockups (Chinese)                                                                                  |
| [docs/design.md][design]                                                       | Overall design and decision log (Chinese)                                                                                                       |
| [docs/extensions.md][extensions]                                               | Local extensions (draft design, not implemented) (Chinese)                                                                                      |
| [docs/benchmarks/][benchmarks]                                                 | Preset benchmarks, the D20 todo retest and the cache acceptance experiment (reports and raw data)                                               |
| [docs/wave6-plan.md][wave6]                                                    | Wave 6 design: agent bar and sub-agent view, traces, memory, ChatGPT login, bilingual UI, `/config` (Chinese)                                   |
| [docs/i18n.md][i18n]                                                           | Bilingual development conventions: language selection, message catalogs and key naming, model-side isolation, check script (Chinese)            |
| [docs/wave5-plan.md][wave5]                                                    | Wave 5 design (Chinese)                                                                                                                         |
| [docs/implementation-plan.md][impl], [wave3-plan][w3]                          | Early implementation plans (for history) (Chinese)                                                                                              |
| [docs/research/][research]                                                     | Wave 5 and wave 6 research reports (for history) (Chinese)                                                                                      |

The npm package includes the first fifteen user docs above (both languages where available); the rest are design and history material linked on GitHub.

[design]: https://github.com/Owlbay/armadra-agent/blob/main/docs/design.md
[extensions]: https://github.com/Owlbay/armadra-agent/blob/main/docs/extensions.md
[benchmarks]: https://github.com/Owlbay/armadra-agent/tree/main/docs/benchmarks
[wave6]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave6-plan.md
[i18n]: https://github.com/Owlbay/armadra-agent/blob/main/docs/i18n.md
[wave5]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave5-plan.md
[impl]: https://github.com/Owlbay/armadra-agent/blob/main/docs/implementation-plan.md
[w3]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave3-plan.md
[research]: https://github.com/Owlbay/armadra-agent/tree/main/docs/research

## Known limitations

- **The Linux sandbox is not verified on real machines**: the bubblewrap policies are only verified by unit tests and Ubuntu CI, never on a Linux desktop / server; without bwrap ama falls back to `unshare -r -n` (network isolation only, unusable for the bash sandbox), and with neither it behaves as if there were no sandbox (codemode back to the execute class, approval every time).
- **Real-CLI tests for external agents only run locally**: CI runs only recorded replays and ama driving ama; end-to-end tests against `claude` / `codex` need a logged-in machine and run with `AMA_E2E_AGENTS=1` (using your subscription quota); see [docs/agents.md](docs/agents.md) (Chinese).
- **DeepSeek, Zhipu and Kimi still default to Chat**: their Messages channels (`@messages`) have only been tested through relays; the default switches once direct official endpoints pass the measurement gate (`scripts/channel-probe.mjs`).
- **models.dev refresh PRs do not trigger CI automatically**: without the repository secret `MODELS_DEV_PR_TOKEN`, the weekly workflow opens the PR with the default token (after running `pnpm run ci` itself and putting the result in the description).
- Sub-agents have depth 1, do not read `.claude/agents` and have no fork mode that inherits the parent conversation; Windows has no OS sandbox.

## Development

Requires Node ≥ 22 and pnpm (version in `packageManager` of `package.json`; `corepack enable` is enough).

```sh
pnpm install
pnpm run ci              # typecheck, fmt:check, check:deps, check:i18n, release:check, test, build, then bundle --version
AMA_E2E=1 pnpm test:e2e  # bundle-level end-to-end: print / rpc / acp / plan / sub-agents / rewind / codemode / cache / host (fake provider, free)
```

Since pnpm 10, `pnpm ci` is the built-in "clean install", so run the checks with `pnpm run ci`. Common single steps: `pnpm test`, `pnpm typecheck`, `pnpm fmt`, `pnpm build`. Tests always use the fake provider: `AMA_FAKE_SCRIPT=<script.json>` makes it produce text, tool calls, 429s, dropped streams and so on from a script; examples are in `test/fixtures/scripts/`.

**Real-model scripts** (run locally, not in CI; `pnpm build` first):

| Script                                                   | Purpose                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `node scripts/bench-presets.mjs` (`pnpm bench:presets`)  | Preset benchmark (`--tasks long` for long multi-step tasks) |
| `node scripts/cache-experiment.mjs` (`pnpm bench:cache`) | Cache acceptance experiments E1–E5                          |
| `node scripts/record-sse.mjs`                            | Record SSE samples of each protocol as test fixtures        |

The first two share budget controls: `--config` / `AMA_REAL_CONFIG` (a config.json with key references), `--models` / `AMA_REAL_MODELS`, `--max-requests` / `AMA_REAL_MAX_REQUESTS` (default 60), `--budget-usd` / `AMA_REAL_BUDGET_USD` (default 3). They stop as soon as the request count or budget is exceeded and output the data collected so far; config and data directories point to temp directories, never your user config.

**Constraints**: runtime dependencies must be zero; `src/` may only use `node:` built-ins and relative paths (guarded by `pnpm check:deps`). `src/` is organized by layer (`ai` model access, `agent` loop, `session` session tree, `tools`, `codemode`, `permissions`, `hooks`, `host` host contract, `tui` component library, `modes` entry points, `cli` startup), and each directory's `types.ts` is the contract between modules.

**Releasing**: bump the version in `package.json`, update both changelogs (English [CHANGELOG.md](CHANGELOG.md) and Chinese [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md), turning "Unreleased" into the version), merge into main and push a `v<version>` tag. Once CI is green the release job creates a GitHub Release (`ama.cjs`, `ama-sandbox.cjs`, `package.tgz`, `SHA256SUMS`) and publishes to npm with provenance. It prefers OIDC trusted publishing (npm ≥ 11.5.1, upgraded inside the job): add a GitHub Actions trusted publisher in the `@armadra/agent` package settings on npmjs.com (organization `Owlbay`, repository `armadra-agent`, workflow `ci.yml`, environment empty) and no long-lived token is needed; the repository secret `NPM_TOKEN` stays as a fallback, and the job fails with a hint when neither exists. `pnpm release:check` checks that the tag matches the version, requires a breaking version bump when protocol constants change, and checks that both READMEs / changelogs and `docs/en/` exist and link to each other and that both changelogs have a section for the current version (English from 0.6.0 on).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) (English, from 0.6.0) and [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese, complete history since 0.1).

## License

[MIT](LICENSE)
