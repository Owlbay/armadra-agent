# 检查点与回滚：设计与实施计划

> 状态：实施设计（2026-10-02）。基线：`main` = `95c0435`（0.4.0）。
> 设计依据：`docs/design.md` §8 会话树、§9 压缩、§9.1 缓存保证、§13 SDK / RPC；对照同类终端 Agent 的检查点实现（只借鉴行为与边界，不复制代码）。
> 路径相对仓库根；`[RW-x]` 为本计划的批次编号（§6）。

## §0 结论

| #   | 决定                                                                                                                                                                         | 理由                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D1  | 回滚 = 「对话」与「代码」两件事，入口 `/rewind` 与空闲时双击 Esc；选项：对话 + 代码 / 仅对话 / 仅代码 / 从这里摘要 / 摘要到这里 / 取消                                       | 两者独立才能覆盖「代码写坏了但对话想留」「对话跑偏了但代码要留」 |
| D2  | 检查点粒度 = 开启新回合的用户消息；运行中插话（steer）与排队消息并入当前回合，不单独建                                                                                       | 回合是用户能理解的最小单位                                       |
| D3  | 代码跟踪 edit / write（含 codemode 内层调用、task 子会话）改过的文件；每次发新回合按**当前磁盘状态**重拍已跟踪文件，所以 bash 或手动对已跟踪文件的改动也会被收进下一个检查点 | bash 任意改动不可完整追踪；已跟踪文件这样处理就不会漏            |
| D4  | 备份按内容 sha256 存全局目录，多会话、多检查点共用；会话文件只记哈希                                                                                                         | 同内容只存一份；fork 不用迁移备份                                |
| D5  | 恢复前做冲突检测：磁盘内容既不等于 ama 最后写入的、也不等于最近检查点的 → 冲突，缺省跳过并列出，`onConflict: "overwrite"` 才覆盖                                             | 不冲掉用户在回合外的手动修改                                     |
| D6  | git 状态不动；检查点记 HEAD，回滚时 HEAD 变了只提示并给命令                                                                                                                  | `reset` 类操作风险高，交给用户                                   |
| D7  | 对话回滚复用会话树（`navigate` 换叶子），被离开的分支留在文件里                                                                                                              | 现有能力，零迁移                                                 |
| D8  | 回滚后上下文只发新路径，前缀逐字节不变，缓存照常命中；需要告诉模型的事（文件与对话不一致）以 `custom_message` 追加在末尾                                                     | §9.1 前缀稳定                                                    |
| D9  | `影子 git` 模式（能覆盖 bash 改动）作为可选 `checkpoints.mode: "shadow-git"`，缺省关，最后一批做                                                                             | 大仓库慢、依赖 git，不适合作缺省                                 |

## §1 数据模型

### §1.1 备份存储

- 目录：`<dataDir>/file-history/blobs/<sha256 前 2 位>/<sha256 全长>`，内容为文件原字节（不压缩、不改换行与 BOM）；先写 `<name>.tmp-<pid>` 再 rename，已存在即跳过。
- 不备份：超过 `checkpoints.maxFileBytes`（缺省 5 MiB）的文件、非普通文件。记录里标 `skipped: "too_large" | "not_regular"`，回滚时报告「无法恢复」。
- 内存会话（无会话文件）不建检查点，`/rewind` 只提供「仅对话」。

### §1.2 会话条目（均为 `custom`，不进上下文，不影响前缀）

```ts
// customType "ama.checkpoint"：新回合的用户消息条目追加之后立即追加
interface CheckpointData {
  v: 1;
  userEntryId: string; // 这个检查点属于哪条用户消息（「这条消息发出前」的状态）
  files: Record<string, FileRecord>; // 全部已跟踪文件；键 = cwd 内相对路径（/ 分隔），cwd 外为绝对路径
  git?: { head: string; branch?: string }; // 直接读 .git/HEAD（含 worktree 的 gitdir 文件），不起 git 进程
}

// customType "ama.checkpoint-track"：回合中途第一次碰某文件时追加，补进本回合的检查点
interface CheckpointTrackData {
  v: 1;
  userEntryId: string;
  path: string;
  record: FileRecord;
}

interface FileRecord {
  blob: string | null; // sha256；null = 当时文件不存在（回滚时删除）
  mode?: number; // 普通文件的权限位
  size?: number;
  realParentDir?: string; // 记录时父目录的 realpath（恢复时校验没被移动）
  skipped?: "too_large" | "not_regular";
}
```

- 读取：按文件顺序重放全会话（不限活动分支）的两类条目，得到 `Map<userEntryId, CheckpointData>`；`checkpoint-track` 并入对应检查点。
- 每个文件的第一条记录（最早的 `blob`）永久保留，作为「找不到更近记录时」的回退。

### §1.3 运行时状态（`src/checkpoints/tracker.ts`）

- `trackedFiles: Set<string>`、最近检查点、`lastWritten: Map<路径, sha256>`（ama 最后一次写入后的内容哈希，用于冲突检测；只在内存，恢复会话后以最近检查点为准）。
- 检查点上限 `checkpoints.keep`（缺省 100）：超出时较早检查点不再列为回滚点；备份由 GC 清理（§1.4）。

### §1.4 清理

- `ama sessions prune` 与删除会话时：标记 —— 扫描所有会话文件里的 `ama.checkpoint*` 引用；清除 —— 删除未被引用且 mtime 超过 1 天的 blob。
- `ama doctor` 显示 file-history 占用。

## §2 时机

| 时机                                                                    | 动作                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新回合用户消息落盘后（`runPrompt`，steer / 排队并入的不算）             | 对每个已跟踪文件：lstat → 不存在记 `null`；size / mode 与上一条记录一致且 mtime 不晚于记录时间 → 沿用；否则读内容算 sha256，等于上一条则沿用，不等则写 blob。追加 `ama.checkpoint` |
| edit / write 写文件**之前**（`ctx.checkpoint?.beforeWrite(abs)`）       | 文件在任何检查点里都没出现过 → 备份当前内容（不存在记 `null`），追加 `ama.checkpoint-track`，加入 `trackedFiles`；出现过则什么都不做                                               |
| edit / write 写文件**之后**（`ctx.checkpoint?.afterWrite(abs, bytes)`） | 记 `lastWritten`                                                                                                                                                                   |
| task 子会话                                                             | 子会话的 `ctx.checkpoint` 指向父会话的 tracker，记到父会话当前回合                                                                                                                 |
| codemode 内层调用                                                       | 走同一工具上下文，天然覆盖                                                                                                                                                         |

`beforeWrite` 失败（磁盘满、权限）只记 warn，不阻止写入（与对照实现一致：检查点是辅助，不能让编辑失败）。

## §3 回滚

### §3.1 API（`AgentSession`，SDK 同名，RPC 见 §5）

类型见 `src/checkpoints/types.ts`（`RewindPoint`、`RewindRequest`、`RewindResult`、`CodeRestoreResult`）：

```ts
rewindPoints(): RewindPoint[];               // 活动路径上的新回合用户消息，从旧到新
rewind(request: RewindRequest): Promise<RewindResult>;
```

`dryRun` 的 `code` 字段给出将恢复的文件与 `insertions / deletions`，界面的每行统计与确认预览都用它（懒计算，只对选中项）。

- 运行中调用抛 `AmaError("busy")`。全部失败且无一恢复 → `AmaError("rewind_failed", "没有文件被恢复…")`。

### §3.2 恢复代码（`src/checkpoints/restore.ts`）

对每个已跟踪文件，取目标检查点里的记录，没有则取该文件最早的记录：

1. 记录 `skipped` → 报告 `too_large` / `not_regular`。
2. 当前内容与记录相同 → 跳过（不计入）。
3. 冲突检测：当前 sha256 ∉ {`lastWritten`，最近检查点的记录} → 冲突；`skip` 时列入 `conflicts` 不动。
4. 安全检查（不通过 → `skipped`）：目标是符号链接 / 非普通文件 / `nlink > 1`；父目录 realpath ≠ `realParentDir`。
5. `blob: null` → 删除文件（只删普通文件）。
6. 否则写回：Windows 以外用 `O_NOFOLLOW` 打开目标，`fstat` 与路径 `lstat` 的 dev / ino 一致才写；清空后写入 blob 内容，恢复 `mode`；目标不存在时按需创建父目录（再次校验父目录）。
7. 被恢复 / 删除的文件从 `readFiles` 移除（模型再改前必须重新 read）。

`dryRun` 只做 1–4 并用行级 diff 计 `insertions / deletions`（复用 `tools/edit` 的 diff 实现）。

### §3.3 回滚对话（`src/agent/session-rewind.ts`）

1. `navigate(userEntry.parentId)`（已有：换叶子、重载消息、`cache.onContextChanged()`）。
2. `readFiles` 按新路径重算：路径上成功的 read 工具调用的绝对路径（不跨分支保留）。
3. 返回 `draft`：原消息文本与图片，交互界面回填输入框。
4. 模型、思考级别、权限模式保持当前（文档写明）。

### §3.4 文件与对话不一致时告诉模型

- 仅对话：若有已跟踪文件当前内容 ≠ 目标检查点 → 下一次提示前追加 `custom_message{customType:"ama.rewind-note"}`：「回滚到较早的对话，但以下文件保留了之后的修改：…（最多 20 个，其余计数）」。
- 仅代码：追加「以下文件已恢复到第 N 条消息之前的状态：…」。
- 对话 + 代码：两边一致，不追加。
- 该条目在回滚落点之后、下一条用户消息之前，只追加在末尾，不改前缀。

### §3.5 摘要两项

- 「从这里摘要」= `navigate(parentId, { summarize: true })`（已有 `branch_summary`，走会话前缀续写），并回填原消息。
- 「摘要到这里」= 以所选用户消息为切点做一次档二压缩（`compaction` 条目的 `firstKeptEntryId` = 该消息），之后的消息原样保留，停在末尾。可附说明（`instructions`）。

### §3.6 中断即撤回

运行中 Esc 中断，且本回合还没有任何 assistant 文本 / 工具调用、输入框为空 → 自动 `rewind(当前回合, "conversation")` 并回填原消息（配置 `ui.restoreOnCancel`，缺省 true）。

## §4 交互

- 空闲且输入框为空：双击 Esc（间隔 ≤ 800 ms，第一次提示「再按 Esc 回滚」）打开回滚列表；输入框有字：双击 Esc 清空输入并存进输入历史（↑ 可取回），第一次提示「再按 Esc 清空」。运行中 Esc 仍为中断。
- 列表：活动路径上的用户消息，最近在下、缺省选中最后一条；高亮行右侧显示 `N 文件 +x −y` / `无代码改动`（对高亮项做 dryRun，结果缓存）。
- 选中后：确认面板（左竖条样式，复用 `/session` 面板），显示消息原文与时间、选项（有代码改动才出现两个「恢复代码」项；两个摘要项可在行内输入说明）、预览（「将恢复 N 个文件 +x −y」/「代码不变」/ 冲突与跳过清单）、git HEAD 变化提示（附 `git log --oneline <记录>..HEAD` 与 `git reset --soft <记录>` 两条命令，不执行）。
- 结果通知：`已恢复 N 个文件，跳过 M 个（原因…）`。
- line 模式：`/rewind` 列编号；`/rewind <n> [both|conversation|code]`。
- 文案进 i18n 风格的现有中文常量；字形走主题 glyphs（ASCII 可用）。

## §5 RPC / SDK / Hook / 配置

- RPC：`get_rewind_points` → `{ points }`；`rewind { entryId, mode, dryRun?, onConflict? }` → `RewindResult`；事件 `session_rewound { entryId, mode, restored, deleted, conflicts, skipped }`。写进 `docs/rpc.md`。
- SDK：`session.rewindPoints()`、`session.rewind()`。
- Hook：新增命令式事件 `PostRewind`（payload `{ entryId, mode, files }`，不可阻止）；`docs/hooks.md` 同步。
- 配置（`key-docs.ts` 每项要说明与缺省值）：
  - `checkpoints.mode`: `"tools"`（缺省）/ `"shadow-git"` / `"off"`；`AMA_CHECKPOINTS=off` 覆盖。
  - `checkpoints.maxFileBytes`: 5 242 880。
  - `checkpoints.keep`: 100。
  - `ui.restoreOnCancel`: true。

## §6 影子 git（`checkpoints.mode: "shadow-git"`）[RW-D]

- 仓库：`<dataDir>/file-history/shadow/<sha256(cwd) 前 16>/`（`--git-dir`），`--work-tree=cwd`；尊重 cwd 的 `.gitignore` 与 `info/exclude`，额外排除 `.git`。
- 每个新回合：`git add -A` + `write-tree` + `commit-tree`，提交 id 记进 `CheckpointData.shadowCommit`（契约里预留可选字段）。
- 护栏：cwd 下文件数 > 20 000 或单次快照 > 3 s → 本会话降级为 `tools` 并提示；需要 `git` 在 PATH。
- 恢复：只处理目标提交与「当前工作区快照」之间的差异文件，逐个按 §3.2 的冲突与安全检查写回或删除；不碰 `.gitignore` 掉的文件。
- 与 `tools` 模式并存：edit / write 的跟踪照常（冲突检测仍以它为准）。

## §7 缓存与上下文

- 回滚后第一次请求：system + tools + 落点之前的消息与回滚前发过的请求逐字节相同 → 有效期内命中；`onContextChanged()` 使这次请求成为重置点（不做未命中归因、保温作废），与现状一致。
- `ama.checkpoint*` 是 `custom`，不进上下文；`ama.rewind-note` 是 `custom_message`，只出现在新落点之后。
- 测试：回滚前后请求体前缀逐字节比较（`src/agent/session-rewind.test.ts`）。

## §8 批次与文件所有权

契约 PR（本计划所在 PR）先合入：`src/checkpoints/types.ts`、`ToolContext.checkpoint?`。配置 `checkpoints.*` 归 RW-A，`ui.restoreOnCancel` 与 `PostRewind` 归 RW-B（各自同步 `config/{types,schema,json-schema,key-docs}.ts` 与 `hooks/types.ts`）。之后：

| 批次            | 内容                                                                                                                                                                      | 文件所有权                                                                                                                                                                                               | 依赖                                          | 验收                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-A 检查点核心 | blob 存储、tracker、条目重放、恢复与安全检查、冲突检测、dry-run diff、GC、doctor 占用；edit / write 调 `ctx.checkpoint`                                                   | `src/checkpoints/**`（除 types.ts）、`src/tools/{edit,write}.ts` 的两处调用、`src/cli/subcommands/{sessions,doctor}.ts` 的 GC / 占用                                                                     | 契约                                          | 单测覆盖 §3.2 每条分支（符号链接、硬链接、父目录移动、删除、新建、冲突 skip / overwrite、too_large）；三平台 CI 绿（Windows 无 O_NOFOLLOW 分支）                                  |
| RW-B 会话与接口 | `session-rewind.ts`（编排、readFiles 重算、rewind-note、摘要两项、中断即撤回）、检查点接线（runPrompt 后建检查点、子会话指向父 tracker）、RPC / SDK / `PostRewind` / 文档 | `src/agent/session-rewind.ts`（新）、`src/agent/{session,session-run,session-tools,session-subagent}.ts` 的接线、`src/modes/rpc/**`、`src/sdk.ts`、`src/hooks/**` 的事件、`docs/{rpc,hooks,sessions}.md` | 契约；RW-A 的实现可先用内存桩，合入顺序 A → B | fake 供应商端到端：edit 两个文件 → rewind both → 文件与对话都回到之前、readFiles 不含被恢复文件、下一请求前缀逐字节不变；仅对话 / 仅代码各自的 note；子会话编辑可回滚；中断即撤回 |
| RW-C 交互界面   | 双击 Esc、回滚列表、确认面板、预览、git 提示、结果通知、line 模式 `/rewind`                                                                                               | `src/modes/interactive/**`、`src/modes/commands-core.ts`、`docs/tui.md`                                                                                                                                  | RW-B                                          | 帧黄金：列表、面板（有 / 无代码改动、冲突、git 提示）、ASCII；tmux 手测双击 Esc 两种行为                                                                                          |
| RW-D 影子 git   | §6                                                                                                                                                                        | `src/checkpoints/shadow-git.ts`（新）及其测试                                                                                                                                                            | RW-A                                          | 临时 git 仓库里 bash 改动可回滚；护栏降级；无 git 时提示                                                                                                                          |

- A 与 B 并行开发（B 用桩），A 先合；C 与 D 在 B / A 合入后并行。
- 每个文件 ≤ 600 行（`src/agent/session.ts` 已 600 行，新逻辑放 `session-rewind.ts`）。
- 每批次细粒度提交、一个 PR、CI 绿后由主会话合并（merge commit）；不发版。
