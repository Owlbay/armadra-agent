# R3：ama 的 Plan 能力——各家实现对照与推荐设计

调研对象：ama（`/Users/yovinchen/Projects/Rust/Tauri/armadra-agent`，HEAD `fb36ecd`），以及 工具 A 2.1.285（本机打包产物 `本机材料`）、工具 B 0.160.0（本机二进制 strings）、工具 C（`本机材料`）、工具 D、工具 E、工具 F、工具 G、工具 H、工具 I、工具 J（官方文档 / issue）。只读调研，没有改仓库。

---

## 0. 结论

1. **ama 现在的 plan 只是权限管线里的一行规则**：`modeDecision()` 对 `plan` 模式下的 write / execute 一律返回 deny（`src/permissions/pipeline.ts:71-76`）。模型**不知道自己处在 plan 模式**，只有在调用写工具被拒时才从拒绝消息里得知。没有计划产物，没有审批，退出时也不交接执行。plan 下 bash 全部被拒（连 `git log` 都不行），`task` 是 execute 类也被拒，所以 plan 模式里**既不能用只读命令，也不能派只读子 Agent 去探索**。`todo` 工具在 default 预设里关着，和 plan 也没有任何关联。
2. **各家做法已经收敛成同一条流程**：只读探索 → 产出结构化计划（Markdown）→ 用专门的通道呈现并审批（批准 / 改 / 拒）→ 切回执行模式，并把计划交给执行阶段（todo 或文件）。差别只在三处：**计划由谁写进文件**（模型写，还是由客户端从回复里提取）、**审批靠工具调用还是靠文本标记**、**执行阶段要不要换模型或换上下文**。
3. **ama 有严格的前缀字节稳定要求（design §9.1）**，所以模式切换**不能改系统提示，也不能增删工具**。工具 E 已经踩过这个坑：退出 plan 时把 `plan_exit` 从工具表里删掉，结果缓存命中率下降（issue #27683）。可行的办法是 工具 A 和 工具 B 的做法：**模式说明作为尾部的 user / developer 消息注入**，ama 现成的载体是 `custom_message`（参照 `ama.aborted` 的先例，`src/agent/session-run.ts:100-107`），它投影成 user 消息，不碰前缀。
4. **推荐方案**（详见 §3）：
   - 计划**不新增工具**。模型在回复里输出 `<proposed_plan>…</proposed_plan>` 块（工具 B 的做法），**由 ama 负责落盘**到会话条目 `ama.plan` 和 Markdown 文件。这样模型在 plan 模式下完全不需要写权限，也就避开了 工具 E / 工具 D「模型不敢写或写不了计划文件」的那类 bug。
   - 运行结束时如果检测到计划块，TUI / RPC / SDK 发起审批：批准并执行 / 批准并在新上下文执行 / 继续修改 / 放弃。
   - 批准后：切回进入 plan 前的模式（类似 工具 A 的 `prePlanMode`），把计划步骤写成 `ama.todo`，再追加一条 `custom_message`「计划已批准 + 计划全文 + 按 todo 推进」并触发新回合。
   - `todo` 工具**在会话开始时就固定进 default 预设**（约 150 token，留在缓存前缀里），不在中途开启。
   - plan 模式放宽两点：①只读 bash（复用 `analyzeBashForAuto` 的安全名单）放行；②`task` 在子会话强制 plan 模式时放行。
   - 可选：`plan.model` / `plan.thinkingLevel` 把规划和执行用的模型分开（对应 工具 A 的 规划专用模型别名、工具 B 的 `plan_mode_reasoning_effort`、工具 D 的 Pro→Flash、工具 H / 工具 I 的每模式模型）。换模型时一次性丢掉缓存，所以缺省关闭，只在批准时切一次。
5. **主要风险**：计划块的识别靠模型守格式，需要回退办法（找不到块时提供「把上一条回复当计划」）；把计划转换成 todo 的解析规则；如果规划和执行用不同模型，切换那一刻缓存全部重读；Armadra 的协调者场景里，计划审批要经过宿主 broker，不能让 ama 自己替人回答。

---

## 1. 各家 Plan 机制对照

### 1.1 总表

| 维度                 | 工具 A                                                                                                                              | 工具 B                                                                                                                         | 工具 D                                                                                             | 工具 E                                                                               | 工具 F                                     | 工具 G                                          | 工具 H                                            | 工具 I                                | 工具 J                                    | 工具 C（扩展示例）                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------- | ------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 进入方式             | Shift+Tab 循环到 plan；`--permission-mode plan`；模型也能调 `EnterPlanMode`                                                         | `/plan` 或切到 Plan 协作模式（collaboration mode）                                                                             | `/plan [goal]`、`--approval-mode=plan`、Shift+Tab、自然语言加 `enter_plan_mode` 工具（需用户确认） | Tab 切到 plan agent；实验开关 `<TOOL>_EXPERIMENTAL_PLAN_MODE`                        | Shift+Tab 或模式下拉                       | 新建 Spec（Feature / Bugfix / Quick）           | 切到 Plan 开关                                    | 切到 Architect 模式                   | `/architect`、`--architect`、`/chat-mode` | `/plan`、`--plan`、Ctrl+Alt+P                             |
| 只读怎么实现         | 权限层：plan 模式下非只读工具一律禁止，只有计划文件这一处可写；同时用提示词提醒                                                     | 主要靠提示词：区分「不改仓库状态的动作」和「会改状态的动作」，允许跑会写缓存的测试和构建；`update_plan` 在 Plan 模式下直接报错 | 策略引擎：只读工具、研究子 Agent、ask_user，以及只能写计划目录里的 .md                             | 权限配置：plan agent 的 edit / bash 设为 `ask`；实验版只允许写 `.<工具E>/plans/*.md` | 产品内部实现（未公开）                     | 分阶段生成文档，阶段之间有审批关口              | Plan 模式不能改文件、不能执行命令                 | 工具组：read、mcp，edit 只限 Markdown | architect 本身不编辑，回复交给 editor     | `setActiveTools` 去掉 edit / write，bash 走只读命令白名单 |
| 计划怎么呈现         | 模型把计划写进计划文件，再调 `ExitPlanMode`，弹出审批框显示计划                                                                     | 回复里的 `<proposed_plan>` 块，TUI 用专门的单元格渲染                                                                          | 调 `exit_plan_mode(plan_path)`，弹框显示                                                           | 调 `plan_exit`，提问后交给 build                                                     | 显示 Plan 文档，可编辑，再点 Build         | requirements / design / tasks 三个文件          | 用 `plan_mode_respond` 对话                       | 写 .md 文件                           | 普通回复，然后问是否编辑文件              | 从回复里提取 `Plan:` 编号列表                             |
| 审批选项             | 清空上下文后执行（auto / bypass / accept edits）、保留上下文执行（accept edits / auto / default）、交到云端继续细化、不批准并附意见 | 提示词要求不要问「是否继续」，用户自己切出 Plan 模式再要求实现；也可以留在 Plan 模式继续细化                                   | 批准后自动接受编辑或手动接受编辑；给反馈；用户自己改文件；Esc 取消                                 | 问一次后交给 build                                                                   | Build 按钮；结果不满意就回退并改计划       | 每个阶段批准后才进下一个                        | 手动切到 Act                                      | `switch_mode` / 手动切                | `/ok`、`--auto-accept-architect`          | 执行（跟踪进度）/ 留在 plan / 细化                        |
| 批准后怎么切模式     | 回到 `prePlanMode`（进入 plan 前的模式）；auto 不可用时回落 default                                                                 | 新的 `<collaboration_mode>` developer 消息宣布 Default                                                                         | 退出 Plan，进入所选的审批模式                                                                      | 切到 build agent（有 bug：交接后仍沿用 plan 的模型）                                 | 进入 Agent 执行                            | 进入任务执行                                    | 切到 Act，对话历史保留                            | 切到 Code 模式                        | 启动 editor Coder，不带历史               | 恢复工具，进入执行模式                                    |
| 计划是否落文件       | 是：`~/.<工具A>/plans/<形容词>-<动名词>-<名词>.md`；`plansDirectory` 可改到项目内（必须在项目根下）                                 | 否：只在对话里                                                                                                                 | 是：`~/.<工具D>/tmp/<project>/<session>/plans/`，可改成项目内；30 天自动清理                       | V1：`.<工具E>/plans/<时间戳>-<slug>.md`；V2 丢掉了这个流程（issue #49879）           | 是：默认存在 home 目录，可「保存到工作区」 | 是：`.<工具G>/specs/<name>/`                    | 可选（deep-planning 产出 implementation_plan.md） | 是（.md）                             | 否                                        | 否（只存进会话条目）                                      |
| 和 todo 的关系       | 批准结果里提示「先更新 todo 列表」；TodoWrite / TaskCreate 是另一套独立工具，有 10 轮未更新就提醒的机制                             | Plan 模式与 `update_plan`（清单工具）明确分开，Plan 模式下禁止用后者                                                           | 文档里没有关联                                                                                     | `todowrite` 是独立工具                                                               | 计划里带 todo，Build 时逐条执行            | tasks.md 就是任务清单，带状态，可按依赖分波并行 | Focus Chain / todo                                | `update_todo_list`                    | 无                                        | 计划步骤即 todo，用 `[DONE:n]` 标记进度                   |
| 提示词要点           | 五阶段流程；不准用文本或提问来征求批准，只能调 ExitPlanMode；提醒分完整版和简版                                                     | 先探索再提问；计划要做到实现者不用再做任何决定；最终计划的格式要求；不要问「是否继续」                                         | 先在聊天里谈拢，再调 exit 工具                                                                     | V1 每回合注入计划提醒和计划文件路径                                                  | 先提澄清问题                               | EARS 格式写需求                                 | 先讨论策略                                        | 担任「技术负责人 / 规划者」角色       | 先提方案，editor 再落地                   | 注入 `[PLAN MODE ACTIVE]` 和 `Plan:` 格式要求             |
| 规划和执行用不同模型 | `规划专用模型别名`：plan 模式下用 Opus，其他用 Sonnet                                                                               | `plan_mode_reasoning_effort`：Plan 模式单独设推理强度                                                                          | 自动选模型时，Plan 用 Pro，批准后换 Flash                                                          | 每个 agent 可以配 `model`                                                            | 用户自己选                                 | —                                               | 每个模式可以配不同模型                            | 每个模式记住各自的模型（sticky）      | architect 和 editor 是两个模型            | 无                                                        |

### 1.2 工具 A（本机 2.1.285 产物）

- **模式说明放在消息里，不放进系统提示**。plan 模式的说明以带 `isMeta` 标记的 user 消息（attachment）注入。第一次注入完整版，之后注入简版（原文大意为「Plan mode still active (see full instructions earlier…)」）。频率由常量 `TURNS_BETWEEN_ATTACHMENTS:5`、`FULL_REMINDER_EVERY_N_ATTACHMENTS:5` 控制：每 5 个回合提醒一次，每第 5 次提醒用完整版。退出时有一条 `plan_mode_exit` 附件，重新进入时有 `plan_mode_reentry`。子 Agent 用单独的简短版本（函数 `Smr`）。这些都不改系统提示和工具表，和 ama 的缓存要求一致。
- **只读约束**：说明开头是硬性规定，原文是「you MUST NOT make any edits (with the exception of the plan file…)」。可写的例外只有计划文件。目标会话（goal）这类功能在 plan 模式下直接抛错，消息为「Plan mode is active, so a goal cannot be proposed yet」。
- **计划文件**：`plansDirectory` 设置项（「relative to project root… defaults to ~/.<工具A>/plans/」）；路径不在项目根内会报错并回落到默认目录。本机 `~/.<工具A>/plans/` 下有 16 个文件，名字是随机三词 slug（如 `buzzing-growing-squirrel.md`）；内容是 Markdown，结构通常为 `# 标题 → ## Context → 分步 / 分模块的小节 → 验证`。提示词里 Phase 4 要求「列出关键文件，重复模式只描述一次，必须带验证小节」。
- **ExitPlanMode**：工具说明要求「计划写完、准备审批时才调用」，而且只用于需要写代码的任务，纯调研不用。执行时从磁盘读计划；用户在审批框里改过计划时，会把新内容写回文件并在结果里回显（`planWasEdited`）。批准后把模式恢复为 `prePlanMode`（auto 不可用时回落 default）。返回给模型的结果大意是「用户已批准计划，可以开始写代码，适用时先更新 todo 列表」，后面附上计划全文。审批框还有「清空上下文再执行」选项，会话随之重置（`conversation_reset` 的 trigger 为 `plan_mode_exit`），由 `showClearContextOnPlanAccept` 控制是否显示。
- **团队 / 子 Agent**：teammate 在 plan 模式下调 ExitPlanMode 时，不弹给用户，而是给 lead 的收件箱发一条 `plan_approval_request{planFilePath, planContent, requestId}`，lead 回 `plan_approval_response{approved, feedback, permissionMode}`。requestId 对不上会被拒绝，并要求重新提交。这是**协调者审批子 Agent 计划**的现成范式。
- **工具表**：子 Agent 的工具过滤里，只有 plan 模式才补上 ExitPlanMode（`if(h==="plan"&&!M.some(...)) M.push(XG)`）。主线程里这个工具常驻，因为它 `isEnabled` 恒为真，工具表不随模式变化。
- **Todo / Task**：TodoWrite 的条目有 `content` + `activeForm` + `status`，说明里要求「主动、经常用，任何时候至少一项 in_progress」。新版本是 TaskCreate / TaskUpdate（条目有 `subject / description / owner / blocks / blockedBy`，可以跨 Agent 共享）。提醒机制：连续 10 轮没更新、且距上次提醒也满 10 轮，就注入一条 `todo_reminder` / `task_reminder`。
- **规划专用模型别名**：模型别名，说明文字为「Use Opus in plan mode, Sonnet otherwise」。启动小贴士会提示连按两次 Shift+Tab 进入 Plan Mode，用 Opus 规划。

### 1.3 工具 B（本机 0.160.0 二进制）

- **Plan 是一种「协作模式」，不是权限模式**。切换时注入一条 developer 消息，用 `<collaboration_mode>` 包起来。提示词写明：只有新的 developer 指令能改变模式，用户在对话里要求执行也不算，这时应理解为「请规划如何执行」。切回 Default 时同样注入一条消息，宣布之前的模式说明全部失效。
- **只读靠提示词**：明确列出「允许：读、搜、静态分析、不改受版本控制文件的测试和构建」和「禁止：编辑、会改写文件的格式化工具、补丁、迁移、代码生成」，判断不了时的准则是看这一步算「做事」还是「规划」。我**没有在二进制里找到 Plan 模式另外切换沙箱或审批策略的证据**，所以按「靠指令约束」记录。
- **三阶段**：先探索环境，再对齐意图，最后定实现细节。用 `request_user_input` 提问，每次 1–3 题，选项互斥，并给出推荐默认值。
- **`<proposed_plan>` 块**：开、闭标签各占一行，块内用 Markdown，标签不翻译。每回合最多一个块，修订时必须整份重写。要求包含：标题、摘要、公共接口的变化、测试、假设与默认值；倾向于 3–5 个短小节，路径尽量少写。TUI 有专门的 `ProposedPlanCell` 渲染。
- **`update_plan`**：独立的清单工具（`steps[{step, status}]` 加 `explanation`）。在 Plan 模式下调用会报错，报错原文是「update_plan is a TODO/checklist tool and is not allowed in Plan mode」。
- **`plan_mode_reasoning_effort`**：配置项，Plan 模式单独设推理强度；`/model` 里能分别设置全局默认值和 Plan 模式的覆盖值。

### 1.4 工具 D

- 有 `enter_plan_mode`（需用户确认）和 `exit_plan_mode(plan_path)` 两个工具。`plan_path` 必须在计划目录内，且文件存在、不为空。审批时选「自动接受编辑」或「手动接受编辑」，也可以给反馈或自己改文件。
- 用策略引擎实现只读：只开放只读工具、研究子 Agent（codebase investigator）、ask_user，以及计划目录内 .md 的写入。
- 自动选模型时：Plan 阶段用 Pro，批准后切到 Flash。
- 已知问题：这两个工具常驻工具表（issue #24370 提议按模式隐藏）。Windows 上有用户因为计划文件写不出来，导致 exit 失败（#18730）。

### 1.5 工具 E

- 内置两个主 agent：build 和 plan，用 Tab 切换。plan 的 edit / bash 设为 `ask`，每个 agent 可以单独配模型。
- 实验版 plan 模式：计划写在 `.<工具E>/plans/<时间戳>-<slug>.md`，`plan_exit` 写死交给 build。**教训**：①退出时从工具表删掉 `plan_exit`，缓存前缀因此断开（#27683）；②子 Agent 也能调 `plan_exit`（#18515）；③交接后仍然沿用 plan 的模型（#16276、#48157）；④模型以为 plan 模式完全只读，不肯写计划文件（#11078、#10883）；⑤V2 丢掉了计划文件流程（#49879）。

### 1.6 工具 F / 工具 G / 工具 H / 工具 I / 工具 J / 工具 C

- **工具 F**：先问澄清问题，再调研，再生成可编辑的计划文档（带 todo），点 Build 执行。官方建议是结果不满意就回退并改计划，而不是靠追问修补。
- **工具 G**：Spec 驱动，三个文件 `requirements.md`（EARS 格式）/ `design.md` / `tasks.md`，阶段之间有审批关口。任务有实时状态，可以按依赖图分「波」并行执行。还有 Quick Spec（不设关口）和 Bugfix Spec。
- **工具 H**：Plan / Act 两个模式，切换时对话历史保留，每个模式可以配不同模型；`/deep-planning` 用于大任务。
- **工具 I**：Architect 模式只能编辑 Markdown；Orchestrator 模式没有直接的工具，只用 `new_task` 把子任务派给其他模式；每个模式记住各自的模型。
- **工具 J**：architect 模型用文字描述方案，editor 模型在**没有历史、没有仓库地图**的新 Coder 里把方案翻译成编辑。已知安全问题：architect 的输出不经预处理直接交给 editor，可以被提示注入利用（#5058）。
- **工具 C plan-mode 扩展**（`本机材料`）：在 `before_agent_start` 注入一条 `display:false` 的 custom 消息（`[PLAN MODE ACTIVE]` + `Plan:` 格式）；在 `agent_end` 提取编号步骤，用 `ui.select` 让用户选三个选项之一；执行时注入剩余步骤，模型输出 `[DONE:n]` 标记进度，靠 `turn_end` 解析；在 `context` 钩子里过滤掉过期的 plan 提醒。缺点是用 `setActiveTools` 改工具表，会断缓存。

---

## 2. ama 现状

### 2.1 plan 模式做了什么

| 项           | 现状                                                                                                                                                              | 证据                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 定义         | 六种权限模式之一，界面名 Plan，说明为「只读，不改文件、不跑命令」                                                                                                 | `src/permissions/modes.ts:15-25`                                            |
| 进入         | Shift+Tab 循环（Manual → Accept edits → Plan → Auto → Bypass）、`/permission`、`--permission-mode plan`、配置项、RPC `set_permission_mode`、SDK `permission.mode` | `modes.ts:38-44`、`docs/guides/permissions.md`、`docs/reference/rpc.md:108` |
| 约束         | 管线第 ③ 步：read 放行，write / execute 拒绝，拒绝消息是 `Permission mode "plan" allows only read-only tools`                                                     | `src/permissions/pipeline.ts:71-76, 251-258`                                |
| bash         | execute 类，全部拒绝（包括 `ls`、`git log`、`rg`）                                                                                                                | 同上                                                                        |
| task         | `permission: "execute"`，被拒，plan 下不能派子 Agent 探索                                                                                                         | `src/tools/task.ts:91`                                                      |
| codemode     | strict（Node ≥ 25）时是 read 类，可以调用；脚本里嵌套的写调用仍走管线被拒                                                                                         | `src/codemode/tool.ts:290`                                                  |
| 模型是否知道 | **不知道**：系统提示里没有模式信息，也没有注入任何消息；`setPermissionMode` 只改 broker 并发出事件                                                                | `src/agent/session.ts:468-471`                                              |
| 持久化       | 模式切换不写会话条目，resume 后回到配置里的缺省模式                                                                                                               | 同上；`src/session/types.ts` 没有 `permission_mode_change` 条目             |
| 界面         | 状态栏里 Plan 用 accent 色                                                                                                                                        | `src/modes/interactive/status-bar.ts:126`                                   |
| 文档残留     | `/permission` 的命令说明还写着旧值 `plan                                                                                                                          | default                                                                     | auto-edit | full-auto` | `src/modes/commands-core.ts:64`，`docs/history/gap-audit-2026-10.md:120` 已经记录 |

### 2.2 todo 工具

- `action: set | get`；`set` 整表替换，条目为 `{id, text, status: pending|in_progress|done}`，写进 `custom{customType:"ama.todo"}`（不进上下文）；`get` 取活动分支上最近一条。`permission: "read"`，`executionMode: "parallel"`。见 `src/tools/todo.ts`、`docs/reference/session-format.md:108`。
- **default 预设里没有它**（D19：多一次更新就多一次往返）。只有 `codemode on` 时能在脚本里调用（`src/tools/presets.ts:40-45`、`docs/design/design.md:568`）。
- 不进系统提示，也没有提醒机制，没有 TUI 面板（gap-audit P2）。

### 2.3 和推荐设计相关的现成基础设施

- **`custom_message` 条目会投影成 user 消息**（`src/agent/transform.ts:47-54`），`ama.aborted` 已经这样用（`src/agent/session-run.ts:100-107`）。这正好是模式提醒和交接消息的载体，不改前缀。
- **系统补丁会改前缀**：`updateSystem` / `addTool` 落补丁之后，「请求时由协议层重装全量」（`src/agent/system-prompt.ts:8-9`）。也就是说，**任何把模式写进系统节的做法都会断缓存**，不能用。
- `analyzeBashForAuto`（`src/permissions/auto-safe.ts:529`）已经有逐段分词、嵌套展开、安全名单和重定向检查，plan 模式的只读 bash 可以直接复用。
- 审批链（宿主 broker → 界面 → 无人值守按拒绝）、RPC 的 `permission_request` / `permission_response`，可以照着它们的形状做计划审批。
- 子 Agent（`spawnSubagent`）继承权限模式与 broker，子会话强制 plan 模式只需要传一个参数。

### 2.4 缺口

1. 模型不知道 plan 模式，没有规划流程的提示词，也没有计划输出格式。
2. 没有计划产物、没有审批、没有切回执行模式的交接。用户只能手动 Shift+Tab 切回，再口头说一句「照做」。
3. plan 下不能用只读 bash，也不能派只读子 Agent，探索能力比 default 模式还弱（default 下 bash 至少会询问）。
4. 计划没有落盘，和 todo 也接不上；todo 默认关闭，执行阶段没有进度跟踪。
5. 模式不持久化，resume 后丢失。
6. 没有提问工具（工具 A 的 AskUserQuestion、工具 B 的 request_user_input、工具 D 的 ask_user），规划阶段的澄清只能靠纯文本。
7. RPC / SDK 没有计划相关的事件和命令，Armadra 拿不到结构化的计划。

---

## 3. 推荐设计

### 3.1 总流程

```text
进入 plan（Shift+Tab / /plan [目标] / --plan / RPC set_permission_mode / SDK）
  │  记 prePlanMode；写 ama.plan_state{active:true, prePlanMode}
  │  下一次 user 回合前注入 custom_message ama.plan_mode（完整版）
  ▼
只读探索（read/grep/glob/ls、只读 bash、强制 plan 模式的 task 子 Agent、codemode strict）
  │  每 5 个回合注入一次简版提醒；被拒消息里写明「plan 模式」和怎么退出
  ▼
模型输出 <proposed_plan> 块（每回合最多一个，修订就整份重写）
  │  agent_settled 时由 ama 提取 → 写 ama.plan{version, markdown, steps} → 写计划文件
  ▼
审批（TUI 对话框 / RPC plan_proposed 事件 / SDK onPlanProposed）
  ├─ 批准并执行          → 切回 prePlanMode（或用户选的模式）
  ├─ 批准，新上下文执行  → 新会话，首条消息带计划（可选）
  ├─ 继续修改 + 意见     → 留在 plan，意见作为 user 消息
  └─ 放弃                → 留在 plan，不再提示这一版
  ▼
交接：steps → ama.todo（全部 pending，第一项 in_progress）
      custom_message ama.plan_approved（计划全文 + 文件路径 + 「按 todo 推进，每完成一步更新 todo」）
      触发新回合；如配置了 plan.model，此时切回执行模型
  ▼
执行中：模型调 todo（parallel，和其他工具同一条回复发出）；TUI 面板与 RPC 事件显示进度
      连续 N 轮没更新 → 注入 ama.todo_reminder（custom_message，可关）
```

### 3.2 模式说明注入：保住缓存

- **规则：模式只影响「尾部消息」和「权限管线」，绝不改系统节和工具表。**
- 新增三种 `custom_message`（`display:false`，投影成 user 消息，进转录也进上下文）：
  - `ama.plan_mode`：进入 plan 后第一次 user 回合前注入完整版（约 300–500 token）；之后每 5 个回合注入一次简版（1–2 句），每第 5 次换成完整版（照搬 工具 A 的节奏）。压缩之后的第一个回合也补一次完整版，因为原来的说明可能已经被摘要吃掉。
  - `ama.plan_mode_exit`：退出 plan 时注入一句「plan 模式已结束，之前的只读限制不再适用」。工具 B 和 工具 A 都有这一步，否则模型会继续按只读行事。
  - `ama.plan_approved`：交接消息，见 §3.5。
- 注入时机放在 `beforeRequest` 之前的 prompts 投递阶段（`src/agent/loop.ts:5` 描述的 turn_start → 投递 prompts），和 `ama.aborted` 一样经 `persistMessage` 落盘。好处：resume 和 fork 时重放一致；`/tree` 换叶子时自然跟随分支。
- 被拒消息改成带指引，例如 `Plan mode is active: write/execute tools are disabled. Finish the plan with a <proposed_plan> block.`。即使提醒被压缩掉，模型也能从拒绝结果里恢复。
- **不新增 `enter_plan` / `exit_plan` 工具**：工具常驻要占前缀（D19 的取舍），按模式增删又会断缓存（工具 E #27683）。模型想建议进入 plan 时，直接在文字里建议就行。
- 测试：在 §9.1 已有的「连续 20 回合 system+tools 逐字节相同」用例里，加入「中途 plan ↔ default 切换 3 次」，断言前缀指纹不变、`cache_miss` 没有 `prefix_changed`。

### 3.3 plan 模式下的权限（管线第 ③ 步细化）

| 调用                                | 现在                 | 建议                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read / grep / glob / ls / todo(get) | 放行                 | 不变                                                                                                                                                                                                                                     |
| `todo set`                          | 放行（read 类）      | **拒绝**，并提示用 `<proposed_plan>`（学 工具 B：plan 和清单分开，免得模型把 todo 当计划，跳过审批）                                                                                                                                     |
| bash                                | 拒绝                 | 用 `analyzeBashForAuto` 判断：每一段都在只读子集里（去掉 `npm test` / `cargo build` 这类会跑项目脚本的条目，没有写重定向）就放行；其余在交互模式下询问（对话框标明「plan 模式下执行命令」），无人值守时拒绝。配置 `plan.bash: "readonly" | "ask" | "deny"`，缺省 `readonly`；改成 `ask` 时询问的范围与 default 模式一致 |
| write / edit                        | 拒绝                 | 不变（计划文件由 ama 写，模型不需要写权限）                                                                                                                                                                                              |
| task                                | 拒绝                 | 放行，前提是子会话强制 `plan` 模式（不继承父会话的 prePlanMode），而且子会话里不处理计划块（只有根会话负责提取和审批，避免 工具 E #18515 那种子 Agent 触发退出的问题）                                                                   |
| codemode                            | strict 时放行        | 不变；脚本内的嵌套调用照常过管线                                                                                                                                                                                                         |
| 宿主工具                            | 按 `permission` 分类 | 不变；宿主可以把「只读的画布工具」标成 read                                                                                                                                                                                              |
| deny 规则、危险命令、Hook           | 先于模式判定         | 不变                                                                                                                                                                                                                                     |

严格度排序 `plan < allowlist` 要重新核对：plan 放行了只读 bash 之后，`plan ⊆ allowlist` 不再成立（allowlist 只放行 allow 规则命中的 bash）。建议在 `docs/guides/permissions.md` 里把严格度改成「plan 与 allowlist 不可比」，或者让 allowlist 也放行同一个只读子集。这一点要先定（见 §4 待定项）。

### 3.4 计划产物：格式与持久化

**输出格式（写进提示词）**

```markdown
<proposed_plan>

# <标题>

## 背景

（1–3 句：要解决什么、调研得出的关键事实）

## 步骤

- [ ] S1 <动作>（涉及：path/a.ts）
- [ ] S2 <动作> [depends: S1] [agent: codex]

## 验证

- <命令或检查项>

## 假设与风险

- <假设：未回答问题时选用的默认值>
  </proposed_plan>
```

- 开、闭标签各占一行，标签不翻译（照搬 工具 B 的规则）；每回合最多一个块，修订时整份重写。
- 「步骤」用 `- [ ] Sx` 清单：这是转换成 todo 的唯一来源。可选标注 `[depends: …]`、`[agent: …]`，给协调者用（§3.7）。解析不出步骤也照样允许审批，只是不生成 todo。
- 提示词要点（综合各家）：先探索再提问，能从仓库查到的不要问（工具 B）；计划要具体到「换个人不用再做任何决定」（工具 B、工具 A）；列出关键文件，重复的改动只描述一次（工具 A Phase 4）；必须有验证小节；不要用文字问「这样可以吗」，计划块本身就是审批入口（工具 A、工具 B）；用户在 plan 模式下要求执行，按「请规划如何执行」理解（工具 B）。

**持久化**

- 权威数据在会话 JSONL 里：`custom{customType:"ama.plan"}`，`data: { id, version, status: proposed|approved|rejected|superseded, markdown, steps:[{id,text,dependsOn?,agent?}], sourceEntryId, filePath? }`，不进上下文（计划正文已经在助手回复里）。另有 `custom{customType:"ama.plan_state"}`，`data: { active, prePlanMode, planId? }`，用来在 resume 时恢复 plan 模式，同时补上 §2.4 第 5 条。两种条目都要写进 `docs/reference/session-format.md`。
- 文件只作为导出：缺省写到 `<数据目录>/plans/<sessionId>-v<N>.md`（不污染仓库，和 工具 A 默认的 `~/.<工具A>/plans/` 一致）；配置 `plan.directory` 可以指到项目内（例如 `.ama/plans/`，必须在项目根之内，照抄 工具 A 对 `plansDirectory` 的校验）。文件由 ama 进程写，不经过模型的工具调用，所以不受 plan 模式只读限制，也不触发 auto 规则层对 `.ama/` 的保护。
- 用户编辑：审批框里提供「在外部编辑器里改」（依赖 gap-audit 里的外部编辑器项）。改过之后版本号加一，交接消息里放修改后的全文（对应 工具 A 的 `planWasEdited`）。

**和 todo 的关系**

- 计划是「批准过的设计」，todo 是「执行进度」。只在批准那一刻单向转换（steps → `ama.todo`）。之后模型自己维护 todo，计划不随之改动；要改计划就回到 plan 模式。
- `todo` 工具的改动：
  - 加 `action: "update"`，参数为 `{id, status}[]` 的补丁，省得每次整表重发（整表 `set` 保留）；
  - 条目加可选的 `planStep`，指回 `S1` 等步骤 id；
  - **在会话开始时把 todo 固定加进 default 预设**。理由：todo 是 `parallel`，可以和同一条回复里的其他工具调用一起发出，不额外增加往返；约 150 token 留在缓存前缀里，代价很小。D19 的原决定要相应修订。如果坚持默认关，那么 plan 交接**只能用 工具 C 那种 `[DONE:n]` 文本标记**，而且不能中途打开 todo（会断前缀）。
- 提醒：执行中连续 10 个回合没有更新 todo，并且还有未完成项，就注入 `ama.todo_reminder`（照 工具 A 的阈值；可通过 `todo.reminder: false` 关闭）。

### 3.5 审批与交接

**触发**：`agent_settled` 时，如果当前是 plan 模式且最后一条助手消息里有完整的 `<proposed_plan>` 块，就生成 `ama.plan(status: proposed)` 并发起审批。如果没有块，什么也不做（多数回合只是问答或澄清）。

**选项（TUI 对话框，复用审批对话框和选择器的组件）**

| 选项                                                                              | 动作                                                                                                                                                     |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 批准并执行（显示将切到的模式，缺省 prePlanMode；进入前就是 plan 时用 default） | 切模式，转换 todo，注入 `ama.plan_approved`，触发回合                                                                                                    |
| 2. 批准并执行（Auto / Accept edits）                                              | 同上，但用户直接指定执行模式（对应 工具 A 的多个「Yes」）                                                                                                |
| 3. 批准，在新上下文中执行                                                         | fork 或新建会话，首条 user 消息为计划全文加文件路径；原会话标记 approved（对应 工具 A 的 clear context、工具 J 的无历史 editor）。上下文占用高时优先推荐 |
| 4. 继续修改…                                                                      | 打开输入框，意见作为普通 user 消息发出，留在 plan                                                                                                        |
| Esc                                                                               | 关闭对话框，留在 plan，计划标记 rejected                                                                                                                 |

- 交接消息 `ama.plan_approved`（custom_message，`display:true` 时在界面上折叠显示）：「计划已批准，plan 模式结束，可以修改文件和执行命令。按 todo 推进，每完成一步用 todo update 标记」，后面附计划全文和文件路径。工具 A 的批准结果也附了全文，原因是模型往往需要原文作为执行依据，摘要会丢细节。
- 关键原则：**ama 不替人批准**。无人值守（`-p`、RPC 未声明 `plans` 能力）时的策略由配置 `plan.unattended: "stop" | "approve"` 决定，缺省 `stop`：落盘计划，退出码或事件说明「计划等待审批」。只有用户显式配置 `approve` 时才自动进入执行。这条与 Armadra 的 Review guidelines 一致（「可能替人回答权限提示与对话框」算 P1）。
- `/plan` 命令：`/plan` 切换 plan 模式；`/plan <目标>` 进入 plan 模式并把目标作为 user 消息发出；`/plan show` 显示当前计划；`/plan approve` 是行模式（line mode）下没有对话框时的批准入口。

### 3.6 规划模型与执行模型分开（可选）

- 配置：`plan.model`（`provider/model`）、`plan.thinkingLevel`。缺省不设，与当前会话相同。
- 生效点：进入 plan 时切到规划模型，**批准时**切回执行模型（不在每次 Shift+Tab 时切）。
- 缓存代价：换模型后，下一次请求的前缀缓存必然全部失效（缓存按模型隔离），ama 会记为 `model_changed`。所以：①缺省关闭；②设置项说明里写清楚「切换时一次全价重读」；③如果选了「新上下文执行」，反正要重读，搭配换模型最划算；④只改 thinkingLevel 而不换模型时，system 和 tools 部分的缓存能保住，但 Anthropic 改思考参数会让消息部分的缓存失效，需要实测确认。
- 不建议照搬 工具 J 那种每条消息都过两个模型：往返和费用都翻倍，而且 工具 J 有 architect 输出直接注入 editor 的安全问题（#5058）。ama 的交接消息走正常的 custom_message 通道，内容是数据，不会被当成斜杠命令或模板展开。

### 3.7 作为协调者：把计划派给子 Agent 或其他 CLI Agent

- 步骤上的 `[agent: X]` 和 `[depends: …]` 解析进 `steps[].agent` / `dependsOn`，转换成 todo 时保留。
- 独立模式：协调者在执行阶段用 `task` 派发，`description` 填步骤 id，子会话结束后由协调者更新 todo。可以按依赖分「波」并发（参照 工具 G 的 waves；ama 的 SubagentPool 并发上限是 4）。
- 嵌入 Armadra（`coordinator` 预设，只有 read 和宿主工具）：协调者的 plan 模式本来就接近只读。计划批准后，由宿主工具 `canvas_send` 按步骤投递给连线的 CLI Agent；进度通过 `canvas_inbox` 回来，再由协调者更新 todo。ama 不知道画布，只负责产出结构化的 `steps`，**派发策略由宿主适配器实现**。
- 子 Agent 自己的计划（工具 A teammate 的范式）：子会话处于 plan 模式时，计划块不弹给用户，而是作为 `task` 结果返回给父会话，由父会话（协调者）决定批准、改还是拒。如果 Armadra 里的其他 CLI Agent 也产出计划，适配器可以把它们包装成同样的 `plan_proposed` 事件交给画布 UI，ama 不参与这部分。
- 授权边界：计划步骤里写的 agent 名只是建议。派发时仍然走连线授权，不能因为计划里写了某个 agent，就绕过画布的连线去投递。

### 3.8 RPC / SDK 暴露

**RPC（增量，写进 `docs/reference/rpc.md`）**

| 类型 | 名称                                   | 形状                                                                                                   |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 能力 | `set_client_capabilities` 加 `"plans"` | 声明之后，计划审批交给客户端；不声明时按 `plan.unattended` 处理                                        |
| 事件 | `plan_proposed`                        | `{ planId, version, markdown, steps[], filePath? }`                                                    |
| 事件 | `plan_resolved`                        | `{ planId, decision: approve                                                                           | approve_fresh | revise | reject, mode? }` |
| 事件 | `todo_updated`                         | `{ items[] }`（现在只能从 `entry_appended` 里过滤，单独发更方便画布做进度条）                          |
| 命令 | `plan_response`                        | `{ planId, decision, mode?, feedback?, editedMarkdown? }`，与 `permission_response` 同构，支持预先暂存 |
| 命令 | `get_plan`                             | `{ planId? }` → 当前或指定计划                                                                         |
| 命令 | `get_todos`                            | → `{ items[] }`                                                                                        |
| 已有 | `set_permission_mode {mode:"plan"}`    | 语义扩展：记录 prePlanMode，注入提醒                                                                   |

**SDK（`@armadra/agent`）**：`session.plan.current()`、`session.plan.respond(...)`；创建会话时的选项 `plan: { model?, thinkingLevel?, directory?, bash?, unattended?, onProposed?(plan) => Promise<Decision> }`；`onProposed` 和 host broker 一样，是一个可以异步等待的决策回调。

**Hook**：可选新事件 `PlanProposed`（命令式 Hook 可以把计划推送到外部，或在 CI 里自动批准）。为控制范围，第一期可以不做。

### 3.9 实施切分建议

| 批次 | 内容                                                                                                 | 主要文件                                                                                   | 验证                                             |
| ---- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| P1   | plan 模式的提醒注入（完整版 / 简版 / 退出）、带指引的被拒消息、`ama.plan_state` 持久化与 resume 恢复 | `src/agent/session-run.ts`、新文件 `src/agent/plan-mode.ts`、`src/permissions/pipeline.ts` | 前缀稳定测试（切换 3 次）、resume 测试           |
| P2   | 只读 bash 与 plan 子 Agent 放行；`todo set` 在 plan 下拒绝；修订严格度文档                           | `pipeline.ts`、`auto-safe.ts`、`task.ts`、`docs/guides/permissions.md`                     | 权限真值表                                       |
| P3   | `<proposed_plan>` 提取、`ama.plan` 条目、文件导出、TUI 审批框、`/plan` 命令                          | 新文件 `src/plan/*`、`src/modes/interactive/*`                                             | 提取的边界用例（不闭合、多个块、代码块里的标签） |
| P4   | 交接：转换成 todo、`ama.plan_approved`、切模式、新上下文执行选项；todo 加 `update` 与提醒；预设调整  | `src/tools/todo.ts`、`presets.ts`、D19 修订                                                | 端到端：plan → 批准 → todo 推进                  |
| P5   | RPC / SDK 接口与文档；`plan.model` 分离                                                              | `src/modes/rpc/*`、`src/sdk.ts`、`docs/reference/rpc.md`                                   | 契约测试                                         |

---

## 4. 风险与待定项

| #   | 风险 / 待定                | 说明                                                                       | 建议                                                                                                                        |
| --- | -------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | 计划块识别不稳             | 弱模型可能不输出标签、标签不闭合，或把标签写进代码块里                     | 只识别不在代码块里、标签各占一行的块；识别不到时，在 plan 模式回合结束后提供「把上一条回复当作计划」的入口                  |
| 2   | 把步骤转成 todo 的规则     | 有的模型用编号列表而不是 `- [ ]`                                           | 两种都识别；最多保留 30 条，超过就截断并提示                                                                                |
| 3   | todo 进不进 default 预设   | 与 D19 冲突                                                                | 我倾向于加进去（理由见 §3.4），需要用 `docs/benchmarks` 的预设基准复测一次                                                  |
| 4   | plan 与 allowlist 的严格度 | plan 放行只读 bash 之后，`plan ⊆ allowlist` 不再成立                       | 二选一：allowlist 也放行只读子集，或者文档改成两者不可比；项目级配置「只能收紧」的规则要随之更新                            |
| 5   | 只读 bash 的边界           | 安全名单看的是命令文本，`grep -r` 会读到 `.env`；`npm test` 会执行项目脚本 | plan 下用比 auto 更窄的子集（去掉测试和构建）；机密路径仍由规则层询问或拒绝                                                 |
| 6   | 提醒被压缩吃掉             | 档二摘要后，模型可能忘记自己在 plan 模式                                   | 压缩后的第一个回合补发完整版提醒；被拒消息自带指引                                                                          |
| 7   | 换模型的缓存代价           | 每次切换都全价重读一次                                                     | 缺省关闭；只在批准时切；界面提示估算费用                                                                                    |
| 8   | 新上下文执行时的信息损失   | 计划之外的调研细节会丢                                                     | 提示词要求计划自成一体（工具 A 的 ultraplan 也这样要求：给无法追问的实现者看）                                              |
| 9   | 替人审批                   | 无人值守或协调者场景，可能自动批准                                         | 缺省 `stop`；自动批准只能由用户显式配置开启；RPC 必须声明 `plans` 能力才会把审批交给客户端                                  |
| 10  | 子会话误触审批             | 工具 E #18515                                                              | 只有根会话提取计划块；子会话的计划作为 `task` 结果返回                                                                      |
| 11  | 计划文件写进项目           | 可能被误提交                                                               | 缺省写到数据目录；项目内的目录要用户显式配置                                                                                |
| 12  | 提问工具                   | 规划阶段的澄清质量取决于有没有结构化提问                                   | 本报告不展开；如果要加，同样要在会话开始时固定进工具表，并且在无人值守时退化为「采用推荐默认值并写进假设」（工具 B 的规则） |

---

## 附：主要证据位置

- ama：`src/permissions/pipeline.ts:71-76, 251-258`；`src/permissions/modes.ts`；`src/tools/todo.ts`；`src/tools/presets.ts:40-45`；`src/tools/task.ts:91`；`src/codemode/tool.ts:290`；`src/agent/session.ts:468-491`；`src/agent/system-prompt.ts:1-10`；`src/agent/transform.ts:42-70`；`src/agent/session-run.ts:100-107`；`docs/design/design.md` §5.6、§9.1；`docs/guides/permissions.md`；`docs/history/gap-audit-2026-10.md:31,120`。
- 工具 A：`本机材料` 偏移约 13 275 000–13 284 000（plan 模式附件文本）、12 604 300（提醒节奏常量）、12 617 000（附件生成）、16 453 500–16 459 500（ExitPlanMode）、16 598 600（EnterPlanMode）、9 003 500（plan_approval_request / response）、5 575 100（plansDirectory 校验）、5 084 200（规划专用模型别名）；本机 `~/.<工具A>/plans/`（16 个文件，只看了标题结构）。
- 工具 B：本机 `工具 B 0.160.0` 二进制 strings（Plan Mode (Conversational) 提示词、`<collaboration_mode>`、`update_plan` 在 Plan 模式下报错、`plan_mode_reasoning_effort`、`ProposedPlanCell`）。
- 工具 C：本机材料（README 与扩展示例源码）。
- 工具 D：（公开资料）、issue #24370、#18730。
- 工具 E：（公开资料）、issue #27683、#18515、#16276、#48157、#11078、#49879。
- 工具 F：（公开资料）；工具 G：（公开资料）；工具 H：（公开资料）；工具 I：（公开资料）；工具 J：（公开资料）、issue #5058。
