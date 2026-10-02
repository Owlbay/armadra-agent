# ama

[![CI](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Owlbay/armadra-agent/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@armadra/agent)](https://www.npmjs.com/package/@armadra/agent)
[![license](https://img.shields.io/npm/l/@armadra/agent)](LICENSE)

一个在终端里写代码的 Agent，也可以嵌进 [Armadra](https://github.com/yovinchen/Armadra) 画布当协调者。用 TypeScript 写成，运行时零依赖，也提供单文件发行版。

```sh
npm i -g @armadra/agent
export ANTHROPIC_API_KEY=sk-...       # 任一家的 key 即可
ama
```

## 目录

- [为什么做 ama](#为什么做-ama)
- [特性一览](#特性一览)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [接入中转站](#接入中转站)
- [工具与预设](#工具与预设)
- [缓存](#缓存)
- [安全](#安全)
- [沙箱](#沙箱)
- [Plan](#plan)
- [子 Agent](#子-agent)
- [外部 Agent](#外部-agent)
- [回滚](#回滚)
- [界面与入口](#界面与入口)
- [嵌入 Armadra](#嵌入-armadra)
- [文档](#文档)
- [已知限制](#已知限制)
- [开发](#开发)

## 为什么做 ama

- **调用型 Agent**：ama 被别的程序调用的时候和被人使用的时候一样多——`-p` 一次性运行、`--mode rpc`、SDK、宿主适配器都是一等入口，退出码与 JSON 形状是契约。
- **分层清楚**：参考 Pi 的分层，协议实现与供应商数据分开。四条协议线（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Google Generative AI）只写一次，供应商只是「baseUrl + key + 模型表 + compat 开关」。
- **配置精简**：设一个环境变量就能用；常用配置只有五个键，其余都有缺省。只用 API Key（官方或中转站），只做 Skill 与内置工具，不接 MCP。
- **缓存优先**：长任务的大部分用量是缓存读取。ama 保证请求前缀逐字节稳定，按各家写法打缓存断点，并把缓存是否生效、为什么没命中显示出来。
- **两种用法**：独立用就是一个终端编码 Agent；嵌入 Armadra 时作为画布上的协调者，驱动 Claude Code、Codex、OpenCode 等 CLI Agent 分工、汇报与汇总。

## 特性一览

| 方面            | 内容                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 多协议与供应商  | 4 条协议线、17 家内置供应商（Anthropic、OpenAI、Google、DeepSeek、Moonshot、智谱、通义、OpenRouter、Groq、xAI、Mistral、MiniMax、阶跃、火山方舟、腾讯、Ollama、LM Studio）、内置渠道（Messages / Responses 优先、Chat 回落）、自定义供应商、模型级协议 |
| 零配置与中转站  | 有 key 就选第一个可用的供应商（中转站按价格规则挑缺省模型）；识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`；`ama providers add` 只给 baseUrl 与 key 一键接入：列模型、探测渠道、写回配置                                                               |
| 模型元数据      | 上下文、输出上限、图像输入、推理、价格来自随包的 models.dev 内置快照（启动与运行都不联网，`ama models refresh` 显式刷新）；一个供应商可挂多个渠道（Chat / Responses / Messages），`provider/model@渠道`                                                |
| 图像输入        | `-p --image`、界面里 `@图片路径`、`Ctrl+V` / `/paste` 粘贴剪贴板图片；按端点分档的单图上限、超限自动缩放；模型不收图片时直接拒绝并提示换模型                                                                                                           |
| 工具与预设      | read / edit / write / bash / grep / glob，另有 ls、todo、task / task_ctl（子 Agent）、codemode；四个预设 `default` / `minimal` / `codemode-only` / `coordinator`                                                                                       |
| Plan 与子 Agent | Plan 模式只读调研、出计划后审批执行；`task` 委派子 Agent（内置 general / explore / plan，可自定义类型，前台 / 后台 / 续聊 / worktree 隔离）                                                                                                            |
| 外部 Agent      | `task(agent="claude" \| "codex" \| "acp:<程序>")` 以各 CLI 自己的登录驱动外部编码 Agent，审批只交给人；`ama --mode acp` 把 ama 暴露为 ACP Agent                                                                                                        |
| 回滚与沙箱      | 每回合检查点，`/rewind` / 双击 Esc 回到任一条消息之前（代码、对话或两者）；macOS / Linux 的操作系统沙箱隔离 codemode 与（可选）bash                                                                                                                    |
| codemode        | 模型写一段 JS，在受 Node 权限模型约束的子进程里编排多次工具调用，只有输出回到模型                                                                                                                                                                      |
| Skill           | `SKILL.md` 目录，模型按索引自行读取，用户用 `/skill:<名字>` 调用；另有提示模板                                                                                                                                                                         |
| 两层 Hook       | 命令式 Hook（`hooks.json`，11 个事件，用户策略）与进程内宿主适配器 HostApi（嵌入方）                                                                                                                                                                   |
| 权限            | 四种模式、allow / deny 规则、危险命令识别（穿透 `sh -c` / `eval` / `xargs` / `find -exec`）、项目信任、审批时的执行前预览                                                                                                                              |
| 缓存            | 前缀稳定、缓存字段与兼容开关、未命中归因、「报 / 不报缓存」三态、长工具运行时保温、压缩摘要按会话前缀续写                                                                                                                                              |
| 会话            | JSONL 条目树，分叉与 `/tree` 回溯；两档压缩（裁剪大工具结果 → 摘要）与熔断；预算上限（`--max-turns` / `--max-cost`）、重复调用检测、模型回退                                                                                                           |
| 入口            | 差分渲染终端界面、`--no-tui` 行式、`-p`（text / json / stream-json）、`--mode rpc`、`--mode acp`、SDK                                                                                                                                                  |

## 安装

需要 **Node ≥ 22**。

### npm

```sh
npm i -g @armadra/agent
ama --version
```

### Release 单文件

[Releases](https://github.com/Owlbay/armadra-agent/releases) 附带 `ama.cjs`、`ama-sandbox.cjs`、`package.tgz` 与 `SHA256SUMS`。`ama.cjs` 是全部内联的单文件，`ama-sandbox.cjs` 是 codemode 的沙箱子进程入口，两者放在**同一目录**：

```sh
sha256sum -c --ignore-missing SHA256SUMS   # macOS：shasum -a 256 -c --ignore-missing SHA256SUMS
node ama.cjs --version
alias ama="node /path/to/ama.cjs"
```

`package.tgz` 与 npm 上的包内容相同，可以离线安装：`npm i -g ./package.tgz`。

### 从源码构建

```sh
git clone https://github.com/Owlbay/armadra-agent.git && cd armadra-agent
corepack enable && pnpm install
pnpm build                 # 产出 dist/ 与 dist/bundle/ama.cjs、dist/bundle/ama-sandbox.cjs
node dist/bundle/ama.cjs --version
```

### Node 版本、codemode 与沙箱

| Node / 平台                                 | codemode                                                                                                                                                              | bash 沙箱（`sandbox.bash: "auto"`）                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| ≥ 25                                        | 文件系统与网络都隔离；`codemode` 按只读类工具处理，`default` 权限模式下免审批；`default` 预设**缺省开启** codemode                                                    | 取决于平台（下两行）                                          |
| 22 / 24 + 操作系统沙箱（macOS、多数 Linux） | 子进程经 `sandbox-exec` / bubblewrap 启动，网络由内核拒绝；与 Node ≥ 25 相同：只读类、`default` 预设缺省开启                                                          | macOS `sandbox-exec`、Linux bubblewrap 可用（`unshare` 不算） |
| 22 / 24，没有操作系统沙箱（如 Windows）     | 隔离文件系统，**不隔离网络**；`codemode` 按执行类处理，每次都要审批（状态栏显示红色 `net!`）；`default` 预设缺省**不开** codemode，启动时提示一次（每个配置目录一次） | 不可用，bash 照常审批                                         |

其余功能在 Node 22 起都一样。`ama doctor` 显示本机的操作系统沙箱能力（[docs/sandbox.md](docs/sandbox.md)）；`sandbox.enabled: "off"` 或 `AMA_SANDBOX=off` 关闭它。网络未隔离时想用 codemode 就显式开：`--codemode on` 或 config 写 `"codemode": { "mode": "on" }`。`codemode.requireStrict: true` 可以在网络未隔离时直接禁用 codemode。

## 快速开始

**零配置**：设好任一家的标准环境变量就能用，ama 按内置顺序选第一个有 key 的供应商和它的缺省模型（`ama config show` 说明选了谁、为什么）。没有任何 key 时启动会提示怎么配，不会落到测试用的 `fake` 供应商上。

```sh
export ANTHROPIC_API_KEY=sk-...        # 或 OPENAI_API_KEY、GEMINI_API_KEY、DEEPSEEK_API_KEY、MOONSHOT_API_KEY ……
cd your-project
ama                                    # 终端界面
```

**把 key 存起来**：不想放在环境变量里，就存进 `~/.config/ama/auth.json`（0600）。key 从 stdin 读取，不经命令行参数、不进 shell 历史：

```sh
ama auth set deepseek                  # 终端里输入（不回显）
ama auth list                          # 只列供应商与 key 形态，不显示 key
ama auth remove deepseek
```

**一次性运行**：`-p` 执行完就退出，适合脚本与管道。

```sh
ama -p "解释一下 src/index.ts"
git diff | ama -p "审阅这段改动"         # 提示也可以来自 stdin
ama -p "列出 TODO" --model deepseek/deepseek-v4-pro --output-format json
```

**常用参数**：

| 参数                                                    | 作用                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| `--model provider/id`                                   | 选模型（配置、命令行、`/model`、SDK 写法一致）               |
| `--thinking off\|minimal\|low\|medium\|high\|xhigh`     | 思考级别（缺省 `medium`）                                    |
| `--permission-mode plan\|default\|auto-edit\|full-auto` | 权限模式（缺省 `default`）                                   |
| `-c` / `-r [id]`                                        | 继续本目录最近的会话 / 选择会话恢复                          |
| `--tools-preset <名>`                                   | 工具预设（见下文）                                           |
| `--allow <规则>` / `--deny <规则>`                      | 追加权限规则，可重复                                         |
| `--max-turns N` / `--max-cost USD`                      | 一次运行的轮数 / 美元上限（`-p` 到限退出 8）                 |
| `--agent-dir <目录>`                                    | 追加子 Agent 定义目录，可重复                                |
| `--mode rpc` / `--mode acp`                             | stdio 上说 RPC（JSONL）/ ACP（JSON-RPC），供宿主与编辑器驱动 |

**内置供应商**（17 家）：Anthropic、OpenAI、Google、DeepSeek、Moonshot（Kimi）、智谱、通义（DashScope）、OpenRouter、Groq、xAI、Mistral、MiniMax、阶跃、火山方舟、腾讯 TokenHub、Ollama、LM Studio。多协议的供应商带内置渠道，缺省协议 Messages / Responses 优先、Chat 回落：OpenAI、xAI、火山方舟走 Responses，通义、MiniMax、阶跃、腾讯走 Messages，DeepSeek、智谱、Kimi 暂走 Chat（`@messages` 可选），`provider/model@渠道` 指定渠道。完整表见 [docs/providers.md](docs/providers.md)「内置供应商」。

本地 Ollama / LM Studio 不需要 key：`ama --model ollama/<模型名>`。`ama --help` 列出全部参数与子命令；测试或排查时可用不花钱的 `--model fake/echo`（回显最后一条用户消息；模型选择器、`models list`、`doctor` 缺省不列这个测试供应商，`AMA_SHOW_FAKE=1` 时列出）。

## 配置

一个文件 `~/.config/ama/config.json`。第一次进入对话（交互、`-p`、RPC）或 `ama providers add` 时自动建好目录（0700）、
最小的 `config.json` 与给编辑器用的 `config.schema.json`；`config show`、`doctor`、`models list` 等只读命令不写配置目录。
也可以 `ama init` 手动建（已有文件不覆盖）。生成的 `config.json` 只有 `$schema`、`version` 与空 `providers`，不写死缺省值——以后
缺省值调整时老配置同样跟着变。`ama config path` 打印各文件位置，`ama config edit` 用 `$VISUAL` / `$EDITOR` 打开，
`config.schema.json` 给每个键带了说明与缺省值，编辑器悬停可见。常用的只有五个键：

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

其余（`compaction`、`retry`、`codemode`、`hooks`、`ui`、`skills`、`cache`、`request`）都有缺省，`ama config show` 列出每一项的生效值与来源（default / user / profile / project / cli），也接受 `--tools-preset` / `--codemode` 看覆盖后的效果。

**请求超时**：模型请求有空闲超时，缺省 300 s——等响应头、以及流里两块数据之间超过这个时间就判定卡住，按可重试错误
走 `retry` 的退避重试（收到任何字节即重新计时，长回答不受影响）。用 `request.idleTimeoutMs`（只认用户级）或环境变量
`AMA_IDLE_TIMEOUT_MS` 调整，0 关闭。

**代理**：设了 `HTTPS_PROXY` / `HTTP_PROXY`（`NO_PROXY` 排除）时，ama 启动时调用 Node 内置的环境变量代理（等价于
`NODE_USE_ENV_PROXY=1`，零依赖）。Node 24+ 直接可用；Node 22 只有 22.21+ 设 `NODE_USE_ENV_PROXY=1` 才行，更早的版本会提示一次
并直连。`ama doctor` 的「代理」一节显示当前状态（代理地址里的账号密码打码）。

### 文件位置与层级

| 位置                  | 内容                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/ama/`      | 用户级：`config.json`、`config.schema.json`（ama 生成）、`auth.json`（0600）、`hooks.json`、`keybindings.json`、`trust.json`、`AGENTS.md`、`skills/` |
| `~/.local/share/ama/` | 数据：`sessions/`（会话 JSONL）、`plans/`（计划文件）、`file-history/`（检查点备份）、`models-dev.json`（`ama models refresh` 的覆盖）、输入历史     |
| `<项目>/.ama/`        | 项目级：`config.json`（只能收紧）、`hooks.json` / `skills/` / `prompts/`（需信任）                                                                   |
| `<项目>/AGENTS.md`    | 项目约定，从 cwd 向上查找，自动进系统提示                                                                                                            |
| `--profile <文件>`    | 宿主 profile（嵌入方用，见「嵌入 Armadra」）                                                                                                         |

`AMA_CONFIG_DIR` / `AMA_DATA_DIR` 可改两个目录；也遵循 `XDG_CONFIG_HOME` / `XDG_DATA_HOME`，Windows 下是 `%APPDATA%\ama` 与 `%LOCALAPPDATA%\ama`。

合并顺序是 **内置缺省 ← 用户级 ← profile ← 项目级**，但项目级只能收紧：可以追加 deny、把权限模式改严、把工具预设改窄、关掉 codemode；`allow` 规则、放宽模式、`cache`、`tools.default` 等放宽项被忽略并给出 warning。这样克隆一个陌生仓库不会因为它的配置而放开权限。

### 检查

```sh
ama config show          # 每一项的生效值与来源、供应商、将使用的模型、工具
ama config show --json
ama doctor               # 配置层级、项目信任、key 来源、Hook、终端能力
```

## 接入中转站

**一键接入**：只给 baseUrl 与 key。

```sh
export PACKY_API_KEY=sk-...
ama providers add packy --base-url https://proxy.example/v1 --key-env PACKY_API_KEY --probe --limit 8 --yes
ama -p "hi" --model packy/kimi-k2.5               # 首选渠道
ama -p "hi" --model packy/kimi-k2.5@messages      # 指定渠道（Anthropic Messages）
ama -p "图里有什么颜色" --image shot.png --model packy/kimi-k2.5
ama providers list                                 # 供应商 → 渠道 → 模型数、key 来源
```

`add` 列出 `GET {baseUrl}/models` 的模型，从 baseUrl 推出 chat / responses / messages 三个候选渠道，`--probe` 逐渠道发最小
请求，把能用的渠道写进每个模型的 `channels`；上下文、输出上限、图像、推理与价格不写进配置，运行时从内置的 models.dev
快照补（`ama models list` 标出每个字段的来源）。不给 `--key-env` 时 key 从 stdin 读（不回显）存进 `auth.json`。写入后的配置：

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

**零配置**：内置的 `openai` / `anthropic` 识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`。baseUrl 不在官方主机时接受目录外的 model id，缓存相关字段按保守缺省。

```sh
OPENAI_BASE_URL=https://proxy.example/v1 OPENAI_API_KEY=$PACKY_API_KEY \
  ama -p "hi" --model openai/qwen3.8-flash
```

**一个供应商 + 模型级协议**：同一个中转站下，不同模型支持的协议常常不同。不必为每种协议建一个供应商，把 `api` 写在模型上即可：

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

- `api` 缺省 `openai-completions`；可选 `openai-responses`、`anthropic-messages`、`google-generative-ai`。
- `apiKey` 支持 `$ENV` / `${ENV}`（读环境变量）与 `!command`（执行命令取值），不要把 key 明文写进配置。
- 自定义模型的元数据缺省从随包的 models.dev 快照补（启动不联网；`ama models refresh` 显式联网刷新到数据目录，`refresh-catalog`
  是旧名）；匹配不到时不猜 `contextWindow`，自动压缩关闭，需要时在模型条目里补上或写 `"modelsDev": "provider/model"` 指定条目。

**不想手写模型表**：让 ama 去问中转站。

```sh
ama models discover packy                              # 列出 GET {baseUrl}/models
ama models discover packy --probe --write --limit 8    # 逐个探测可用协议并写回配置
ama models check packy/grok-4.7                        # 一次最小请求确认连通
ama models cache-probe packy/grok-4.7                  # 这个端点报不报缓存
```

`--probe` 对每个模型依次试几种协议，记第一个成功的；`--write` 合并进用户级 `config.json`（原文件备份为 `config.json.bak`，已有条目不覆盖）。`--probe` 与 `cache-probe` 都会发真实请求：执行前打印预估，401 / 403 / 429 即停，`cache-probe` 在非交互环境需要 `--yes`。细节见 [docs/providers.md](docs/providers.md)。

## 工具与预设

| 预设            | 模型直接看到的工具                                             | 适合                                                                                        |
| --------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `default`       | read、edit、write、bash、grep、glob；网络隔离时另加 `codemode` | 缺省（要 todo 就 `tools.default: ["+todo"]`）                                               |
| `minimal`       | read、edit、write、bash                                        | 小模型、小上下文；`full-auto`                                                               |
| `codemode-only` | 只有 `codemode`                                                | 长流程、工具调用密集的任务                                                                  |
| `coordinator`   | read 与宿主注册的画布工具                                      | 嵌入 Armadra 的协调者：不写文件、不跑 bash；codemode 缺省关，显式开了脚本里也只能调这些工具 |

- `--tools-preset <名>` 或 `tools.preset` 选预设。`codemode` 是 `codemode-only` 的旧名（0.3.0），配置、命令行、RPC、SDK 都还认，`ama config show` 显示规范名并提示。
- `tools.default` 在预设上微调：`["+task", "+todo", "-glob"]`；不带前缀的名字整组替换。`task` 与 `task_ctl` 同进退（`+task` 一起加）。
- 另有 `--tools a,b,c`（只启用这些）、`--exclude-tools a,b`、交互模式的 `/tools`。

**codemode** 让模型写一段 JavaScript，用 `tools.<name>(args)` 编排多次工具调用（可以 `Promise.all` 并发），只有脚本输出回到模型。脚本跑在 `node --permission` 子进程的 vm 里：没有 `require` / `import` / `process` / `fetch`，每次内层调用仍逐个经过 Hook、权限与审批。

**缺省开放**：`codemode.mode` 不写时跟随预设——`default` → `on`（六个工具 + codemode，只在网络隔离的沙箱里：Node ≥ 25，或 Node 22 / 24 + 操作系统沙箱；否则 `off`），`codemode-only` → `only`，`minimal` / `coordinator` → `off`。显式的 `--codemode off|on|only` 或 `codemode.mode` 优先，项目级只能写 `off`。`on` 模式下 codemode 的描述只用一行列出可在脚本里调用的直接工具（参数相同）与仅脚本可调的工具名，不重复声明，前缀只多约 400 token（[三预设基准](https://github.com/Owlbay/armadra-agent/blob/main/docs/benchmarks/presets-2026-10-02.md)测的是去重前的 codemode 预设：小任务输入多约 45%、轮数不减）。只读检索多、调用次数多的长流程可以用 `codemode-only`。

## 缓存

长任务的主要用量是缓存读取：前缀一旦变化，此后每次请求都按全价重读。ama 分三层处理：

- **协议层**：系统提示节顺序固定、不含时间戳，工具按名排序，中途变化只追加在末尾；按各家写法打缓存断点（Anthropic `cache_control`、OpenAI `prompt_cache_key` 等），端点 400 拒收某个缓存字段时自动去掉重发。
- **会话层**：每次请求记前缀指纹，检测未命中并归因（空闲超时、子任务、切换模型、系统提示 / 工具表变化、服务端淘汰），判定端点报不报缓存，长工具运行期间保温。
- **展示层**：状态栏、`/session`、`/cache`、RPC 统计与 `ama models cache-probe`。

### 读状态栏

独立终端缺省两行（`Ctrl+G` / `/statusline` 切换成一行，嵌入宿主缺省一行）：

```
tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)    ↑412k ↓8.1k · cache 83% ♨ · rebill $0.11 · [-]
Accept edits     claude-opus-5-5 medium | Ctx 34.0% | proj ⎇ main 5ae9e54 (+12,-3) | $0.84 | 2h24m
```

上行是速率与用量，下行是权限模式、模型与思考级别、上下文、目录与 git 分支（含工作区增删行）、费用、会话时长。缓存相关的项：

| 项             | 怎么读                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `cache 83%`    | **最近一次**请求的命中率；会话累计在 `/session`                            |
| `cache —`      | 端点还没报过缓存（还没有足够长的可比请求）                                 |
| `cache 未报告` | 端点不报缓存（连续 3 次读写都是 0）；这类请求不算进命中率，而不是显示成 0% |
| `♨`            | 保温计时中                                                                 |
| `rebill $0.11` | 本会话因缓存未命中多付的钱（无价格的模型显示 token）；为 0 不显示          |
| `Ctx 34.0%`    | 上下文占用；≥ 70% 黄、≥ 90% 红，跨过时消息区提示「约剩 N 回合」            |

一次未命中重计费 ≥ 20k token 或 ≥ $0.10 时，消息区写一行原因。`/cache` 看缓存统计，`/cache fingerprint` 查前缀指纹（两次之间哈希变了，就是系统提示或工具表被改了）。

### 三态、保温与摘要续写

- **三态**：每个端点（供应商 + 主机 + 模型）在 `unknown` / `reported` / `silent` 之间判定。只有 `reported` 才显示命中率、检测未命中、保温；不报缓存的中转不会被误报成 0%。中转上已知不报的模型可以设 `compat.cacheReporting: "silent"`。
- **保温**：工具长时间运行（长测试、`task` 子任务、codemode 脚本）时，在缓存 TTL 到期前重放一次上一个请求（`maxTokens: 1`），只付读价把缓存续上。`cache.warming` 取 `off` / `streaming`（缺省，只在运行中）/ `idle`（空闲也保温，适合贵模型），`/cache warm …` 本会话切换；期望节省低于 `cache.minSavingsUsd`（缺省 $0.05）不发。
- **摘要续写**：上下文压缩的摘要请求接在与上一次真实请求逐字节相同的前缀后面，整段历史按读价计费；失败时回落为独立摘要请求。

### 实测

[缓存验收实验](https://github.com/Owlbay/armadra-agent/blob/main/docs/benchmarks/cache-2026-10-02.md)（2026-10-02，经一家测试中转站）：

| 场景                        | 结果                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Kimi 摘要续写               | 摘要请求读缓存 20.2k / 20.5k，**命中 98.8%**（修复前 0%：发 `tool_choice` 时前缀在工具段断开） |
| DeepSeek 按 2048 粒度报缓存 | 假未命中 3 次 → **0 次**（自动推断端点缓存粒度）                                               |
| 基线命中率（5 轮编码任务）  | Kimi 累计 86%、MiniMax 75%，均 0 次未命中                                                      |

缓存相关的全部配置与各协议字段见 [docs/providers.md](docs/providers.md)「缓存」。

## 安全

**权限模式**（`--permission-mode`、配置 `permission.mode`、`/permission` 选择器、交互模式 `Shift+Tab` 或输入为空时 `Tab` 循环）：

| 模式        | 显示名             | 读  | 写                                                     | 执行（bash 等）                |
| ----------- | ------------------ | --- | ------------------------------------------------------ | ------------------------------ |
| `default`   | Manual             | ✓   | 询问                                                   | 询问                           |
| `auto-edit` | Accept edits       | ✓   | ✓                                                      | 询问                           |
| `plan`      | Plan               | ✓   | 拒绝                                                   | 拒绝                           |
| `auto`      | Auto               | ✓   | ✓ ¹                                                    | 安全的自动放行，有风险的才问 ² |
| `full-auto` | Bypass permissions | ✓   | ✓                                                      | ✓                              |
| `allowlist` | Allowlist only     | ✓   | 只放行 allow 规则命中的，其余拒绝，从不询问（适合 CI） | 同左                           |

¹ 机密文件（`.env`、私钥、`.ssh/` 等）、`.git/` 与 `.ama/`、项目目录外的写入仍然询问。
² 三层判定：规则层（危险命令、网络、删除类、受保护路径 → 询问）→ 静态判定（安全名单：`ls`、`cat`、`grep`、`git status/diff/log`、`npm test`、`tsc --noEmit`、`cargo test` 等 → 放行）→ 都没决定时问一次模型分类器（独立请求，不影响主会话缓存；`permission.autoModel` 可指定便宜模型）。详见 [docs/permissions.md](docs/permissions.md)。

**判定顺序**：deny 规则（含 Hook deny）→ 危险命令 →（auto 的规则层）→ 模式 / 静态判定 → allow 规则把「询问」变「允许」→（auto 的分类器）。前面的结论后面不能放宽。无人值守（`-p`、RPC 未接审批）时「询问」一律按拒绝。项目级配置只能收紧模式，且不能设 `auto` / `full-auto`。

- **规则**：`bash(git push*)`、`write(src/**)`、`read(**)`、`canvas_*`；`--allow` / `--deny` 可重复。内置 deny：写 `.git/**`、读写 `.ssh/**`。
- **危险命令**：`rm -rf /`、`sudo`、`git push --force`、`git reset --hard`、`git clean -f`、`curl … | sh`、`chmod -R 777`、`npm publish`、`shutdown` 等，即使有 allow 规则也要询问。识别会穿透 `sh -c '…'`、`eval`、`xargs`、`find -exec` 与 git 全局选项。
- **bash 沙箱**（缺省关闭）：见下文「沙箱」。
- **项目信任**：`.ama/hooks.json`、`.ama/skills/`、`.ama/prompts/` 会执行或注入项目里的内容，需要先信任目录（交互模式问一次，可记住；`--trust` / `--no-trust`；非交互缺省不信任）。`AGENTS.md` 与 `.ama/config.json` 不需要信任，因为后者只能收紧。
- **执行前预览**：审批对话框除了输入摘要，还列出这一步会碰到什么——bash 里 `rm` / `mv` / `git clean` / `git reset --hard` / 重定向的目标路径是否存在、大小、目录里有多少文件；write 显示路径与行数，edit 显示每处修改的 −/+ 摘要。`y` 允许、`n` 拒绝、`a` 本会话同类不再问、`v` 看完整输入。
- **Hook**：`hooks.json` 在 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`PostCompact`、`PostRewind` 等 11 个事件运行 shell 命令，可以否决工具调用、改写输入、追加上下文、让运行再跑一轮。见 [docs/hooks.md](docs/hooks.md)。
- **审批来源**：子 Agent 与外部 Agent 发起的审批在对话框标题标出来源（`[task:explore]`、`[claude · 会话 abc12345]`、「首次运行外部 Agent」），见 [docs/permissions.md](docs/permissions.md)「审批对话框的来源标注」。

## 沙箱

macOS 用 `sandbox-exec`，Linux 用 bubblewrap（退而 `unshare -r -n`，只隔离网络），启动时用目标配置跑一次最小探针确认真能用（嵌套沙箱、没有用户命名空间时降级），`ama doctor` 显示结果。Windows 没有操作系统沙箱。

- **codemode**：子进程经沙箱启动，内核拒绝网络与一切写入；有沙箱时 Node 22 / 24 与 Node ≥ 25 一样按只读类处理、`default` 预设缺省开启（见上文「Node 版本、codemode 与沙箱」）。
- **bash**（缺省关闭）：`"sandbox": { "bash": "auto" }` 后 bash（含后台 bash）在沙箱里跑——只能写工作区、系统临时目录与 `sandbox.writable` 追加的目录，工作区的 `.ama/`、`.git/hooks`、`.git/config` 只读，读不到 `~/.ssh` 等凭据，缺省不能联网（`sandbox.network: "allow"` 放开）。`default` / `auto-edit` 下沙箱内的命令免审批（危险命令、deny 规则、Hook ask 照旧）；被沙箱拒绝时模型可以请求 `sandbox: false` 不经沙箱重跑，这一步照常审批、无人值守拒绝。状态栏多一个 `沙箱` 标记。
- `sandbox.*` 只认用户级 / profile，项目级只能写收紧的 `network: "deny"`；`sandbox.enabled: "off"` 或 `AMA_SANDBOX=off` 整体关闭。

细节、各平台策略与已知绕过见 [docs/sandbox.md](docs/sandbox.md)。

## Plan

Plan 模式（`Shift+Tab`、`/permission plan`、`/plan <目标>`、`--permission-mode plan`）下模型只读调研——只放行读工具、只读命令（`ls`、`rg`、`git log / diff` 等）与只读子 Agent——最后输出 `<proposed_plan>` 计划块。ama 提取步骤、把计划落到 `<数据目录>/plans/`，弹出审批框：

- **批准并执行** / **批准，在新上下文执行**（新建会话，以计划全文开场），接着选执行模式（回到进入前的模式 / Accept edits / Auto）；步骤变成待办，逐步推进（有 todo 工具时用 `todo update`，没有时模型每完成一步写一行 `[DONE:S1]`）；
- **继续修改**（意见发给模型重写计划）/ **放弃并退出 Plan**；`e` 在外部编辑器里改计划，Esc 放弃但留在 Plan。

line 模式用 `/plan approve [模式|fresh]` / `/plan reject`；RPC 声明 `plans` 能力后由客户端审批；SDK 用 `createAgentSession({ plan: { onProposed } })`。**ama 不替人批准**：`-p` 缺省停在「计划待审批」并退出 9，用户级配置 `"plan": { "unattended": "approve" }` 才在无人值守时自动批准执行。`plan.model` 可让规划与执行用不同模型。见 [docs/plan.md](docs/plan.md)。

## 子 Agent

`task` 工具把子任务交给一个全新上下文的子 Agent（同进程、独立会话文件，深度 1），结果作为工具结果回到父会话。`default` 预设下 `task` 只在 codemode 脚本里可用，直接暴露用 `--tools …,task` 或 `tools.default: ["+task"]`。

- 内置类型 `general`（缺省）、`explore`、`plan`（后两者强制只读、不弹审批）；`~/.config/ama/agents/*.md`、`.ama/agents/*.md`（需信任）或 `--agent-dir` 定义自己的类型（工具白名单、模型、权限、轮数、worktree 隔离）。
- 同一回复里的多个 task 并行（`subagents.maxConcurrent`，缺省 4）；`background: true` 立即返回 `taskId`，完成后父会话收到 `<task-notification>`；`task{taskId}` 续聊；`task_ctl` 列出 / 等待 / 停止 / 读输出；`isolation: "worktree"` 在独立 git worktree 里跑。
- 子会话工具表与父逐字节相同，首个请求复用父的缓存前缀。界面里 task 工具行折叠显示进度，`/tasks` 看输出或停止，`/agents` 列出可用类型。

见 [docs/agents.md](docs/agents.md)「子 Agent」。

## 外部 Agent

`task(agent="claude")`、`"codex"` 或 `"acp:<程序>"`（Gemini CLI、OpenCode、Kimi、ama 自己等任意 ACP Agent）用你在该 CLI 里的**现有登录**驱动外部编码 Agent，前台 / 后台 / 续聊 / `task_ctl` 与 ama 子 Agent 一致；结果按资料处理。

- **审批只交给人**：外部 Agent 要确认的操作走界面 / 宿主，auto 分类器与模型都不参与；无人值守一律拒绝。每个会话首次以某个外部 Agent 运行时确认一次（allow 规则 `task(claude)` 或 `full-auto` 放行）。
- 外部 Agent 的模式不比 ama 当前模式宽（plan / allowlist 下只读）；子进程缺省剥离供应商 key、`*_BASE_URL`、`AMA_*`，不把订阅切成 API 计费；只在已信任目录里启动；有并发池、美元预算与看门狗。
- 嵌入宿主时 ama 不自己启动外部 CLI，只用宿主经 `HostApi.runners` 注入的 runner。
- **ama 作为 ACP Agent**：`ama --mode acp` 供 Zed、JetBrains、Armadra 的 ACP 节点驱动；`@armadra/agent/acp` 导出客户端、驱动与假 Agent。

见 [docs/agents.md](docs/agents.md)「外部 Agent」与 [docs/acp.md](docs/acp.md)。

## 回滚

每条开启新回合的用户消息都是回滚点：edit / write 第一次写文件前备份，每个新回合重拍已跟踪文件（`checkpoints.mode: "shadow-git"` 时整个工作目录进影子仓库，bash 的改动也能回滚）。

- `/rewind` 或空闲时双击 Esc 打开列表，确认面板给出：恢复代码和对话 / 恢复对话 / 恢复代码 / 从这里摘要 / 摘要到这里，每项带预览；回合外被手动改过的文件按冲突列出、缺省跳过，可选择覆盖；git HEAD 变了只提示命令，不动 git。
- 运行中 Esc 中断且本回合还没有输出时自动撤回这条消息并回填（`ui.restoreOnCancel`）。
- line 模式 `/rewind <n> [both|conversation|code] [overwrite]`；RPC `get_rewind_points` / `rewind`；SDK `session.rewind()`；Hook `PostRewind`。

见 [docs/tui.md](docs/tui.md)「回滚」、[docs/rewind-plan.md](docs/rewind-plan.md) 与 [docs/sessions.md](docs/sessions.md)。

## 界面与入口

### 终端界面

直接运行 `ama`（stdin / stdout 都是 TTY）进入交互模式。界面只用主屏，对话历史留在终端回滚里，tmux `capture-pane` 能读到完整对话。

| 按键                 | 作用                                                           |
| -------------------- | -------------------------------------------------------------- |
| Enter                | 发送；运行中插话（steer）                                      |
| Alt+Enter            | 运行中排到本轮之后（followUp）                                 |
| Shift+Enter / Ctrl+J | 换行                                                           |
| Esc                  | 中断当前运行                                                   |
| Esc Esc（空闲）      | 输入框为空：打开回滚列表（同 `/rewind`）；有字：清空并存进历史 |
| Shift+Tab / Tab      | 循环权限模式（Tab 只在输入为空时；进入 Bypass 前确认）         |
| Ctrl+O               | 展开 / 折叠工具输出                                            |
| Ctrl+L / Ctrl+T      | 选择模型 / 思考级别                                            |
| Ctrl+G               | 底部信息行 两行 ↔ 一行（同 `/statusline`）                     |
| Ctrl+V               | 粘贴剪贴板里的图片，插入 `@<路径>`（同 `/paste`）              |
| Ctrl+C               | 清空输入；输入为空时 1.5 秒内再按一次退出                      |
| Tab                  | 补全：`/` 命令、模板与 Skill，`@` 文件路径                     |

常用命令：`/model`、`/thinking`、`/permission`、`/tools`、`/compact`、`/tree`（回到某条消息之前重新分支）、`/fork`、`/resume`、`/new`、`/session`、`/cache`、`/hooks`、`/skill:<名字>`、`/help`；第五波新增 `/plan`（计划面板与审批，`/plan <目标>` 进入 Plan）、`/tasks`（子 Agent 任务）、`/agents`（可用类型与外部 Agent）、`/paste`（剪贴板图片）、`/rewind`（回滚）、`/statusline [full|compact]`。输入里的 `@图片路径`（或粘贴 / 拖入的图片路径）作为图片附件发给模型；`/model` 按「供应商 · 渠道」分组，标出上下文与 `img`。按键可在 `~/.config/ama/keybindings.json` 覆盖。见 [docs/tui.md](docs/tui.md)。

`--no-tui`（或 stdin / stdout 不是 TTY、`TERM=dumb`）进入行式界面：readline + 括号粘贴，命令相同。

### `-p` 一次性运行

| `--output-format` | stdout                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| `text`（缺省）    | 最后一条回答的文本                                                            |
| `json`            | 一个 `result` 对象：会话 id、模型、`stopReason`、`text`、用量、费用、缓存统计 |
| `stream-json`     | 每行一个事件，与 RPC 事件同形状                                               |

**stdin**：管道内容拼在提示后面（`git diff | ama -p "审阅"`）；没有提示参数时管道内容就是提示。有提示参数时只等管道的
首字节 2 秒（`AMA_STDIN_WAIT_MS` 可调，0 = 不等）：一个字节都没收到就忽略 stdin、继续运行，并在 stderr 提示一行——父进程
留着不关的管道不会让 `-p` 挂起；收到首字节后读到 EOF。上游命令要先跑很久才输出时，在末尾加 `-` 一直等到 EOF
（`npm test 2>&1 | ama -p "找出失败原因" -`）；`--no-stdin` 完全不读。`< 文件` 重定向总会读取。

`--image <文件>` 可重复，随提示发送图片（PNG / JPEG / GIF / WebP，单张上限按端点分档、base64 后计：官方 Anthropic 10 MB、Gemini / OpenAI 20 MB、中转 5 MB，超限时尝试用 sips / ImageMagick 缩放）；提示里的 `@图片路径` 同样作为附件。当前
模型不收图片时直接退出 2，不发请求。

`--max-turns N` 限制一次运行最多 N 轮（一次模型请求加它的工具执行算一轮），`--max-cost USD` 限制一次运行的美元用量（配置
`limits.maxTurns / maxCostUsd` 同义），到上限时提前结束（事件 `limit_reached`），**退出码 8**（0.4.x 的 `--max-turns` 是 1），
`json` 结果带 `limitReached{kind, value, limit}`（轮数到限另有 `maxTurnsReached: true`）。Plan 模式下计划待审批时退出 9（见上文「Plan」）。

`--system-prompt <文本|@文件>` 补充系统提示（任何模式都可用）：缺省作为最后一条规则追加，preamble 与工具表这段最长的
缓存前缀不变；`--system-prompt-mode replace` 改为替换开头的角色说明，工具表、规则与 AGENTS.md 仍然保留。

`--no-session` 让会话只留在内存里、不写会话文件（适合 CI 与一次性调用；之后无法 `--resume`），交互模式里 `/new` 切出的
新会话同样不落盘。

**无人值守**：`-p` 没有人审批，缺省权限模式下需要询问的调用（写文件、跑命令）一律拒绝。被拒时 stderr 一行汇总被拒的
工具与原因，`json` 结果带 `deniedTools`，`stream-json` 的 `tool_execution_end` 带 `denied: true`，退出码 7。需要放行时用
`--permission-mode auto-edit`（放行写入）/ `auto`（ama 判断每一步），或 `--allow "bash(npm test*)"` 按规则放行。

| 退出码 | 含义                                                         |
| ------ | ------------------------------------------------------------ |
| 0      | 正常                                                         |
| 1      | 运行期错误（模型最终失败等）                                 |
| 2      | 用法错误；当前模型不收图片                                   |
| 3      | 配置 / profile / 路径错误                                    |
| 4      | 无可用模型或 key                                             |
| 5      | 会话不存在 / 损坏                                            |
| 6      | 宿主 / Hook 启动失败                                         |
| 7      | `-p` 有工具调用被拒（无人审批、deny 规则、plan 等）          |
| 8      | `-p` 到达预算上限（`--max-turns` / `--max-cost` / `limits`） |
| 9      | `-p` 产出的计划已落盘、待审批（`plan.unattended: stop`）     |
| 78     | 宿主 API 版本不匹配                                          |
| 130    | SIGINT；143 = SIGTERM                                        |

### 会话统计、检索与复用

会话是 `<数据目录>/sessions` 下的 JSONL，下面这些命令只读不写（缺省看当前目录的会话，`--all` 看全部）：

```sh
ama stats --since 7d --by model           # 请求、token、缓存命中率、费用、工具调用 Top N（--json 可用）
ama sessions search "parser" --role user  # 跨会话全文检索，/正则/ 也行
ama sessions show 3f9a1c2e                # 末尾列出用户消息编号
ama -p --from 3f9a1c2e#2 --model packy/kimi-k2.5   # 用那条消息（含图片）换个模型再问
ama sessions export 3f9a1c2e --format md --output s.md   # md / json / jsonl，导出前脱敏
```

统计口径（命中率只算报告缓存的端点、费用只加有价请求等）与导出格式见 [docs/sessions.md](docs/sessions.md)。

### RPC

`ama --mode rpc` 在 stdin / stdout 上说 JSONL：先发 `hello` 与 `session_start`，之后收 `prompt`、`steer`、`abort`、`set_model`、`get_session_stats`、`fork` 等命令，推送流事件与审批请求。

```sh
printf '{"id":"1","type":"prompt","message":"hi"}\n' | ama --mode rpc --model fake/echo
```

`hello.capabilities` 列出服务端能力（`approvals`、`images`、`hooks`、`plans`），客户端用 `set_client_capabilities` 声明要接管的审批与计划审批。第五波新增计划（`plan_response` / `get_plan` / `get_todos`）、任务（`get_tasks` / `get_agents`）、回滚（`get_rewind_points` / `rewind` / `summarize_*`）命令与 `subagent_*`、`plan_*`、`limit_reached`、`telemetry_tick` 等事件。协议见 [docs/rpc.md](docs/rpc.md)，类型从 `@armadra/agent/rpc` 导入。

`ama --mode acp` 说 ACP（JSON-RPC over NDJSON），见 [docs/acp.md](docs/acp.md)。

### SDK

```sh
npm i @armadra/agent
```

```ts
import { createAgentSession } from "@armadra/agent";

const session = await createAgentSession({
  cwd: process.cwd(),
  model: "anthropic/<model-id>", // 试跑可用 "fake/echo"
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

- `createAgentSession` 不读文件系统配置：内存会话、指定工具、回调审批，适合嵌在别的程序里。
- 回滚：`session.rewindPoints()` 列出活动路径上开启新回合的用户消息；`session.rewind({ entryId, mode: "both" | "conversation" | "code", dryRun?, onConflict? })` 回到该消息之前（返回原消息草稿与代码恢复结果，内存会话只能仅对话）；`session.summarizeFrom(entryId, instructions?)` / `session.summarizeUpTo(entryId, instructions?)` 对应「从这里摘要」「摘要到这里」。设计见 [docs/rewind-plan.md](docs/rewind-plan.md)。
- 计划：`createAgentSession({ plan: { onProposed } })` 在计划提出后回调审批（返回 `{ decision: "approve" | "approve_fresh" | "revise" | "reject", mode?, feedback? }`），或之后用 `session.plan.respond()`；`session.plan.current()` / `todos()` 读当前计划与待办。类型 `SessionPlanOptions`、`PlanDecision` 等从包入口导出，见 [docs/plan.md](docs/plan.md)「接口」。
- `createRuntime({ argv })` 走与 `ama` 命令行相同的启动序列（读配置、AGENTS.md、Skill、hooks.json、auth.json）。
- 子路径：`@armadra/agent/host`（宿主适配器类型）、`@armadra/agent/rpc`（RPC 类型）、`@armadra/agent/tui`（终端组件库）、`@armadra/agent/acp`（ACP 类型、客户端、驱动与假 Agent）、`@armadra/agent/bundle`（单文件 `ama.cjs`，`require.resolve` 可取路径交给 `node` 或 `ELECTRON_RUN_AS_NODE=1` 启动）。

完整示例见 [examples/sdk-demo.ts](https://github.com/Owlbay/armadra-agent/blob/main/examples/sdk-demo.ts)（自定义工具、流式输出、用量统计）。

## 嵌入 Armadra

Armadra 以 `ama --profile <path>` 启动 ama。profile 是一个 JSON 文件，指定宿主适配器（`host`）、指令（`instructions`）、Skill 与提示模板目录、Hook 文件、key 文件（`authFile`，可配 `authEnv: false` 不读环境变量）、会话目录与 `trustProject`。

宿主适配器是一个本地 JS 模块，导出 `hostApi` 与 `create(api)`，经 `HostApi` 注册画布工具（`canvas_*` / `context_*`）、追加系统提示、接管审批、注入消息、显示状态。同一个 profile 在画布外运行时适配器不激活，ama 退化为普通独立模式。配合 `coordinator` 预设，协调者只读文件、调用画布工具，不自己改代码。

- ama 一侧的接口：[docs/host-api.md](docs/host-api.md)
- 协调者的设计与契约：Armadra 仓库 [docs/design/coordinator-agent.md](https://github.com/yovinchen/Armadra/blob/main/docs/design/coordinator-agent.md)

## 文档

| 文档                                                  | 内容                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [docs/providers.md](docs/providers.md)                | 内置供应商与渠道、API Key、自定义供应商与中转站、模型元数据快照、图像输入、compat、缓存 |
| [docs/tui.md](docs/tui.md)                            | 终端界面：布局、状态栏、按键、命令、回滚、审批、Plan 审批、子 Agent、剪贴板图片、组件库 |
| [docs/permissions.md](docs/permissions.md)            | 权限模式、plan 只读命令、判定顺序、沙箱内免审批、auto 三层判定、审批来源标注            |
| [docs/plan.md](docs/plan.md)                          | Plan 模式：流程、计划格式、审批、分模型、配置与持久化                                   |
| [docs/agents.md](docs/agents.md)                      | 子 Agent（类型、定义文件、后台、续聊、worktree）与外部 Agent（驱动、权限、环境、预算）  |
| [docs/acp.md](docs/acp.md)                            | ACP：`ama --mode acp` 与 ama 作为 ACP 客户端                                            |
| [docs/sandbox.md](docs/sandbox.md)                    | 操作系统沙箱：codemode 与 bash、各平台实现、配置与已知绕过                              |
| [docs/codemode.md](docs/codemode.md)                  | codemode 脚本、沙箱与权限                                                               |
| [docs/hooks.md](docs/hooks.md)                        | 命令式 Hook（hooks.json）                                                               |
| [docs/host-api.md](docs/host-api.md)                  | 宿主适配器 API                                                                          |
| [docs/rpc.md](docs/rpc.md)                            | RPC 协议（stdio JSONL）                                                                 |
| [docs/session-format.md](docs/session-format.md)      | 会话文件格式                                                                            |
| [docs/sessions.md](docs/sessions.md)                  | 会话统计、检索、`--from` 复用、导出、检查点与影子 git                                   |
| [docs/rewind-plan.md](docs/rewind-plan.md)            | 检查点与回滚的设计                                                                      |
| [docs/tui-design.md](docs/tui-design.md)              | 终端界面视觉规格与逐屏样稿                                                              |
| [docs/design.md][design]                              | 总体设计与决策记录（第五波增补指引在 §0 之后）                                          |
| [docs/extensions.md][extensions]                      | 本地扩展（设计草案，未实现）                                                            |
| [docs/benchmarks/][benchmarks]                        | 预设基准、D20 todo 复测与缓存验收实验（报告与原始数据）                                 |
| [docs/wave6-plan.md][wave6]                           | 第六波设计：Agent 栏与子 Agent 视图、轨迹、Memory、ChatGPT 登录、中英双语、`/config`    |
| [docs/i18n.md][i18n]                                  | 中英双语开发约定：语言选择、消息目录与键名规范、模型侧隔离、检查脚本                    |
| [docs/wave5-plan.md][wave5]                           | 第五波设计：状态行、模型元数据、渠道、图像、外部 Agent、Plan、子 Agent、压缩与 harness  |
| [docs/implementation-plan.md][impl]、[wave3-plan][w3] | 早期实施计划（追溯用）                                                                  |
| [docs/research/][research]                            | 第五波与第六波调研报告（追溯用）                                                        |

npm 包里带上表前十五份（用户文档）；其余是设计与追溯材料，链接指向 GitHub。

[design]: https://github.com/Owlbay/armadra-agent/blob/main/docs/design.md
[extensions]: https://github.com/Owlbay/armadra-agent/blob/main/docs/extensions.md
[benchmarks]: https://github.com/Owlbay/armadra-agent/tree/main/docs/benchmarks
[wave6]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave6-plan.md
[i18n]: https://github.com/Owlbay/armadra-agent/blob/main/docs/i18n.md
[wave5]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave5-plan.md
[impl]: https://github.com/Owlbay/armadra-agent/blob/main/docs/implementation-plan.md
[w3]: https://github.com/Owlbay/armadra-agent/blob/main/docs/wave3-plan.md
[research]: https://github.com/Owlbay/armadra-agent/tree/main/docs/research

## 已知限制

- **Linux 沙箱未在真机上验证**：bubblewrap 的策略只经单元测试与 Ubuntu CI 验证，没有在 Linux 桌面 / 服务器真机上跑过；没有 bwrap 时退到 `unshare -r -n`（只隔离网络，不能用于 bash 沙箱），都没有则按无沙箱处理（codemode 回到执行类、每次审批）。
- **外部 Agent 的真实 CLI 测试只在本地跑**：CI 只跑录制回放与 ama 驱动 ama；接 `claude` / `codex` 的端到端需要本机已登录，`AMA_E2E_AGENTS=1` 时运行（会用你的订阅额度），见 [docs/agents.md](docs/agents.md)「本地验证真实 CLI」。
- **DeepSeek、智谱、Kimi 缺省仍走 Chat**：它们的 Messages 渠道（`@messages`）只在中转上测过，等官方直连过了实测门（`scripts/channel-probe.mjs`）再切缺省。
- **models.dev 刷新 PR 不自动触发 CI**：仓库 secret `MODELS_DEV_PR_TOKEN` 没配时，每周的 workflow 用缺省 token 开 PR（先在 workflow 里自跑 `pnpm run ci` 并把结果写进描述）。
- 子 Agent 深度 1，不读 `.claude/agents`，不支持继承父对话的 fork 模式；Windows 没有操作系统沙箱。

## 开发

需要 Node ≥ 22 与 pnpm（版本见 `package.json` 的 `packageManager`，`corepack enable` 即可）。

```sh
pnpm install
pnpm run ci              # typecheck、fmt:check、check:deps、release:check、test、build，再跑 bundle --version
AMA_E2E=1 pnpm test:e2e  # bundle 级端到端：print / rpc / acp / plan / 子 Agent / 回滚 / codemode / cache / host（fake 供应商，不花钱）
```

pnpm 10 起 `pnpm ci` 是内置的「清理后安装」，跑检查要写 `pnpm run ci`。常用单项：`pnpm test`、`pnpm typecheck`、`pnpm fmt`、`pnpm build`。测试一律用 fake 供应商：`AMA_FAKE_SCRIPT=<脚本.json>` 让它按脚本产出文本、工具调用、429、断流等，示例在 `test/fixtures/scripts/`。

**真实模型脚本**（本地跑，CI 不跑；先 `pnpm build`）：

| 脚本                                                      | 用途                                  |
| --------------------------------------------------------- | ------------------------------------- |
| `node scripts/bench-presets.mjs`（`pnpm bench:presets`）  | 预设基准（`--tasks long` 多步长任务） |
| `node scripts/cache-experiment.mjs`（`pnpm bench:cache`） | 缓存验收实验 E1–E5                    |
| `node scripts/record-sse.mjs`                             | 录制各协议的 SSE 样本作为测试 fixture |

前两个共用预算控制：`--config` / `AMA_REAL_CONFIG`（含 key 引用的 config.json）、`--models` / `AMA_REAL_MODELS`、`--max-requests` / `AMA_REAL_MAX_REQUESTS`（缺省 60）、`--budget-usd` / `AMA_REAL_BUDGET_USD`（缺省 3）。超过请求数或预算立即停止并输出已有数据；配置与数据目录指向临时目录，不碰你的用户配置。

**约束**：运行时依赖必须为零，`src/` 只允许 `node:` 内置模块与相对路径（`pnpm check:deps` 守住）。`src/` 按层分目录（`ai` 模型接入、`agent` 循环、`session` 会话树、`tools`、`codemode`、`permissions`、`hooks`、`host` 宿主契约、`tui` 组件库、`modes` 各入口、`cli` 启动），各目录的 `types.ts` 是模块之间的契约。

**发布**：改 `package.json` 版本与 [CHANGELOG.md](CHANGELOG.md)，合入 main 后打 `v<版本>` tag。CI 全绿后 release job 生成 GitHub Release（`ama.cjs`、`ama-sandbox.cjs`、`package.tgz`、`SHA256SUMS`），再以 provenance 发布到 npm：优先用 OIDC 可信发布（trusted publishing，npm ≥ 11.5.1，job 内自动升级），在 npmjs.com 的 `@armadra/agent` 包设置 → Trusted Publisher 添加 GitHub Actions（组织 `Owlbay`、仓库 `armadra-agent`、工作流 `ci.yml`、环境留空）即可，不需要长期 token；仓库 secret `NPM_TOKEN` 保留为回退，两者都没有时 job 失败并提示。`pnpm release:check` 检查 tag 与版本一致，协议常量变化要求破坏性版本升级。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
