<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ama-wordmark-dark.svg">
  <img src="docs/assets/ama-wordmark-light.svg" alt="ama" width="216">
</picture>

English · [简体中文](README.zh-CN.md)

**A coding agent for your terminal that scripts, editors and hosts can call, and that can hand work to other coding agents.**

[![CI](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@armadra/agent)](https://www.npmjs.com/package/@armadra/agent)
[![license](https://img.shields.io/npm/l/@armadra/agent)](LICENSE)
[![node](https://img.shields.io/node/v/@armadra/agent)](https://nodejs.org)

[Install](#install) · [Connect a model](#connect-a-model) · [Usage](#usage) · [Configuration and permissions](#configuration-and-permissions) · [Docs](docs/README.md) · [Changelog](CHANGELOG.md)

</div>

---

ama reads, edits and runs code in your project from a terminal UI, and answers one-shot questions with `ama -p`. It can
delegate to its own sub-agents or drive external coding agents (Claude Code, Codex, GitHub Copilot CLI, OpenCode, Pi and
any ACP agent) with the login you already have in each CLI. Use it on its own, from your editor over ACP, embedded through
RPC or the SDK, or as the coordinator on the [Armadra](https://github.com/Owlbay/Armadra) canvas.

## Why ama

- **Zero runtime dependencies**: TypeScript on Node ≥ 22 with nothing in `dependencies`; also shipped as a single
  `ama.cjs` file. HTTP, SSE, YAML frontmatter and JSON Schema handling are written in-house.
- **Cache first**: the system prompt and tool table stay byte-stable within a session, changes are only appended, cache
  breakpoints follow each provider, and the status bar shows the hit rate and why a request missed. Token budgets for
  the main tool presets are enforced by tests.
- **Approvals go to a person**: neither ama nor the model answers a permission prompt, including those raised by
  sub-agents and external agents. When nobody can approve (`-p`, unattended RPC), the answer is "deny".
- **Built to be called**: `-p`, `--mode rpc`, `--mode acp`, the SDK and host adapters are first-class entry points;
  exit codes and JSON shapes are contracts, versioned and checked before every release.
- **Skills, not MCP**: extend ama with `SKILL.md` directories, prompt templates, command hooks and host adapters.

## Install

```sh
npm i -g @armadra/agent
ama --version
```

Each [release](https://github.com/Owlbay/armadra-agent/releases) also ships a single-file build (`ama.cjs` plus the
codemode sandbox entry `ama-sandbox.cjs`, kept in the same directory) and `package.tgz` for offline installs.

## Connect a model

Pick one:

```sh
export ANTHROPIC_API_KEY=sk-...       # or OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, …
ama auth set deepseek                 # store a key in ~/.config/ama/auth.json (0600), read from stdin
ama auth login chatgpt                # use your own ChatGPT Plus / Pro plan instead of an API key
ama providers add packy --base-url https://relay.example/v1 --probe   # a relay: list models, probe protocols, write config
ama --model ollama/<model>            # local Ollama / LM Studio need no key
```

- **Built-in providers (18)**: Anthropic, OpenAI, Google, DeepSeek, Moonshot (Kimi), Zhipu, Qwen (DashScope), OpenRouter,
  Groq, xAI, Mistral, MiniMax, StepFun, Volcengine Ark, Tencent, ChatGPT (plan login), Ollama and LM Studio, over four
  protocols: Anthropic Messages, OpenAI Responses, OpenAI Chat Completions and Google Generative AI.
- **Channels**: one provider can expose several endpoints; `provider/model@channel` picks one, e.g.
  `deepseek/deepseek-v4-pro@messages`.
- **Model metadata** (context window, output limit, image input, reasoning, prices) comes from a bundled models.dev
  snapshot, so startup needs no network; `ama models refresh` updates it on demand.
- With a key present, ama picks the first provider that has one and its default model; `ama config show` says which
  and why.

Details: [providers and models](docs/en/guides/providers.md), [ChatGPT login](docs/en/guides/providers.md#chatgpt-login),
[connecting relays](docs/en/guides/providers.md#connecting-relays).

## Usage

### Terminal UI

```sh
cd your-project
ama
```

| Key / command          | Effect                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| Shift+Tab (Tab, empty) | Cycle permission modes; entering Bypass asks to confirm                     |
| `/model` (Ctrl+L)      | Pick a model                                                                |
| ↓ on an empty input    | Focus the agent bar; Enter opens a live view of a sub-agent                 |
| Ctrl+B                 | Move a blocking foreground sub-agent to the background (in tmux: `C-b C-b`) |
| Esc / Esc Esc          | Interrupt the run / (idle, empty input) open the rewind list                |
| `/plan <goal>`         | Research read-only, then approve a plan before anything is changed          |
| `/trace`               | Tree of turns, requests, tools and sub-agents with timing                   |
| `/config`              | Settings panel                                                              |

`/help` lists every command. Each turn is a checkpoint that `/rewind` can return to (code, conversation or both).
See [terminal UI](docs/en/guides/tui.md) and [sessions](docs/en/guides/sessions.md).

### One-shot runs: `-p`

```sh
ama -p "explain src/index.ts"
git diff | ama -p "review this change"
npm test 2>&1 | ama -p "why does this fail" -
ama -p "list the TODOs" --output-format json      # or stream-json, same events as RPC
```

`-p` has nobody to approve, so writes and commands are denied unless you allow them (`--permission-mode auto-edit`,
`auto`, or `--allow "bash(npm test*)"`). Budgets: `--max-turns`, `--max-cost`. Exit codes are listed at the end of
`ama --help` (for example 7 = tool calls denied, 8 = budget reached, 9 = plan awaiting approval).

### Coordinate external agents

`task(agent="…")` runs another coding agent with that CLI's own login, model and permission policy; the result comes back
as a tool result. Approvals it raises go to you only, and its mode is never wider than ama's.

| `agent`                           | Driver                                                       | Status (2026-10-10)  |
| --------------------------------- | ------------------------------------------------------------ | -------------------- |
| `claude`                          | `claude-agent-acp` → `claude -p` stream-json → one-shot JSON | Verified             |
| `codex`                           | `codex-acp` → `codex app-server` → `codex exec` (one-shot)   | Verified             |
| `copilot`                         | `copilot --acp --stdio`                                      | Verified             |
| `opencode`                        | `opencode acp`                                               | Verified             |
| `pi`                              | `pi --mode rpc` with an approval gate loaded for the run     | Verified             |
| `cursor`                          | `cursor-agent acp`                                           | Listed, not verified |
| `gemini`, `qwen`, `kimi`, `goose` | Their ACP subcommands                                        | Listed, not verified |
| `acp:<program>`                   | Any other ACP agent                                          | —                    |

`task` is not in the default tool list: enable it with `tools.default: ["+task"]` (or `--tools …,task`). `/agents`
shows which CLIs are installed. Capability matrix, mode mapping and accounts:
[sub-agents and external agents](docs/guides/agents.md#实测能力矩阵2026-10-10) (Chinese), measurements in
[external agent benchmarks](docs/benchmarks/external-agents-2026-10.md).

### Sub-agents and fork

The same `task` tool starts ama's own sub-agents: built-in `general`, `explore` and `plan`, or your types in
`~/.config/ama/agents/*.md`, `.ama/agents/*.md` (trusted projects) or `--agent-dir`. A sub-agent starts with a fresh
context by default; `context: "fork"` inherits the parent conversation and reuses its cached prefix. Tasks run in the
background in the UI, RPC and ACP (`-p` waits), can be isolated in a git worktree, and appear in the agent bar where you
can watch and talk to them. Depth is 1: sub-agents cannot delegate again.

### Embed and integrate

| Entry point          | Use                                                              | Docs                                                                   |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ama --mode acp`     | ACP agent for Zed, JetBrains and Armadra; also an ACP client     | [ACP](docs/en/reference/acp.md)                                        |
| `ama --mode rpc`     | JSONL over stdio for hosts; types in `@armadra/agent/rpc`        | [RPC protocol](docs/en/reference/rpc.md)                               |
| SDK                  | `createAgentSession()` / `createRuntime()` from `@armadra/agent` | [example](examples/sdk-demo.ts)                                        |
| `--profile <file>`   | Host adapter: register tools, answer approvals, inject messages  | [host adapter API](docs/en/reference/host-api.md)                      |
| `@armadra/agent/tui` | The terminal component library                                   | [terminal UI](docs/en/guides/tui.md#component-library-armadraagenttui) |

Zed (`settings.json`):

```json
{ "agent_servers": { "ama": { "type": "custom", "command": "ama", "args": ["--mode", "acp"] } } }
```

SDK:

```ts
import { createAgentSession } from "@armadra/agent";

const session = await createAgentSession({
  cwd: process.cwd(),
  model: "anthropic/<model-id>", // "fake/echo" for a dry run
  auth: { kind: "env" },
  permission: { mode: "default", ask: async (req) => (req.toolName === "read" ? "allow" : "deny") },
});
await session.prompt("list the entry files under src");
console.log(session.getLastAssistantText());
await session.dispose();
```

## Configuration and permissions

- **Config**: one user file, `~/.config/ama/config.json`, merged as built-in defaults ← user ← profile ← project ←
  command line. The project level (`.ama/config.json`) can only tighten. `ama config show` prints every effective value
  with its source; `ama doctor` checks layers, trust, key sources, hooks and the sandbox.
- **AGENTS.md**: read automatically, no trust needed. In each directory the first of `AGENTS.override.md`, `AGENTS.md`,
  `AGENTS.MD` is used; the user-level `~/.config/ama/AGENTS.md` comes first, then ancestors from the outermost down to
  the current directory. Identical copies (for example a worktree inside the main repo) are read once.
- **Trust**: project hooks (`.ama/hooks.json`), skills (`.ama/skills/`, ancestor `.agents/skills/`) and prompt templates
  load only in trusted projects. ama asks once in the terminal UI and can remember the answer; `--trust` / `--no-trust`
  decide for one launch; unattended runs default to untrusted.
- **Permission modes**:

| Mode        | Display name       | Writes      | Commands                                           |
| ----------- | ------------------ | ----------- | -------------------------------------------------- |
| `default`   | Manual             | ask         | ask                                                |
| `auto-edit` | Accept edits       | allow       | ask                                                |
| `plan`      | Plan               | deny        | read-only commands only                            |
| `auto`      | Auto               | allow ¹     | safe list allowed, the rest judged by a classifier |
| `full-auto` | Bypass permissions | allow       | allow (dangerous commands ask)                     |
| `allowlist` | Allowlist only     | allow rules | allow rules (for CI)                               |

¹ Secrets, `.git/`, `.ama/` and paths outside the project still ask. Deny rules and dangerous-command detection apply in
every mode. On macOS (`sandbox-exec`) and Linux (bubblewrap) an OS sandbox isolates codemode and, optionally, bash; Windows has none. See
[permissions](docs/en/guides/permissions.md) and [sandbox](docs/guides/sandbox.md) (Chinese).

The interface is available in English and Chinese (`--lang`, `AMA_LANG` or `ui.language`); text sent to the model is
always English, so requests are byte-identical in both languages.

## Documentation

The [documentation index](docs/README.md) lists every document (an English index is in
[docs/en/README.md](docs/en/README.md)). Layout:

- `docs/guides/`: how things work today: [terminal UI](docs/en/guides/tui.md), [providers](docs/en/guides/providers.md),
  [permissions](docs/en/guides/permissions.md), [sessions](docs/en/guides/sessions.md), plus agents, plan mode, memory,
  hooks, codemode, sandbox and i18n in Chinese.
- `docs/reference/`: protocols and formats: [RPC](docs/en/reference/rpc.md), [ACP](docs/en/reference/acp.md),
  [host adapter API](docs/en/reference/host-api.md), [session file format](docs/reference/session-format.md) (Chinese).
- `docs/design/`: the [overall design](docs/design/design.md) and other target designs.
- `docs/history/`, `docs/research/`, `docs/benchmarks/`: finished plans, research and measurements, for the record.

Release notes: [CHANGELOG.md](CHANGELOG.md) (English, from 0.6.0) and [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)
(Chinese, complete history).

## Development and release

Requires Node ≥ 22 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm run ci              # typecheck, format, dependency, i18n and doc-link checks, release check, tests, build
AMA_E2E=1 pnpm test:e2e  # bundle-level end-to-end tests with the free fake provider
```

Tests use the scripted `fake` provider, never a real model. Conventions are in [AGENTS.md](AGENTS.md) and
[CONTRIBUTING](.github/CONTRIBUTING.md). Releases are cut by pushing a `v<version>` tag: CI creates the GitHub Release
and publishes to npm through trusted publishing.

## License

[MIT](LICENSE). Model metadata comes from [models.dev](https://models.dev) (MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
