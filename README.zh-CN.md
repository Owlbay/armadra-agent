# ama

[![CI](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@armadra/agent)](https://www.npmjs.com/package/@armadra/agent)
[![license](https://img.shields.io/npm/l/@armadra/agent)](LICENSE)
[![node](https://img.shields.io/node/v/@armadra/agent)](https://nodejs.org)

[English](README.md) · 简体中文

在终端里写代码的 Agent，也能协调其它 Agent 一起干活。可以单独使用，也可以嵌进 [Armadra](https://github.com/Owlbay/Armadra) 画布。

```text
 ▄███▄  ██▄   ▄██  ▄███▄    ama
██▀ ▀██ ███▄ ▄███ ██▀ ▀██   anthropic/claude-sonnet-4-5@messages · 思考 medium
███████ ██ ▀█▀ ██ ███████   ~/Projects/demo · 已信任
██   ██ ██     ██ ██   ██   Accept edits · 预设 default
▀▀   ▀▀ ▀▀     ▀▀ ▀▀   ▀▀   AGENTS.md · 2 Skill
                            /help 命令 · Shift+Tab 切模式 · Ctrl+O 展开工具输出
```

- [ama 是什么](#ama-是什么)
- [快速开始](#快速开始)
- [核心能力](#核心能力)
- [嵌入与集成](#嵌入与集成)
- [命令速查](#命令速查)
- [退出码](#退出码)
- [文档](#文档)
- [已知限制](#已知限制)
- [开发](#开发)
- [许可证与致谢](#许可证与致谢)

## ama 是什么

ama 在终端界面里读代码、改代码、跑命令，也能用 `ama -p` 一次性回答问题。它还能把活交给别的 Agent：自己的子 Agent，或者 Claude Code、Codex 以及任意 ACP Agent 这类外部编码 Agent（各用各 CLI 自己的登录）。嵌进 Armadra 时，它是画布上的协调者：把任务派给其它 CLI Agent，收集它们的汇报并做总结。

设计取向：

- **小而自足**：TypeScript 编写，运行时零依赖，另有单文件 `ama.cjs` 发行版。要求 Node ≥ 22。
- **为被调用而做**：`-p`、`--mode rpc`、`--mode acp`、SDK 与宿主适配器都是正式入口，退出码与 JSON 形状都是契约。
- **缓存优先**：请求前缀逐字节稳定，缓存断点按各家的方式放，界面直接显示缓存是否生效、为什么没命中。主要预设的「系统提示 + 工具表」都有 token 预算，由测试守住。
- **权限不代答**：ama 和模型都不会替人回答权限请求；没人能审批时一律按拒绝处理。
- **Skills 而非 MCP**：扩展靠 `SKILL.md` 目录、提示模板、命令式 Hook 和宿主适配器。
- **配置少**：设一个环境变量就能开始，其余都有缺省。

## 快速开始

### 安装

```sh
npm i -g @armadra/agent
ama --version
```

[Releases](https://github.com/Owlbay/armadra-agent/releases) 另提供单文件版（`ama.cjs` 与 codemode 沙箱入口 `ama-sandbox.cjs`，两者放在同一目录）和可离线安装的 `package.tgz`。

### 配一个模型

任选一种：

```sh
export ANTHROPIC_API_KEY=sk-...          # 或 OPENAI_API_KEY、GEMINI_API_KEY、DEEPSEEK_API_KEY……
ama auth set deepseek                    # 把 key 存进 ~/.config/ama/auth.json（0600），从 stdin 读入
ama providers add packy --base-url https://proxy.example/v1 --probe   # 中转站 / 网关：baseUrl + key
ama auth login chatgpt                   # 用自己的 ChatGPT Plus / Pro 订阅代替 API Key
ama --model ollama/<model>               # 本地 Ollama / LM Studio 不需要 key
```

有 key 时，ama 按内置顺序选第一家有 key 的供应商及其缺省模型；`ama config show` 会说明选了谁、为什么。

### 第一次对话

```sh
cd your-project
ama                                      # 终端界面
ama -p "解释 src/index.ts"               # 一次性：打印回答后退出
git diff | ama -p "审一下这个改动"        # 管道输入追加在提示后面
ama -p "列出 TODO" --output-format json
```

`-p` 没有人审批，写文件和跑命令默认被拒；需要时用 `--permission-mode auto-edit`、`auto` 或 `--allow "bash(npm test*)"` 放行。

### 常用按键

| 按键 / 命令               | 作用                                                   |
| ------------------------- | ------------------------------------------------------ |
| Shift+Tab（空输入时 Tab） | 循环切换权限模式；进入 Bypass 前要确认                 |
| `/model`（Ctrl+L）        | 选模型；Tab 显示全部供应商，Space 把模型加入常用列表   |
| 空输入时按 ↓              | 聚焦 Agent 栏；Enter 打开子 Agent 的实时视图           |
| Ctrl+B                    | 把阻塞中的前台子 Agent 转到后台（tmux 里按 `C-b C-b`） |
| Esc / 双击 Esc            | 中断运行 /（空闲且输入为空时）打开回滚列表             |
| Ctrl+G                    | 状态栏完整 ↔ 精简                                      |
| Ctrl+O                    | 展开 / 折叠工具输出与思考                              |
| `/config`                 | 设置面板                                               |
| 连按两次 Ctrl+C           | 退出（恢复命令留在终端回滚区）                         |

`/help` 列出全部命令。按键可在 `~/.config/ama/keybindings.json` 里改，见 [docs/tui.md](docs/tui.md#按键)。

## 核心能力

### 模型与供应商

四条协议线（Anthropic Messages、OpenAI Responses、OpenAI Chat Completions、Google Generative AI），18 家内置供应商：Anthropic、OpenAI、Google、DeepSeek、Moonshot（Kimi）、智谱、通义千问（DashScope）、OpenRouter、Groq、xAI、Mistral、MiniMax、阶跃星辰、火山方舟、腾讯、ChatGPT（订阅登录）、Ollama、LM Studio。一家供应商可以挂多个渠道，优先 Messages / Responses，Chat 兜底；`provider/model@channel` 显式指定渠道。中转站用 `ama providers add` 接入：列模型、探测渠道、写回配置。上下文窗口、输出上限、图像输入、推理与价格来自内置的 models.dev 快照，启动不联网（`ama models refresh` 按需更新）。`models.enabled`（`ama models enable|disable`，或在 `/model` 里按 Space）让选择器只列常用模型。见 [docs/providers.md](docs/providers.md) 与 [ChatGPT 登录](docs/providers.md#chatgpt-登录)。

### 权限与沙箱

| 模式        | 显示名             | 写文件        | 执行命令                 |
| ----------- | ------------------ | ------------- | ------------------------ |
| `default`   | Manual             | 询问          | 询问                     |
| `auto-edit` | Accept edits       | 放行          | 询问                     |
| `plan`      | Plan               | 拒绝          | 只放行只读命令           |
| `auto`      | Auto               | 放行 ¹        | 安全的放行，有风险的询问 |
| `full-auto` | Bypass permissions | 放行          | 放行（危险命令仍询问）   |
| `allowlist` | Allowlist only     | 按 allow 规则 | 按 allow 规则（适合 CI） |

¹ 凭据文件、`.git/`、`.ama/` 与项目外路径仍询问。`auto` 分三档判断：规则档、静态安全名单、最后由模型分类器单独发一次请求判断。allow / deny 规则（`bash(git push*)`、`write(src/**)`）、能看穿 `sh -c` / `eval` / `xargs` 的危险命令识别、项目信任在所有模式下都生效；项目级配置只能收紧。macOS（`sandbox-exec`）与 Linux（bubblewrap）上用 OS 沙箱隔离 codemode，bash 可选（`sandbox.bash: "auto"`）。见 [docs/permissions.md](docs/permissions.md) 与 [docs/sandbox.md](docs/sandbox.md)。

### 子 Agent 与外部 Agent

`task` 工具把子任务交给一个全新上下文的子 Agent：内置 `general`、`explore`、`plan`，也可以在 `~/.config/ama/agents/*.md`、`.ama/agents/*.md`（需信任项目）或 `--agent-dir` 里定义自己的类型。`default` 预设下 `task` 在 codemode 脚本里可调用，`tools.default: ["+task"]` 直接暴露。终端界面、RPC 与 ACP 下任务缺省在后台运行，完成后发通知；`-p` 会等它结束。运行中的任务列在状态行上方的 Agent 栏里，可以打开实时视图直接和子 Agent 对话。`task(agent="claude" | "codex" | "acp:<程序>")` 用你在该 CLI 里已有的登录驱动外部 Agent，审批只交给人，模式不会比 ama 当前的宽。`ama --mode acp` 把 ama 自己作为 ACP Agent 提供出去。见 [docs/agents.md](docs/agents.md) 与 [docs/tui.md](docs/tui.md#agent-栏)。

### Plan 模式

Plan 模式（`Shift+Tab`、`/plan <目标>`、`--permission-mode plan`）下模型只读调研，最后给出计划。ama 把计划落盘并弹出审批框：批准执行（可选在全新上下文里执行，并选择执行模式）、继续修改或放弃。步骤会变成 todo 逐条推进。无人值守的 `-p` 不会代为批准，以退出码 9 停下；`plan.model` 可以让规划和执行用不同模型。见 [docs/plan.md](docs/plan.md)。

### 回滚与检查点

每个回合是一个检查点：文件在第一次被写之前先备份；`checkpoints.mode: "shadow-git"` 把整个工作目录快照进影子仓库，bash 的改动也能撤回。双击 Esc（或 `/rewind`）回到任意一条消息之前，可恢复代码、对话或两者，也可以从该处开始摘要。手动改过的文件列为冲突，缺省跳过。见 [docs/tui.md](docs/tui.md#回滚) 与 [docs/sessions.md](docs/sessions.md)。

### 上下文与缓存

长会话自动分两档压缩：先裁掉旧的大块工具结果，再对历史做摘要，摘要请求沿用已缓存的前缀。ama 保持前缀逐字节稳定，识别并解释缓存未命中，区分「报告缓存用量」与「不报告」的端点，长时间跑工具时还能给缓存保温（`cache.warming`）。跨会话 Memory 缺省关闭，`ama memory enable` 开启；关闭时请求逐字节不变。见 [docs/providers.md](docs/providers.md#缓存) 与 [docs/memory.md](docs/memory.md)。

### 可观测性

状态栏第一行是吞吐（tok/s、首 token 耗时）、用量与缓存命中率；第二行是模式、模型、上下文、git 分支、费用与时长；用 ChatGPT 订阅时还有第三行，显示额度用量与重置时间。`Ctrl+G` 折成一行。`/trace` 打开回合 → 请求 → 工具 → 子 Agent 的耗时树；`ama sessions trace <id> --html` 输出同样内容的脱敏单文件页面。`ama stats` 跨会话汇总请求数、token、缓存命中率与费用。见 [docs/tui.md](docs/tui.md#布局) 与 [docs/sessions.md](docs/sessions.md)。

### codemode 与工具预设

codemode 让模型写一小段 JavaScript 编排多次工具调用，脚本在 `node --permission` 子进程里运行（可用时套 OS 沙箱），只有输出回到模型；每次内部调用照样经过 Hook 与权限。工具预设：`default`（read、edit、write、bash、grep、glob，网络隔离时加上 codemode）、`minimal`、`codemode-only`、`coordinator`。见 [docs/codemode.md](docs/codemode.md)。

### 配置

用户级只有一个文件 `~/.config/ama/config.json`，首次使用时创建，附带给编辑器用的 JSON schema。层级按「内置缺省 ← 用户级 ← profile ← 项目级 ← 命令行」合并，项目级（`.ama/config.json`）只能收紧。`/config` 打开设置面板；命令行用 `ama config get|set|unset|list`，`ama config show` 列出每个键的生效值与来源。项目里的 `AGENTS.md` 自动读入。`ama doctor` 检查配置层级、信任、key 来源、Hook 与沙箱。见 [docs/tui.md](docs/tui.md#config-设置面板与-ama-config)。

### 界面语言

界面有中文和英文：`ui.language`（`auto` / `zh` / `en`）、`--lang` 或 `AMA_LANG`；`auto` 跟随 `LANG`。发给模型的内容固定是英文，两种语言下请求完全相同；想让模型用中文回复，设 `ui.replyLanguage`（例如 `"Chinese"`）。

## 嵌入与集成

**SDK**：`npm i @armadra/agent`。

```ts
import { createAgentSession } from "@armadra/agent";

const session = await createAgentSession({
  cwd: process.cwd(),
  model: "anthropic/<model-id>", // 空跑用 "fake/echo"
  auth: { kind: "env" },
  permission: {
    mode: "default",
    ask: async (request) => (request.toolName === "read" ? "allow" : "deny"),
  },
});
await session.prompt("列出 src 下的入口文件");
console.log(session.getLastAssistantText());
await session.dispose();
```

`createAgentSession` 不读配置文件；`createRuntime({ argv })` 走和 `ama` 命令相同的启动流程。更完整的例子见 [examples/sdk-demo.ts](https://github.com/Owlbay/armadra-agent/blob/main/examples/sdk-demo.ts)。

| 入口                 | 用途                                                           | 文档                                 |
| -------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `ama --mode rpc`     | stdio 上的 JSONL，供宿主驱动；类型在 `@armadra/agent/rpc`      | [docs/rpc.md](docs/rpc.md)           |
| `ama --mode acp`     | 给编辑器与 Armadra 的 ACP Agent；客户端在 `@armadra/agent/acp` | [docs/acp.md](docs/acp.md)           |
| `--profile <文件>`   | 宿主适配器：画布工具、审批、注入消息、状态展示                 | [docs/host-api.md](docs/host-api.md) |
| `@armadra/agent/tui` | 终端组件库                                                     | [docs/tui.md](docs/tui.md)           |

Armadra 用 `ama --profile <路径>` 加 `coordinator` 预设启动 ama：协调者只读文件、调用画布工具，自己不改代码。

## 命令速查

| 命令                                                     | 用途                                                    |
| -------------------------------------------------------- | ------------------------------------------------------- |
| `ama` / `ama --no-tui`                                   | 终端界面 / 行模式                                       |
| `ama -p "<提示>"`                                        | 一次性运行（`--output-format text\|json\|stream-json`） |
| `ama -c` / `ama -r [id]`                                 | 继续本目录最近的会话 / 恢复指定会话                     |
| `ama auth set\|list\|remove <provider>`                  | 管理已存的 API Key                                      |
| `ama auth login\|logout\|status chatgpt`                 | ChatGPT 订阅登录                                        |
| `ama providers add\|list\|channels\|remove\|refresh`     | 中转站与自定义供应商                                    |
| `ama models list\|check\|discover\|refresh`              | 模型列表、连通检查、中转发现、刷新 models.dev           |
| `ama models enable\|disable`                             | `/model` 常用列表（`models.enabled`）                   |
| `ama models cache-probe <provider/id>`                   | 端点是否报告缓存用量                                    |
| `ama config show\|path\|edit\|get\|set\|unset\|list`     | 配置                                                    |
| `ama sessions list\|show\|search\|export\|trace\|prune`  | 会话、全文搜索、导出、轨迹                              |
| `ama stats [--since 7d] [--by model]`                    | 跨会话用量统计                                          |
| `ama memory list\|show\|edit\|rm\|path\|enable\|disable` | Memory                                                  |
| `ama doctor` / `ama init`                                | 诊断 / 创建配置目录                                     |

常用参数：`--model`、`--thinking`、`--permission-mode`、`--allow` / `--deny`、`--tools-preset`、`--max-turns`、`--max-cost`、`--image`、`--lang`。完整列表见 `ama --help`。

## 退出码

| 退出码 | 含义                                                         |
| ------ | ------------------------------------------------------------ |
| 0      | 成功                                                         |
| 1      | 运行期错误（模型最终失败等）                                 |
| 2      | 用法错误；当前模型不接受图像                                 |
| 3      | 配置 / profile / 路径错误；`ama config set` 拒绝了键或值     |
| 4      | 没有可用的模型或 key                                         |
| 5      | 会话不存在或已损坏                                           |
| 6      | 宿主 / Hook 启动失败                                         |
| 7      | `-p` 有工具调用被拒（无人审批、deny 规则、plan 等）          |
| 8      | `-p` 到达预算上限（`--max-turns` / `--max-cost` / `limits`） |
| 9      | `-p` 产出的计划已保存，等待审批                              |
| 78     | 宿主 API 版本不匹配                                          |
| 130    | SIGINT；143 为 SIGTERM                                       |

## 文档

**用户文档**

- [供应商与模型](docs/providers.md)（[English](docs/en/providers.md)）：供应商、渠道、key、ChatGPT 登录、中转站、models.dev、图像、缓存
- [终端界面](docs/tui.md)（[English](docs/en/tui.md)）：布局、状态栏、按键、命令、回滚、审批、Agent 栏、轨迹、`/config`
- [权限](docs/permissions.md)（[English](docs/en/permissions.md)）：模式、判定顺序、auto 的三档
- [会话](docs/sessions.md)（[English](docs/en/sessions.md)）：统计、搜索、`--from`、导出、轨迹、检查点
- [子 Agent 与外部 Agent](docs/agents.md)、[Plan 模式](docs/plan.md)、[Memory](docs/memory.md)、[沙箱](docs/sandbox.md)、[codemode](docs/codemode.md)、[命令式 Hook](docs/hooks.md)

**集成文档**

- [RPC 协议](docs/rpc.md)（[English](docs/en/rpc.md)）、[宿主适配器 API](docs/host-api.md)（[English](docs/en/host-api.md)）
- [ACP](docs/acp.md)（[English](docs/en/acp.md)）、[会话文件格式](docs/session-format.md)

**设计与研究**

- [总体设计与决策记录][design]、[终端界面视觉规范](docs/tui-design.md)、[回滚设计](docs/rewind-plan.md)、[双语开发约定][i18n]
- [本地扩展（设计草案，未实现）][extensions]、[基准测试][benchmarks]、[调研报告][research]
- 各波设计：[第三波][w3]、[第五波][wave5]、[第六波][wave6]、[早期实现计划][impl]

[design]: https://github.com/Owlbay/armadra-agent/blob/main/docs/design.md
[i18n]: https://github.com/Owlbay/armadra-agent/blob/main/docs/i18n.md
[extensions]: https://github.com/Owlbay/armadra-agent/blob/main/docs/extensions.md
[benchmarks]: https://github.com/Owlbay/armadra-agent/tree/main/docs/benchmarks
[research]: https://github.com/Owlbay/armadra-agent/tree/main/docs/research
[w3]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave3-plan.md
[wave5]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave5-plan.md
[wave6]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave6-plan.md
[impl]: https://github.com/Owlbay/armadra-agent/blob/main/docs/implementation-plan.md

更新记录：[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（中文，完整历史）与 [CHANGELOG.md](CHANGELOG.md)（英文，从 0.6.0 起）。

## 已知限制

- **Linux 沙箱没有在真机上验证**：bubblewrap 策略只有单元测试和 Ubuntu CI 覆盖。Windows 没有 OS 沙箱：Node 22 / 24 下 codemode 不隔离网络，每次都要审批。
- **外部 Agent 的真实 CLI 测试只在本地跑**：CI 只跑录制回放和 ama 驱动 ama；真实的 `claude` / `codex` 需要已登录的机器并设 `AMA_E2E_AGENTS=1`。
- **ChatGPT 登录尚未用真实账户验证**：两种登录方式只在本地 mock 上测过；真实账户检查用 `AMA_E2E_CHATGPT=1` 在本地运行。
- **DeepSeek、智谱、Kimi 缺省走 Chat 渠道**：它们的 Messages 渠道（`@messages`）只通过中转站测过。
- 子 Agent 深度为 1，没有继承父对话的 fork 模式。

## 开发

需要 Node ≥ 22 和 pnpm（`corepack enable`）。

```sh
pnpm install
pnpm run ci              # 类型检查、格式、依赖与 i18n 检查、发版检查、测试、构建
AMA_E2E=1 pnpm test:e2e  # bundle 级端到端测试，用免费的 fake 供应商
```

测试只用脚本驱动的 `fake` 供应商（`AMA_FAKE_SCRIPT`），不调真实模型。`src/` 只能用 `node:` 内置模块和相对路径（`pnpm check:deps` 守住）。发版：改版本号、更新两份更新记录、推送 `v<版本>` tag，GitHub Actions 创建 Release 并通过可信发布推到 npm。

## 许可证与致谢

[MIT](LICENSE)。模型元数据来自 [models.dev](https://models.dev)（MIT），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
