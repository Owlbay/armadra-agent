# 宿主适配器 API（@armadra/agent/host）

宿主适配器是一个本地 JS 模块，ama 启动时加载它并交给它一个 `HostApi`：它可以注册工具、追加系统提示、观察事件、回答审批、注入用户消息、在界面上显示通知与状态。Armadra 画布就是以宿主适配器的形式接入的（画布工具 `canvas_*` / `context_*` 都由适配器注册）。类型定义在 `src/host/types.ts`，从 `@armadra/agent/host` 导出，`HOST_API_VERSION = 1`。设计依据见 [design.md](../design/design.md) §6.2、§6.3、§11.1 第 13 步。

## 模块形状

```js
// my-host.mjs
export const hostApi = 1;
export function create(api) {
  if (!api.env.MY_HOST_ENABLED) return undefined; // 不激活：ama 退化为普通独立模式
  api.tools.register({
    name: "my_lookup",
    description: "Look up a ticket by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    permission: "read",
    async execute(input) {
      return { content: `ticket ${input.id}: …` };
    },
  });
  api.instructions.add({
    kind: "text",
    name: "my-host",
    text: "Tickets live in the tracker; use my_lookup.",
  });
  api.events.on("agent_settled", () => api.ui.setStatus("my-host", "idle"));
  return { id: "my-host", dispose() {} };
}
```

- 导出 `hostApi`（必须等于 `HOST_API_VERSION`）与 `create(api)`；也可以放在默认导出（ESM `export default { hostApi, create }` 或 CJS `module.exports = { hostApi, create }`）。
- `create` 返回 `HostAdapter`（`{ id: string, dispose?() }`，`id` 非空）激活；返回 `undefined` 表示本次不激活。可以是 async。
- `dispose()` 在退出时调用（`session_shutdown` 事件之后），幂等。

## 加载

- 来源：`--host <模块>` 或 profile 的 `host`（命令行优先）；相对路径按 cwd 解析。
- `.mjs` 用动态 `import()`；`.cjs` 用 `require`；`.js` 先 `require`，遇到 ESM（`ERR_REQUIRE_ESM` 等）再 `import()`。单文件发行版 `ama.cjs` 里同样能加载 ESM 适配器。
- 时机：启动序列第 13 步——配置、资源、模型与工具注册表就绪之后，组装会话之前。`create()` 里注册的工具与指令进入首个请求的系统提示与工具表，前缀从第一个请求起就稳定。
- 失败：

| 情形                                          | 退出码 |
| --------------------------------------------- | ------ |
| 文件不存在、加载抛错、缺 `hostApi` / `create` | 6      |
| `hostApi` 不等于 `HOST_API_VERSION`           | 78     |
| `create()` 抛错或 10 秒内未返回               | 6      |
| 返回的适配器缺 `id`                           | 6      |

## HostApi

| 成员                                            | 说明                                                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                       | `HOST_API_VERSION`                                                                                                                            |
| `agent`                                         | `{ name: "ama", version }`                                                                                                                    |
| `env`                                           | 启动时环境变量的冻结副本                                                                                                                      |
| `mode`                                          | `interactive` / `line` / `print` / `rpc`                                                                                                      |
| `session.id()` / `file()` / `cwd()` / `model()` | 当前会话（换会话后跟随新会话）；`file()` 在首次请求落盘前为 `undefined`                                                                       |
| `tools.register(tool)`                          | 注册工具（形状见下）；名字须匹配 `^[a-z][a-z0-9_]{1,63}$`，同名已存在抛 `tool_exists`。建议加前缀（`canvas_*`）                               |
| `tools.disable(name)`                           | 隐藏内置工具（如 Armadra 禁用 `task`），系统提示的工具节随之不再列它                                                                          |
| `tools.list()`                                  | 当前全部工具名                                                                                                                                |
| `instructions.add(source)`                      | 追加到系统提示最后的 `host` 节；`{ kind: "file", path }` 或 `{ kind: "text", text, name? }`                                                   |
| `events.on(name, handler)`                      | 观察事件（下表），返回注销函数                                                                                                                |
| `approvals.setBroker(broker)`                   | 设置审批回答者（见「审批」）                                                                                                                  |
| `messages.sendUser(text, origin?)`              | 以 user 消息注入：空闲时开始一次运行（`"started"`），运行中按 steer 入队（`"queued"`）；`origin` 缺省 `"host"`，落盘在消息上，界面标 `↳ host` |
| `ui.notify(message, level?)`                    | 交互 / line 模式进消息区；rpc 模式变成 `notification` 事件（stderr 另有一份）；print 模式写 stderr                                            |
| `ui.setStatus(key, text?)`                      | 状态栏的宿主项；`text` 为空或缺省则移除该键                                                                                                   |
| `log(level, message, detail?)`                  | 日志；`warn` / `error` 写 stderr                                                                                                              |
| `cache?.onWarmingDecision(handler)`             | 缓存保温的否决钩子（见「缓存保温」）；可选面，旧版本运行时没有它，用前判断 `api.cache !== undefined`                                          |

`create()` 期间会话还没组装完：`session.*` 返回启动时确定的值，`sendUser` 会以 `busy` 拒绝——要在启动时发消息，等 `session_start` 事件之后再调用。

### 工具定义

```ts
interface ToolDefinition<I = unknown> {
  name: string;
  label?: string; // TUI 标题
  description: string;
  parameters: JsonSchema;
  permission: "read" | "write" | "execute"; // 权限管线的分类
  executionMode?: "sequential" | "parallel"; // 缺省 read 并行、其余串行
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  promptSnippet?: string; // 系统提示 tools 节一行
  promptGuidelines?: string[]; // 系统提示 rules 节
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
  renderCall?(input: I, width: number): string[];
  renderResult?(result: ToolResult, width: number, expanded: boolean): string[];
}
interface ToolResult {
  content: string | ContentBlock[];
  isError?: boolean;
  details?: unknown; // 落盘，不进上下文
  structured?: unknown; // codemode 脚本里 tools.<name>() 的返回值
  terminate?: boolean; // 整批结果都为 true 才提前结束本次运行
}
```

`ToolContext` 提供 `toolCallId`、`cwd`、`sessionId`、`sessionFile?`、`signal`、`depth`、`model?`、`thinkingLevel?`、`outputDir?`、`onUpdate(partial)`（运行中输出）、`readFiles` / `markRead`、`activeTools?`（会话活动集的只读快照，工具据此给可执行的提示）、`tools.executeTool(name, input)`（嵌套调用，受同一管线）、`session.appendCustom` / `lastCustom`（不进上下文的 custom 条目，见 [session-format.md](session-format.md)）、`spawnSubagent?`、`log`。

宿主工具与内置工具走同一条路径：schema 校验 → 命令式 Hook PreToolUse → 权限管线（按 `permission` 分类）→ 审批 → 执行 → PostToolUse。在 codemode 脚本里也能以 `tools.<name>()` 调用。

## 事件

`events.on` 的处理器只观察：抛错只记日志，不影响运行；处理器依次调用并等待，`session_shutdown` 被 await（退出前可以做清理）。

| 事件                                                              | 载荷                                                                                              | 来源                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `session_start`                                                   | `sessionId`、`sessionFile?`、`cwd`、`reason: startup \| resume \| new \| fork`                    | 启动与换会话                                                                                 |
| `before_agent_start`                                              | `prompt`                                                                                          | 用户提示展开后、运行开始前                                                                   |
| `agent_start` / `turn_start` / `turn_end` / `agent_before_settle` | `{}`                                                                                              | 运行与回合                                                                                   |
| `agent_end`                                                       | `stopReason`、`willRetry`                                                                         |                                                                                              |
| `agent_settled`                                                   | `warning?`                                                                                        | 运行彻底结束                                                                                 |
| `tool_call`                                                       | `toolCallId`、`toolName`、`input`                                                                 | 工具开始执行（已通过权限）                                                                   |
| `tool_result`                                                     | `toolCallId`、`toolName`、`isError`                                                               | 工具执行结束                                                                                 |
| `tool_approval_requested`                                         | `requestId`、`toolName`                                                                           | 需要审批                                                                                     |
| `tool_approval_resolved`                                          | `requestId`、`decision`                                                                           | 审批结论                                                                                     |
| `session_compact`                                                 | `tokensBefore`                                                                                    | 压缩成功                                                                                     |
| `model_select`                                                    | `model: { provider, id }`                                                                         | 切换模型                                                                                     |
| `hook_executed`                                                   | `event`、`command`、`exitCode`、`durationMs`                                                      | 每条命令式 Hook 结束                                                                         |
| `cache_miss`                                                      | `missedTokens`、`missedCost?`、`reason`、`detail?`、`idleMs`                                      | 一次缓存未命中（含低于界面门槛的）                                                           |
| `context_pressure`                                                | `percent`、`threshold: 70 \| 90`、`remainingTokens?`、`estimatedTurnsLeft?`                       | 上下文占用跨过 70% / 90%                                                                     |
| `quota_update`                                                    | `provider`、`planType?`、`primary?`、`secondary?`（`{ usedPercent, resetsAt?, windowMinutes? }`） | ChatGPT 订阅配额更新（[W6-O]；配额耗尽另有错误码 `quota_exceeded`，登录失效 `auth_expired`） |
| `session_shutdown`                                                | `{}`                                                                                              | 退出前（之后跑 SessionEnd Hook、`dispose`）                                                  |

需要逐 token 的流式内容或完整事件流时用 RPC 或 SDK 的 `subscribe`，宿主事件是精简过的。

## 审批

`approvals.setBroker({ ask(request, signal) })`：工具调用需要确认时，审批链依次问**宿主 broker → UI（TUI 对话框 / RPC 客户端 / SDK 回调）→ 无人作答 deny**。

- `ask` 返回 `"allow"` / `"deny"` / `"allow_session"` 作答；返回 `undefined` 交给下一个回答者；抛错按 deny。
- `request`：`requestId`、`toolName`、`input`、`reason: "mode" | "dangerous" | "hook"`、`hookReason?`、`preview?`（执行前预览，见 [rpc.md](rpc.md)「审批」）、`context?`（`depth > 0` 表示来自 `task` 子 Agent；codemode 内层调用带 `parentToolCallId`）。
- 超时（缺省 10 分钟，`AMA_APPROVAL_TIMEOUT_MS`）或运行被中断时 `signal` abort，结论为 deny。审批串行，同一时刻只有一个请求在等。
- 时机：broker 每次审批时现取，可以在 `create()` 里设，也可以之后任何时候设或替换；最后一次 `setBroker` 生效。
- 宿主 broker 只决定「谁来回答 ask」，不能放宽 deny 规则、命令式 Hook 的 deny 与危险命令识别（[design.md](../design/design.md) §6.3）。

## 缓存保温

`api.cache.onWarmingDecision(handler)` 在每次缓存保温请求前以内置决策调用 `handler(decision)`：

```ts
interface WarmDecision {
  action: "warm" | "stop"; // 内置决策
  phase: "streaming" | "idle";
  promptTokens: number; // 上一次真实请求的 input + cacheRead + cacheWrite
  warmCost: number | undefined; // 一次保温的花费（美元）
  missCost: number | undefined; // 不保温而失效时多付的金额
  probability: number; // 失效后仍会再发请求的概率：streaming 1、idle 0.15
  reason?: string; // stop 的原因
}
```

返回 `"warm"` / `"stop"`（可以是 Promise）。返回 `"stop"` 即不发并停止本轮保温（内置决策本是 warm 时，停止原因记为 `declined`）；返回 `"warm"` 可以覆盖内置的 stop。处理器出错回落内置决策。注册多个时最后注册且未注销的那个生效；返回值是注销函数。保温机制本身见 [providers.md](../guides/providers.md)「缓存」。

## 退出

- 进程退出：`session_shutdown` 事件（await）→ SessionEnd Hook（`reason: "exit"`）→ `adapter.dispose()` → 会话 dispose。`dispose` 抛错只记 warning。
- `/new`、`/resume`、`/fork` 与 RPC 换会话：适配器保持激活，不发 `session_shutdown`；顺序是 SessionEnd Hook（`new` / `switch`）→ 旧会话 dispose → 新会话的 `session_start` → SessionStart Hook。`api.session.*` 随之指向新会话。

## 嵌入 Armadra

Armadra 用 profile 启动 ama：`ama --profile <path>`，profile 的 `host` 指向它的适配器（`ama-armadra.cjs`），另带 instructions、skillDirs、hooksFile、authFile、sessionDir、`trustProject`。适配器在 `ARMADRA_NODE_ID` 缺失时返回 `undefined`，同一个 profile 在画布外退化为普通 ama。

有 profile 时的界面缺省：`ui.quietStartup: "header"`、`ui.statusLine: "compact"`（最后一行是状态栏，宿主按 `·` 解析）。Agent 栏（`ui.agentBar`）不再缺省关闭，与独立终端一样是 `auto`；宿主自己展示子任务、不要栏时在 profile 的 `config` 指向的配置文件里写 `{ "ui": { "agentBar": "off" } }`。

契约细节见 Armadra 仓库 [docs/design/coordinator-agent.md](https://github.com/yovinchen/Armadra/blob/main/docs/design/coordinator-agent.md)。
