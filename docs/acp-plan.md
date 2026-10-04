# ACP 支持补全设计（对照 v1 schema 1.24.1）

> 状态：**已实施**（#110–#114、[ACP-Z] 收尾 PR，2026-10-04）。原为实施设计，基线 `main` = `e4a9fa8`（0.6.6）；现状以 [acp.md](acp.md) 为准。
> 与设计的主要偏差：① 拒答不改消息的 `stopReason`（仍以 error 收尾，TUI / print / 重试口径不变），以 `rawStopReason: "refusal"` 经 `stopReasonOf()` 判定（D12）；② `session_info_update` 在 `session/prompt` 答复**之前**发（§2.1 写的是之后）；③ 配置项的供应商可用状态由异步的 `prepareConfigOptions()` 在开会话前预解析，`buildConfigOptions()` 保持同步；④ 新会话的权限模式取进程启动时的模式，不继承当前前台会话的；⑤ 从未打开（或已 close）的 id 直接 `session/prompt` 回 -32002，不隐式打开；⑥ 客户端侧的 `$/cancel_request` 由 [ACP-D] 打开（`AcpClient` 与假 Agent），不在 C0；⑦ 有模型时 `authenticate` 也回 -32602（与认证门一致，[ACP-Z] 修正）。R8（本机 Zed 真跑）未做，见收尾 PR 描述。
> Zed 1.21 实测（2026-10-04）后的两处修正：⑧ D4 的 terminal 认证 `args` 按规范是**追加**到启动命令后面，改为 `--acp-terminal-auth <id>`（原写法在 Zed 里又进了 ACP 模式）；⑨ D8 否决的 `mode` 配置项补上——Zed 有 `configOptions` 就不再看 `modes`，不给就无法切权限模式。
> 依据：[research/acp-gap-2026-10.md](research/acp-gap-2026-10.md)（差距审计）、`/tmp/acp-v1-schema.json` / `acp-v1-meta.json`（1.24.1 稳定）、`/tmp/acp-validate/probe*.mjs`（实测脚本）、`docs/acp.md`、`docs/wave5-plan.md` §5、`docs/wave6-plan.md`（批次写法）。
> 硬约束不变：TypeScript、Node ≥ 22、**零运行时依赖**（devDependencies 不新增）、单文件 ≤ 600 行、单 bundle、i18n 严格模式（en 为形状源、zh `satisfies`、给模型的文本固定英文）、缓存前缀逐字节稳定、`src/cli/prompt-budget.test.ts` 三档不突破、**权限请求不代答**。`--mode rpc`、TUI、print、宿主（HostApi）行为不变；ACP 线上形状继续通过 schema 校验。
> 路径相对仓库根；`[ACP-x]` 为本计划批次编号（§3）。

> **与 #107 的关系**：#107（`AcpClient` 的 elicitation 与会话配置项）先于本计划合入。C0 直接沿用它的 `AcpSessionConfigOption` / `AcpConfigSelectOption` / `AcpConfigSelectGroup` / `AcpSetConfigOptionParams|Result` 与 `ACP_METHODS.sessionSetConfigOption`，不再重定义（§1.1 里同名片段以 #107 为准，只补本计划需要而它没有的字段）；`AcpClient.setConfigOption`、开会话答的 `configOptions`、假 Agent 的 `--config-options` 已有，D 只做模式回退、-32000 引导、-32800 与 diff 路径。客户端侧 elicitation 已由 #107 完成；服务端仍不发 elicitation（D16）。
>
> **未决问题的决定（2026-10-04）**：Q1–Q4 全部按推荐——allow_session 记忆本波不按会话回填；`session/close` 后再 prompt 回 -32002；`model` 选项不列没配 key 的供应商；接受 `ama auth set` 的交互式供应商选择器。

## §0 结论（决策列表）

| #   | 选择                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 理由                                                                                                                                                                                                                                | 被否方案                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **多会话 = 每个 ACP sessionId 一个常驻 `AgentSessionImpl`（`Map`），同一时刻只跑一个回合，其它会话的 `session/prompt` 进 FIFO 队列**（不再回 -32600 busy）；出队时把该会话切为「前台」（`setForegroundSession`：HostApi `session.*`、Hook 公共字段、工具工厂 `session()` 跟随，重放它自己的权限模式到共享管线，清 allow_session 记忆）。`session/new                                                                                                                                                                                          | load                                                                                                                                                                                                                                | resume                                                                                                                                    | list | set_mode | set_config_option | close`任何时候都可调，不要求空闲。排队中的 prompt 收到`session/cancel`/`session/close`→ 直接回`cancelled`。 | 这是对报告 P0-1「真正并发 vs 排队」的拍板：`PermissionPipeline.setMode` / allow_session 记忆是**进程级共享**（`session-settings.ts:99-101`、`pipeline.ts:246`），`ComposeState.session` 是工具工厂的唯一会话指针（`compose.ts:175`），HostApi / Hook 只有一个「当前会话」（`bootstrap.ts:245-258, 286-295`），`ApprovalBrokerChain` 是串行队列。真并发要把这四处都改成按会话隔离，波及 rpc / TUI；排队既修掉 -32002 与 busy，又零风险。Zed 的多线程里同时只有一个在等回复是常态。 | ① 真并发多 `AgentSession`（上述共享状态会串会话、权限模式互相覆盖）；② 报告的「最小修复」只保留空会话对象（busy 仍在，Zed 切线程时仍失败）。 |
| D2  | 启动时那个空会话仍由第一个 `session/new` 认领（黄金记录 `mode-prompt.jsonl` 的前四行不变）；之后的 `session/new` 经新的 `createSessionAlongside()` 建**兄弟会话**，不 dispose 旧会话、不跑 SessionEnd Hook。`session/close` 才 dispose（跑 SessionEnd Hook `reason: "switch"`）；stdin 关闭时按顺序 dispose 全部。空会话不落盘（现状保留），切回时从 `Map` 取，不查盘。                                                                                                                                                                       | `compose-session.ts` 的 `buildSession()` 本来就能从同一份装配材料建任意多个会话；差的只是「不替换 `record.current`」这一层。                                                                                                        | 改 `switchSession` 加 `keepOld` 参数——它的语义（Hook、dispose、`clearSessionGrants`）与多会话相反，不宜复用。                             |
| D3  | **无模型也能握手**：`runCli` 里 `--mode acp` 的 `bootstrap()` 抛 `ExitCode.NoModel` 时**不退出**，改起 `runAcpAuthGate()`：只处理 `initialize`（按客户端 `clientCapabilities.auth.terminal` 决定是否给 `authMethods`），其它会话方法先**重试一次 `bootstrap()`**（有 1 s 节流），成功则把同一条 `JsonRpcPeer` 交给 `AcpServer` 并处理当前请求，失败回 `-32000`（message = `noModelGuidance()` 文案，`data: { methods: [...] }`）。退出语义改为同 ACP 正常模式（stdin 关闭 → 0）。                                                             | 不碰 `startup-steps.resolveModel` 的「延迟化」——那会让 Runtime 带一个可空 model，影响 rpc / TUI / SDK 全部消费者。门控层只在 ACP 进程里存在；重试整段 bootstrap 代价是读配置 + 发现 skills（毫秒级），只在用户登录后发生一两次。    | ① Runtime 允许 `model: undefined`，AcpServer 在 prompt 前懒解析（改 `Runtime` 契约与 SDK）；② 退出码 4 + stderr（现状，Zed 无登录入口）。 |
| D4  | 终端认证方法（只在客户端声明 `auth.terminal` 时发）：`{ type:"terminal", id:"chatgpt", name, args:["auth","login","chatgpt"] }` 与 `{ type:"terminal", id:"api-key", name, args:["auth","set"] }`。`ama auth set` 无 provider 且 stdin 为 TTY 时弹供应商选择器（复用 `cli/choice-prompt.ts`）。不实现 `authenticate`（收到回 -32602「not an agent method」），不声明 `auth.logout`。                                                                                                                                                          | Zed 声明了 `auth.terminal`，是它唯一会给用户「登录」按钮的入口；ama 的两条登录路径（ChatGPT OAuth、API key）都已是子命令。规范：terminal 方法「MUST NOT pass to authenticate」。                                                    | agent 型 `authenticate`（ama 在 stdio 之外没有可交互的凭据输入通道，宿主模式也不发起交互登录——wave6 D16）。                               |
| D5  | **codemode 内层调用单列**：带 `parentToolCallId` 的 `tool_execution_start` 也发 `tool_call`（pending，`title` 前缀 `codemode › `，`_meta: { ama: { parentToolCallId } }`），`end` 发 `tool_call_update`。权限请求的 `toolCallId` 改用 `request.context.toolCallId`（`session-tools.ts:238` 已填，内层调用也有），不再按工具名 + 参数匹配。                                                                                                                                                                                                    | 实测孤儿 UUID 的根因就是「内层从不公布 + 退回 requestId」；`context.toolCallId` 是精确链接。ACP 没有父子关系字段，`_meta` 是规范留的扩展位，Zed 忽略即为平铺列表，条目都会收口。                                                    | 权限请求指向外层 codemode 调用——Zed 的 `upsert` 会用内层 title/rawInput 覆盖外层条目。                                                    |
| D6  | **diff 内容**：`ToolResult` 新增可选 `fileChange?: { path; oldText: string \| null; newText: string; firstChangedLine?: number }`，edit / write 填入（单侧 ≤ 256 KiB，超过不填）；`tool-runner.ts:121` 只拷 `details` 进转录，所以 **`fileChange` 不落盘**。ACP `tool_call_update(completed)` 带 `{ type:"diff", path, oldText, newText }` + 4 KB 文本；`locations[].line = firstChangedLine`。回放（`session/load`）没有 diff，只有文本。                                                                                                    | edit 手里有改前 / 改后全文（`edit.ts:254-256`），write 已读旧文（`write.ts:68`）；放进 `details` 会把整文件写进会话 JSONL（`tool-runner.ts:121`），不可取。                                                                         | ① 放 `details`（落盘膨胀）；② ACP 层事后读文件再反推旧文（不可靠）。                                                                      |
| D7  | **状态顺序**：映射器收到 `permission_request`（带 `context.toolCallId`）时发 `tool_call_update { status:"pending" }`，`permission_resolved(allow)` 后再发 `in_progress`；`tool_execution_start` 仍立即发 `in_progress`（无审批时顺序不变）。                                                                                                                                                                                                                                                                                                  | 工具运行器的 `tool_execution_start` 在门禁之前（`tool-runner.ts:342-357`），改它会影响 TUI / RPC 的事件序；在 ACP 层用两个已有事件纠正，线上多两条更新但语义正确。                                                                  | 改 `runToolBatch` 把 start 挪到门禁后（改变 rpc 事件时序与黄金记录）。                                                                    |
| D8  | **config options**：`model`（select，category `model`，按供应商分组 `SessionConfigSelectGroup`，值 `provider/model-id`；只列已有 key / 本地可用的供应商，`fake` 按 `hideFakeProvider` 规则）与 `thinking`（select，category `thought_level`，按当前模型支持的级别过滤）。**不**再给 `mode` 类别的 config option——模式继续只走 `modes`。无 boolean 项（故不看 `session.configOptions.boolean`）。`set_config_option` → `session.setModel()` / `setThinkingLevel()`；`model_changed` / `thinking_level_changed` 事件 → `config_option_update`。 | 两个选择器同一状态会在 Zed 出现两处模式切换；规范说 category 只是 UX 提示、不参与正确性。模型目录可能很大，分组 + 过滤后与 TUI `/model` 选择器口径一致。                                                                            | 报告建议的三项（含 mode）。                                                                                                               |
| D9  | **available_commands**：会话 new / load / resume 响应之后发一次 `available_commands_update`：skills → `skill:<name>`（description；`disableModelInvocation` 不影响人用），提示模板 → `<name>`（`argumentHint` → `input.hint`）。不列内置斜杠命令。                                                                                                                                                                                                                                                                                            | 这两类在 ACP 的 prompt 文本里**已经可用**（`expandPrompt` 走 `expandSkillCommand` / `expandPromptCommand`），只是客户端不知道；内置命令（`/new`、`/compact`…）在 ACP 下不执行（`commands-core` 是 line / TUI 的），列出来就是谎话。 | 把 `/compact` 等接进 ACP prompt（另立项）。                                                                                               |
| D10 | **`$/cancel_request` 两侧**：`JsonRpcPeer` 新选项 `cancelRequests?: boolean`（ACP 两侧 true，Codex app-server false）：本端 `request()` 的 `signal` abort 时发 `$/cancel_request { requestId }`；入站 `$/cancel_request` abort 对应 `IncomingRequestContext.signal`，处理器此后抛错一律回 `-32800`。AcpServer 的 `session/prompt` 被 `$/cancel_request` 取消 → 等价 `session/cancel`，但响应是 `-32800`（规范「Request cancelled」）。审批超时 / 回合中断时 Zed 的对话框因此会关掉。                                                          | 现在 `jsonrpc.ts:86-110` 的 abort 只本地拒绝；审批 10 分钟超时后 Zed 对话框残留是实测问题。                                                                                                                                         | 只做出站（入站 MAY，但做了才能让客户端撤回挂起的 prompt）。                                                                               |
| D11 | `session/list`：按请求 `cwd` 过滤（缺省本目录；给了别的 cwd 回空列表，不报错），`cursor` = `updatedAt\|sessionId` 的 base64，每页 50，`nextCursor`；非法 cursor → -32602。`title` = 会话名，否则首条提示**去掉 `<resource …>…</resource>` 块后的首行 ≤ 80 字**。每回合结束发 `session_info_update { title?, updatedAt }`（title 只在变化时带）。                                                                                                                                                                                              | 规范 SHOULD 对非法 cursor 报错；Zed 用 `session_info_update` 刷线程标题。                                                                                                                                                           | 自动生成标题（模型调用，成本与前缀无关但多一次请求，另议）。                                                                              |
| D12 | 其它 P2：`prompt()` 的 catch 分支里 `cancelRequested` → 回 `cancelled`；`StopReason` 加 `"refusal"`（Anthropic `stop_reason: "refusal"` 映射，其它供应商不产生），ACP 回 `refusal`；回放 toolResult 带 4 KB 文本；`tool_call.name` 补上；模式 `name` / `description` 走 `permissionModeLabel()` 与 `msg().permissions.modeDescription`；收到 `mcpServers` / `additionalDirectories` 时 stderr 一行并在文档写明偏离 MUST 的理由；`PromptResponse.usage` 文档改为 unstable（线上照发，`drivers/acp/types.ts:215` 注释改）。                     | 均为小改，照报告。                                                                                                                                                                                                                  | —                                                                                                                                         |
| D13 | **客户端侧**：`pickModeId` 在 Agent 没有 `modes` 时看 `configOptions` 里 `category:"mode"` 的 select，并以 `session/set_config_option` 设置；`-32000` 时错误文案列出 `authMethods` 名称（terminal 方法附 `args`）；取消回合时 `-32800` 视为 `cancelled`；diff 内容的 `path` 计入 `filesTouched`；入站 `$/cancel_request` 让挂起的权限对话框关掉（回 `cancelled`）。                                                                                                                                                                           | 报告 §3 的四个缺口。                                                                                                                                                                                                                | 客户端也实现 `set_config_option` 选模型（ama 作客户端由 `task` 的 `model` 决定，暂不透传）。                                              |
| D14 | **schema 校验进仓库，不加 devDependency**：`test/fixtures/acp/schema-v1.24.1.json`（官方全文 175 KB 原样）+ `test/helpers/acp-schema.ts` 手写最小校验器（只需 `type / $ref / properties / required / additionalProperties / allOf / anyOf / oneOf / const / enum / items / minimum / maximum / not`，`x-*`、`format`、`discriminator`、`default`、`unevaluatedProperties` 忽略，约 180 行）。`validateAcpWire(lines)` 对四份黄金记录与各批次的新用例逐条校验，并以 `/tmp/acp-validate/probe.mjs` 的 ajv 结果做一次交叉比对（C0 验收）。       | 官方 schema 的关键字集合很小（统计见 §4），手写足够；用户要求零运行时依赖且提到此方案。                                                                                                                                             | ajv 作 devDependency（更稳，但 `check-no-deps` 的精神是「不引入第三方 JSON 工具链」，先不加；若手写校验器出现误报再换）。                 |
| D15 | 文案：新建领域文件 `src/i18n/messages/acp.ts`（C0 把 `print.acp.*` 整体迁入，`catalog.ts` 登记），各批次在自己的子对象里加键（`acp.auth.*` A、`acp.session.*` B、`acp.tools.*` C、`acp.config.*` / `acp.client.*` D）。发给 ACP 客户端的 name / description / error message 是给人看的，走 i18n；`_meta`、id、value 等机器字段不翻译。                                                                                                                                                                                                        | wave6 D23 同一做法；`print.ts` 已经承载三个模式的文案。                                                                                                                                                                             | 各批次继续往 `print.ts` 加键（冲突面大）。                                                                                                |
| D16 | 有意不做并写进 `docs/acp.md`「偏离与不做」节：客户端 `fs/*`、`terminal/*`；MCP（含 stdio MUST）；elicitation；`session/delete`；`logout`；`cwd` 固定为启动目录。                                                                                                                                                                                                                                                                                                                                                                              | 报告结论；维持。                                                                                                                                                                                                                    | —                                                                                                                                         |
| D17 | 黄金记录：`test/fixtures/acp/mode-prompt.jsonl` 会因 C（`name`）、D（`configOptions`、`available_commands_update`）各变一次——它是生成文件，**每个改变它的批次合并时 `UPDATE_GOLDEN=1` 重录并逐条过 schema 校验**，收尾 `[ACP-Z]` 最后再录一次定稿。驱动侧三份 `driver-*.jsonl` 只有 D 改（`$/cancel_request` 出站）。                                                                                                                                                                                                                         | 并行批次无法预先约定字节；schema 校验保证每次重录都合规。                                                                                                                                                                           | 冻结黄金让后合者手改（易错）。                                                                                                            |

## §1 契约（`[ACP-C0]` 先落地，之后批次只消费）

### §1.1 `src/drivers/acp/types.ts`（现 323 行，+约 100 行）

```ts
export const ACP_METHODS = {
  …现有…,
  authenticate: "authenticate",
  sessionSetConfigOption: "session/set_config_option",
  cancelRequest: "$/cancel_request",
} as const;

export const RPC_ERRORS = { …现有…, requestCancelled: -32800 } as const;

// initialize
export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  session?: { configOptions?: { boolean?: Record<string, unknown> | null } | null } | null;
  auth?: { terminal?: boolean };
}
export type AcpAuthMethod =
  | { type?: "agent"; id: string; name: string; description?: string | null }
  | { type: "terminal"; id: string; name: string; description?: string | null;
      args?: string[]; env?: Record<string, string> };
export interface AcpAgentCapabilities { …现有…; auth?: { logout?: Record<string, unknown> | null } }

// config options（只用 select；boolean 类型声明但 ama 不发）
export type AcpConfigCategory = "mode" | "model" | "model_config" | "thought_level" | (string & {});
export interface AcpConfigSelectOption { value: string; name: string; description?: string | null }
export interface AcpConfigSelectGroup { group: string; name: string; options: AcpConfigSelectOption[] }
export type AcpSessionConfigOption =
  | { type: "select"; id: string; name: string; description?: string | null; category?: AcpConfigCategory | null;
      currentValue: string; options: AcpConfigSelectOption[] | AcpConfigSelectGroup[] }
  | { type: "boolean"; id: string; name: string; description?: string | null; category?: AcpConfigCategory | null;
      currentValue: boolean };
export type AcpSetConfigOptionParams =
  { sessionId: string; configId: string } & ({ type?: "value_id"; value: string } | { type: "boolean"; value: boolean });
export interface AcpSetConfigOptionResult { configOptions: AcpSessionConfigOption[] }
export interface AcpNewSessionResult { sessionId: string; modes?: …; configOptions?: AcpSessionConfigOption[] | null }
// Load/Resume 结果同样加 configOptions

// tool call
export interface AcpToolCall { …现有…; name?: string | null; _meta?: Record<string, unknown> | null }
export interface AcpAvailableCommand { name: string; description: string; input?: { hint: string } | null }
export type AcpSessionUpdate =
  | …现有…
  | { sessionUpdate: "available_commands_update"; availableCommands: AcpAvailableCommand[] }
  | { sessionUpdate: "config_option_update"; configOptions: AcpSessionConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null };

export interface AcpCancelRequestParams { requestId: string | number | null }
/** ama 自己的 _meta 命名空间（客户端 MUST 不假设其含义）。 */
export const ACP_META_KEY = "ama" as const;
export interface AcpAmaMeta { parentToolCallId?: string }
```

`AcpPromptUsage` 的注释改为「UNSTABLE（1.24.1 仍只在 schema.unstable.json）」。

### §1.2 `src/drivers/jsonrpc.ts`（C0 实现，+约 50 行）

```ts
export interface JsonRpcPeerOptions {
  …现有…;
  /** 协议级取消（ACP `$/cancel_request`）：缺省 false（Codex app-server 不认）。 */
  cancelRequests?: boolean;
}
// request(): signal abort 时若 cancelRequests → send({ method: "$/cancel_request", params: { requestId: id } })，本地仍以 aborted 拒绝
// onLine(): 通知 method === "$/cancel_request" 且 cancelRequests → inflight.get(requestId)?.abort()，不再转给 onNotification
// handleRequest(): 每个入站请求一个 AbortController（与 lifetime 合成 ctx.signal）；处理器抛错且 ctx.signal.aborted → 错误码 -32800
```

### §1.3 `src/cli/compose-session.ts`（C0：`bridgeEvent` 迁到新文件 `src/cli/compose-events.ts` 腾出约 90 行，再加约 60 行）

```ts
/** 不替换当前会话、不 dispose、不跑 SessionEnd Hook 地再建一个会话（ACP 多会话）。 */
export async function createSessionAlongside(
  target: Runtime | AgentSession,
  request: Extract<SwitchRequest, { kind: "new" | "resume" }>,
): Promise<AgentSessionImpl>;
// new: SessionManager.create(sessionDirForCwd(…)) 或 inMemory；resume: openSession({kind:"resume",id})
// 调 buildSession(record, manager, current.model(), current.thinkingLevel())；records.set(next, record)
// 发 events.emit("session_start", { …, reason: "new" | "resume" }) 并跑 SessionStart Hook（additionalContext 存进 per-session Map）

/** 把宿主 / Hook / 工具工厂的「当前会话」切到 session；清 allow_session 记忆；返回是否真的切换了。 */
export function setForegroundSession(
  target: Runtime | AgentSession,
  session: AgentSessionImpl,
): boolean;
// record.current = session; record.state.session = session; assembly.onSessionReplaced(session);
// record.hookContext = () => contexts.get(session)；PermissionPipeline.clearSessionGrants()

/** 释放一个兄弟会话（SessionEnd Hook reason "switch" → dispose）；若它是前台则前台置为 fallback。 */
export async function disposeSessionAlongside(
  target: Runtime | AgentSession,
  session: AgentSessionImpl,
  fallback: AgentSessionImpl,
): Promise<void>;
```

`switchSession()` 行为不变（rpc / TUI 不受影响）。`SessionRecord` 加 `hookContexts: WeakMap<AgentSession, string | undefined>`。

### §1.4 `src/tools/types.ts`（C0，+约 15 行）

```ts
/** [ACP-C0] 文件改动的改前 / 改后全文：只随 tool_execution_end 事件走，不入转录（tool-runner 只拷 details）。 */
export interface FileChange { path: string; oldText: string | null; newText: string; firstChangedLine?: number }
export const FILE_CHANGE_TEXT_LIMIT = 256 * 1024;
export interface ToolResult { …现有…; fileChange?: FileChange }
```

### §1.5 `src/ai/types.ts`（C0，1 行）

`export type StopReason = "stop" | "length" | "toolUse" | "aborted" | "error" | "refusal";` ——消费者 `switch` 都有 default，加成员不破坏；Anthropic 映射由 B 做。

### §1.6 ACP 服务端骨架（C0 建文件，批次填实现）

```ts
// src/modes/acp/acp-connection.ts [C0]：peer + 协商结果，门控与服务端共用
export interface AcpConnection {
  readonly peer: JsonRpcPeer;                 // cancelRequests: true
  clientCapabilities: AcpClientCapabilities;  // initialize 后填
  readonly initialized: boolean;
}
export function createAcpConnection(streams: { input; output }, log: (m: string) => void,
  handlers: { onRequest(method, params, ctx): Promise<unknown>; onNotification(method, params): void }): AcpConnection;

// src/modes/acp/acp-server.ts [B 拥有]：构造签名改为
constructor(runtime: Runtime, connection: AcpConnection, log?: (message: string) => void)
/** 门控交接：由 runAcpAuthGate 在 bootstrap 成功后调用，处理本次请求。 */
handle(method: string, params: Params): Promise<unknown>   // 由 private 改 public

// src/modes/acp/acp-config.ts [C0 建壳返回空实现，D 填]
export function buildConfigOptions(session: AgentSession, providers: ProviderRegistryApi, env: NodeJS.ProcessEnv): AcpSessionConfigOption[];
export async function applyConfigOption(session: AgentSession, params: AcpSetConfigOptionParams): Promise<void>; // 未知 id / value → RpcError invalidParams
export function availableCommands(resources: LoadedResources): AcpAvailableCommand[];

// src/modes/acp/acp-events.ts [C 拥有]：C0 先只加签名
export class AcpEventMapper {
  constructor(cwd: string, emit: (u: AcpSessionUpdate) => void, session: () => AgentSession,
              extras: () => { configOptions: AcpSessionConfigOption[]; commands: AcpAvailableCommand[] });
  /** 会话 new / load / resume 响应发出后由服务端调：available_commands_update + config_option_update。 */
  announce(): void;
  /** 回合结束后由服务端调：session_info_update（title 变化时带 title）。 */
  emitSessionInfo(title: string | null, updatedAt: string): void;
}
```

### §1.7 测试契约（C0）

- `test/fixtures/acp/schema-v1.24.1.json`（官方全文原样复制）。
- `test/helpers/acp-schema.ts`：`validateAcp(def: string, value: unknown): string[]`（错误列表，空即通过）与 `assertAcpWire(wire: readonly WireLine[])`（按 `probe.mjs` 的 RESP 映射逐条判定 request / response / notification / error 应套的 `$defs`，含 `$/cancel_request` → `CancelRequestNotification`、`session/set_config_option` → `SetSessionConfigOptionRequest|Response`、`authenticate`）。
- `src/modes/acp/acp-mode.test.ts` 的四份黄金与 `driver-*.jsonl` 在 C0 里先全部过 `assertAcpWire`（现状 0 失败，作为基线）。
- `src/drivers/acp/testing/fake-agent.ts`（C0 加标记，D 使用）：`--config-only`（不给 `modes`，给 `configOptions` 的 mode 类别）、`--auth-required`（`session/new` 回 -32000，`initialize` 给一条 terminal 方法）、`[cancel-request]`（权限挂起 2 s 后 Agent 自己发 `$/cancel_request` 撤回）。

### §1.8 `src/i18n/messages/acp.ts`（C0）

迁入现有 `print.acp.*`（引用处 `msg().print.acp` → `msg().acp.core`），预留子对象 `auth / session / tools / config / client` 为空壳；`catalog.ts` 登记。各批次按 D15 在各自子对象加键，属「多批次各加、后合者 rebase」文件。

### §1.9 C0 的其它一行改动

- `src/acp.ts`：导出新类型（`type *` 已覆盖）与 `ACP_META_KEY`。
- `src/cli/bootstrap.ts` `runCli`：`catch (error)` 里 `if (acp && isStartupError(error) && error.exitCode === ExitCode.NoModel) return (await import("../modes/acp/acp-auth-gate.js")).runAcpAuthGate(args, deps, io);`（A 实现文件，C0 先放 stub 返回 `reportError`）。

## §2 行为细节

### §2.1 会话池与队列（B）

```text
AcpServer
  sessions: Map<sessionId, { session: AgentSessionImpl; mapper: AcpEventMapper; unsubscribe; mode: PermissionMode; title?: string }>
  queue: { sessionId; params; resolve; reject; cancelled: AbortController }[]
  running: sessionId | undefined
```

- `session/prompt`：会话不存在 → -32002；入队并立即返回 Promise；`drain()`：取队首，`setForegroundSession()`（真的切换时若 `state.permissionMode !== entry.mode` 调 `session.setPermissionMode(entry.mode)`——会发一条 `current_mode_update`，Zed 本来就显示该线程的模式），`session.prompt(...)`，结束按现逻辑回 stopReason，再 `mapper.emitSessionInfo()`，继续下一条。
- `session/cancel`：目标在跑 → `abort()`；在队列 → 出队、回 `{ stopReason: "cancelled", usage: 零 }`。
- `session/set_mode`：记进 `entry.mode`；目标是前台 → 立即 `setPermissionMode`；否则只记（出队时应用），但仍发 `current_mode_update`（直接 `emit`，不经会话）。
- `session/close`：在跑 → abort 并等 idle；在队列 → cancelled；`disposeSessionAlongside()`；从 `Map` 删除。再对该 id prompt → -32002（规范语义；现状是「重新打开」，文档写明变化）。
- `session/load` 回放时另一会话在跑：回放只是通知，照常发。
- stdin 关闭：`finish()` 对所有会话 abort / waitForIdle / dispose（队列全部 cancelled）。
- `_meta`：请求里带的忽略；响应不发（除 D5 的 `tool_call._meta`）。

### §2.2 认证门（A）

```text
runCli ── bootstrap 抛 NoModel ──▶ runAcpAuthGate(args, deps, io)
  initialize ──▶ { protocolVersion:1, agentCapabilities: ACP_AGENT_CAPABILITIES, authMethods: caps.auth?.terminal ? TERMINAL_METHODS : [], agentInfo }
  authenticate ──▶ -32602 "terminal auth methods are not passed to authenticate"
  session/* ──▶ 距上次失败 ≥ 1 s 则 bootstrap(args, deps, io)
      成功 ──▶ server = new AcpServer(runtime, connection); 之后 onRequest 全部转 server.handle；本次请求也交给它
      失败(NoModel) ──▶ -32000 { message: noModelGuidance(), data: { authMethods: [...ids] } }
      失败(其它) ──▶ 对应 RpcError internalError，并 stderr
  其它 ──▶ -32601
  stdin 关闭 ──▶ 若已交接，走 AcpServer 的退出；否则退出 0
```

`takeOverStdout()` 在门控启动前先调用（bootstrap 期间宿主 / Hook 的 `console.log` 不再可能污染 stdout——顺手修掉报告 §4 的低概率风险）。

### §2.3 事件映射增补（C）

| ama 事件                                            | 新增 / 变化                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `message_update.toolcall_end`                       | `tool_call` 加 `name`                                                                                                |
| `tool_execution_start`（带 parent）                 | `tool_call { pending, name, title: "codemode › bash: …", _meta: { ama: { parentToolCallId } } }`，随后 `in_progress` |
| `permission_request`（`context.toolCallId` 已公布） | `tool_call_update { status: "pending" }`                                                                             |
| `permission_resolved`（allow / allow_session）      | `tool_call_update { status: "in_progress" }`                                                                         |
| `tool_execution_end`（任意层）                      | `content: [diff?, text]`，`locations[].line`，`rawOutput` 不发（4 KB 文本已够）                                      |
| `model_changed` / `thinking_level_changed`          | `config_option_update`（取 `extras().configOptions`）                                                                |
| 回放 toolResult                                     | 带 4 KB 文本                                                                                                         |
| `permissionModes()`                                 | `name: permissionModeLabel(id)`、`description: msg().permissions.modeDescription[...]`                               |

`AcpServer.askClient` 的 `toolCallId = request.context?.toolCallId ?? mapper.toolCallIdFor(...) ?? request.requestId`；`toolTitle` 对内层加前缀。

### §2.4 客户端（D）

- `AcpClient.initialize` 声明 `clientCapabilities.session.configOptions: {}`（无 boolean）；不声明 `auth.terminal`（ama 作客户端没有可交互终端可借）。
- `setConfigOption(sessionId, configId, value)`；`AcpDriverSession.start`：`pickModeId` 失败且 `configOptions` 有 `category:"mode"` 的 select → 选 value id 与 ama 模式映射同名者并 `setConfigOption`。
- `-32000`：`AmaError("agent_auth_required", msg().acp.client.authRequired(agentId, methods))`，方法列表来自 `initResult.authMethods`（terminal 的附 `ama 路径 + args` 提示让用户在终端里跑）。
- `prompt` 的错误 `-32800` 且 `cancelling` → `turn.result("cancelled")`。
- `pushAcpUpdate`：`content[].type === "diff"` 的 `path` 并入 `locations`（`TurnCollector` 现有 `filesTouched` 口径）。
- 入站 `$/cancel_request`：`JsonRpcPeer` 已处理（ctx.signal abort → `onPermission` 的 signal 触发 → 回 `cancelled`）。

## §3 实施批次

C0 先合；A、B、C、D 之后并行，文件互不重叠；Z 收尾。

### `[ACP-C0]` 契约（§1 全部）

| 文件（唯一属主 C0）                                                                                                                                                                                                                                                           | 内容                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/drivers/acp/types.ts`、`src/drivers/jsonrpc.ts`、`src/drivers/jsonrpc.test.ts`（新）                                                                                                                                                                                     | §1.1、§1.2；测试：出站 abort 发 `$/cancel_request`、入站取消 → -32800、Codex 形状（`cancelRequests` 缺省）逐字节不变                |
| `src/cli/compose-session.ts`、`src/cli/compose-events.ts`（新，`bridgeEvent` 搬迁）、`src/cli/compose-session.test.ts`                                                                                                                                                        | §1.3；测试：兄弟会话不 dispose 旧会话、`setForegroundSession` 后 HostApi / Hook / 工具工厂跟随、`switchSession` 行为不变            |
| `src/tools/types.ts`、`src/ai/types.ts`                                                                                                                                                                                                                                       | §1.4、§1.5                                                                                                                          |
| `src/modes/acp/acp-connection.ts`（新）、`acp-config.ts`（新，空实现）、`acp-auth-gate.ts`（新，stub）、`acp-server.ts`（只改构造签名与 `handle` 可见性）、`acp-mode.ts`（用 `createAcpConnection`）、`acp-events.ts`（只加 `announce` / `emitSessionInfo` 空实现与构造参数） | §1.6（之后 server 归 B、events 归 C、config 归 D、gate 归 A）                                                                       |
| `src/i18n/messages/acp.ts`（新）、`catalog.ts`、`print.ts`（删 acp 段）、引用处                                                                                                                                                                                               | §1.8                                                                                                                                |
| `test/fixtures/acp/schema-v1.24.1.json`、`test/helpers/acp-schema.ts`、`test/helpers/acp-schema.test.ts`                                                                                                                                                                      | §1.7；验收：四份黄金 0 失败，且与 `/tmp/acp-validate/results.json` 的逐条结论一致                                                   |
| `src/drivers/acp/testing/fake-agent.ts`                                                                                                                                                                                                                                       | 三个新标记（行为），`docs/acp.md`「测试替身」表同步                                                                                 |
| `src/cli/bootstrap.ts`（`runCli` 一处 catch）、`src/acp.ts`                                                                                                                                                                                                                   | §1.9                                                                                                                                |
| `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 未发布段                                                                                                                                                                                                                                | 建「Unreleased」节，列契约级变化（`ToolResult.fileChange`、`StopReason.refusal`、`JsonRpcPeer.cancelRequests`、`AcpClient` 新类型） |

完成标准：`pnpm ci` 绿；`mode-prompt.jsonl` 等黄金**字节不变**（C0 不改线上形状）；`prompt-budget.test.ts` 不变；rpc / TUI 测试不变。

### `[ACP-A]` 握手与认证门（P0-2、D3、D4）

| 文件所有权                                                                                        | 改动                                                                                          |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/modes/acp/acp-auth-gate.ts`、`acp-auth-gate.test.ts`（新）                                   | §2.2；`TERMINAL_AUTH_METHODS` 常量；节流；交接                                                |
| `src/cli/subcommands/auth.ts`、`auth.test.ts`                                                     | `ama auth set` 无 provider + TTY → `choicePrompt` 选内置需 key 的供应商；非 TTY 仍 UsageError |
| `src/i18n/messages/acp.ts` → `acp.auth.*`                                                         | 方法 name / description、-32000 文案（复用 `noModelGuidance`）、交接后 stderr 提示            |
| `docs/acp.md`「无模型时」节、`docs/en/acp.md`（新，A 建骨架并翻译全文现状，之后批次各改自己的节） | 退出码 4 → 握手 + -32000；Zed 配置示例；终端登录流程                                          |
| CHANGELOG ×2                                                                                      | 一条                                                                                          |

测试：隔离 HOME 下 `--mode acp` 无 key：`initialize`（声明 / 不声明 `auth.terminal` 两种）→ `session/new` 回 -32000 且 `data.authMethods`；写入 `auth.json`（fake 供应商不需 key，用「先无 `--model`、后在 HOME 写 `config.json` 的 `defaultModel: fake/echo`」模拟登录成功）→ 再 `session/new` 成功并能 prompt；`authenticate` → -32602；全部线上行过 `assertAcpWire`。完成标准：实测 `node dist/bundle/ama.cjs --mode acp`（无模型）stdout 有 initialize 响应、退出码 0。

### `[ACP-B]` 多会话与会话元数据（P0-1、P2-11/12/13/15，D1、D2、D11、D12）

| 文件所有权                                                                                                                                                                                          | 改动                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modes/acp/acp-server.ts`（预计超 400 行 → 拆出）、`acp-sessions.ts`（新：池 + 队列 + 列表分页 / 标题）、`acp-sessions.test.ts`（新）、`acp-mode.ts`（finish 遍历全部会话）、`acp-mode.test.ts` | §2.1；`list()` 过滤 / 分页 / 标题；catch 分支 cancelled；`refusal`；mcpServers / additionalDirectories stderr 一行；调用 `mapper.announce()`（new / load / resume 后）与 `emitSessionInfo()` |
| `src/ai/apis/anthropic*.ts`（stop_reason `refusal` 映射，一处）                                                                                                                                     | D12                                                                                                                                                                                          |
| `src/i18n/messages/acp.ts` → `acp.session.*`                                                                                                                                                        | queued、closed、ignoredMcp、ignoredDirs、invalidCursor                                                                                                                                       |
| `docs/acp.md`「`ama --mode acp`」表 + 新「多会话」节、`docs/en/acp.md` 同节                                                                                                                         | 文档                                                                                                                                                                                         |
| CHANGELOG ×2                                                                                                                                                                                        | 一条（含行为变化：close 后再 prompt 报 -32002）                                                                                                                                              |

测试（`acp-mode.test.ts` / `acp-sessions.test.ts`）：报告实测的复现用例「新建 s3（空）→ 旧会话 prompt → s3 prompt」成功；运行中 `session/new` + 对新会话 prompt → 排队，第一个结束后第二个开始，两者 `session/update.sessionId` 各归其位；排队中 cancel → cancelled；两会话不同 `set_mode`，各自出队时 `current_mode_update` 正确且前台会话的 `runtime.permission.mode` 对应；close 后 prompt → -32002；list 分页与非法 cursor；标题去 `<resource>`；`session_info_update`；fake 脚本 `stopReason: refusal`（若 fake provider 不支持则加）。黄金 `mode-prompt.jsonl` 预计不变（B 不改单会话单回合形状，`session_info_update` 在 turn 后——会多一行，则重录）。完成标准：实测脚本 §4 的多会话场景无 -32600 / -32002。

### `[ACP-C]` 工具可视化（P1-3/4/7、P2-10/14/17，D5、D6、D7）

| 文件所有权                                                                                                                                                                                                   | 改动                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `src/modes/acp/acp-events.ts`（预计接近 400 行；`toolTitle / toolKind / toolLocations / resultText` 拆到 `acp-tool-text.ts`）、`acp-events.test.ts`（新，直接喂 `SessionEvent` 序列断言 `AcpSessionUpdate`） | §2.3                                                                           |
| `src/tools/edit.ts`、`edit.test.ts`、`src/tools/write.ts`、`write.test.ts`                                                                                                                                   | 填 `fileChange`（上限、BOM / CRLF 用原始文本）；`write` 新文件 `oldText: null` |
| `src/agent/tool-runner.test.ts`（一条：`fileChange` 不进 `toolResult` 消息）                                                                                                                                 | 守住 D6 的「不落盘」                                                           |
| `src/i18n/messages/acp.ts` → `acp.tools.*`                                                                                                                                                                   | `codemodePrefix`、truncated 迁移                                               |
| `docs/acp.md`「事件映射」「审批」节、`docs/en/acp.md` 同节、`docs/codemode.md` 一句                                                                                                                          | 文档                                                                           |
| CHANGELOG ×2                                                                                                                                                                                                 | 一条                                                                           |

测试：codemode 脚本（复用 `probe-codemode.mjs` 的脚本，走 `composeHarness` + `sandboxCapability`）→ 权限请求的 `toolCallId` 等于某条已发 `tool_call` 的 id，且该 id 最终 `completed`；edit → `content` 含 `diff` 且 `oldText/newText` 正确、`locations[0].line`；超限文件无 diff；审批路径状态序列 `pending → in_progress → pending → in_progress → completed`；`tool_call.name`；回放带文本。`mode-prompt.jsonl` 重录（`name` 字段）。

### `[ACP-D]` 配置项、命令表与客户端侧（P1-5/6/8/9、P2-18，D8、D9、D10 客户端、D13）

| 文件所有权                                                                                                | 改动                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/modes/acp/acp-config.ts`、`acp-config.test.ts`（新）                                                 | `buildConfigOptions`（分组、过滤、`hideFakeProvider`）、`applyConfigOption`、`availableCommands` |
| `src/drivers/acp/client.ts`、`client.test.ts`、`driver.ts`、`driver.test.ts`、`src/drivers/turn.ts`       | §2.4                                                                                             |
| `src/i18n/messages/acp.ts` → `acp.config.*`、`acp.client.*`                                               | 选项 name / description（`Model`、`Thinking level`）、authRequired 文案                          |
| `docs/acp.md`「配置项与命令」节、「作为客户端」节、`docs/en/acp.md` 同节、`docs/agents.md` 模式映射表一行 | 文档                                                                                             |
| `test/fixtures/acp/driver-*.jsonl`（重录：initialize 多了 `session.configOptions`）                       | `UPDATE_GOLDEN=1`                                                                                |
| CHANGELOG ×2                                                                                              | 一条                                                                                             |

B 在服务端接 `session/set_config_option` → `applyConfigOption` → 回 `{ configOptions: buildConfigOptions(...) }`（B 只调用、不实现；C0 的空实现让 B 可独立测试）。测试：fake 供应商下选项含 `fake/echo`、设未知值 -32602、设模型后 `config_option_update`；`--config-only` 假 Agent 下 plan 模式映射走 `set_config_option`；`--auth-required` 下错误文案含方法名；`[cancel-request]` 下权限对话框 `cancelled`、回合正常结束；`-32800` → cancelled。黄金：`mode-prompt.jsonl` 重录（`configOptions` + `available_commands_update` 一行）。

### `[ACP-Z]` 收尾（A–D 合入后）

- `UPDATE_GOLDEN=1` 最终重录四份黄金，`assertAcpWire` 全过；`docs/acp.md` / `docs/en/acp.md` 通读合并（表格一次性对齐）；`docs/gap-audit-2026-10.md` 若引用 ACP 现状则更新；CHANGELOG 两份把 Unreleased 条目归并到发版号；`drivers/acp/types.ts:215` 注释、`docs/acp.md:45` 的 usage 误述改掉；§4 实测脚本跑一遍，结果写进 PR 描述。

### 共享文件规则

| 文件                                  | 规则                                                 |
| ------------------------------------- | ---------------------------------------------------- |
| `src/i18n/messages/acp.ts`            | 各批次只在自己的子对象里加键，后合者 rebase          |
| `docs/acp.md`、`docs/en/acp.md`       | A 建 en 骨架；各批次只改自己的节；Z 统稿             |
| `CHANGELOG.md`、`CHANGELOG.zh-CN.md`  | 各加一条，后合者 rebase                              |
| `test/fixtures/acp/mode-prompt.jsonl` | 生成文件，谁改线上形状谁重录（C、D、可能 B），Z 定稿 |
| `src/modes/acp/acp-mode.test.ts`      | B 拥有；A / C / D 用自己的新测试文件                 |

## §4 验收

每批：`pnpm ci` 绿；本批新用例的线上行全部过 `assertAcpWire`；`prompt-budget.test.ts` 三档不变（本计划不碰系统提示与工具表——`fileChange` 不进请求体；`refusal` 只是枚举）；`rpc-mode.test.ts`、TUI 帧黄金、`contracts*.test.ts` 不变；受影响文件 ≤ 600 行。

整体（Z 执行，思路同 `/tmp/acp-validate/probe.mjs`，不发真实模型请求）：

1. `pnpm build` 后以临时目录为 cwd、隔离 `HOME` / `AMA_CONFIG_DIR` / `AMA_DATA_DIR`，`AMA_FAKE_SCRIPT` 指向脚本，起 `node dist/bundle/ama.cjs --mode acp --model fake/echo`，`clientCapabilities: { auth: { terminal: true }, session: { configOptions: {} } }`。
2. 场景与断言（全部线上行逐条过 ajv，与仓库内手写校验器结论一致）：
   - 无模型：不带 `--model`、无 key → `initialize` 有两条 terminal 方法；`session/new` → -32000；写入 `config.json` `defaultModel: "fake/echo"` 后再 `session/new` 成功；进程退出码 0。
   - 多会话：s1 prompt（fake `delayMs: 3000`）运行中 `session/new` s2 → 成功；对 s2 prompt → 排队；`session/list`；s1 结束后 s2 开始；两条 `session/prompt` 都 `end_turn`；对排队中的 s3 发 `session/cancel` → `cancelled`。
   - 空会话切回：复现报告用例，不再 -32002。
   - codemode：`probe-codemode.mjs` 脚本 → 两次权限请求的 `toolCallId` 都在已发 `tool_call` 集合里且最终 `completed`。
   - edit：`tool_call_update` 含 `diff`；`session/load` 回放不含 diff 但含文本。
   - config：`session/set_config_option { configId: "thinking", value: "high" }` → `config_option_update`；未知 → -32602。
   - 命令表：`available_commands_update` 含 `skill:<内置 skill>`。
   - 取消：权限挂起时客户端发 `$/cancel_request` 撤回 prompt → prompt 响应 -32800、挂起的 `session/request_permission` 被 Agent 以 `$/cancel_request` 撤回。
   - 负向：`authenticate` → -32602；`session/delete`、`logout` → -32601；别的 cwd → -32602；`mcpServers` 非空 → 成功 + stderr 一行。
3. 作为客户端：`task(agent="acp:ama")` 现有 `external-rpc.test.ts` 黄金不变（客户端 initialize 多声明 `session.configOptions` 会改 `external.out.jsonl`？——它记录的是 rpc 侧事件而非 ACP 线路，预计不变；若变则 D 重录并说明）。

## §5 风险与未决问题

| #   | 风险 / 问题                                                                                                                                                                                                          | 处置                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 权限模式是共享管线状态：排队模型下只在出队时重放，**排队中的会话收到 `set_mode` 不会立刻改变正在运行的那条**（预期行为，文档写明）。                                                                                 | B 的测试覆盖；若将来要真并发，先把 `PermissionPipeline` 的 mode / grants 改为按会话键控（独立 RFC）。                                     |
| R2  | `setForegroundSession` 切换会 `clearSessionGrants()`：A 会话里「本会话允许」的 bash 前缀在切到 B 再切回 A 后失效。                                                                                                   | 可接受（与 TUI `/resume` 一致）；或在 `acp-sessions.ts` 里按会话缓存并回填——留作未决 Q1。                                                 |
| R3  | 门控期重试 `bootstrap()` 会重复发 `session_start` 宿主事件 / SessionStart Hook（每次尝试都走第 14 步才失败？不——第 11 步模型解析先失败，第 13/14 步不会执行），所以无副作用；但 `ensurePaths` / 发现 skills 重复跑。 | 1 s 节流；测试断言失败路径不触发 Hook。                                                                                                   |
| R4  | 终端认证的 `args` 让 Zed 以 `ama auth login chatgpt` 起子进程：`--profile` / `--auth-file` 等启动参数不会自动带上。                                                                                                  | 方法 `args` 里追加 `--auth-file <path>`（当 `args.authFile` 给了时）；`--profile` 的 `authFile` 同理。未决 Q2：是否也带 `--lang`。        |
| R5  | `fileChange` 内存：256 KiB × 2 随事件走，TUI / RPC 不消费但会经过 `bridgeEvent`（rpc 的 `tool_result` 事件不含 result）——确认 rpc 模式不会把 `result` 整体序列化出去（`rpc-mode` 的 `tool_execution_end` 投影）。    | C0 测试里加一条「rpc `tool_execution_end` 事件不含 `fileChange`」。                                                                       |
| R6  | 手写 schema 校验器误报 / 漏报。                                                                                                                                                                                      | C0 用 `/tmp/acp-validate/results.json` 的 134 条做交叉比对；对 `allOf + properties` 的组合（ACP 用它表达 `sessionUpdate` 判别）要特别测。 |
| R7  | `mode-prompt.jsonl` 多批次重录造成的合并噩梦。                                                                                                                                                                       | D17：生成文件、合并时重录；Z 定稿。                                                                                                       |
| R8  | Zed 对 `config_option_update` 的渲染位置、对 `_meta.ama` 的忽略、`session_info_update` 的标题刷新均来自读代码（Zed 1.21 本机 vs main 源码），置信度中。                                                              | Z 用本机 Zed 1.21 真跑一次（配置 `agent_servers.ama`），记录到 PR。                                                                       |
| Q1  | 是否把 allow_session 记忆按会话缓存回填（R2）。推荐：本波不做。                                                                                                                                                      |                                                                                                                                           |
| Q2  | `session/close` 后再 prompt 的语义改为 -32002（规范）还是保留「重开」（现状）。推荐：-32002，Zed 关线程后不会再用那个 id。                                                                                           |                                                                                                                                           |
| Q3  | `model` 选项是否列出需要 key 但未配置 key 的供应商（选中后请求会 401）。推荐：不列；文档指向 `ama auth set`。                                                                                                        |                                                                                                                                           |
| Q4  | 是否接受 `ama auth set` 的交互式供应商选择器（A 的范围外延）。推荐：接受，20 行以内。                                                                                                                                |                                                                                                                                           |
