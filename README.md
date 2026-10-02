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
- [界面与入口](#界面与入口)
- [嵌入 Armadra](#嵌入-armadra)
- [文档](#文档)
- [开发](#开发)

## 为什么做 ama

- **调用型 Agent**：ama 被别的程序调用的时候和被人使用的时候一样多——`-p` 一次性运行、`--mode rpc`、SDK、宿主适配器都是一等入口，退出码与 JSON 形状是契约。
- **分层清楚**：参考 Pi 的分层，协议实现与供应商数据分开。四条协议线（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Google Generative AI）只写一次，供应商只是「baseUrl + key + 模型表 + compat 开关」。
- **配置精简**：设一个环境变量就能用；常用配置只有五个键，其余都有缺省。只用 API Key（官方或中转站），只做 Skill 与内置工具，不接 MCP。
- **缓存优先**：长任务的大部分用量是缓存读取。ama 保证请求前缀逐字节稳定，按各家写法打缓存断点，并把缓存是否生效、为什么没命中显示出来。
- **两种用法**：独立用就是一个终端编码 Agent；嵌入 Armadra 时作为画布上的协调者，驱动 Claude Code、Codex、OpenCode 等 CLI Agent 分工、汇报与汇总。

## 特性一览

| 方面           | 内容                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多协议与供应商 | 4 条协议线、13 家内置供应商（Anthropic、OpenAI、Google、DeepSeek、Moonshot、智谱、通义、OpenRouter、Groq、xAI、Mistral、Ollama、LM Studio）、自定义供应商、模型级协议 |
| 零配置与中转站 | 有 key 就选第一个可用的供应商；识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`；`ama providers add` 只给 baseUrl 与 key 一键接入：列模型、探测渠道、写回配置            |
| 模型元数据     | 上下文、输出上限、图像输入、推理、价格缺省从 models.dev 补（本地缓存，启动不联网）；一个供应商可挂多个渠道（Chat / Responses / Messages），`provider/model@渠道`      |
| 图像输入       | `-p --image`、界面里 `@图片路径`；四条协议都映射；模型不收图片时直接拒绝并提示换模型                                                                                  |
| 工具与预设     | read / edit / write / bash / grep / glob，另有 ls、todo、task（子 Agent）、codemode；四个预设 `default` / `minimal` / `codemode` / `coordinator`                      |
| codemode       | 模型写一段 JS，在受 Node 权限模型约束的子进程里编排多次工具调用，只有输出回到模型                                                                                     |
| Skill          | `SKILL.md` 目录，模型按索引自行读取，用户用 `/skill:<名字>` 调用；另有提示模板                                                                                        |
| 两层 Hook      | 命令式 Hook（`hooks.json`，9 个事件，用户策略）与进程内宿主适配器 HostApi（嵌入方）                                                                                   |
| 权限           | 四种模式、allow / deny 规则、危险命令识别（穿透 `sh -c` / `eval` / `xargs` / `find -exec`）、项目信任、审批时的执行前预览                                             |
| 缓存           | 前缀稳定、缓存字段与兼容开关、未命中归因、「报 / 不报缓存」三态、长工具运行时保温、压缩摘要按会话前缀续写                                                             |
| 会话           | JSONL 条目树，分叉与 `/tree` 回溯；两档压缩（裁剪大工具结果 → 摘要）与熔断                                                                                            |
| 入口           | 差分渲染终端界面、`--no-tui` 行式、`-p`（text / json / stream-json）、`--mode rpc`、SDK                                                                               |

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

### Node 版本与 codemode

| Node    | codemode 沙箱                                                                                |
| ------- | -------------------------------------------------------------------------------------------- |
| ≥ 25    | 文件系统与网络都隔离；`codemode` 按只读类工具处理，`default` 权限模式下免审批                |
| 22 / 24 | 隔离文件系统，**不隔离网络**；`codemode` 按执行类处理，每次都要审批（状态栏显示红色 `net!`） |

其余功能在 Node 22 起都一样。`codemode.requireStrict: true` 可以在网络未隔离时直接禁用 codemode。

## 快速开始

**零配置**：设好任一家的标准环境变量就能用，ama 按内置顺序选第一个有 key 的供应商和它的缺省模型。

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

| 参数                                                    | 作用                                           |
| ------------------------------------------------------- | ---------------------------------------------- |
| `--model provider/id`                                   | 选模型（配置、命令行、`/model`、SDK 写法一致） |
| `--thinking off\|minimal\|low\|medium\|high\|xhigh`     | 思考级别（缺省 `medium`）                      |
| `--permission-mode plan\|default\|auto-edit\|full-auto` | 权限模式（缺省 `default`）                     |
| `-c` / `-r [id]`                                        | 继续本目录最近的会话 / 选择会话恢复            |
| `--tools-preset <名>`                                   | 工具预设（见下文）                             |
| `--allow <规则>` / `--deny <规则>`                      | 追加权限规则，可重复                           |

本地 Ollama / LM Studio 不需要 key：`ama --model ollama/<模型名>`。`ama --help` 列出全部参数与子命令；测试或排查时可用不花钱的 `--model fake/echo`（回显最后一条用户消息）。

## 配置

一个文件 `~/.config/ama/config.json`。第一次进入对话（交互、`-p`、RPC）或 `ama providers add` 时自动建好目录（0700）、
最小的 `config.json` 与给编辑器用的 `config.schema.json`；`config show`、`doctor`、`models list` 等只读命令不写配置目录。
也可以 `ama init` 手动建（已有文件不覆盖）。`ama config path` 打印各文件位置，`ama config edit`
用 `$VISUAL` / `$EDITOR` 打开。常用的只有五个键：

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

其余（`compaction`、`retry`、`codemode`、`hooks`、`ui`、`skills`、`cache`、`request`）都有缺省，`ama config show` 会列出来。

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
| `~/.local/share/ama/` | 数据：`sessions/`（会话 JSONL）、`models-dev.json`（模型元数据缓存）、输入历史                                                                       |
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
请求，把能用的渠道写进每个模型的 `channels`；上下文、输出上限、图像、推理与价格不写进配置，运行时从 models.dev 缓存补
（`ama models list` 标出每个字段的来源）。不给 `--key-env` 时 key 从 stdin 读（不回显）存进 `auth.json`。写入后的配置：

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
- 自定义模型的元数据缺省从 models.dev 补（`ama models refresh-catalog` 刷新缓存）；匹配不到时不猜 `contextWindow`，自动
  压缩关闭，需要时在模型条目里补上或写 `"modelsDev": "provider/model"` 指定条目。

**不想手写模型表**：让 ama 去问中转站。

```sh
ama models discover packy                              # 列出 GET {baseUrl}/models
ama models discover packy --probe --write --limit 8    # 逐个探测可用协议并写回配置
ama models check packy/grok-4.7                        # 一次最小请求确认连通
ama models cache-probe packy/grok-4.7                  # 这个端点报不报缓存
```

`--probe` 对每个模型依次试几种协议，记第一个成功的；`--write` 合并进用户级 `config.json`（原文件备份为 `config.json.bak`，已有条目不覆盖）。`--probe` 与 `cache-probe` 都会发真实请求：执行前打印预估，401 / 403 / 429 即停，`cache-probe` 在非交互环境需要 `--yes`。细节见 [docs/providers.md](docs/providers.md)。

## 工具与预设

| 预设          | 模型直接看到的工具                  | 适合                                       |
| ------------- | ----------------------------------- | ------------------------------------------ |
| `default`     | read、edit、write、bash、grep、glob | 缺省                                       |
| `minimal`     | read、edit、write、bash             | 小模型、小上下文；`full-auto`              |
| `codemode`    | 只有 `codemode`                     | 长流程、工具调用密集的任务                 |
| `coordinator` | read 与宿主注册的画布工具           | 嵌入 Armadra 的协调者：不写文件、不跑 bash |

- `--tools-preset <名>` 或 `tools.preset` 选预设。
- `tools.default` 在预设上微调：`["+todo", "+task", "-glob"]`；不带前缀的名字整组替换。
- 另有 `--tools a,b,c`（只启用这些）、`--exclude-tools a,b`、交互模式的 `/tools`。

**codemode** 让模型写一段 JavaScript，用 `tools.<name>(args)` 编排多次工具调用（可以 `Promise.all` 并发），只有脚本输出回到模型。`--tools-preset codemode` 只留它，`--codemode on` 在现有工具之外加上它。脚本跑在 `node --permission` 子进程的 vm 里：没有 `require` / `import` / `process` / `fetch`，每次内层调用仍逐个经过 Hook、权限与审批。

**什么时候用 codemode**：[三预设基准](docs/benchmarks/presets-2026-10-02.md)（三个模型 × 三类小任务）里，codemode 每组输入 token 比 default 多约 45%（工具声明每轮都在前缀里），顶层轮数却没有明显减少——这些任务本来只需要 2–4 次调用。所以缺省保持 `default`，只读检索多、调用次数多的长流程再用 codemode。

## 缓存

长任务的主要用量是缓存读取：前缀一旦变化，此后每次请求都按全价重读。ama 分三层处理：

- **协议层**：系统提示节顺序固定、不含时间戳，工具按名排序，中途变化只追加在末尾；按各家写法打缓存断点（Anthropic `cache_control`、OpenAI `prompt_cache_key` 等），端点 400 拒收某个缓存字段时自动去掉重发。
- **会话层**：每次请求记前缀指纹，检测未命中并归因（空闲超时、子任务、切换模型、系统提示 / 工具表变化、服务端淘汰），判定端点报不报缓存，长工具运行期间保温。
- **展示层**：状态栏、`/session`、`/cache`、RPC 统计与 `ama models cache-probe`。

### 读状态栏

```
anthropic/<model-id> · think:medium · ↑412k ↓8.1k · cache 83% ♨ · $0.84 · rebill $0.11 · ctx 34% · mode:default
```

| 项             | 怎么读                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| `cache 83%`    | **最近一次**请求的命中率；会话累计在 `/session`                            |
| `cache —`      | 端点还没报过缓存（还没有足够长的可比请求）                                 |
| `cache 未报告` | 端点不报缓存（连续 3 次读写都是 0）；这类请求不算进命中率，而不是显示成 0% |
| `♨`            | 保温计时中                                                                 |
| `rebill $0.11` | 本会话因缓存未命中多付的钱（无价格的模型显示 token）；为 0 不显示          |
| `ctx 34%`      | 上下文占用；≥ 70% 黄、≥ 90% 红，跨过时消息区提示「约剩 N 回合」            |

一次未命中重计费 ≥ 20k token 或 ≥ $0.10 时，消息区写一行原因。`/cache` 看缓存统计，`/cache fingerprint` 查前缀指纹（两次之间哈希变了，就是系统提示或工具表被改了）。

### 三态、保温与摘要续写

- **三态**：每个端点（供应商 + 主机 + 模型）在 `unknown` / `reported` / `silent` 之间判定。只有 `reported` 才显示命中率、检测未命中、保温；不报缓存的中转不会被误报成 0%。中转上已知不报的模型可以设 `compat.cacheReporting: "silent"`。
- **保温**：工具长时间运行（长测试、`task` 子任务、codemode 脚本）时，在缓存 TTL 到期前重放一次上一个请求（`maxTokens: 1`），只付读价把缓存续上。`cache.warming` 取 `off` / `streaming`（缺省，只在运行中）/ `idle`（空闲也保温，适合贵模型），`/cache warm …` 本会话切换；期望节省低于 `cache.minSavingsUsd`（缺省 $0.05）不发。
- **摘要续写**：上下文压缩的摘要请求接在与上一次真实请求逐字节相同的前缀后面，整段历史按读价计费；失败时回落为独立摘要请求。

### 实测

[缓存验收实验](docs/benchmarks/cache-2026-10-02.md)（2026-10-02，经一家测试中转站）：

| 场景                        | 结果                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Kimi 摘要续写               | 摘要请求读缓存 20.2k / 20.5k，**命中 98.8%**（修复前 0%：发 `tool_choice` 时前缀在工具段断开） |
| DeepSeek 按 2048 粒度报缓存 | 假未命中 3 次 → **0 次**（自动推断端点缓存粒度）                                               |
| 基线命中率（5 轮编码任务）  | Kimi 累计 86%、MiniMax 75%，均 0 次未命中                                                      |

缓存相关的全部配置与各协议字段见 [docs/providers.md](docs/providers.md)「缓存」。

## 安全

**权限模式**（`--permission-mode`、配置 `permission.mode`、`/permission` 选择器、交互模式 `Shift+Tab` 循环）：

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
- **项目信任**：`.ama/hooks.json`、`.ama/skills/`、`.ama/prompts/` 会执行或注入项目里的内容，需要先信任目录（交互模式问一次，可记住；`--trust` / `--no-trust`；非交互缺省不信任）。`AGENTS.md` 与 `.ama/config.json` 不需要信任，因为后者只能收紧。
- **执行前预览**：审批对话框除了输入摘要，还列出这一步会碰到什么——bash 里 `rm` / `mv` / `git clean` / `git reset --hard` / 重定向的目标路径是否存在、大小、目录里有多少文件；write 显示路径与行数，edit 显示每处修改的 −/+ 摘要。`y` 允许、`n` 拒绝、`a` 本会话同类不再问、`v` 看完整输入。
- **Hook**：`hooks.json` 在 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop` 等 9 个事件运行 shell 命令，可以否决工具调用、改写输入、追加上下文、让运行再跑一轮。见 [docs/hooks.md](docs/hooks.md)。

## 界面与入口

### 终端界面

直接运行 `ama`（stdin / stdout 都是 TTY）进入交互模式。界面只用主屏，对话历史留在终端回滚里，tmux `capture-pane` 能读到完整对话。

| 按键                 | 作用                                       |
| -------------------- | ------------------------------------------ |
| Enter                | 发送；运行中插话（steer）                  |
| Alt+Enter            | 运行中排到本轮之后（followUp）             |
| Shift+Enter / Ctrl+J | 换行                                       |
| Esc                  | 中断当前运行                               |
| Shift+Tab            | 循环权限模式                               |
| Ctrl+O               | 展开 / 折叠工具输出                        |
| Ctrl+L / Ctrl+T      | 选择模型 / 思考级别                        |
| Ctrl+C               | 清空输入；输入为空时 1.5 秒内再按一次退出  |
| Tab                  | 补全：`/` 命令、模板与 Skill，`@` 文件路径 |

常用命令：`/model`、`/thinking`、`/permission`、`/tools`、`/compact`、`/tree`（回到某条消息之前重新分支）、`/fork`、`/resume`、`/new`、`/session`、`/cache`、`/hooks`、`/skill:<名字>`、`/help`。输入里的 `@图片路径`（或粘贴 / 拖入的图片路径）作为图片附件发给模型；`/model` 按「供应商 · 渠道」分组，标出上下文与 `img`。按键可在 `~/.config/ama/keybindings.json` 覆盖。见 [docs/tui.md](docs/tui.md)。

`--no-tui`（或 stdin / stdout 不是 TTY、`TERM=dumb`）进入行式界面：readline + 括号粘贴，命令相同。

### `-p` 一次性运行

| `--output-format` | stdout                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| `text`（缺省）    | 最后一条回答的文本                                                            |
| `json`            | 一个 `result` 对象：会话 id、模型、`stopReason`、`text`、用量、费用、缓存统计 |
| `stream-json`     | 每行一个事件，与 RPC 事件同形状                                               |

**stdin**：没有提示参数时读 stdin 作为提示（`git diff | ama -p`）；有提示参数时不等 stdin——父进程留着不关的管道不会让
`-p` 挂起；要把管道内容拼在提示后面，在末尾加 `-`（`cat log.txt | ama -p "找出报错原因" -`）。`< 文件` 重定向总会读取。

`--image <文件>` 可重复，随提示发送图片（PNG / JPEG / GIF / WebP，单张 ≤ 5 MB）；提示里的 `@图片路径` 同样作为附件。当前
模型不收图片时直接退出 2，不发请求。

`--max-turns N` 限制一次运行最多 N 轮（一次模型请求加它的工具执行算一轮），到上限仍在调用工具时提前结束，退出码 1，
`json` 结果带 `maxTurnsReached: true`。

`--system-prompt <文本|@文件>` 补充系统提示（任何模式都可用）：缺省作为最后一条规则追加，preamble 与工具表这段最长的
缓存前缀不变；`--system-prompt-mode replace` 改为替换开头的角色说明，工具表、规则与 AGENTS.md 仍然保留。

`--no-session` 让会话只留在内存里、不写会话文件（适合 CI 与一次性调用；之后无法 `--resume`），交互模式里 `/new` 切出的
新会话同样不落盘。

**无人值守**：`-p` 没有人审批，缺省权限模式下需要询问的调用（写文件、跑命令）一律拒绝。被拒时 stderr 一行汇总被拒的
工具与原因，`json` 结果带 `deniedTools`，`stream-json` 的 `tool_execution_end` 带 `denied: true`，退出码 7。需要放行时用
`--permission-mode auto-edit`（放行写入）/ `auto`（ama 判断每一步），或 `--allow "bash(npm test*)"` 按规则放行。

退出码：0 正常 · 1 运行期错误 · 2 用法错误 · 3 配置错误 · 4 无可用模型或 key · 5 会话错误 · 6 宿主 / Hook 启动失败 · 7 `-p` 有工具调用被拒 · 78 宿主 API 版本不匹配 · 130 / 143 信号。

### RPC

`ama --mode rpc` 在 stdin / stdout 上说 JSONL：先发 `hello` 与 `session_start`，之后收 `prompt`、`steer`、`abort`、`set_model`、`get_session_stats`、`fork` 等命令，推送流事件与审批请求。

```sh
printf '{"id":"1","type":"prompt","message":"hi"}\n' | ama --mode rpc --model fake/echo
```

协议见 [docs/rpc.md](docs/rpc.md)，类型从 `@armadra/agent/rpc` 导入。

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
- `createRuntime({ argv })` 走与 `ama` 命令行相同的启动序列（读配置、AGENTS.md、Skill、hooks.json、auth.json）。
- 子路径：`@armadra/agent/host`（宿主适配器类型）、`@armadra/agent/rpc`（RPC 类型）、`@armadra/agent/tui`（终端组件库）、`@armadra/agent/bundle`（单文件 `ama.cjs`，`require.resolve` 可取路径交给 `node` 或 `ELECTRON_RUN_AS_NODE=1` 启动）。

完整示例见 [examples/sdk-demo.ts](examples/sdk-demo.ts)（自定义工具、流式输出、用量统计）。

## 嵌入 Armadra

Armadra 以 `ama --profile <path>` 启动 ama。profile 是一个 JSON 文件，指定宿主适配器（`host`）、指令（`instructions`）、Skill 与提示模板目录、Hook 文件、key 文件（`authFile`，可配 `authEnv: false` 不读环境变量）、会话目录与 `trustProject`。

宿主适配器是一个本地 JS 模块，导出 `hostApi` 与 `create(api)`，经 `HostApi` 注册画布工具（`canvas_*` / `context_*`）、追加系统提示、接管审批、注入消息、显示状态。同一个 profile 在画布外运行时适配器不激活，ama 退化为普通独立模式。配合 `coordinator` 预设，协调者只读文件、调用画布工具，不自己改代码。

- ama 一侧的接口：[docs/host-api.md](docs/host-api.md)
- 协调者的设计与契约：Armadra 仓库 [docs/design/coordinator-agent.md](https://github.com/yovinchen/Armadra/blob/main/docs/design/coordinator-agent.md)

## 文档

| 文档                                                                                                 | 内容                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [docs/providers.md](docs/providers.md)                                                               | 内置供应商、API Key、自定义供应商与中转站、compat、缓存 |
| [docs/tui.md](docs/tui.md)                                                                           | 终端界面：布局、按键、命令、审批预览、缓存显示、组件库  |
| [docs/codemode.md](docs/codemode.md)                                                                 | codemode 脚本、沙箱与权限                               |
| [docs/permissions.md](docs/permissions.md)                                                           | 权限模式、auto 三层判定、安全名单、allowlist            |
| [docs/hooks.md](docs/hooks.md)                                                                       | 命令式 Hook（hooks.json）                               |
| [docs/host-api.md](docs/host-api.md)                                                                 | 宿主适配器 API                                          |
| [docs/rpc.md](docs/rpc.md)                                                                           | RPC 协议（stdio JSONL）                                 |
| [docs/session-format.md](docs/session-format.md)                                                     | 会话文件格式                                            |
| [docs/extensions.md](docs/extensions.md)                                                             | 本地扩展（设计草案，未实现）                            |
| [docs/design.md](docs/design.md)                                                                     | 总体设计与决策记录                                      |
| [docs/benchmarks/](docs/benchmarks/)                                                                 | 三预设基准与缓存验收实验（报告与原始数据）              |
| [docs/implementation-plan.md](docs/implementation-plan.md)、[docs/wave3-plan.md](docs/wave3-plan.md) | 实施计划（追溯用）                                      |

## 开发

需要 Node ≥ 22 与 pnpm（版本见 `package.json` 的 `packageManager`，`corepack enable` 即可）。

```sh
pnpm install
pnpm run ci              # typecheck、fmt:check、check:deps、release:check、test、build，再跑 bundle --version
AMA_E2E=1 pnpm test:e2e  # bundle 级端到端：print / rpc / codemode / cache / host（fake 供应商，不花钱）
```

pnpm 10 起 `pnpm ci` 是内置的「清理后安装」，跑检查要写 `pnpm run ci`。常用单项：`pnpm test`、`pnpm typecheck`、`pnpm fmt`、`pnpm build`。测试一律用 fake 供应商：`AMA_FAKE_SCRIPT=<脚本.json>` 让它按脚本产出文本、工具调用、429、断流等，示例在 `test/fixtures/scripts/`。

**真实模型脚本**（本地跑，CI 不跑；先 `pnpm build`）：

| 脚本                                                      | 用途                                  |
| --------------------------------------------------------- | ------------------------------------- |
| `node scripts/bench-presets.mjs`（`pnpm bench:presets`）  | 三预设基准                            |
| `node scripts/cache-experiment.mjs`（`pnpm bench:cache`） | 缓存验收实验 E1–E5                    |
| `node scripts/record-sse.mjs`                             | 录制各协议的 SSE 样本作为测试 fixture |

前两个共用预算控制：`--config` / `AMA_REAL_CONFIG`（含 key 引用的 config.json）、`--models` / `AMA_REAL_MODELS`、`--max-requests` / `AMA_REAL_MAX_REQUESTS`（缺省 60）、`--budget-usd` / `AMA_REAL_BUDGET_USD`（缺省 3）。超过请求数或预算立即停止并输出已有数据；配置与数据目录指向临时目录，不碰你的用户配置。

**约束**：运行时依赖必须为零，`src/` 只允许 `node:` 内置模块与相对路径（`pnpm check:deps` 守住）。`src/` 按层分目录（`ai` 模型接入、`agent` 循环、`session` 会话树、`tools`、`codemode`、`permissions`、`hooks`、`host` 宿主契约、`tui` 组件库、`modes` 各入口、`cli` 启动），各目录的 `types.ts` 是模块之间的契约。

**发布**：改 `package.json` 版本与 [CHANGELOG.md](CHANGELOG.md)，合入 main 后打 `v<版本>` tag。CI 全绿后 release job 生成 GitHub Release（`ama.cjs`、`ama-sandbox.cjs`、`package.tgz`、`SHA256SUMS`），再以 provenance 发布到 npm（需要仓库 secret `NPM_TOKEN`，没有时跳过）。`pnpm release:check` 检查 tag 与版本一致，协议常量变化要求破坏性版本升级。

## 更新记录

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
