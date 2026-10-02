# ama

在终端里写代码、也能嵌进 [Armadra](https://github.com/yovinchen/Armadra) 画布当协调者的编码 Agent；单文件发行，运行时零依赖。

- 独立使用：任意目录运行 `ama`——终端界面、`ama -p` 一次性运行、`ama --mode rpc` 与 SDK。
- 嵌入 Armadra：作为画布上的协调者，驱动 Claude Code、Codex、OpenCode 等 CLI Agent 分工、汇报与汇总。
- 只用 API Key（官方或中转站），只做 Skill 与内置工具，不接 MCP。

## 安装

需要 Node ≥ 22。从 [Releases](https://github.com/Owlbay/armadra-agent/releases) 下载：

- **单文件**：`ama.cjs` 与 `ama-sandbox.cjs`（codemode 的沙箱子进程入口），放在同一目录：

  ```sh
  node ama.cjs --version
  alias ama="node /path/to/ama.cjs"
  ```

- **npm 包**：`package.tgz`（`pnpm pack` 产物，不发布到 npm registry）：

  ```sh
  npm i -g ./package.tgz
  ama --version
  ```

## 快速开始

零配置：设好任一家的标准环境变量就能用，ama 按内置顺序选第一个有 key 的供应商和它的缺省模型。

```sh
export ANTHROPIC_API_KEY=sk-...        # 或 OPENAI_API_KEY、DEEPSEEK_API_KEY、MOONSHOT_API_KEY ……
ama                                    # 终端界面
ama -p "解释一下 src/index.ts"          # 执行后退出，适合脚本
git diff | ama -p "审阅这段改动"        # 提示也可以来自 stdin
```

不想放在环境变量里，就存进 `~/.config/ama/auth.json`（0600）。key 从 stdin 读取，不经命令行参数、不进 shell 历史：

```sh
ama auth set anthropic                 # 终端里输入（不回显）
ama auth list                          # 只列供应商与 key 形态，不显示 key
```

本地 Ollama / LM Studio 不需要 key。内置供应商与环境变量见 [docs/providers.md](docs/providers.md)。

常用参数：`--model provider/id`、`--thinking off|minimal|low|medium|high|xhigh`、`--permission-mode plan|default|auto-edit|full-auto`、`-c` 继续本目录最近的会话、`-r` 选择会话恢复。`ama --help` 列出全部；`ama doctor` 检查配置层级、信任、key 来源、Hook 与终端能力。

## 配置

一个文件 `~/.config/ama/config.json`，常用的只有五个键，其余都有缺省：

```json
{
  "version": 1,
  "defaultModel": "anthropic/<model-id>",
  "thinkingLevel": "medium",
  "permission": { "mode": "default", "allow": ["bash(git status*)"], "deny": ["write(**/.env*)"] },
  "tools": { "preset": "default" },
  "providers": {}
}
```

- 模型引用到处一致：`provider/model-id`（配置、命令行、`/model`、SDK）。
- 项目里的 `.ama/config.json` 只能收紧（追加 deny、把权限模式改严）；项目级 Hook、Skill、提示模板要先信任目录。
- `ama config show` 打印每一项的生效值与来源。

## 接入中转站

**零配置**：内置的 `openai` / `anthropic` 识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`。baseUrl 不在官方主机时接受目录外的 model id，缓存相关字段按保守缺省。

```sh
OPENAI_BASE_URL=https://proxy.example/v1 OPENAI_API_KEY=$PACKY_API_KEY ama -p "hi" --model openai/qwen3.8-flash
```

**一个供应商 + 模型级协议**：同一个中转站下不同模型支持的协议常常不同，协议写在模型上即可。

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

**不想手写模型表**：让 ama 去问中转站，逐个探测可用的协议并写回配置（写前备份 `config.json.bak`，已有条目不覆盖）。

```sh
ama models discover packy --probe --write --limit 8
ama models check packy/grok-4.7           # 一次最小请求确认连通
ama models cache-probe packy/grok-4.7     # 这个端点报不报缓存（计费，先打印预估）
```

`--probe` 与 `cache-probe` 都会发真实请求：执行前打印预估，401 / 403 / 429 即停。写入的模型没有 `contextWindow`，自动压缩随之关闭，需要时手动补。细节见 [docs/providers.md](docs/providers.md)「接入中转站」。

## 工具预设与 codemode

| 预设          | 模型直接看到                        | 用途                                       |
| ------------- | ----------------------------------- | ------------------------------------------ |
| `default`     | read、edit、write、bash、grep、glob | 缺省                                       |
| `minimal`     | read、edit、write、bash             | 适合 `full-auto`                           |
| `codemode`    | 只有 `codemode`                     | 长流程、工具密集任务                       |
| `coordinator` | read 与宿主注册的画布工具           | 嵌入 Armadra 的协调者：不写文件、不跑 bash |

`--tools-preset <名>` 或 `tools.preset` 选预设，`tools.default` 用 `+name` / `-name` 微调（如 `+todo`、`+task`）。

**codemode** 让模型写一段 JavaScript，在脚本里用 `tools.<name>(args)` 编排多次工具调用，只有输出回到模型——多次往返合成一次。`--codemode on` 在现有工具之外加上它，`--tools-preset codemode` 只留它。脚本在受 Node 权限模型约束的子进程里运行，每次内层调用仍逐个经过 Hook、权限与审批。Node ≥ 25 时沙箱同时隔离网络，`codemode` 免审批；Node 22 / 24 不隔离网络，`default` 权限模式下每次都要审批。见 [docs/codemode.md](docs/codemode.md)。

## 缓存

长任务的主要用量是缓存读取。ama 保证前缀逐字节稳定（系统提示节顺序固定、工具按名排序、变化只追加在末尾），按各家写法打缓存断点，并在状态栏告诉你缓存是否在起作用：

```
anthropic/<model-id> · think:medium · ↑412k ↓8.1k · cache 92% ♨ · $0.84 · rebill $0.11 · ctx 34% · mode:default
```

| 项             | 怎么读                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `cache 92%`    | **最近一次**请求的命中率；会话累计在 `/session`                            |
| `cache —`      | 端点还没报过缓存（还没有足够长的可比请求）                                 |
| `cache 未报告` | 端点不报缓存（连续 3 次读写都是 0）；这类请求不算进命中率，而不是显示成 0% |
| `♨`            | 保温计时中：工具运行较久时，在缓存过期前重放一次前缀把它续上（只付读价）   |
| `rebill $0.11` | 本会话因缓存未命中多付的钱（无价格的模型显示 token）；为 0 不显示          |
| `ctx 34%`      | 上下文占用；≥ 70% 黄、≥ 90% 红，跨过时消息区提示「约剩 N 回合」            |

一次未命中重计费 ≥ 20k token 或 ≥ $0.10 时，消息区会写一行原因（空闲超时、子任务、切换模型、系统提示 / 工具表变化、服务端淘汰）。`/cache` 看缓存统计，`/cache warm off|streaming|idle` 本会话切换保温，`/cache fingerprint` 查前缀指纹。保温缺省只在工具运行期间（`cache.warming: "streaming"`），并且只在期望节省 ≥ $0.05 时才发。详见 [docs/tui.md](docs/tui.md)「缓存与上下文」与 [docs/providers.md](docs/providers.md)「缓存」。

## SDK

```ts
import { createAgentSession } from "@armadra/agent";

const session = await createAgentSession({
  cwd: process.cwd(),
  model: "anthropic/<model-id>",
  auth: { kind: "env" },
  permission: {
    mode: "default",
    ask: async (request) => (request.toolName === "read" ? "allow" : "deny"),
  },
});
session.subscribe((event) => {
  if (event.type === "tool_execution_start") console.error(`→ ${event.toolName}`);
});
await session.prompt("列出 src 下的入口文件");
console.log(session.getLastAssistantText());
console.log(session.getStats().cache?.hitRate);
await session.dispose();
```

`createAgentSession` 不读文件系统配置（内存会话、指定工具与回调审批）；`createRuntime({ argv })` 走与 `ama` 命令行相同的启动序列（读配置、AGENTS.md、Skill、hooks.json、auth.json）。子路径：`@armadra/agent/host`（宿主适配器类型）、`@armadra/agent/rpc`（RPC 类型）、`@armadra/agent/tui`（终端组件库）。

## 嵌入 Armadra

Armadra 以 `ama --profile <path>` 启动 ama：profile 指定宿主适配器、指令、Skill 目录、Hook、key 文件与会话目录；适配器经 `HostApi` 注册画布工具（`canvas_*` / `context_*`）、接管审批、注入消息。同一个 profile 在画布外运行时适配器不激活，ama 退化为普通独立模式。协调者的设计与契约见 Armadra 仓库 [docs/design/coordinator-agent.md](https://github.com/yovinchen/Armadra/blob/main/docs/design/coordinator-agent.md)；ama 一侧的接口见 [docs/host-api.md](docs/host-api.md)。

## 文档

| 文档                                             | 内容                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| [docs/providers.md](docs/providers.md)           | 内置供应商、API Key、自定义供应商与中转站、compat、缓存 |
| [docs/tui.md](docs/tui.md)                       | 终端界面：布局、按键、命令、审批预览、缓存显示、组件库  |
| [docs/codemode.md](docs/codemode.md)             | codemode 脚本、沙箱与权限                               |
| [docs/hooks.md](docs/hooks.md)                   | 命令式 Hook（hooks.json）                               |
| [docs/host-api.md](docs/host-api.md)             | 宿主适配器 API                                          |
| [docs/rpc.md](docs/rpc.md)                       | RPC 协议（stdio JSONL）                                 |
| [docs/session-format.md](docs/session-format.md) | 会话文件格式                                            |
| [docs/extensions.md](docs/extensions.md)         | 本地扩展（设计草案，未实现）                            |
| [docs/design.md](docs/design.md)                 | 总体设计                                                |

## 开发

需要 Node ≥ 22 与 pnpm（版本见 `package.json` 的 `packageManager`，`corepack enable` 即可）。

```sh
pnpm install
pnpm run ci        # typecheck、fmt:check、check:deps、test、build，再跑 dist/bundle/ama.cjs --version
```

pnpm 10 起 `pnpm ci` 是内置的「清理后安装」，跑检查要写 `pnpm run ci`。常用单项：`pnpm test`、`pnpm typecheck`、`pnpm fmt`、`pnpm build`（产出 `dist/` 与单文件 `dist/bundle/ama.cjs`、`dist/bundle/ama-sandbox.cjs`）。测试可用 fake 供应商：`ama -p "hi" --model fake/echo`。

目录：`src/` 按层分目录（`ai` 模型接入、`agent` 循环、`session` 会话树、`tools` 工具、`codemode`、`permissions`、`hooks`、`host` 宿主契约、`tui` 组件库、`modes` 各入口模式、`cli` 启动），各目录的 `types.ts` 是模块之间的契约；`scripts/` 是构建与守卫脚本，`test/` 放端到端、fixture 与测试辅助。运行时依赖必须为零，只允许 `node:` 内置模块。

## 许可证

[MIT](LICENSE)
