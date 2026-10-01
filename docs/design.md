# ama 设计：可独立使用、可嵌入 Armadra 的编码 / 协调 Agent

> 状态：目标设计（2026-10-02），未开始实施。仓库 `github.com/yovinchen/armadra-agent`（MIT），npm 包 `@armadra/agent`，可执行名 `ama`。
> 两种用法都是一等公民：① 任意目录下的独立 CLI（`ama`）；② 嵌入 Armadra 画布作为协调者（见 Armadra 仓库 `docs/design/coordinator-agent.md`，下称「文档 B」）。
> 设计只借鉴 Pi 的 RPC 形状、会话树与压缩思路，运行时不依赖它。本文不出现 Armadra 以外的任何宿主专有概念；Armadra 的适配器放在 Armadra 仓库（§9）。

## §0 结论

| #   | 决定                                                                                                                                               | 理由                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **单包** `@armadra/agent`，子路径导出 `.`（SDK）、`./host`（宿主适配器类型）、`./rpc`（RPC 类型）、`./bundle`（单文件入口）                        | 一个人维护，多包只增加发布与版本对齐成本；子路径导出已足够隔离契约面                                                                                                    |
| D2  | 技术栈与 Armadra 对齐：Node ≥ 22、TypeScript 5.9、pnpm、vitest 4、prettier 3、esbuild 打 bundle；源码 ESM，bundle 输出 **CJS 单文件**              | Armadra 的 `cli` / `session-host` / 服务器壳三条 bundle 都是 CJS 单文件、`target: node22`、用 `ELECTRON_RUN_AS_NODE=1 <Electron> <file>` 启动；同形状可直接套用其启动器 |
| D3  | 核心零宿主概念；一切宿主能力经 **宿主适配器**（`--host <module>`）接入：注册工具、订阅事件、追加指令、接管审批                                     | 画布工具、状态上报、审批属于宿主协议，随宿主演进；核心只保证 `HostApi` 的版本化契约                                                                                     |
| D4  | 适配器**放宿主仓库**（Armadra：`apps/desktop/src/agent-host/ama/`），本仓库只发布类型与 `HOST_API_VERSION`                                         | 适配器讲的是 Armadra 的 Hook 面 HTTP、令牌文件、动词表，这些随 Armadra 发布节奏变；放这边会让本仓库每次跟改                                                             |
| D5  | 事件词汇沿用 Pi 扩展事件名（`session_start` … `agent_settled`）                                                                                    | Armadra 已有 `hook/normalize/pi.ts` 吃这套词汇，适配器零翻译                                                                                                            |
| D6  | 第一版只接 API Key；协议线 Anthropic Messages 与 OpenAI 兼容 Chat；Responses 后置；不接 MCP，只做 Skill + 六个内置工具                             | 需求已定；MCP 的进程管理与权限模型是独立一期的工作量                                                                                                                    |
| D7  | 会话是 **JSONL 条目树**（`id` / `parentId`），`message` 条目字段名与 Pi 的 v3 格式一致（`role` / `content` / `model` / `usage` / `responseId`）     | 分叉与分支摘要需要树；字段对齐让 Armadra `core/history/pi.ts` 的解析几乎可复用                                                                                          |
| D8  | 两档压缩：档一**裁剪**（无模型调用，`context_edit` 替换旧工具结果），档二**摘要**（`compaction` 条目）；熔断见 §6.3                                | 多数超限来自工具输出，裁剪便宜且不丢用户话；摘要只在裁剪不够时做                                                                                                        |
| D9  | 权限管线固定顺序：拒绝规则 → 危险命令识别 → 模式 → 允许规则；无人值守下 `ask → deny`；沙箱后置                                                     | 顺序让「拒绝」永远赢，模式只决定「要不要问」，规则不能放开被识别为危险的命令                                                                                            |
| D10 | 入口：行式 REPL（含括号粘贴）、`-p`（text / json / stream-json）、`--mode rpc`（stdio JSONL，Pi 形状）、SDK；ACP 后置                              | REPL 是 Armadra 第一版的节点形态（文档 B M1）；RPC 与 SDK 服务嵌入与测试                                                                                                |
| D11 | 独立模式的协调能力 = 同进程 `task` 子 Agent（深度 1），**不做**多 CLI 编排、终端或 worktree 管理；多 CLI 编排只在宿主下由宿主工具提供              | 终端、连线、worktree 是宿主的领域，独立仓库重造一遍就是第二个 Armadra                                                                                                   |
| D12 | 发布产物：npm 包（ESM + 类型）+ `dist/bundle/ama.cjs` 单文件；`bun compile` 二进制后置                                                             | Armadra 需要的是能被 Electron 当 Node 跑的单文件；独立用户 `npm i -g` 即可；80 MB 二进制与签名问题不值得第一版背                                                        |
| D13 | npm 包名用作用域名 `@armadra/agent`，不用无作用域的 `ama`                                                                                          | 作用域表明归属、不与现有包撞名；短名在 npm 上大概率已被占用；可执行名仍是 `ama`                                                                                         |

## §1 架构与目录

```text
src/
  cli/            入口：参数解析（--mode / -p / --host / --profile …）、退出码
  modes/
    repl/         行式 REPL：readline + 括号粘贴状态机 + 斜杠命令
    print/        -p：text / json / stream-json
    rpc/          --mode rpc：JSONL 读写、命令分派、事件序列化
  agent/          循环：状态机、队列（steer / followUp）、中断、重试
  ai/             供应商：anthropic-messages、openai-chat；流式解析、工具调用归一化、用量
  session/        JSONL 条目树：SessionManager、投影（projection）、分叉、清理
  compaction/     两档压缩、分支摘要、熔断
  tools/          read / write / edit / bash / grep / glob、task（子 Agent）
  skills/         SKILL.md 发现、索引、渐进披露
  permissions/    规则、危险命令识别、模式、询问与无人值守策略
  host/           HostApi 实现与 --host 加载器（类型从 ./host 子路径导出）
  config/         配置文件、auth.json、profile.json、XDG 路径
  sdk.ts          createAgentSession 等公开 API
docs/             design.md（本文）、rpc.md、session-format.md、host-api.md
scripts/          build-bundle.mjs（esbuild）、release 检查
test/fixtures/    JSONL 样本、RPC 黄金记录、脚本化供应商响应
```

依赖方向：`cli → modes → agent → {ai, session, compaction, tools, permissions, skills, host, config}`；`host` 不反向 import `modes`。`src/**` 不得 import 任何宿主包，用一条源码扫描测试守住（与 Armadra `no-electron.test.ts` 同一手法）。

目录与数据位置（独立模式）：

| 内容                           | 位置                                                                           | 覆盖                             |
| ------------------------------ | ------------------------------------------------------------------------------ | -------------------------------- |
| 配置 `config.json`、`auth.json` | `~/.config/ama/`（Windows：`%APPDATA%\ama\`）                                  | `AMA_CONFIG_DIR`                 |
| 会话                           | `~/.local/share/ama/sessions/<编码 cwd>/<ISO 时间>_<uuid>.jsonl`               | `AMA_DATA_DIR`、`--session-dir`  |
| 项目级                         | `<cwd>/.ama/{AGENTS.md,skills/,config.json}`                                   | —                                |
| 用户技能                       | `~/.config/ama/skills/<name>/SKILL.md`                                         | `--skill-dir`（可重复）          |

## §2 模型接入

| 项            | 决定                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议线        | `anthropic-messages`、`openai-chat`（Chat Completions，含 `tool_calls` 流式增量拼接）；`openai-responses` 第 5 期                                                                                                     |
| 模型表        | `config.json` 的 `models[]`：`{ id, provider, api, baseUrl, contextWindow, maxTokens, reasoning, cost? }`；内置少量缺省条目，用户可覆盖；不猜不认识的模型的窗口大小——缺 `contextWindow` 的模型关闭自动压缩并警告 |
| 流式归一化    | 供应商事件 → 内部 `AssistantEvent`：`text_delta` / `thinking_delta` / `tool_call_start` / `tool_call_delta` / `tool_call_end` / `usage` / `done{stopReason}`；上层只认这一套                                        |
| 用量          | `usage{ input, output, cacheRead, cacheWrite }` 统一字段；`responseId` 取供应商响应 id，用于去重与成本对账                                                                                                           |
| 重试          | 429 / 5xx / 网络错误指数退避（1s 起，×2，最多 5 次，上限 30s），`abort` 可打断等待；非瞬时错误不重试                                                                                                                 |
| 思考          | `thinkingLevel: off | low | medium | high`，映射到各协议的推理参数；不支持的模型忽略并记一条 warning                                                                                                                 |
| 密钥来源      | 顺序：`--auth-file` → `AMA_API_KEY_<PROVIDER>` 环境变量 → `~/.config/ama/auth.json`；值只读进局部变量，不日志、不进会话文件                                                                                            |

## §3 循环

### §3.1 状态

```text
idle ──prompt──▶ running ──(模型流结束, 有 tool_call)──▶ executing-tools ──┐
  ▲                 ▲                                                      │
  │                 └──────── 投递 steer 队列 → 下一次模型调用 ◀───────────┘
  │                                   │(无 tool_call 且 steer 队列空)
  │◀── agent_settled ──── 投递 followUp 队列（有则回到 running，无则结束）◀┘
```

- 一次 **run**：从 `prompt` 接受到 `agent_settled`。一次 **turn**：一次模型调用加上它产生的工具执行。
- `agent_end` 只表示底层 run 结束；重试、溢出恢复、followUp 都可能接着来。宿主要知道「不会再自动继续」时等 `agent_settled`（与 Pi 相同的区分）。

### §3.2 中断（abort）精确语义

1. `abort()` 触发会话级 `AbortController`；该 signal 同时传给：供应商流（断开 HTTP）、每个正在执行的工具（`ToolContext.signal`）、重试等待计时器。
2. `bash` 工具收到 signal：向进程组发 `SIGTERM`，2 s 后仍存活发 `SIGKILL`（Windows：`taskkill /T /F`）。
3. **补 tool_result**：模型消息里每个尚无结果的 `tool_call`，写入 `toolResult{ isError: true, content: "aborted by user" }`，再写入一条 `custom_message`（`customType: "ama.aborted"`）记录中断时刻。这样转录永远满足「每个 tool_call 有且仅有一个 result」，下一次请求不会被供应商拒绝。
4. 已流出的部分助手消息照常落盘，`stopReason: "aborted"`。
5. **abort 不清队列**：steer / followUp 队列保留；要清用 `clear_queue`（REPL 的 Esc 先 `clear_queue` 再 `abort`，把队列文本放回输入框）。
6. `abort()` 在会话回到 `idle` 后 resolve。

### §3.3 插话（steer / followUp）精确语义

| 调用                                 | 不在运行时                      | 运行中                                                                                                    | 投递点                                                              |
| ------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `prompt(text)`                       | 开新 run，`disposition: started` | **报错**，除非带 `streamingBehavior: "steer" | "followUp"`                                                 | —                                                                   |
| `steer(text)`                        | 等价于 `prompt`                 | 入 steer 队列，`disposition: queued`                                                                      | 当前 turn 的工具全部执行完、**下一次模型调用之前**，作为 user 消息  |
| `followUp(text)`                     | 等价于 `prompt`                 | 入 followUp 队列                                                                                          | run 自然结束（无 tool_call 且 steer 队列空）时，开下一个 run        |
| 队列模式                             | `steeringMode` / `followUpMode` | `one-at-a-time`（缺省）每个 turn 投一条；`all` 一次投完                                                   | —                                                                   |
| 斜杠命令（`/compact`、`/skill:x`）   | 立即执行                        | 立即执行，不入队                                                                                          | —                                                                   |

steer 消息进入转录时标 `custom: { origin: "steer" }`，渲染时与普通用户消息区分；对模型它就是 user 消息。

### §3.4 工具执行

同一条助手消息里的多个 `tool_call` 默认**顺序**执行（文件工具共享可变状态；并行留给只读工具：`read` / `grep` / `glob` 标 `annotations.readOnly` 的可并行，上限 4）。每个工具的输出超过 `maxToolResultChars`（缺省 30 000）即截断并写全文到 `<sessionDir>/outputs/<toolCallId>.txt`，结果里告知路径。

## §4 工具与 Skill

### §4.1 工具定义

```ts
// @armadra/agent（也从 ./host 再导出）
export interface ToolDefinition<I = unknown> {
  readonly name: string;                 // ^[a-z][a-z0-9_]{1,63}$，宿主工具建议带前缀（canvas_*）
  readonly description: string;
  readonly parameters: JsonSchema;       // JSON Schema draft-07 子集
  readonly annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  /** 权限管线用的粗分类；缺省 "execute"。 */
  readonly permission?: "read" | "write" | "execute";
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}
export interface ToolContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  onUpdate(partial: string): void;       // 流式进度（bash 输出）
}
export interface ToolResult {
  content: string | ContentBlock[];      // 给模型看的
  isError?: boolean;
  details?: unknown;                     // 给界面 / 宿主看的，落盘但不进上下文
}
```

### §4.2 内置工具

| 工具    | 参数                                     | 权限类    | 备注                                                                                       |
| ------- | ---------------------------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `read`  | `path, offset?, limit?`                  | read      | 文本按行号返回；二进制与超大文件拒绝并提示                                                 |
| `write` | `path, content`                          | write     | 整文件写；写前若文件存在且本会话未 `read` 过，返回错误要求先读                             |
| `edit`  | `path, oldText, newText, replaceAll?`    | write     | 精确文本替换；`oldText` 不唯一时报错并给出出现次数                                         |
| `bash`  | `command, timeoutMs?, cwd?`              | execute   | POSIX：`sh -c`；Windows：`AMA_SHELL` → Git Bash → `powershell -NoProfile -Command`；进程组 |
| `grep`  | `pattern, path?, glob?, maxResults?`     | read      | 内置实现（不依赖系统 `rg`），尊重 `.gitignore`                                             |
| `glob`  | `pattern, path?`                         | read      | 同上                                                                                       |
| `task`  | `prompt, tools?, model?`                 | execute   | 同进程子 Agent，深度 ≤ 1、并发 ≤ 4、各自一份 JSONL（`parentSession` 指回）；宿主可禁用      |

### §4.3 Skill（渐进披露）

- 发现：`--skill-dir`、`~/.config/ama/skills/`、`<cwd>/.ama/skills/`，每个子目录一份 `SKILL.md`，YAML 头 `name` / `description` 必填。
- 披露三级：系统提示里只有**索引**（名字 + 一句描述，每条 ≤ 200 字）；模型用 `read` 读完整 `SKILL.md`；`SKILL.md` 可再引用同目录下的文件。
- 用户可用 `/skill:<name> [args]` 把技能正文直接作为本轮提示展开。
- 不做技能包管理、不联网下载。

## §5 会话格式

一个会话一个 JSONL 文件，首行是头，其后每行一个条目；条目经 `id` / `parentId` 成树，分叉不建新文件。

```ts
export interface SessionHeader {
  type: "session"; version: 1; id: string; timestamp: string; cwd: string;
  agent: { name: "ama"; version: string };
  parentSession?: string;                 // fork / clone / task 的来源文件
}
interface EntryBase { id: string; parentId: string | null; timestamp: string }

export type SessionEntry =
  | (EntryBase & { type: "message"; message: AgentMessage })
  | (EntryBase & { type: "compaction"; summary: string; firstKeptEntryId: string;
                   tokensBefore: number; usage?: Usage; details?: { readFiles: string[]; modifiedFiles: string[] } })
  | (EntryBase & { type: "branch_summary"; fromId: string; summary: string; usage?: Usage })
  | (EntryBase & { type: "context_edit"; targetId: string; replacement: string | null; reason: "prune" | "abort" | "manual" })
  | (EntryBase & { type: "model_change"; provider: string; modelId: string })
  | (EntryBase & { type: "thinking_level_change"; thinkingLevel: ThinkingLevel })
  | (EntryBase & { type: "custom"; customType: string; data: unknown })          // 不进上下文
  | (EntryBase & { type: "custom_message"; customType: string; content: string; display: boolean }) // 进上下文
  | (EntryBase & { type: "label"; targetId: string; label?: string })
  | (EntryBase & { type: "session_info"; name?: string });

export type AgentMessage =
  | { role: "system"; sections: Record<string, string | null>; toolsAdded?: ToolDecl[]; toolsRemoved?: string[]; timestamp: number }
  | { role: "user"; content: string | (TextBlock | ImageBlock)[]; origin?: "steer" | "followUp" | "host"; timestamp: number }
  | { role: "assistant"; content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
      provider: string; api: "anthropic-messages" | "openai-chat"; model: string;
      responseId?: string; usage: Usage; stopReason: "stop" | "toolUse" | "length" | "aborted" | "error";
      errorMessage?: string; timestamp: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: string | ContentBlock[];
      isError: boolean; details?: unknown; timestamp: number };

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
```

规矩：

- **只追加**。清理（`ama sessions prune`）按整文件删，不改写文件；删除前把文件移到 `<dataDir>/trash/` 保留 7 天。
- 上下文投影：从叶子回溯到根得到活动分支；遇到 `compaction` 用 `summary` 替换 `firstKeptEntryId` 之前的条目；`context_edit` 按「同一目标最新一条赢」应用；`custom` 与 `label` 不进上下文。
- 系统提示与工具表作为首条 `system` 消息落盘，之后的变化作为新的 `system` 消息补丁（`sections` 名字级替换，`null` 删除）；重放得到当前提示。宿主（Armadra 的历史适配器）因此可以不知道工具表也能渲染。
- `message.usage` / `message.model` / `message.responseId` 的位置与 Pi 一致，成本对账逐条读 assistant 消息。

分叉与分支：`fork(entryId)` 复制活动分支到新文件（`parentSession` 指回）；`/tree` 在**同一文件**内切换叶子，离开分支时可生成 `branch_summary` 挂到新叶子。

## §6 压缩与缓存

### §6.1 触发条件

`contextTokens` 用最近一条 assistant 的 `usage.input + cacheRead + cacheWrite` 加上之后新增条目的估算（字符数 / 4）。

| 档   | 条件                                                           | 动作                                                                                                                        | 成本     |
| ---- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------- |
| 一   | `contextTokens > 0.7 × (contextWindow − reserveTokens)`        | 对**最近两个用户回合之前**、长度 > 2 KiB 的 `toolResult` 写 `context_edit{ replacement: "[已裁剪：<tool> 输出 N 字节，全文 <path>]" }` | 无模型调用 |
| 二   | 裁剪后仍 `> contextWindow − reserveTokens`，或供应商返回上下文溢出错误 / `stopReason: "length"` | 从叶子向上累计到 `keepRecentTokens`（缺省 20k）找切点（只切在 user / assistant / custom_message，不切 toolResult），把切点之前投影成文本请模型按固定模板写摘要，追加 `compaction` | 一次模型调用 |

检查时机：每个 turn 的工具结果追加之后、下一次模型调用之前；新 prompt 之前；run 结束后的溢出恢复。

### §6.2 摘要模板

`## Goal / ## Constraints / ## Progress (Done · In Progress · Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context`，末尾附累计的 `readFiles` / `modifiedFiles`（从被摘要的工具调用里提取，并合并上一条 `compaction.details`）。摘要请求**关闭缓存写入**，`maxTokens` 上限 4 096。

### §6.3 熔断

| 条件                                                      | 动作                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------- |
| 同一 turn 内已做过一次档二                                 | 不再压缩，run 以 `error: context_exhausted` 结束                           |
| 连续两次摘要调用失败（网络 / 供应商错误）                 | 关闭本会话自动压缩，`agent_settled` 携带 `warning: compaction_failed`      |
| 压缩后估算仍 > 0.8 × contextWindow                        | 不重试模型调用，结束 run 并提示用户 `/compact <指示>` 或开新会话           |
| 模型无 `contextWindow`                                    | 自动压缩关闭，溢出错误直接上报                                             |

### §6.4 提示词缓存友好

- 系统提示装配顺序固定：`preamble → tools（按名排序）→ instructions（按传入顺序）→ skills 索引 → cwd`；不含时间、不含随机数。
- Anthropic：三个 `cache_control: ephemeral` 断点——system 块末、tools 末、倒数第二条 user 消息；OpenAI 兼容线依赖前缀缓存，只保证前缀不变。
- steer / followUp 只追加在末尾；工具表变化（宿主启用 / 禁用）作为 `system` 补丁落盘，但发给供应商的仍是完整重装后的提示——这会使前缀失效一次，文档如实说明。
- 档一裁剪改变历史中段，会让该点之后前缀失效；所以档一只在 70% 阈值触发，不做「随手裁」。

## §7 权限

### §7.1 管线（顺序不可调）

```text
tool_call ──▶ ① 拒绝规则 ──命中──▶ deny
              │
              ▼
           ② 危险命令识别（仅 bash）──命中──▶ 按模式最严处理：ask；无人值守 → deny
              │
              ▼
           ③ 模式：plan（只允许 read 类）／default（write、execute 问）／auto-edit（write 自动，execute 问）／full-auto（全自动）
              │
              ▼
           ④ 允许规则（只能把「问」变成「自动」，不能越过 ①②）
```

- 规则形状：`{ tool: "bash", pattern: "git push*" }`、`{ tool: "write", pathGlob: "src/**" }`；来源：`config.json`（用户级 / 项目级）与 `--allow` / `--deny`。
- 危险命令识别：`rm -rf` 指向 `/`、`~`、`.`、`*`；`sudo`、`su`；`dd`、`mkfs`、`> /dev/sd*`；`git push --force*`、`git reset --hard`、`git clean -fd*`；`curl|wget … | sh|bash`；`chmod -R 777`；`kill -9 -1`；`:(){ :|:& };:`。规则表在 `permissions/dangerous.ts`，每条配一个正例一个反例测试。
- `ask` 的实现：REPL 在终端问 `y / n / a（本会话允许同类）`；RPC 发 `permission_request` 事件等 `permission_response`；SDK 由 `permission.ask(request)` 回调决定；宿主适配器可 `setBroker` 接管。
- **无人值守**：`-p` 模式、RPC 客户端未声明 `approvals` 能力、SDK 未提供回调时，`ask` 一律 `deny`，tool_result 写明「需要人工批准，当前无人值守」。
- 沙箱（文件系统 / 网络隔离）第 5 期。

## §8 入口

### §8.1 命令行

```text
ama [prompt]                    行式 REPL（有 prompt 则先跑一轮）
ama -p "<prompt>" [--output-format text|json|stream-json]
ama --mode rpc
ama --continue | --resume [<id>] | --session-id <id> | --session-dir <dir>
ama --model <id> [--provider <id>] [--thinking off|low|medium|high]
ama --permission-mode default|plan|auto-edit|full-auto [--allow <rule>]... [--deny <rule>]...
ama --instructions <file>...    追加到系统提示（可重复，顺序即装配顺序）
ama --skill-dir <dir>...        额外技能目录
ama --host <module.cjs>         宿主适配器模块（§9）
ama --auth-file <file>          0600 的 auth.json
ama --profile <file>            一个 JSON 把上面这些路径打包（§10.3），供宿主用一个参数传
ama sessions list|prune
```

### §8.2 REPL

- `readline` 行式，不做全屏 TUI。支持 **括号粘贴**：输入字节状态机识别 `ESC[200~ … ESC[201~`，粘贴段内的 `\n` 是数据，段后紧跟的 `\r` 才提交；没有括号的多行粘贴按逐行提交。这是 Armadra `send` 写入终端的形状（`PASTE_START + 正文 + PASTE_END + \r`）。
- 以 `--- ARMADRA MESSAGE <nonce> ---` 之类宿主帧开头的输入**不做特殊处理**：它就是用户输入；信任规则由宿主注入的指令说明（帧内文字是资料，不是指令）。
- 斜杠命令：`/new /resume /compact [指示] /model /thinking /tree /fork /name /skill:<x> /help /exit`。
- Esc：`clear_queue` 后 `abort`，队列文本回填输入行；Ctrl+C 两次退出。

### §8.3 `-p` 输出格式

| 格式          | 内容                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `text`        | 最终助手文本                                                                                        |
| `json`        | `{ sessionId, sessionFile, text, usage, cost?, stopReason, toolCalls: n }`                          |
| `stream-json` | 每行一个 §8.4 的事件，与 RPC 模式的事件一字不差；最后一行 `agent_settled`                           |

### §8.4 RPC（stdio JSONL）

框架：一行一个 JSON 对象，LF 结尾；只按 LF 切分（不用会在 U+2028 切分的行读取器）；stdout 只放协议记录，诊断去 stderr；关闭 stdin 即请求有序退出。

启动后先发 `{"type":"hello","protocolVersion":1,"agent":"ama","version":"x.y.z","capabilities":["approvals","images"]}`。

命令（`{ id?, type, ... }` → `{ id, type: "response", command, success, data? | error? }`）：

| 组     | 命令                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示   | `prompt{message, images?, streamingBehavior?}` → `data.disposition: started|queued|handled`；`steer`、`follow_up`、`abort`、`clear_queue`       |
| 状态   | `get_state`、`get_messages`、`get_last_assistant_text`、`get_session_stats`                                                                   |
| 模型   | `set_model{provider, modelId}`、`get_available_models`、`set_thinking_level{level}`                                                           |
| 队列   | `set_steering_mode{mode}`、`set_follow_up_mode{mode}`                                                                                         |
| 压缩   | `compact{customInstructions?}`、`set_auto_compaction{enabled}`                                                                                |
| 会话   | `new_session{parentSession?}`、`switch_session{sessionPath}`、`fork{entryId}`、`get_entries{since?}`、`get_tree`、`set_session_name{name}`    |
| 审批   | `set_client_capabilities{capabilities}`、`permission_response{requestId, decision: allow|deny|allow_session}`                                  |
| 工具   | `get_tools`、`set_active_tools{names}`                                                                                                        |

事件（无 `id`）：`agent_start / turn_start / message_start / message_update{assistantMessageEvent} / message_end{message} / tool_execution_start|update|end / turn_end / agent_end{stopReason} / agent_settled / queue_update{steering, followUp} / compaction_start|end / retry_scheduled|retry_aborted / permission_request{requestId, toolName, input, reason} / permission_resolved / session_changed{sessionId, sessionFile} / model_changed`。

错误：`success: false, error: "<message>"`；JSON 解析失败回 `command: "parse"` 且无 `id`。

### §8.5 SDK

```ts
export function createAgentSession(options?: CreateSessionOptions): Promise<AgentSession>;

export interface CreateSessionOptions {
  cwd?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  auth?: AuthSource;                              // { kind: "file", path } | { kind: "env" } | { kind: "inline", keys }
  sessionManager?: SessionManager;                // SessionManager.inMemory() | SessionManager.open(file) | SessionManager.create(dir, cwd)
  tools?: "default" | "none" | ToolDefinition[];
  instructions?: InstructionSource[];             // { kind: "file", path } | { kind: "text", text }
  skillDirs?: string[];
  permission?: PermissionPolicy;                  // { mode, allow[], deny[], ask?(request): Promise<Decision> }
  host?: HostModule;                              // 等价于 --host，但直接传模块对象
}

export interface AgentSession {
  prompt(text: string, options?: { images?: ImageBlock[]; streamingBehavior?: "steer" | "followUp" }): Promise<PromptDisposition>;
  steer(text: string): Promise<"queued" | "handled">;
  followUp(text: string): Promise<"queued" | "handled">;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  clearQueue(): { steering: string[]; followUp: string[] };
  subscribe(listener: (event: SessionEvent) => void): () => void;
  compact(instructions?: string): Promise<CompactionResult>;
  fork(entryId: string): Promise<AgentSession>;
  readonly state: SessionState;                   // { isStreaming, isCompacting, model, sessionId, sessionFile, messageCount, pendingMessageCount }
  readonly messages: readonly AgentMessage[];
  getLastAssistantText(): string | null;
  dispose(): void;
}
```

`prompt()` 在 run 结束（含自动重试与 followUp）后 resolve；运行中不带 `streamingBehavior` 调用 reject。

## §9 宿主适配器扩展点

### §9.1 加载

`--host <path>`（或 SDK `host`）指向一个 CJS / ESM 模块，缺省导出 `HostModule`。一个进程只装一个适配器；在 `session_start` 之前加载；`hostApi` 不等于本版 `HOST_API_VERSION` 时**拒绝启动**（退出码 78，stderr 一句话）。`create()` 返回 `undefined` 表示本次不激活（例如宿主的环境变量不在），进程照常以独立模式运行。

### §9.2 契约（`@armadra/agent/host`）

```ts
export const HOST_API_VERSION = 1 as const;

export interface HostModule {
  readonly hostApi: typeof HOST_API_VERSION;
  create(api: HostApi): HostAdapter | undefined | Promise<HostAdapter | undefined>;
}

export interface HostAdapter {
  readonly id: string;                               // 例如 "armadra"
  dispose?(): void | Promise<void>;                  // session_shutdown 后调用，幂等
}

export interface HostApi {
  readonly version: typeof HOST_API_VERSION;
  readonly agent: { readonly name: "ama"; readonly version: string };
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly session: {
    id(): string;
    file(): string | undefined;
    cwd(): string;
    model(): { provider: string; id: string } | undefined;
  };
  readonly tools: {
    register(tool: ToolDefinition): void;            // 同名已存在则抛错
    disable(name: string): void;                     // 隐藏内置工具（如 task）
    list(): readonly string[];
  };
  readonly instructions: {
    add(source: InstructionSource): void;            // 追加到系统提示末尾（在 --instructions 之后）
  };
  readonly events: {
    on<E extends keyof AgentEvents>(name: E, handler: (event: AgentEvents[E]) => void | Promise<void>): () => void;
  };
  readonly approvals: {
    setBroker(broker: ApprovalBroker): void;         // 接管 ask；返回 undefined 表示交回默认处理
  };
  readonly messages: {
    sendUser(text: string, origin?: string): Promise<"started" | "queued">; // 以 user 消息注入（运行中按 steer 入队）
  };
  readonly log: (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => void;
}

export interface ApprovalBroker {
  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | undefined>;
}
export interface ApprovalRequest { requestId: string; toolName: string; input: unknown; reason: "mode" | "dangerous"; }
export type ApprovalDecision = "allow" | "deny" | "allow_session";

/** 事件名与 Pi 扩展事件一致；载荷只含下列字段。 */
export interface AgentEvents {
  session_start: { sessionId: string; sessionFile?: string; cwd: string };
  before_agent_start: { prompt: string };
  agent_start: {};
  turn_start: {};
  tool_call: { toolCallId: string; toolName: string; input: unknown };
  tool_result: { toolCallId: string; toolName: string; isError: boolean };
  turn_end: {};
  agent_end: { stopReason: string };
  agent_settled: { warning?: string };
  session_compact: { tokensBefore: number };
  model_select: { model: { id: string; provider: string } };
  tool_approval_requested: { requestId: string; toolName: string };
  tool_approval_resolved: { requestId: string; decision: ApprovalDecision };
  session_shutdown: {};
}
```

### §9.3 规矩

- 事件处理器**只观察**：抛错被记日志、不影响循环；`session_shutdown` 的处理器被 await，其余 fire-and-forget（与宿主上报「不得阻塞一轮」一致）。
- 工具执行的权限判定仍走 §7 管线，适配器注册的工具按 `permission` 分类受同样约束；适配器不能绕过拒绝规则。
- `HostApi` 的增字段是次版本，改语义 / 删字段是主版本并 bump `HOST_API_VERSION`；类型随 npm 包发布，宿主在 CI 里对着自己锁定的版本 typecheck。

## §10 配置与密钥

### §10.1 `config.json`（用户级 `~/.config/ama/`，项目级 `.ama/`，后者覆盖前者）

```json
{
  "version": 1,
  "defaultModel": { "provider": "anthropic", "id": "<model id>" },
  "thinkingLevel": "medium",
  "models": [ { "id": "...", "provider": "anthropic", "api": "anthropic-messages", "baseUrl": "https://api.anthropic.com", "contextWindow": 200000, "maxTokens": 16384 } ],
  "providers": { "anthropic": { "api": "anthropic-messages", "baseUrl": "..." }, "local": { "api": "openai-chat", "baseUrl": "http://127.0.0.1:8080/v1" } },
  "permission": { "mode": "default", "allow": [], "deny": [] },
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "skills": { "dirs": [] }
}
```

### §10.2 `auth.json`（0600）

```json
{ "version": 1, "providers": { "anthropic": { "apiKey": "..." }, "local": { "apiKey": "..." } } }
```

独立模式：`ama auth set <provider>` 从 stdin 读键写入（不接受命令行参数，避免进 shell 历史）。嵌入模式：宿主把它存在自己的密钥库里，启动前写一份 0600 文件并以 `--auth-file` 传路径；本仓库不知道宿主的密钥库。

### §10.3 `profile.json`（宿主用）

```json
{ "version": 1, "host": "<abs path>/ama-armadra.cjs", "instructions": ["<abs>/instructions.md"],
  "skillDirs": ["<abs>/skills"], "authFile": "<abs>/auth.json", "sessionDir": "<abs>/sessions",
  "config": "<abs>/config.json" }
```

存在的理由：宿主把启动行打进 shell 时有长度上限（Armadra 实测约 1 KB），六个绝对路径放不下；一个 `--profile <path>` 就够。`profile.json` 不含密钥，可以是确定性生成的产物。

## §11 分发产物

| 产物                                  | 构建                                                                                    | 用途                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| npm 包 `@armadra/agent`（ESM + `.d.ts`） | `tsc -p tsconfig.build.json` → `dist/`；`bin.ama = dist/cli.js`                         | 独立用户 `npm i -g @armadra/agent`；SDK；宿主拿类型          |
| `dist/bundle/ama.cjs`                 | `scripts/build-bundle.mjs`（esbuild，`platform: node`，`format: cjs`，`target: node22`，全部依赖内联，无原生模块） | 宿主随包携带，用任意 Node ≥ 22 兼容运行器启动（Electron 的 `ELECTRON_RUN_AS_NODE=1`、服务器壳的 `node`） |
| `bun compile` 二进制                  | 第 5 期                                                                                 | 无 Node 的机器                                              |

硬约束：**无原生依赖**（没有 node-pty、sqlite 绑定），这是单文件能被 Electron 当 Node 跑的前提。

Windows：支持；`bash` 工具按 §4.2 回退；路径一律 `path` 处理；REPL 用 `readline` 不依赖 PTY。CI 的 Windows 行跑单测与 `-p` 冒烟。

发布：推 `v*` 标签 → CI 跑全部测试 → `npm publish --access public`（scoped 包必须显式公开）→ GitHub Release 附 `ama.cjs` 与 `SHA256SUMS`。版本语义：`HOST_API_VERSION` 变 → 主版本；RPC `protocolVersion` 变 → 主版本；其余按 semver。

## §12 测试策略

| 层                 | 方法                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 供应商解析         | 录制的 SSE 片段（两条协议线）→ 内部事件序列黄金文件                                                                                    |
| 循环               | **脚本化供应商**（`test/fixtures/scripts/*.json`：第 n 次调用返回什么、何时抛 429）驱动完整 run；断言 abort 补 result、steer 投递点、followUp 时机 |
| 会话               | JSONL 样本 ↔ 投影结果；fork / tree / prune；与 Armadra `history/pi.ts` 共用一份 fixture 的字段子集                                      |
| 压缩               | 构造超限会话，断言档一只改旧工具结果、档二切点合法、熔断条件各触发一次                                                                 |
| 权限               | 危险命令表每条正反例；四种模式 × 三类工具的真值表；无人值守 → deny                                                                     |
| REPL 输入          | 直接喂字节到输入状态机：括号粘贴含 `\n`、无括号多行、Esc 清队列                                                                        |
| RPC                | 黄金记录：每条命令的请求 / 响应 / 事件序列字节比对；JSONL 切分含 U+2028                                                                |
| 宿主 API           | 一个测试用适配器：注册工具、订阅全部事件、接管审批；版本不匹配拒绝启动                                                                 |
| 端到端（可选）     | `AMA_E2E_PROVIDER=…` 才跑的真模型用例，CI 不跑                                                                                         |

工具：vitest 4（`pool: "forks"`，有真子进程）、prettier 检查、`tsc --noEmit`、源码扫描（无宿主 import、无原生依赖）。

## §13 分期与 MVP

| 期   | 交付物                                                                                                                                                          | 验收                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | 仓库骨架、构建（tsc + esbuild bundle）、两条协议线流式与工具调用、线性 JSONL 落盘、脚本化供应商测试框架                                                          | `ama -p "say hi"` 对两条线各跑通；bundle 能以 `node dist/bundle/ama.cjs -p` 运行                                                                        |
| 1    | **独立 MVP**：循环（abort / steer / followUp）、六个内置工具、权限管线（含危险命令）、REPL（括号粘贴）、`-p` 三格式、`config.json` / `auth.json`、npm 0.1.0  | §12 的循环、权限、REPL 测试全绿；真模型手测：读改一个文件、一次 Esc 中断后继续对话                                                                     |
| 2    | **宿主接入**：`HostApi` v1、`--host` / `--profile` / `--instructions` / `--auth-file` / `--skill-dir`、事件总线（§9.2 词汇）、审批代理、`task` 可禁用；冻结 `HOST_API_VERSION = 1` | 测试适配器收齐全部事件；Armadra 文档 B 第 1 期的 agent-e2e 场景 11 跑通                                                                                 |
| 3    | 会话树：fork / `/tree` / 分支摘要 / prune；两档压缩与熔断；缓存断点；`get_entries` / `get_tree`                                                                 | 压缩测试全绿；长会话（> 窗口 2 倍）在脚本化供应商下自动压缩且不循环                                                                                    |
| 4    | `--mode rpc` 全命令、SDK 公开 API、Skill 渐进披露、`task` 子 Agent、Windows 收尾、`ama.cjs` 随 Release 发布                                                      | RPC 黄金记录全绿；Windows CI 绿；一个外部脚本仅凭 `docs/rpc.md` 写出的客户端能跑通 prompt → agent_settled                                               |
| 5    | 后置：Responses 协议线、ACP、沙箱、`bun compile`                                                                                                                 | 另立设计                                                                                                                                               |

MVP = 第 0–2 期（独立可用 + Armadra 能嵌入）。第 3 期之前，会话仍是线性追加、无压缩——长会话会撞窗口，REPL 提示 `/new`。

## §14 风险与待定项

| #   | 风险 / 待定                                                                                                 | 处置                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R1  | OpenAI 兼容线各家对流式 `tool_calls` 增量、`usage` 字段的差异                                               | 第 0 期先对两家真实端点录 SSE 样本；差异收敛在 `ai/openai-chat.ts` 一处                                            |
| R2  | 宿主要求「不阻塞一轮」与审批代理需要等待之间的矛盾                                                          | 审批是**工具执行前**的等待，不是事件处理器；有超时（宿主可配，缺省 10 分钟），超时按 deny                          |
| R3  | 档一裁剪让缓存前缀失效                                                                                      | 只在 70% 阈值触发；文档明说这是一次性成本                                                                         |
| R4  | `@armadra` npm 作用域是否已归用户所有                                                                       | 第 0 期先 `npm org` 核实；拿不到就退回无作用域名并在本文记录                                                      |
| R5  | 括号粘贴在不同终端 / tmux 下的转义差异                                                                      | 状态机只认 `ESC[200~` / `ESC[201~`；tmux 透传实测在 Armadra 的 e2e 里覆盖                                          |
| R6  | 独立模式用户期待「协调别的 CLI」                                                                            | README 明确边界（§0 D11）：独立模式只有 `task`；要编排去 Armadra                                                   |
| 待定 | 模型表的缺省条目与成本单价由谁维护；`thinking` 在 OpenAI 兼容线的映射；`task` 子 Agent 是否继承父会话的 steer | 第 1 期前定                                                                                                       |
