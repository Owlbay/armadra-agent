<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/ama-wordmark-dark.svg">
  <img src="docs/assets/ama-wordmark-light.svg" alt="ama" width="216">
</picture>

[English](README.md) · 简体中文

**在终端里写代码的 Agent：脚本、编辑器和宿主都能调用它，它也能把活交给其它编码 Agent。**

[![CI](https://github.com/AMA-Link/armadra-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/AMA-Link/armadra-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@armadra/agent)](https://www.npmjs.com/package/@armadra/agent)
[![license](https://img.shields.io/npm/l/@armadra/agent)](LICENSE)
[![node](https://img.shields.io/node/v/@armadra/agent)](https://nodejs.org)

[安装](#安装) · [连接模型](#连接模型) · [用法](#用法) · [配置与权限](#配置与权限) · [文档](docs/README.md) · [更新记录](CHANGELOG.zh-CN.md)

</div>

---

ama 在终端界面里读代码、改代码、跑命令，也能用 `ama -p` 一次性回答问题。它可以把子任务交给自己的子 Agent，或者以你在各个
CLI 里已有的登录驱动外部编码 Agent（Claude Code、Codex、GitHub Copilot CLI、OpenCode、Pi 以及任意 ACP Agent）。可以单独
使用，可以在编辑器里经 ACP 使用，可以经 RPC 或 SDK 嵌入，也可以在 [Armadra](https://github.com/AMA-Link/Armadra) 画布上
担任协调者。

## 为什么用 ama

- **运行时零依赖**：TypeScript 编写，运行在 Node ≥ 22 上，`dependencies` 为空；另有单文件 `ama.cjs` 发行版。HTTP、SSE、
  YAML frontmatter 与 JSON Schema 都自己实现。
- **缓存优先**：同一会话内系统提示与工具表逐字节稳定，变化只追加在末尾；缓存断点按各家的方式放，状态栏显示命中率和未命中
  的原因。主要工具预设的 token 预算由测试守住。
- **审批只交给人**：ama 与模型都不代答权限请求，子 Agent 与外部 Agent 发起的也一样。没有人能审批时（`-p`、无人值守的
  RPC）一律拒绝。
- **为被调用而做**：`-p`、`--mode rpc`、`--mode acp`、SDK 与宿主适配器都是正式入口；退出码与 JSON 形状都是契约，带版本号，
  每次发布前检查。
- **Skills 而非 MCP**：用 `SKILL.md` 目录、提示模板、命令式 Hook 与宿主适配器扩展 ama。

## 安装

```sh
npm i -g @armadra/agent
ama --version
```

每个 [Release](https://github.com/AMA-Link/armadra-agent/releases) 还附带单文件版（`ama.cjs` 与 codemode 沙箱入口
`ama-sandbox.cjs`，放在同一目录）和离线安装用的 `package.tgz`。

## 连接模型

任选一种：

```sh
export ANTHROPIC_API_KEY=sk-...       # 或 OPENAI_API_KEY、GEMINI_API_KEY、DEEPSEEK_API_KEY …
ama auth set deepseek                 # 从 stdin 读 key，存到 ~/.config/ama/auth.json（0600）
ama auth login chatgpt                # 用自己的 ChatGPT Plus / Pro 订阅额度，不用 API key
ama providers add packy --base-url https://relay.example/v1 --probe   # 中转：列模型、探测协议、写配置
ama --model ollama/<模型>             # 本地 Ollama / LM Studio 不需要 key
```

- **内置供应商（18 家）**：Anthropic、OpenAI、Google、DeepSeek、Moonshot（Kimi）、智谱、通义（DashScope）、OpenRouter、
  Groq、xAI、Mistral、MiniMax、阶跃星辰、火山方舟、腾讯、ChatGPT（订阅登录）、Ollama 与 LM Studio，覆盖四种协议：
  Anthropic Messages、OpenAI Responses、OpenAI Chat Completions 与 Google Generative AI。
- **渠道**：一个供应商可以挂多个接口，`provider/model@channel` 指定其中一个，例如 `deepseek/deepseek-v4-pro@messages`。
- **模型元数据**（上下文窗口、输出上限、图像输入、推理、价格）来自随包附带的 models.dev 快照，启动不联网；
  `ama models refresh` 按需更新。
- 有 key 时，ama 取第一个有 key 的供应商及其缺省模型；`ama config show` 说明选了哪个、为什么。

详见[供应商与模型](docs/guides/providers.md)、[ChatGPT 登录](docs/guides/providers.md#chatgpt-登录)、
[接入中转站](docs/guides/providers.md#接入中转站)。

## 用法

### 终端界面

```sh
cd your-project
ama
```

| 按键 / 命令             | 作用                                                   |
| ----------------------- | ------------------------------------------------------ |
| Shift+Tab（空输入 Tab） | 循环切换权限模式；进入 Bypass 需要确认                 |
| `/model`（Ctrl+L）      | 选模型                                                 |
| 空输入时 ↓              | 进入 Agent 栏；Enter 打开子 Agent 的实时视图           |
| Ctrl+B                  | 把阻塞中的前台子 Agent 转到后台（tmux 里按 `C-b C-b`） |
| Esc / Esc Esc           | 中断运行 /（空闲且输入为空）打开回滚列表               |
| `/plan <目标>`          | 先只读调研，批准计划后才开始改动                       |
| `/trace`                | 回合、请求、工具与子 Agent 的耗时树                    |
| `/config`               | 设置面板                                               |

`/help` 列出全部命令。每个回合都是检查点，`/rewind` 可以回到其中任一处（代码、对话或两者）。
见[终端界面](docs/guides/tui.md)与[会话](docs/guides/sessions.md)。

### 一次性运行：`-p`

```sh
ama -p "解释 src/index.ts"
git diff | ama -p "审查这次改动"
npm test 2>&1 | ama -p "为什么失败" -
ama -p "列出 TODO" --output-format json      # 或 stream-json，事件与 RPC 同形
```

`-p` 没有人审批，写文件与跑命令缺省被拒，需要显式放行（`--permission-mode auto-edit`、`auto`，或
`--allow "bash(npm test*)"`）。预算用 `--max-turns`、`--max-cost` 控制。退出码列在 `ama --help` 末尾（例如 7 = 工具调用
被拒，8 = 达到预算，9 = 计划待批准）。

### 协调外部 Agent

`task(agent="…")` 以对应 CLI 自己的登录、模型与权限策略运行另一个编码 Agent，结果作为工具结果回来。它发起的审批只交给你，
它的模式不会比 ama 当前的更宽。

| `agent`                           | 驱动                                                       | 状态（2026-10-10） |
| --------------------------------- | ---------------------------------------------------------- | ------------------ |
| `claude`                          | `claude-agent-acp` → `claude -p` stream-json → 一次性 JSON | 已实测             |
| `codex`                           | `codex-acp` → `codex app-server` → `codex exec`（一次性）  | 已实测             |
| `copilot`                         | `copilot --acp --stdio`                                    | 已实测             |
| `opencode`                        | `opencode acp`                                             | 已实测             |
| `pi`                              | `pi --mode rpc`，运行时加载审批闸扩展                      | 已实测             |
| `cursor`                          | `cursor-agent acp`                                         | 已收录，未实测     |
| `gemini`、`qwen`、`kimi`、`goose` | 各自的 ACP 子命令                                          | 已收录，未实测     |
| `acp:<程序>`                      | 其它任意 ACP Agent                                         | —                  |

`task` 不在缺省工具表里：用 `tools.default: ["+task"]`（或 `--tools …,task`）打开。`/agents` 显示本机装了哪些 CLI。
能力矩阵、模式映射与账户说明见[子 Agent 与外部 Agent](docs/guides/agents.md#实测能力矩阵2026-10-10)，实测数据见
[外部 Agent 驱动实测](docs/benchmarks/external-agents-2026-10.md)。

### 子 Agent 与 fork

同一个 `task` 工具也启动 ama 自己的子 Agent：内置 `general`、`explore`、`plan`，或定义在 `~/.config/ama/agents/*.md`、
`.ama/agents/*.md`（已信任的项目）或 `--agent-dir` 里的类型。子 Agent 缺省从全新上下文开始；`context: "fork"` 继承父会话
的对话并复用它已缓存的前缀。在终端界面、RPC 与 ACP 里任务缺省在后台运行（`-p` 等待完成），可以放进独立的 git worktree，
并显示在 Agent 栏里，你可以查看并直接与它对话。深度为 1：子 Agent 不能再委派。

### 嵌入与集成

| 入口                 | 用途                                                               | 文档                                                 |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `ama --mode acp`     | 供 Zed、JetBrains 与 Armadra 驱动的 ACP Agent；也能作为 ACP 客户端 | [ACP](docs/reference/acp.md)                         |
| `ama --mode rpc`     | 面向宿主的 stdio JSONL；类型在 `@armadra/agent/rpc`                | [RPC 协议](docs/reference/rpc.md)                    |
| SDK                  | `@armadra/agent` 的 `createAgentSession()` / `createRuntime()`     | [示例](examples/sdk-demo.ts)                         |
| `--profile <文件>`   | 宿主适配器：注册工具、回答审批、注入消息                           | [宿主适配器 API](docs/reference/host-api.md)         |
| `@armadra/agent/tui` | 终端组件库                                                         | [终端界面](docs/guides/tui.md#组件库armadraagenttui) |

Zed（`settings.json`）：

```json
{ "agent_servers": { "ama": { "type": "custom", "command": "ama", "args": ["--mode", "acp"] } } }
```

SDK：

```ts
import { createAgentSession } from "@armadra/agent";

const session = await createAgentSession({
  cwd: process.cwd(),
  model: "anthropic/<model-id>", // 试运行用 "fake/echo"
  auth: { kind: "env" },
  permission: { mode: "default", ask: async (req) => (req.toolName === "read" ? "allow" : "deny") },
});
await session.prompt("列出 src 下的入口文件");
console.log(session.getLastAssistantText());
await session.dispose();
```

## 配置与权限

- **配置**：用户级只有一个文件 `~/.config/ama/config.json`，按「内置缺省 ← 用户级 ← profile ← 项目级 ← 命令行」合并。
  项目级（`.ama/config.json`）只能收紧。`ama config show` 列出每个键的生效值与来源；`ama doctor` 检查配置层级、信任、
  key 来源、Hook 与沙箱。
- **AGENTS.md**：自动读入，不需要信任。每个目录取 `AGENTS.override.md`、`AGENTS.md`、`AGENTS.MD` 中第一个存在的；
  用户级 `~/.config/ama/AGENTS.md` 在最前，其后是从最外层祖先到当前目录。内容完全相同的副本（例如主仓库目录内的
  worktree）只读一次。
- **信任**：项目级 Hook（`.ama/hooks.json`）、Skill（`.ama/skills/`、祖先目录的 `.agents/skills/`）与提示模板只在已信任的
  项目里加载。终端界面里首次询问一次，可以记住；`--trust` / `--no-trust` 只决定本次启动；无人值守时缺省不信任。
- **权限模式**：

| 模式        | 显示名             | 写文件     | 命令                           |
| ----------- | ------------------ | ---------- | ------------------------------ |
| `default`   | Manual             | 询问       | 询问                           |
| `auto-edit` | Accept edits       | 放行       | 询问                           |
| `plan`      | Plan               | 拒绝       | 只放行只读命令                 |
| `auto`      | Auto               | 放行 ¹     | 安全名单放行，其余由分类器判断 |
| `full-auto` | Bypass permissions | 放行       | 放行（危险命令仍询问）         |
| `allowlist` | Allowlist only     | 按允许规则 | 按允许规则（用于 CI）          |

¹ 密钥文件、`.git/`、`.ama/` 与项目外的路径仍然询问。拒绝规则与危险命令检测在所有模式下生效。macOS（`sandbox-exec`）与
Linux（bubblewrap）上有操作系统级沙箱隔离 codemode，bash 可选接入；Windows 没有。见[权限](docs/guides/permissions.md)与
[沙箱](docs/guides/sandbox.md)。

界面有中文与英文两种（`--lang`、`AMA_LANG` 或 `ui.language`）；发给模型的文本始终是英文，两种界面语言下请求逐字节相同。

## 文档

[文档索引](docs/README.md)列出了全部文档。分层如下：

- `docs/guides/`：现行行为与用法，包括[终端界面](docs/guides/tui.md)、[供应商与模型](docs/guides/providers.md)、
  [权限](docs/guides/permissions.md)、[会话](docs/guides/sessions.md)、[子 Agent 与外部 Agent](docs/guides/agents.md)、
  [Plan 模式](docs/guides/plan.md)、[记忆](docs/guides/memory.md)、[命令式 Hook](docs/guides/hooks.md)、
  [codemode](docs/guides/codemode.md)、[沙箱](docs/guides/sandbox.md)、[界面语言](docs/guides/i18n.md)。
- `docs/reference/`：协议与格式，包括 [RPC](docs/reference/rpc.md)、[ACP](docs/reference/acp.md)、
  [宿主适配器 API](docs/reference/host-api.md)、[会话文件格式](docs/reference/session-format.md)。
- `docs/design/`：[总体设计](docs/design/design.md)与其它目标设计。
- `docs/history/`、`docs/research/`、`docs/benchmarks/`：已完成的计划、调研与实测记录，只用于追溯。

更新记录：[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（中文，完整历史）与 [CHANGELOG.md](CHANGELOG.md)（英文，从 0.6.0 起）。

## 开发与发布

需要 Node ≥ 22 与 pnpm（`corepack enable`）。

```sh
pnpm install
pnpm run ci              # 类型检查、格式、依赖 / i18n / 文档链接检查、发版检查、测试、构建
AMA_E2E=1 pnpm test:e2e  # 用免费的 fake 供应商跑 bundle 级端到端测试
```

测试只用脚本化的 `fake` 供应商，不调真实模型。开发约定见 [AGENTS.md](AGENTS.md) 与[贡献指南](.github/CONTRIBUTING.md)。
发布由推送 `v<版本>` tag 触发：CI 创建 GitHub Release，并经 npm 可信发布推送。

## 许可

[MIT](LICENSE)。模型元数据来自 [models.dev](https://models.dev)（MIT），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
