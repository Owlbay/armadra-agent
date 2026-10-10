# Plan 模式

plan 模式让 ama 先只读调研、写出一份结构化的计划，经人批准后再切回执行模式按计划推进。本文写流程、计划格式、审批的几种入口、配置与持久化；权限细节见 [permissions.md](permissions.md)「plan 模式与只读命令」，设计依据见 [wave5-plan.md](../history/wave5-plan.md) §6。

## 流程

```text
进入 plan（Shift+Tab / /permission / --permission-mode plan / RPC set_permission_mode / SDK）
  记下进入前的模式（prePlanMode），会话里落 ama.plan_state{active:true}
只读探索：read / grep / glob / ls、只读命令、task 子 Agent（同样处在 plan）
  每个提示之后追加模式说明 ama.plan_mode（第 1 个完整版，之后每 5 个提示一次简版，每第 5 次与压缩后完整版）
模型输出 <proposed_plan> 块
  回合以纯文本结束时提取 → 落 ama.plan{status:"proposed"} 与计划文件 → 事件 plan_proposed
审批：批准并执行 / 指定模式执行 / 在新上下文执行 / 继续修改 / 放弃
交接：步骤写成 todo（首项 in_progress）→ 切回执行模式 → 新回合带上 ama.plan_approved（计划全文 + 文件路径）
```

- **模式说明只追加在尾部**：说明以 `custom_message`（`display: false`）跟在用户消息之后，投影成 user 消息，不改系统提示和工具表，进入 / 退出 plan 前后缓存前缀逐字节不变。没有 enter / exit 之类的工具。
- 手动退出 plan（没有批准计划）时，下一个提示后追加 `ama.plan_mode_exit`，告诉模型只读限制已解除。
- 在 plan 里被拒的写 / 执行调用，拒绝说明自带指引（`Finish the plan with a <proposed_plan> block`），说明被压缩掉后模型也能恢复。
- `todo` 在 plan 下只能 `get`：清单由批准的计划生成，避免模型用 todo 代替计划、跳过审批。
- 只有根会话提取计划；`task` 子会话里的计划块作为 task 结果文本返回给父会话。

## 计划格式

```markdown
<proposed_plan>

# <标题>

## 背景

## 步骤

- [ ] S1 <动作>（涉及：path/a.ts）
- [ ] S2 <动作> [depends: S1] [agent: codex]

## 验证

## 假设与风险

</proposed_plan>
```

- 开、闭标签各占一行，不在代码围栏里；一条回复里有多个块取最后一个完整块，不闭合的块忽略。
- 步骤取 `- [ ] Sx` 清单；没有清单时取「步骤 / Steps」小节里的编号列表。`[depends: …]`、`[agent: …]` 解析成 `dependsOn`、`agent`（只是建议，派发仍按各自的授权）。最多 30 条，多出的截断并记 warning。解析不出步骤也能审批，只是不生成 todo。
- 弱模型不写标签时，可以把上一条回复当作计划提交审批（`PlanController.proposeFromLastReply()`，交互界面与 line 模式的 `/plan approve` 用它）。

## 审批

谁来回答取决于运行方式；**ama 不替人批准**：

| 运行方式                             | 回答者                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 交互（TUI）                          | 用户在底部审批框里选：批准并执行 / 批准，在新上下文执行（两者接着选执行模式：回到进入前的模式 / Accept edits / Auto）/ 继续修改（框内或外部编辑器写意见）/ 放弃并退出 Plan；`e` 在 `$VISUAL` / `$EDITOR` 里改计划，Esc 放弃但留在 Plan。见 [tui.md](tui.md)「Plan 审批」 |
| 交互（line，`--no-tui`）             | `/plan approve [模式\|fresh]`、`/plan reject`；回复 `1` / `2` / `3` 也能批准（进入前的模式 / Accept edits / Auto），其它内容作为修改意见、留在 plan                                                                                                                      |
| RPC，声明了 `plans` 能力             | 客户端：`plan_proposed` → `plan_response`（见 [rpc.md](../reference/rpc.md)「计划审批」）                                                                                                                                                                                |
| SDK，给了 `plan.onProposed`          | 回调：运行结束后调用，返回 `{ decision, mode?, feedback?, editedMarkdown? }`；返回 undefined 留待 `session.plan.respond()`                                                                                                                                               |
| `-p`、未声明能力的 RPC、无回调的 SDK | 配置 `plan.unattended`：`stop`（缺省）落盘计划后停下，不切模式、不执行；`approve` 在同一次运行里自动批准并执行                                                                                                                                                           |

四种决定：

- **approve**：计划标 approved；步骤写成 `ama.todo`（`planStep` 指回步骤 id，首项 in_progress）；权限模式切到指定模式，缺省进入 plan 前的模式（进入前就是 plan 时用 Manual）；配置了 `plan.model` 时切回执行模型；随后开新回合：用户消息 `The plan is approved. Go ahead.`（`origin: "plan"`）+ `ama.plan_approved`（计划全文、文件路径与进度记法，见下文「进度记法」）。line 模式下回复 `1` 本身就是这个回合的用户消息。
- **approve_fresh**：同样标 approved 并切模式，但执行放到新会话：首条用户消息是计划全文与文件路径，新会话里写 todo。RPC 由服务端新建会话；SDK 的 `respond()` 返回 `freshPrompt`，由调用方新建会话后 `planController(next).adopt(plan)` 再发它。上下文占用高或配置了 `plan.model` 时最划算（反正要重读）。
- **revise**：留在 plan；`feedback` 作为普通用户消息开回合，模型整份重写计划，新版本号 +1，旧版标 superseded。
- **reject**：计划标 rejected，留在 plan。交互界面的「放弃，退出 Plan 模式」在 reject 之后切回进入前的模式；审批框里按 Esc 是 reject 但留在 plan。

**进度记法**：活动工具集里有 `todo`（`tools.default: ["+todo"]`、`--tools …,todo`）时，交接消息请模型「按 todo 推进，每完成一步 todo update」；没有时（`default` 预设缺省不含 todo，见 D20 与 [docs/benchmarks/](https://github.com/Owlbay/armadra-agent/tree/main/docs/benchmarks)）请模型每完成一步在回复里**单独一行**写 `[DONE:<步骤 id>]`（如 `[DONE:S1]`），ama 在回合结束时读这些标记：对应的计划待办标 done，没有进行中的项时下一个 pending 转 in_progress，照常落 `ama.todo`、发 `todo_updated`，界面与 RPC 的进度显示不受影响。「在新上下文执行」的首条消息用同样的规则。

客户端改过的全文（`editedMarkdown`，界面里「在外部编辑器里改」）先落一份新版本，交接消息用改后的全文。

`-p` 在 `stop` 下停在「计划待审批」时：stderr 一行写明计划文件与审批办法，`--output-format json` 的结果带 `planPending{planId, version, filePath}`，退出码 **9**（计划已落盘、未执行；不复用 7「工具调用被拒」）。`approve` 下批准后照常执行，退出码按执行结果。

## 规划 / 执行分模型

`plan.model`（`provider/model[@channel]`）与 `plan.thinkingLevel`：plan 下的**第一个提示**切到规划模型，**批准时**切回执行模型（手动退出后的下一个提示也切回）。只是经过 plan（Shift+Tab 循环）不会切。缺省不设。换模型后前缀缓存全部失效，下一次请求全价重读（记为 `cache_miss{model_changed}`），所以缺省关闭；搭配「在新上下文执行」最划算。切走的执行模型记在 `ama.plan_state` 里，resume 后批准仍能切回。

## 配置

| 键                   | 缺省               | 说明                                                                                         |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `plan.bash`          | `readonly`         | plan 下的 bash：`readonly` 只读命令放行其余拒绝，`ask` 其余询问，`deny` 全拒；项目级只能更严 |
| `plan.directory`     | `<数据目录>/plans` | 计划文件目录；相对路径按项目根解析，必须在项目根之内，否则 warning 回落缺省；只认用户级      |
| `plan.unattended`    | `stop`             | 无人值守时 `stop` 停下等人审批，`approve` 自动批准执行；只认用户级                           |
| `plan.model`         | 不设               | 规划用模型                                                                                   |
| `plan.thinkingLevel` | 不设               | 规划时的思考强度                                                                             |

## 持久化

| 条目                                 | 内容                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `custom{ama.plan}`                   | `PlanData`：`{ id, version, status, markdown, steps, sourceEntryId, filePath? }`；状态变化另记一条，同 id 取分支上最后一条 |
| `custom{ama.plan_state}`             | `{ active, prePlanMode, planId?, executionModel?, executionThinking? }`：进入 / 退出 plan；resume 时据此回到 plan          |
| `custom_message{ama.plan_mode}`      | 模式说明（完整版或简版）                                                                                                   |
| `custom_message{ama.plan_mode_exit}` | 手动退出 plan                                                                                                              |
| `custom_message{ama.plan_approved}`  | 交接消息（批准即说明 plan 已结束，不再另发 `ama.plan_mode_exit`）                                                          |
| `custom{ama.todo}`                   | 批准时由步骤生成的清单                                                                                                     |

计划文件 `<目录>/<sessionId>-v<N>.md` 只是导出，由 ama 进程写，不经模型的工具调用，不受 plan 只读限制。版本号在会话内单调。

## 接口

- RPC：命令 `plan_response` / `get_plan` / `get_todos`，能力 `plans`，事件 `plan_proposed` / `plan_resolved` / `todo_updated`，见 [rpc.md](../reference/rpc.md)。
- SDK：`createAgentSession({ plan: { bash?, directory?, unattended?, model?, thinkingLevel?, onProposed? } })`；返回的会话有 `session.plan.current()`、`session.plan.respond(response)`、`session.plan.todos()`。
- 进程内：`planController(session)`（`src/agent/session-plan.ts`）给界面用——`pending()`、`respond()`、`proposeFromLastReply()`、`adopt()`、`setAttendance()`。
- 交互界面：底部审批框（四个选项 + 执行模式、`e` 编辑计划、Esc 留在 Plan）、`/plan` 面板，`/plan <目标>` 进入 Plan 并发出目标，`/plan approve [模式|fresh]` / `/plan reject` 不开对话框直接作答；见 [tui.md](tui.md)「Plan 审批」。
- `-p`：`stop` 下退出码 9 与 `planPending`（见上文）；要无人值守执行就在用户级配置写 `"plan": { "unattended": "approve" }`。
