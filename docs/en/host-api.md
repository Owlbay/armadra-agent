# Host adapter API (@armadra/agent/host)

English · [简体中文](../host-api.md)

> Translated from the Chinese [docs/host-api.md](../host-api.md) as of commit `979608b`. When the two differ, the Chinese
> version is authoritative.

A host adapter is a local JS module that ama loads at startup and hands a `HostApi`. With it the adapter can register tools, append to the system prompt, observe events, answer approvals, inject user messages and show notifications and status in the interface. The Armadra canvas plugs in as a host adapter (the canvas tools `canvas_*` / `context_*` are all registered by the adapter). The types are defined in `src/host/types.ts` and exported from `@armadra/agent/host`; `HOST_API_VERSION = 1`. The design rationale is in [design.md](../design.md) §6.2, §6.3 and §11.1 step 13 (Chinese).

## Module shape

```js
// my-host.mjs
export const hostApi = 1;
export function create(api) {
  if (!api.env.MY_HOST_ENABLED) return undefined; // not activated: ama falls back to plain standalone mode
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

- Export `hostApi` (must equal `HOST_API_VERSION`) and `create(api)`; they may also sit on the default export (ESM `export default { hostApi, create }` or CJS `module.exports = { hostApi, create }`).
- `create` activates the adapter by returning a `HostAdapter` (`{ id: string, dispose?() }` with a non-empty `id`); returning `undefined` means "not activated this time". It may be async.
- `dispose()` is called on exit (after the `session_shutdown` event) and is idempotent.

## Loading

- Source: `--host <module>` or the profile's `host` (the command line wins); relative paths resolve against cwd.
- `.mjs` uses dynamic `import()`; `.cjs` uses `require`; `.js` tries `require` first and falls back to `import()` on ESM errors (`ERR_REQUIRE_ESM` etc.). The single-file build `ama.cjs` can load ESM adapters too.
- Timing: step 13 of the startup sequence, after config, resources, the model and the tool registry are ready and before the session is assembled. Tools and instructions registered in `create()` enter the system prompt and tool table of the first request, so the prefix is stable from the first request on.
- Failures:

| Case                                                       | Exit code |
| ---------------------------------------------------------- | --------- |
| File missing, loading throws, `hostApi` / `create` missing | 6         |
| `hostApi` differs from `HOST_API_VERSION`                  | 78        |
| `create()` throws or does not return within 10 seconds     | 6         |
| The returned adapter has no `id`                           | 6         |

## HostApi

| Member                                          | Description                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                       | `HOST_API_VERSION`                                                                                                                                                                                   |
| `agent`                                         | `{ name: "ama", version }`                                                                                                                                                                           |
| `env`                                           | A frozen copy of the environment variables at startup                                                                                                                                                |
| `mode`                                          | `interactive` / `line` / `print` / `rpc`                                                                                                                                                             |
| `session.id()` / `file()` / `cwd()` / `model()` | The current session (follows the new session after a switch); `file()` is `undefined` until the first request is written to disk                                                                     |
| `tools.register(tool)`                          | Register a tool (shape below); the name must match `^[a-z][a-z0-9_]{1,63}$`, and an existing name throws `tool_exists`. A prefix is recommended (`canvas_*`)                                         |
| `tools.disable(name)`                           | Hide a built-in tool (Armadra disables `task`, for example); the tools section of the system prompt stops listing it                                                                                 |
| `tools.list()`                                  | All current tool names                                                                                                                                                                               |
| `instructions.add(source)`                      | Append to the final `host` section of the system prompt; `{ kind: "file", path }` or `{ kind: "text", text, name? }`                                                                                 |
| `events.on(name, handler)`                      | Observe events (table below); returns an unsubscribe function                                                                                                                                        |
| `approvals.setBroker(broker)`                   | Set the approval answerer (see "Approvals")                                                                                                                                                          |
| `messages.sendUser(text, origin?)`              | Inject a user message: when idle it starts a run (`"started"`), while running it is queued as a steer (`"queued"`); `origin` defaults to `"host"`, is persisted on the message and shown as `↳ host` |
| `ui.notify(message, level?)`                    | Goes to the message area in interactive / line mode; becomes a `notification` event in rpc mode (with a copy on stderr); written to stderr in print mode                                             |
| `ui.setStatus(key, text?)`                      | A host item in the status bar; an empty or missing `text` removes the key                                                                                                                            |
| `log(level, message, detail?)`                  | Logging; `warn` / `error` go to stderr                                                                                                                                                               |
| `cache?.onWarmingDecision(handler)`             | Veto hook for cache warming (see "Cache warming"); an optional facet missing in older runtimes, so check `api.cache !== undefined` before use                                                        |

During `create()` the session is not assembled yet: `session.*` returns the values fixed at startup, and `sendUser` is rejected with `busy`. To send a message at startup, wait for the `session_start` event.

### Tool definition

```ts
interface ToolDefinition<I = unknown> {
  name: string;
  label?: string; // TUI title
  description: string;
  parameters: JsonSchema;
  permission: "read" | "write" | "execute"; // class used by the permission pipeline
  executionMode?: "sequential" | "parallel"; // default: read runs in parallel, the rest sequentially
  annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  promptSnippet?: string; // one line in the system prompt's tools section
  promptGuidelines?: string[]; // system prompt rules section
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
  renderCall?(input: I, width: number): string[];
  renderResult?(result: ToolResult, width: number, expanded: boolean): string[];
}
interface ToolResult {
  content: string | ContentBlock[];
  isError?: boolean;
  details?: unknown; // persisted, never enters the context
  structured?: unknown; // return value of tools.<name>() in codemode scripts
  terminate?: boolean; // the run ends early only when every result in the batch sets it
}
```

`ToolContext` provides `toolCallId`, `cwd`, `sessionId`, `sessionFile?`, `signal`, `depth`, `model?`, `thinkingLevel?`, `outputDir?`, `onUpdate(partial)` (output while running), `readFiles` / `markRead`, `activeTools?` (read-only snapshot of the session's active tool set, so tools can give actionable hints), `tools.executeTool(name, input)` (nested calls through the same pipeline), `session.appendCustom` / `lastCustom` (custom entries that never enter the context, see [session-format.md](../session-format.md), Chinese), `spawnSubagent?` and `log`.

Host tools take the same path as built-in tools: schema validation → command hook PreToolUse → permission pipeline (classified by `permission`) → approval → execution → PostToolUse. They can also be called from codemode scripts as `tools.<name>()`.

## Events

`events.on` handlers only observe: a throw is just logged and does not affect the run; handlers are called and awaited in order, and `session_shutdown` is awaited (so you can clean up before exit).

| Event                                                             | Payload                                                                                          | Source                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`                                                   | `sessionId`, `sessionFile?`, `cwd`, `reason: startup \| resume \| new \| fork`                   | Startup and session switches                                                                                                             |
| `before_agent_start`                                              | `prompt`                                                                                         | After the user prompt is expanded, before the run starts                                                                                 |
| `agent_start` / `turn_start` / `turn_end` / `agent_before_settle` | `{}`                                                                                             | Runs and turns                                                                                                                           |
| `agent_end`                                                       | `stopReason`, `willRetry`                                                                        |                                                                                                                                          |
| `agent_settled`                                                   | `warning?`                                                                                       | The run has fully ended                                                                                                                  |
| `tool_call`                                                       | `toolCallId`, `toolName`, `input`                                                                | A tool starts executing (permission already granted)                                                                                     |
| `tool_result`                                                     | `toolCallId`, `toolName`, `isError`                                                              | A tool finished executing                                                                                                                |
| `tool_approval_requested`                                         | `requestId`, `toolName`                                                                          | Approval needed                                                                                                                          |
| `tool_approval_resolved`                                          | `requestId`, `decision`                                                                          | Approval decided                                                                                                                         |
| `session_compact`                                                 | `tokensBefore`                                                                                   | Compaction succeeded                                                                                                                     |
| `model_select`                                                    | `model: { provider, id }`                                                                        | Model switched                                                                                                                           |
| `hook_executed`                                                   | `event`, `command`, `exitCode`, `durationMs`                                                     | Each command hook finished                                                                                                               |
| `cache_miss`                                                      | `missedTokens`, `missedCost?`, `reason`, `detail?`, `idleMs`                                     | A cache miss (including those below the interface threshold)                                                                             |
| `context_pressure`                                                | `percent`, `threshold: 70 \| 90`, `remainingTokens?`, `estimatedTurnsLeft?`                      | Context usage crossed 70% / 90%                                                                                                          |
| `quota_update`                                                    | `provider`, `planType?`, `primary?`, `secondary?` (`{ usedPercent, resetsAt?, windowMinutes? }`) | ChatGPT subscription quota updated ([W6-O]; an exhausted quota has its own error code `quota_exceeded`, an expired login `auth_expired`) |
| `session_shutdown`                                                | `{}`                                                                                             | Before exit (followed by the SessionEnd hook and `dispose`)                                                                              |

For token-level streaming content or the full event stream, use RPC or the SDK's `subscribe`; host events are a trimmed set.

## Approvals

`approvals.setBroker({ ask(request, signal) })`: when a tool call needs confirmation, the approval chain asks **the host broker → the UI (TUI dialog / RPC client / SDK callback) → deny when nobody answers**, in that order.

- `ask` answers by returning `"allow"` / `"deny"` / `"allow_session"`; returning `undefined` passes to the next answerer; a throw counts as deny.
- `request`: `requestId`, `toolName`, `input`, `reason: "mode" | "dangerous" | "hook"`, `hookReason?`, `preview?` (the pre-execution preview, see [rpc.md](rpc.md) "Approvals"), `context?` (`depth > 0` means it comes from a `task` sub-agent; codemode inner calls carry `parentToolCallId`).
- On timeout (10 minutes by default, `AMA_APPROVAL_TIMEOUT_MS`) or when the run is interrupted, `signal` aborts and the decision is deny. Approvals are serial: only one request waits at a time.
- Timing: the broker is looked up at each approval, so it can be set in `create()` or set / replaced at any later time; the last `setBroker` wins.
- The host broker only decides "who answers an ask"; it cannot loosen deny rules, command hook denies or dangerous-command detection ([design.md](../design.md) §6.3, Chinese).

## Cache warming

`api.cache.onWarmingDecision(handler)` calls `handler(decision)` with the built-in decision before every cache warming request:

```ts
interface WarmDecision {
  action: "warm" | "stop"; // built-in decision
  phase: "streaming" | "idle";
  promptTokens: number; // input + cacheRead + cacheWrite of the last real request
  warmCost: number | undefined; // cost of one warming request (USD)
  missCost: number | undefined; // extra cost if the cache expires without warming
  probability: number; // probability that another request follows after expiry: streaming 1, idle 0.15
  reason?: string; // reason for stop
}
```

Return `"warm"` / `"stop"` (a Promise is fine). `"stop"` skips the request and stops this warming round (when the built-in decision was warm, the stop reason is recorded as `declined`); `"warm"` can override a built-in stop. If the handler fails, the built-in decision applies. With several handlers, the last one registered and not unsubscribed wins; the return value is an unsubscribe function. The warming mechanism itself is described in [providers.md](providers.md) "Caching".

## Exit

- Process exit: `session_shutdown` event (awaited) → SessionEnd hook (`reason: "exit"`) → `adapter.dispose()` → session dispose. A throw from `dispose` is only logged as a warning.
- `/new`, `/resume`, `/fork` and RPC session switches: the adapter stays active and no `session_shutdown` is sent; the order is SessionEnd hook (`new` / `switch`) → old session dispose → `session_start` of the new session → SessionStart hook. `api.session.*` then points to the new session.

## Embedding in Armadra

Armadra starts ama with a profile: `ama --profile <path>`. The profile's `host` points to its adapter (`ama-armadra.cjs`) and also carries instructions, skillDirs, hooksFile, authFile, sessionDir and `trustProject`. The adapter returns `undefined` when `ARMADRA_NODE_ID` is missing, so the same profile behaves as plain ama outside the canvas.

Interface defaults with a profile: `ui.quietStartup: "header"` and `ui.statusLine: "compact"` (the last line is the status bar, which the host parses by `·`). The agent bar (`ui.agentBar`) is no longer off by default; it is `auto` as in a standalone terminal. A host that shows sub-tasks itself and does not want the bar writes `{ "ui": { "agentBar": "off" } }` into the config file its profile's `config` points to.

Contract details are in [docs/design/coordinator-agent.md](https://github.com/yovinchen/Armadra/blob/main/docs/design/coordinator-agent.md) in the Armadra repository.
