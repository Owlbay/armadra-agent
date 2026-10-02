# 会话文件格式（JSONL 条目树）

会话是一个只追加的 JSONL 文件：首行是头，其后每行一个条目（以及可选的 `leaf` 行）。条目经 `parentId` 连成树，「当前分支」是从根到叶子的一条路径；发给模型的上下文由当前分支**投影**得到。类型定义在 `src/session/types.ts`（经 `@armadra/agent` 导出），格式版本 `SESSION_FORMAT_VERSION = 1`。设计依据见 [design.md](design.md) §8、§9。

## 位置与文件

- 目录：`--session-dir` > profile `sessionDir` > `<数据目录>/sessions`（数据目录缺省 `~/.local/share/ama`，`AMA_DATA_DIR` 可改）。
- 文件：`<sessions>/<编码 cwd>/<ISO 时间>_<uuid>.jsonl`。编码 cwd = 去掉开头的分隔符，`/`、`\`、`:` 换成 `-`；ISO 时间里的 `:` 与 `.` 也换成 `-`。文件名里的 uuid 就是会话 id。
- 延迟落盘：新会话先在内存里，首次模型请求前才建文件、写头与已缓存的条目；之前退出不留文件。
- 只追加：每条记录一行 JSON + LF，以 O_APPEND 写入。打开时若末行是半行（写入中途崩溃），截掉半行再继续；中间行损坏 → 拒绝打开（`session_corrupt`，退出码 5），不猜测、不重写文件。
- 单写者锁：`<file>.lock`（O_EXCL 创建，内容为 pid）；持锁进程已不在时视为陈旧锁并接管。
- `ama sessions prune [--older-than <天>]`（缺省 30 天）把文件移到 `<sessions>/.trash/`，文件名前缀删除时间；trash 里超过 7 天的再清理。

## 头

```json
{
  "type": "session",
  "version": 1,
  "id": "0b7f…",
  "timestamp": "2026-10-02T08:00:00.000Z",
  "cwd": "/home/me/proj",
  "agent": { "name": "ama", "version": "0.1.0" },
  "parentSession": "/…/上一个会话.jsonl"
}
```

`parentSession` 只在 fork 与 `task` 子会话里出现，指向来源文件。读取时 `version` 不是 1 → 拒绝并提示升级 ama；缺头、头损坏、条目缺 `id` 或 `type`、出现第二个头 → 拒绝。

## 条目

全部条目都有 `id`、`parentId`（根条目为 `null`）、`timestamp`（ISO 8601）。

| `type`                  | 字段                                                                                                               | 进上下文                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `message`               | `message`：`system` / `user` / `assistant` / `toolResult` 四种 LLM 消息                                            | 是                           |
| `compaction`            | `summary`、`firstKeptEntryId`、`tokensBefore`、`usage?`、`details?`（`readFiles` / `modifiedFiles`）               | 是，作为摘要消息             |
| `branch_summary`        | `fromId`、`summary`、`usage?`、`details?`                                                                          | 是，作为分支摘要消息         |
| `context_edit`          | `targetId`、`replacement: string \| null`、`reason: prune \| abort \| retry \| overflow \| manual \| image_budget` | 改写目标条目                 |
| `model_change`          | `provider`、`modelId`、可选 `channel`（多渠道供应商的渠道名）                                                      | 否（决定续会话时的模型）     |
| `thinking_level_change` | `thinkingLevel`                                                                                                    | 否（决定续会话时的思考级别） |
| `custom`                | `customType`、`data`                                                                                               | 否                           |
| `custom_message`        | `customType`、`content`（字符串或内容块）、`display`、`details?`                                                   | 是，作为 custom 消息         |
| `label`                 | `targetId`、`label?`（缺省 = 清除标签）                                                                            | 否                           |
| `session_info`          | `name?`                                                                                                            | 否                           |
| `usage`                 | `kind`、`provider`、`model`（不含 provider 的模型 id）、`usage`                                                    | 否                           |

### 消息

- `system`：`{ role: "system", sections, toolsAdded?, toolsRemoved?, timestamp }`。首条是全量：系统提示的命名节（固定顺序 `preamble → tools → rules → project_context → skills → hooks → cwd → host`）与工具声明表；之后只落**补丁**——节名级替换、值为 `null` 表示删除该节，`toolsAdded` / `toolsRemoved` 增删工具。依次重放得到当前系统提示；请求时由协议层重装全量。首条 system 消息在首次请求前落盘，也就是建文件的时刻。
- `user`：`content`、`origin?`（缺省 = 普通用户输入；`steer` / `followUp` 是运行中插话与排队，`host` 是宿主 `sendUser` 注入，其它字符串原样记录）。
- `assistant`：`content`（文本 / 思考 / 工具调用块）、`api`、`provider`、`model`、`usage`、`stopReason`，以及可选的 `responseId`、`thinkingLevel`、`providerThinkingLevel`、`rawStopReason`、`errorMessage`。`usage` 是 `{ input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost?, cacheReported? }`：`input` 不含缓存部分，`cost` 是 `{ input, output, cacheRead, cacheWrite, total }`（美元，模型无价格时缺省），`cacheReported` 表示原始响应里出现过缓存字段。
- `toolResult`：对应工具调用的结果（`toolCallId`、`toolName`、`content`、`isError`、`details?`）。

### `usage` 条目

不进上下文的请求用量，计入 `/session` 费用与 RPC 统计，投影时跳过。`kind` 目前有 `"cache_warm"`（缓存保温请求，见 [providers.md](providers.md)「缓存」）与 `"permission_classify"`（auto 权限模式的分类请求，见 [permissions.md](permissions.md)）：

```json
{
  "type": "usage",
  "kind": "cache_warm",
  "provider": "anthropic",
  "model": "<model-id>",
  "usage": {
    "input": 1,
    "output": 1,
    "cacheRead": 12000,
    "cacheWrite": 0,
    "totalTokens": 12002,
    "cost": { "input": 0, "output": 0, "cacheRead": 0.0036, "cacheWrite": 0, "total": 0.0036 }
  },
  "id": "…",
  "parentId": "…",
  "timestamp": "…"
}
```

### `leaf` 行

`/tree` 在同一文件里换叶子时追加一行 `{"type":"leaf","id":<条目 id 或 null>,"timestamp":…}`。它**不是条目**：没有 `parentId`，`get_entries` 与树不返回它，fork 不复制它。打开文件时，最后一条 `leaf` 行若在最后一条条目之后，就用它的 `id` 作叶子（`null` = 回到根之前的空分支）；之后又追加了条目则作废。

`usage` 条目与 `leaf` 行都是 v1 的可选行，格式版本不升。

## 投影

当前分支 → 上下文消息（`src/session/projection.ts`）：

1. **压缩**：分支上若有 `compaction`，取最新一条。上下文 = 该 compaction（作为摘要消息）+ `firstKeptEntryId` 到它之间的非 system 条目 + 它之后的全部条目。compaction 之前的 system 消息依次重放后折成一条完整的 system **检查点**放在最前（文件里不另存检查点）。
2. **改写**：对分支上每个目标取最新一条 `context_edit`：`replacement` 为 `null` → 从上下文剔除；字符串 → 只换内容，保留角色与元数据（assistant 换成一个文本块，摘要类换 `summary`，system 不改）。用途：档一裁剪旧工具结果（`prune`）、中断（`abort`）、失败重试的尝试（`retry`）、溢出恢复（`overflow`）、手动（`manual`）、单请求图片总量超预算时把最旧的图换成占位文本（`image_budget`，第五波 W5-I）。
3. **映射**：`message` → 原消息；`custom_message` → `{ role: "custom", customType, content, display, details? }`；`compaction` → `{ role: "compactionSummary", summary, tokensBefore }`；`branch_summary` → `{ role: "branchSummary", summary, fromId }`；其余类型（含 `usage` 与未知类型）不进上下文。
4. **模型与思考级别**：分支上最近的 `model_change` / `thinking_level_change`，续会话时据此恢复。

发给模型前，`convertToLlm` 把三种扩展角色（custom、compactionSummary、branchSummary）转成 user 消息。

## 分支与 fork

- `/tree`：同一文件换叶子（落 `leaf` 行）；从旧位置再发消息就形成新分支。离开的分支可以写 `branch_summary` 带进新分支。
- fork（`--fork <id>`、`/fork`、RPC `fork`）：把根 → 指定条目的分支复制到新文件，头的 `parentSession` 指回原文件；不复制 `leaf` 行。
- `task` 子会话：独立文件，头带 `parentSession`，首条条目是 `custom{customType:"ama.task"}`。

## custom 类型

`custom` 不进上下文，`custom_message` 进上下文。ama 自己使用的 `customType`：

| `customType`         | 条目类型         | 内容                                                                                           | 写入时机                                                                           |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ama.todo`           | `custom`         | `data: { items: { id, text, status: pending \| in_progress \| done, planStep? }[] }`，整表快照 | `todo` 工具 `set` / `update`、计划获批时由步骤生成（W5-F）；`get` 取分支上最近一条 |
| `ama.task`           | `custom`         | `data: { parentToolCallId, description, parentSession? }`；第五波见表后说明                    | `task` 子会话的首条条目；第五波起父会话也写                                        |
| `ama.codemode-store` | `custom`         | `data: { entries }`，`store()` 的完整快照                                                      | codemode 脚本成功结束且写过 store；读取取分支上最近一条                            |
| `ama.aborted`        | `custom_message` | `content`：告诉模型上一条回复被用户中断；`display: false`                                      | 用户中断运行                                                                       |
| `ama.hook_context`   | `custom_message` | `content`：UserPromptSubmit Hook 的 `additionalContext`；`display: false`                      | 随用户提示进上下文                                                                 |
| `ama.rewind-note`    | `custom_message` | `content`：回滚后哪些文件与对话不一致（最多列 20 个）；`display: false`                        | 仅对话 / 仅代码回滚后，下一次提示之前追加在末尾                                    |

`ama.task`（第五波 W5-G）：子会话首条的 `data` 另带 `taskId`、`agent`；父会话在任务开始、每次续聊与结束时各写一条，
`data` = `TaskInfo`（`taskId, agent, runner, description, background, status, startedAt, endedAt?, turns?, usage?, costUsd?,
outputFile?, sessionRef?`）+ `parentToolCallId`、`cwd`。同一 `taskId` 取分支上最后一条；resume 时据此重建任务注册表，
`status: "running"` 视为 `interrupted`（`taskId` 续聊重开 `sessionRef.sessionFile`）。没有 `status` 的是子会话自己的首条。

第五波登记的类型（docs/wave5-plan.md；括号里是开始写入的批次，之前的版本不会产生，读到未知 `customType` 一律忽略）。`custom_message` 类都是 `display: false`，经扩展点 `beforePrompts` 追加在末尾，不改缓存前缀：

| `customType`         | 条目类型         | 内容                                                                                                                                     | 写入时机                                                                                                                        |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ama.plan`           | `custom`         | `data: PlanData`：`{ id, version, status: proposed \| approved \| rejected \| superseded, markdown, steps[], sourceEntryId, filePath? }` | 根会话在 plan 下一回合以纯文本结束、回复里有 `<proposed_plan>` 时；审批结果（approved / rejected / superseded）另记一条（W5-F） |
| `ama.plan_state`     | `custom`         | `data: { active, prePlanMode, planId?, executionModel?, executionThinking? }`（后两项：`plan.model` 切走的执行模型）                     | 进入 / 退出 plan 模式；resume 时据此回到 plan（W5-F）                                                                           |
| `ama.plan_mode`      | `custom_message` | `content`：plan 模式说明（完整版或简版）                                                                                                 | 进入 plan 后的首个提示前，之后每 5 回合简版、压缩后补完整版（W5-F）                                                             |
| `ama.plan_mode_exit` | `custom_message` | `content`：已退出 plan 模式                                                                                                              | 手动退出 plan 后的下一次提示前（获批时由 `ama.plan_approved` 说明，不另发）（W5-F）                                             |
| `ama.plan_approved`  | `custom_message` | `content`：获批计划全文、文件路径与进度记法（有 todo 工具时「按 todo 推进」，没有时「每完成一步单独一行写 `[DONE:<步骤>]`」）            | 计划获批交接时（W5-F）                                                                                                          |
| `ama.post_compact`   | （不单独成条）   | 回注改为 `compaction.summary` 末尾的 `<post-compact-state>` 块（清单与指针，不含正文；见 `compaction/post-compact.ts`）                  | 写 compaction 条目时（W5-H1），模型看到「摘要 → 回注 → 保留区」                                                                 |
| `ama.reminder`       | `custom_message` | `content`：提醒（todo 复述、外部文件改动、上下文用量、预算余量、后台命令退出），`<system-reminder>` 包起来                               | 新提示之前按 `reminders.*` 追加（W5-H2）；run 进行中的提醒不单独成条，追加在工具批次最后一条 toolResult 的末尾                  |
| `ama.agent-session`  | `custom`         | `data: { agent, runner, sessionId, cwd?, taskId? }`：外部 Agent 自己的会话引用（不含原始事件与转录）                                     | 外部 Agent 会话建立 / 续聊时（W5-E）                                                                                            |
| `ama.agent-usage`    | `custom`         | `data: { agent, sessionId, unit: usd \| tokens \| requests, amount, tokens? }`                                                           | 外部 Agent 每个回合结束（W5-E）；`SessionStats.external` 据此汇总                                                               |

其它程序（宿主、SDK 工具经 `ToolContext.session.appendCustom`）可以写自己的 `customType`；建议加前缀避免冲突，`ama.` 前缀保留给 ama。

## 读取方

- `ama sessions list|show`、交互模式 `/resume`、RPC `get_entries{since}`（以 entry id 为游标返回 `{ entries, leafId }`）、`get_tree`。
- 只读扫描（不加锁、不修复）：`ama stats`、`ama sessions search|export`、`--from`，见 [sessions.md](sessions.md)。
- 嵌入方可以直接读文件：按行解析，首行为头，跳过 `type: "leaf"` 的行后按 `parentId` 建树；遇到不认识的条目类型保留但不进上下文。
