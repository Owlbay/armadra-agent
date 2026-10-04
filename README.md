# ama

[![CI](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@armadra/agent)](https://www.npmjs.com/package/@armadra/agent)
[![license](https://img.shields.io/npm/l/@armadra/agent)](LICENSE)
[![node](https://img.shields.io/node/v/@armadra/agent)](https://nodejs.org)

English · [简体中文](README.zh-CN.md)

A coding agent for your terminal that can also coordinate other agents. Use it on its own, or embed it in the [Armadra](https://github.com/Owlbay/Armadra) canvas.

```text
 ▄███▄  ██▄   ▄██  ▄███▄    ama
██▀ ▀██ ███▄ ▄███ ██▀ ▀██   anthropic/claude-sonnet-4-5@messages · thinking medium
███████ ██ ▀█▀ ██ ███████   ~/Projects/demo · trusted
██   ██ ██     ██ ██   ██   Accept edits · preset default
▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀   AGENTS.md · 2 Skill
                            /help commands · Shift+Tab mode · Ctrl+O expand tool output
```

- [What is ama](#what-is-ama)
- [Quick start](#quick-start)
- [Capabilities](#capabilities)
- [Embedding and integration](#embedding-and-integration)
- [Command reference](#command-reference)
- [Exit codes](#exit-codes)
- [Documentation](#documentation)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License and acknowledgements](#license-and-acknowledgements)

## What is ama

ama reads, edits and runs code in your project from a terminal UI, and answers one-shot questions with `ama -p`. It can also hand work to other agents: its own sub-agents, or external coding agents such as Claude Code, Codex and any ACP agent, each using that CLI's own login. Inside Armadra it acts as the coordinator on the canvas: it dispatches work to other CLI agents, collects their reports and summarizes them.

Design choices:

- **Small and self-contained**: TypeScript with zero runtime dependencies; also shipped as a single `ama.cjs` file. Requires Node ≥ 22.
- **Built to be called**: `-p`, `--mode rpc`, `--mode acp`, the SDK and host adapters are first-class entry points; exit codes and JSON shapes are contracts.
- **Cache first**: the request prefix stays byte-stable, cache breakpoints follow each provider, and the UI shows whether the cache works and why it missed. The system prompt plus tool table of the main presets stays within token budgets enforced by tests.
- **Approvals are never answered for you**: neither ama nor the model answers a permission prompt on a person's behalf; when nobody can approve, the answer is "deny".
- **Skills, not MCP**: extend ama with `SKILL.md` directories, prompt templates, command hooks and host adapters.
- **Little configuration**: one environment variable is enough to start; everything else has a default.

## Quick start

### Install

```sh
npm i -g @armadra/agent
ama --version
```

[Releases](https://github.com/Owlbay/armadra-agent/releases) also ship a single-file build (`ama.cjs` plus the codemode sandbox entry `ama-sandbox.cjs`, kept in the same directory) and `package.tgz` for offline installs.

### Connect a model

Pick one:

```sh
export ANTHROPIC_API_KEY=sk-...          # or OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, …
ama auth set deepseek                    # store a key in ~/.config/ama/auth.json (0600), read from stdin
ama providers add packy --base-url https://proxy.example/v1 --probe   # a relay or gateway: baseUrl + key
ama auth login chatgpt                   # your own ChatGPT Plus / Pro plan instead of an API key
ama --model ollama/<model>               # local Ollama / LM Studio need no key
```

With a key present, ama picks the first provider that has one and that provider's default model; `ama config show` explains which and why.

### First conversation

```sh
cd your-project
ama                                      # terminal UI
ama -p "explain src/index.ts"            # one-shot: prints the answer and exits
git diff | ama -p "review this change"   # piped input is appended to the prompt
ama -p "list the TODOs" --output-format json
```

`-p` has nobody to approve, so writes and commands are denied unless you allow them (`--permission-mode auto-edit`, `auto`, or `--allow "bash(npm test*)"`).

### Keys to know

| Key / command          | Effect                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| Shift+Tab (Tab, empty) | Cycle permission modes; entering Bypass asks to confirm                     |
| `/model` (Ctrl+L)      | Pick a model; Tab shows all providers, Space adds the model to your list    |
| ↓ on an empty input    | Focus the agent bar; Enter opens a live view of a sub-agent                 |
| Ctrl+B                 | Move a blocking foreground sub-agent to the background (in tmux: `C-b C-b`) |
| Esc / Esc Esc          | Interrupt the run / (idle, empty input) open the rewind list                |
| Ctrl+G                 | Status bar: full ↔ compact                                                  |
| Ctrl+O                 | Expand / fold tool output and thinking                                      |
| `/config`              | Settings panel                                                              |
| Ctrl+C twice           | Quit (the resume command stays in the scrollback)                           |

`/help` lists every command. Keys can be remapped in `~/.config/ama/keybindings.json`; see [docs/en/tui.md](docs/en/tui.md#keys).

## Capabilities

### Models and providers

Four protocol lines (Anthropic Messages, OpenAI Responses, OpenAI Chat Completions, Google Generative AI) and 18 built-in providers: Anthropic, OpenAI, Google, DeepSeek, Moonshot (Kimi), Zhipu, Qwen (DashScope), OpenRouter, Groq, xAI, Mistral, MiniMax, StepFun, Volcengine Ark, Tencent, ChatGPT (plan login), Ollama and LM Studio. One provider can mount several channels; Messages / Responses are preferred and Chat is the fallback, and `provider/model@channel` picks one explicitly. Relays connect with `ama providers add`, which lists the models, probes the channels and writes the config. Context window, output limit, image input, reasoning and prices come from a bundled models.dev snapshot, so startup needs no network (`ama models refresh` updates it on demand). `models.enabled` (`ama models enable|disable`, or Space in `/model`) keeps the picker to the models you use. See [docs/en/providers.md](docs/en/providers.md) and [ChatGPT login](docs/en/providers.md#chatgpt-login).

### Permissions and sandbox

| Mode        | Display name       | Writes      | Commands                          |
| ----------- | ------------------ | ----------- | --------------------------------- |
| `default`   | Manual             | ask         | ask                               |
| `auto-edit` | Accept edits       | allow       | ask                               |
| `plan`      | Plan               | deny        | read-only commands only           |
| `auto`      | Auto               | allow ¹     | safe ones allowed, risky ones ask |
| `full-auto` | Bypass permissions | allow       | allow (dangerous commands ask)    |
| `allowlist` | Allowlist only     | allow rules | allow rules (for CI)              |

¹ Secrets, `.git/`, `.ama/` and paths outside the project still ask. `auto` decides in three tiers: rules, then a static safe list, then a model classifier on a separate request. Allow / deny rules (`bash(git push*)`, `write(src/**)`), dangerous-command detection that sees through `sh -c` / `eval` / `xargs`, and project trust apply in every mode; project config can only tighten. On macOS (`sandbox-exec`) and Linux (bubblewrap) an OS sandbox isolates codemode, and optionally bash (`sandbox.bash: "auto"`). See [docs/en/permissions.md](docs/en/permissions.md) and [docs/sandbox.md](docs/sandbox.md) (Chinese).

### Sub-agents and external agents

The `task` tool hands a sub-task to a sub-agent with a fresh context: built-in `general`, `explore` and `plan`, or your own types defined in `~/.config/ama/agents/*.md`, `.ama/agents/*.md` (trusted projects) or `--agent-dir`. Under the `default` preset `task` is callable from codemode scripts; `tools.default: ["+task"]` exposes it directly. In the terminal UI, RPC and ACP a task runs in the background by default and reports back with a notification; `-p` waits for it. Running tasks appear in the agent bar above the status line, where you can open a live view and talk to a sub-agent directly. `task(agent="claude" | "codex" | "acp:<program>")` drives an external agent with your existing login in that CLI; its approvals go to a human only and its mode is never wider than ama's. `ama --mode acp` exposes ama itself as an ACP agent. See [docs/agents.md](docs/agents.md) (Chinese) and [docs/en/tui.md](docs/en/tui.md#agent-bar).

### Plan mode

In Plan mode (`Shift+Tab`, `/plan <goal>`, `--permission-mode plan`) the model researches read-only and ends with a plan. ama saves it and opens an approval dialog: approve and execute (optionally in a fresh context, with a choice of execution mode), keep revising, or discard. Steps become todos. Unattended `-p` stops with exit code 9 instead of approving; `plan.model` lets planning and execution use different models. See [docs/plan.md](docs/plan.md) (Chinese).

### Rewind and checkpoints

Each turn is a checkpoint: files are backed up before ama first writes them, and `checkpoints.mode: "shadow-git"` snapshots the whole working directory so bash changes can be undone too. Double Esc (or `/rewind`) returns to before any message, restoring code, conversation or both, or summarizing from that point. Files you changed by hand are listed as conflicts and skipped by default. See [docs/en/tui.md](docs/en/tui.md#rewind) and [docs/en/sessions.md](docs/en/sessions.md).

### Context and caching

Long sessions compact automatically in two tiers: large old tool results are pruned first, then the history is summarized, with the summary request reusing the cached prefix. ama keeps the prefix byte-stable, detects and explains cache misses, tells endpoints that report cache usage from those that do not, and can warm the cache during long tool runs (`cache.warming`). Cross-session memory is off by default; `ama memory enable` turns it on, and requests are byte-identical while it is off. See [docs/en/providers.md](docs/en/providers.md#caching) and [docs/memory.md](docs/memory.md) (Chinese).

### Observability

The status bar shows throughput (tok/s, time to first token), usage and cache hit rate on the first line; mode, model, context, git branch, cost and duration on the second; and with a ChatGPT plan a third line with quota usage and reset times. `Ctrl+G` folds it to one line. `/trace` opens a tree of turns, requests, tools and sub-agents with timing; `ama sessions trace <id> --html` writes the same as a redacted single-file page. `ama stats` aggregates requests, tokens, cache hit rate and cost across sessions. See [docs/en/tui.md](docs/en/tui.md#layout) and [docs/en/sessions.md](docs/en/sessions.md).

### codemode and tool presets

codemode lets the model write a short JavaScript that orchestrates many tool calls; it runs in a `node --permission` child process (inside the OS sandbox when available) and only its output goes back to the model. Every inner call still passes hooks and permissions. Tool presets: `default` (read, edit, write, bash, grep, glob, plus codemode when the network is isolated), `minimal`, `codemode-only` and `coordinator`. See [docs/codemode.md](docs/codemode.md) (Chinese).

### Configuration

One user file, `~/.config/ama/config.json`, created on first use with a JSON schema for editors. Layers merge as built-in defaults ← user ← profile ← project ← command line; the project level (`.ama/config.json`) can only tighten. `/config` opens a settings panel; from the shell use `ama config get|set|unset|list`, and `ama config show` prints every effective value with its source. Project conventions in `AGENTS.md` are picked up automatically. `ama doctor` checks layers, trust, key sources, hooks and sandbox. See [docs/en/tui.md](docs/en/tui.md#the-config-settings-panel-and-ama-config).

### Interface language

The interface is available in Chinese and English: `ui.language` (`auto` / `zh` / `en`), `--lang` or `AMA_LANG`; `auto` follows `LANG`. Text sent to the model is always English, so requests are identical in both languages; set `ui.replyLanguage` (for example `"Chinese"`) to have the model reply in another language.

## Embedding and integration

**SDK**: `npm i @armadra/agent`.

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
await session.prompt("list the entry files under src");
console.log(session.getLastAssistantText());
await session.dispose();
```

`createAgentSession` reads no config files; `createRuntime({ argv })` runs the same startup as the `ama` command. A fuller example is [examples/sdk-demo.ts](https://github.com/Owlbay/armadra-agent/blob/main/examples/sdk-demo.ts).

| Entry point          | Use                                                               | Docs                                       |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `ama --mode rpc`     | JSONL over stdio for hosts; types in `@armadra/agent/rpc`         | [docs/en/rpc.md](docs/en/rpc.md)           |
| `ama --mode acp`     | ACP agent for editors and Armadra; client in `@armadra/agent/acp` | [docs/en/acp.md](docs/en/acp.md)           |
| `--profile <file>`   | Host adapter: canvas tools, approvals, injected messages, status  | [docs/en/host-api.md](docs/en/host-api.md) |
| `@armadra/agent/tui` | The terminal component library                                    | [docs/en/tui.md](docs/en/tui.md)           |

Armadra starts ama with `ama --profile <path>` and the `coordinator` preset: the coordinator reads files and calls canvas tools but never edits code itself.

## Command reference

| Command                                                  | Purpose                                                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `ama` / `ama --no-tui`                                   | Terminal UI / line mode                                   |
| `ama -p "<prompt>"`                                      | One-shot run (`--output-format text\|json\|stream-json`)  |
| `ama -c` / `ama -r [id]`                                 | Continue the latest session here / resume a session       |
| `ama auth set\|list\|remove <provider>`                  | Manage stored API keys                                    |
| `ama auth login\|logout\|status chatgpt`                 | ChatGPT plan login                                        |
| `ama providers add\|list\|channels\|remove\|refresh`     | Relays and custom providers                               |
| `ama models list\|check\|discover\|refresh`              | Models, availability, relay discovery, models.dev refresh |
| `ama models enable\|disable`                             | The `/model` list (`models.enabled`)                      |
| `ama models cache-probe <provider/id>`                   | Whether an endpoint reports cache usage                   |
| `ama config show\|path\|edit\|get\|set\|unset\|list`     | Settings                                                  |
| `ama sessions list\|show\|search\|export\|trace\|prune`  | Sessions, full-text search, export, traces                |
| `ama stats [--since 7d] [--by model]`                    | Usage across sessions                                     |
| `ama memory list\|show\|edit\|rm\|path\|enable\|disable` | Memory                                                    |
| `ama doctor` / `ama init`                                | Diagnostics / create the config directory                 |

Common flags: `--model`, `--thinking`, `--permission-mode`, `--allow` / `--deny`, `--tools-preset`, `--max-turns`, `--max-cost`, `--image`, `--lang`. `ama --help` lists everything.

## Exit codes

| Code | Meaning                                                                 |
| ---- | ----------------------------------------------------------------------- |
| 0    | Success                                                                 |
| 1    | Runtime error (the model ultimately failed, etc.)                       |
| 2    | Usage error; the current model does not accept images                   |
| 3    | Config / profile / path error; `ama config set` rejected a key or value |
| 4    | No usable model or key                                                  |
| 5    | Session missing or corrupted                                            |
| 6    | Host / hook startup failure                                             |
| 7    | `-p` had tool calls denied (no approver, deny rules, plan, …)           |
| 8    | `-p` reached a budget limit (`--max-turns` / `--max-cost` / `limits`)   |
| 9    | `-p` saved a plan that awaits approval                                  |
| 78   | Host API version mismatch                                               |
| 130  | SIGINT; 143 = SIGTERM                                                   |

## Documentation

Seven docs have English versions; the rest are in Chinese.

**User docs**

- [Providers and models](docs/en/providers.md) ([中文](docs/providers.md)): providers, channels, keys, ChatGPT login, relays, models.dev, images, caching
- [Terminal UI](docs/en/tui.md) ([中文](docs/tui.md)): layout, status bar, keys, commands, rewind, approvals, agent bar, traces, `/config`
- [Permissions](docs/en/permissions.md) ([中文](docs/permissions.md)): modes, decision order, auto's three tiers
- [Sessions](docs/en/sessions.md) ([中文](docs/sessions.md)): stats, search, `--from`, export, traces, checkpoints
- [Sub-agents and external agents](docs/agents.md), [Plan mode](docs/plan.md), [Memory](docs/memory.md), [Sandbox](docs/sandbox.md), [codemode](docs/codemode.md), [Command hooks](docs/hooks.md) (Chinese)

**Integration docs**

- [RPC protocol](docs/en/rpc.md) ([中文](docs/rpc.md)), [Host adapter API](docs/en/host-api.md) ([中文](docs/host-api.md))
- [ACP](docs/en/acp.md) ([中文](docs/acp.md)): `ama --mode acp`, sessions, tool calls, sign-in, deviations, the ACP client
- [Session file format](docs/session-format.md) (Chinese)

**Design and research** (Chinese)

- [Overall design and decision log][design], [terminal UI visual spec](docs/tui-design.md), [rewind design](docs/rewind-plan.md), [bilingual conventions][i18n]
- [Local extensions (draft, not implemented)][extensions], [benchmarks][benchmarks], [research reports][research]
- Wave plans: [wave 3][w3], [wave 5][wave5], [wave 6][wave6], [early implementation plan][impl]

[design]: https://github.com/Owlbay/armadra-agent/blob/main/docs/design.md
[i18n]: https://github.com/Owlbay/armadra-agent/blob/main/docs/i18n.md
[extensions]: https://github.com/Owlbay/armadra-agent/blob/main/docs/extensions.md
[benchmarks]: https://github.com/Owlbay/armadra-agent/tree/main/docs/benchmarks
[research]: https://github.com/Owlbay/armadra-agent/tree/main/docs/research
[w3]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave3-plan.md
[wave5]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave5-plan.md
[wave6]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave6-plan.md
[impl]: https://github.com/Owlbay/armadra-agent/blob/main/docs/implementation-plan.md

Release notes: [CHANGELOG.md](CHANGELOG.md) (English, from 0.6.0) and [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese, complete history).

## Known limitations

- **Linux sandbox not verified on real machines**: bubblewrap policies are covered by unit tests and Ubuntu CI only. Windows has no OS sandbox: on Node 22 / 24 codemode there is not network-isolated and asks for approval every time.
- **External agents against real CLIs run locally only**: CI uses recorded replays and ama driving ama; real `claude` / `codex` runs need a logged-in machine and `AMA_E2E_AGENTS=1`.
- **ChatGPT login not yet verified with a real account**: both login flavors are tested against a local mock; real-account checks run locally with `AMA_E2E_CHATGPT=1`.
- **DeepSeek, Zhipu and Kimi default to the Chat channel**: their Messages channels (`@messages`) have only been tested through relays.
- Sub-agents have depth 1 and no fork mode that inherits the parent conversation.

## Development

Requires Node ≥ 22 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm run ci              # typecheck, format, dependency and i18n checks, release check, tests, build
AMA_E2E=1 pnpm test:e2e  # bundle-level end-to-end tests with the free fake provider
```

Tests use the scripted `fake` provider (`AMA_FAKE_SCRIPT`), never a real model. `src/` may only use `node:` built-ins and relative imports (`pnpm check:deps`). To release, bump the version, update both changelogs and push a `v<version>` tag; GitHub Actions creates the release and publishes to npm through trusted publishing.

## License and acknowledgements

[MIT](LICENSE). Model metadata comes from [models.dev](https://models.dev) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
