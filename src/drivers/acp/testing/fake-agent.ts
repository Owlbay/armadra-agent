/**
 * 黄金记录用的假 ACP Agent（docs/history/wave5-plan.md §5.1、§5.7）。[W5-E]
 *
 * 零依赖、不联网、不碰文件系统；行为由提示文本里的标记决定，供 ama 自己的测试与 Armadra 复用
 * （`@armadra/agent/acp` 导出 {@link runFakeAcpAgent} 与可执行入口路径）：
 *
 * | 提示里含         | 行为                                                                              |
 * | ---------------- | --------------------------------------------------------------------------------- |
 * | （无标记）       | `agent_message_chunk` 回 `echo: <文本>`，`usage_update`，`end_turn`               |
 * | `[permission]`   | `tool_call`(edit, pending) → `session/request_permission`（四个选项）→ 按结果     |
 * |                  | `tool_call_update` completed / failed；客户端回 cancelled 时本回合 `cancelled`    |
 * | `[slow]`         | 一直等，直到 `session/cancel` → `cancelled`                                       |
 * | `[plan]`         | 先发 `plan`（两条）再回文本                                                      |
 * | `[think]`        | 先发 `agent_thought_chunk`                                                        |
 * | `[refuse]`       | `refusal`                                                                         |
 * | `[elicit]`       | `elicitation/create`（选颜色的表单）→ 回 `elicit: <action> <content JSON>`；客户端    |
 * |                  | 没声明 `elicitation` 能力时回 `elicit: unsupported`；`cancel` 时本回合 `cancelled` |
 * | `[model]`        | 回 `model <当前模型>`（`configOptions` 关着时是 `model none`）                     |
 * | `[env NAME]`     | 回 `env NAME <值的 sha256 | absent>`（测环境变量到没到，不回显值）                  |
 * | `[cancel-request]` | 同 `[permission]` 发权限请求，挂起 `cancelRequestMs`（缺省 2 s）后自己发            |
 * |                  | `$/cancel_request` 撤回；`tool_call_update` failed，回 `permission withdrawn`、`end_turn` |
 *
 * `configOptions: true`（可执行入口 `--config-options`）：开会话答一个 `model` 配置项（分组 `fast` 里有
 * `small`、`big` 里有 `large`，当前 `small`），`session/set_config_option` 可改；缺省不答，线路与之前相同。
 * `configOnly: true`（`--config-only`）：开会话不答 `modes`，改在 `configOptions` 里给 category `mode` 的
 * 选择项（id `mode`），经 `session/set_config_option` 切换；可与 `configOptions` 同开（两项都给）。
 * `authRequired: true`（`--auth-required`）：`initialize` 给一条 terminal 型认证方法，开会话
 * （new / load / resume）一律回 -32000。
 *
 * 会话：`session/new` 发 `fake-<n>`；`session/resume` / `session/load` 接受任何 `fake-` 开头的 id
 * （load 先回放一条用户消息与一条回复）；`session/list` 列本进程建过的会话。
 */

import { createHash } from "node:crypto";
import { ACP_METHODS, ACP_PROTOCOL_VERSION, RPC_ERRORS, type AcpAuthMethod } from "../types.js";
import type {
  AcpContentBlock,
  AcpElicitationResult,
  AcpSessionConfigOption,
  AcpPromptParams,
  AcpRequestPermissionResult,
  AcpSessionUpdate,
} from "../types.js";
import { JsonRpcPeer, RpcError } from "../../jsonrpc.js";

export interface FakeAcpAgentOptions {
  /** `initialize` 回的 agentInfo.name，缺省 `fake-acp-agent`。 */
  name?: string;
  /** 不声明 resume / list / close / loadSession（测降级路径）。 */
  minimal?: boolean;
  /** 开会话答 `configOptions`（一个 `model` 选择项）并接 `session/set_config_option`。 */
  configOptions?: boolean;
  /** 不答 `modes`，模式改由 `configOptions` 里 category `mode` 的选择项给出。 */
  configOnly?: boolean;
  /** `initialize` 给 terminal 型认证方法，开会话回 -32000。 */
  authRequired?: boolean;
  /** `[cancel-request]` 撤回权限请求前等多久（毫秒，缺省 2000）。 */
  cancelRequestMs?: number;
}

/** `authRequired` 时 `initialize` 给的认证方法。 */
export const FAKE_AUTH_METHOD: AcpAuthMethod = {
  type: "terminal",
  id: "login",
  name: "Log in",
  description: "Run the fake agent's login command",
  args: ["--login"],
};

interface FakeSession {
  id: string;
  cwd: string;
  mode: string;
  model: string;
  /** 当前回合的取消器。 */
  turn?: AbortController | undefined;
  turns: number;
}

const MODES = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
];

/** 规范要求选项全部平铺或全部分组（不能混排），所以 `small` 也放进一组。 */
const MODELS: AcpSessionConfigOption["options"] = [
  { group: "fast", name: "Fast", options: [{ value: "small", name: "Small" }] },
  { group: "big", name: "Big", options: [{ value: "large", name: "Large", description: "slow" }] },
];
const MODEL_VALUES = ["small", "large"];
const MODE_VALUES = MODES.map((m) => m.id);

/** 一个表单：必填的颜色（枚举）与可选的数量。 */
const ELICIT_SCHEMA = {
  type: "object",
  properties: {
    color: { type: "string", enum: ["red", "blue"] },
    count: { type: "integer", minimum: 1 },
  },
  required: ["color"],
} as const;

function textOf(blocks: readonly AcpContentBlock[]): string {
  return blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("");
}

function waitAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** 在给定流上跑假 Agent；输入流结束时 resolve。 */
export function runFakeAcpAgent(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  options: FakeAcpAgentOptions = {},
): Promise<void> {
  const sessions = new Map<string, FakeSession>();
  let counter = 0;
  /** 客户端在 initialize 里声明了 elicitation。 */
  let canElicit = false;
  const configOf = (s: FakeSession): AcpSessionConfigOption[] => [
    ...(options.configOnly === true
      ? [
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: s.mode,
            options: MODES.map((m) => ({ value: m.id, name: m.name })),
          },
        ]
      : []),
    ...(options.configOptions === true
      ? [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: s.model,
            options: MODELS,
          },
        ]
      : []),
  ];
  const hasConfig = options.configOptions === true || options.configOnly === true;
  /** 开会话答复里的 `configOptions`（关着时不加这个键）。 */
  const config = (s: FakeSession): { configOptions?: AcpSessionConfigOption[] } =>
    hasConfig ? { configOptions: configOf(s) } : {};
  /** 开会话答复里的 `modes`（`configOnly` 时不给）。 */
  const modes = (s: FakeSession) =>
    options.configOnly === true ? {} : { modes: { currentModeId: s.mode, availableModes: MODES } };
  const requireAuth = (): void => {
    if (options.authRequired === true)
      throw new RpcError(RPC_ERRORS.authRequired, "authentication required");
  };
  const update = (sessionId: string, value: AcpSessionUpdate): Promise<void> =>
    peer.notify(ACP_METHODS.sessionUpdate, { sessionId, update: value });
  const session = (id: unknown): FakeSession => {
    const found = typeof id === "string" ? sessions.get(id) : undefined;
    if (found === undefined)
      throw new RpcError(RPC_ERRORS.resourceNotFound, `unknown session: ${String(id)}`);
    return found;
  };
  const open = (id: string, cwd: string): FakeSession => {
    const created: FakeSession = { id, cwd, mode: "default", model: "small", turns: 0 };
    sessions.set(id, created);
    return created;
  };

  const prompt = async (params: AcpPromptParams): Promise<unknown> => {
    const s = session(params.sessionId);
    const turn = new AbortController();
    s.turn = turn;
    s.turns += 1;
    const text = textOf(params.prompt);
    const usage = { inputTokens: 10 * s.turns, outputTokens: 5, totalTokens: 10 * s.turns + 5 };
    const done = (stopReason: string): unknown => {
      s.turn = undefined;
      return { stopReason, usage };
    };
    if (text.includes("[think]"))
      await update(s.id, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking…" },
      });
    if (text.includes("[plan]"))
      await update(s.id, {
        sessionUpdate: "plan",
        entries: [
          { content: "read", priority: "high", status: "completed" },
          { content: "write", priority: "medium", status: "pending" },
        ],
      });
    if (text.includes("[refuse]")) return done("refusal");
    const say = (line: string): Promise<void> =>
      update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } });
    if (text.includes("[elicit]")) {
      if (!canElicit) {
        await say("elicit: unsupported");
        return done("end_turn");
      }
      let answer: AcpElicitationResult;
      try {
        answer = await peer.request<AcpElicitationResult>(ACP_METHODS.elicitationCreate, {
          sessionId: s.id,
          message: "Pick a color",
          requestedSchema: ELICIT_SCHEMA,
        });
      } catch {
        return done("cancelled");
      }
      await say(`elicit: ${answer.action} ${JSON.stringify(answer.content ?? null)}`);
      return done(answer.action === "cancel" ? "cancelled" : "end_turn");
    }
    if (text.includes("[model]")) {
      await say(`model ${options.configOptions === true ? s.model : "none"}`);
      return done("end_turn");
    }
    const env = /\[env ([A-Z0-9_]+)\]/.exec(text);
    if (env !== null) {
      const value = process.env[env[1]!];
      const digest =
        value === undefined ? "absent" : createHash("sha256").update(value).digest("hex");
      await say(`env ${env[1]} ${digest}`);
      return done("end_turn");
    }
    if (text.includes("[slow]")) {
      await waitAbort(turn.signal);
      return done("cancelled");
    }
    if (text.includes("[cancel-request]")) {
      const toolCallId = `call-${s.turns}`;
      await update(s.id, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Write note.txt",
        kind: "edit",
        status: "pending",
      });
      const withdraw = new AbortController();
      const timer = setTimeout(() => withdraw.abort(), options.cancelRequestMs ?? 2000);
      const asked = peer
        .request<AcpRequestPermissionResult>(
          ACP_METHODS.requestPermission,
          {
            sessionId: s.id,
            toolCall: { toolCallId, title: "Write note.txt", kind: "edit", status: "pending" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
          withdraw.signal,
        )
        .then(
          (answer) => answer,
          () => undefined,
        );
      const answer = await Promise.race([asked, waitAbort(turn.signal).then(() => undefined)]);
      clearTimeout(timer);
      if (turn.signal.aborted) {
        withdraw.abort();
        return done("cancelled");
      }
      if (answer === undefined) {
        await update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
        await say("permission withdrawn");
        return done("end_turn");
      }
      await update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: "completed" });
      await say(`answered ${answer.outcome.outcome}`);
      return done("end_turn");
    }
    if (text.includes("[permission]")) {
      const toolCallId = `call-${s.turns}`;
      await update(s.id, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Write note.txt",
        kind: "edit",
        status: "pending",
        locations: [{ path: `${s.cwd}/note.txt` }],
        rawInput: { path: "note.txt", content: "hi" },
      });
      let answer: AcpRequestPermissionResult;
      try {
        answer = await peer.request<AcpRequestPermissionResult>(ACP_METHODS.requestPermission, {
          sessionId: s.id,
          toolCall: { toolCallId, title: "Write note.txt", kind: "edit", status: "pending" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
            { optionId: "never", name: "Never", kind: "reject_always" },
          ],
        });
      } catch {
        return done("cancelled");
      }
      if (answer.outcome.outcome === "cancelled" || turn.signal.aborted) {
        await update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
        return done("cancelled");
      }
      const allowed = answer.outcome.optionId === "allow" || answer.outcome.optionId === "always";
      await update(s.id, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: allowed ? "completed" : "failed",
      });
      await update(s.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: allowed ? "wrote note.txt" : "write rejected" },
      });
      await update(s.id, { sessionUpdate: "usage_update", used: usage.totalTokens, size: 1000 });
      return done("end_turn");
    }
    await update(s.id, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `echo: ${text}` },
    });
    await update(s.id, {
      sessionUpdate: "usage_update",
      used: usage.totalTokens,
      size: 1000,
      cost: { amount: 0.001 * s.turns, currency: "USD" },
    });
    return done("end_turn");
  };

  const peer: JsonRpcPeer = new JsonRpcPeer({
    input,
    output,
    // 只有 [cancel-request] 会 abort 出站请求；入站撤回目前不影响假 Agent 的处理器
    cancelRequests: true,
    async onRequest(method, raw) {
      const params = (raw ?? {}) as Record<string, unknown>;
      switch (method) {
        case ACP_METHODS.initialize: {
          const capabilities = params["clientCapabilities"] as Record<string, unknown> | undefined;
          canElicit = capabilities?.["elicitation"] != null;
          return {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: options.minimal
              ? { promptCapabilities: { image: false } }
              : {
                  loadSession: true,
                  promptCapabilities: { image: false, embeddedContext: false },
                  sessionCapabilities: { list: {}, resume: {}, close: {} },
                },
            authMethods: options.authRequired === true ? [FAKE_AUTH_METHOD] : [],
            agentInfo: { name: options.name ?? "fake-acp-agent", version: "1.0.0" },
          };
        }
        case ACP_METHODS.sessionNew: {
          requireAuth();
          counter += 1;
          const s = open(`fake-${counter}`, String(params["cwd"] ?? ""));
          if (options.minimal) return { sessionId: s.id, ...config(s) };
          return { sessionId: s.id, ...modes(s), ...config(s) };
        }
        case ACP_METHODS.sessionResume:
        case ACP_METHODS.sessionLoad: {
          requireAuth();
          const id = String(params["sessionId"] ?? "");
          if (options.minimal || !id.startsWith("fake-"))
            throw new RpcError(RPC_ERRORS.resourceNotFound, `unknown session: ${id}`);
          const s = sessions.get(id) ?? open(id, String(params["cwd"] ?? ""));
          if (method === ACP_METHODS.sessionLoad) {
            await update(id, {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "earlier" },
            });
            await update(id, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "echo: earlier" },
            });
          }
          return { ...modes(s), ...config(s) };
        }
        case ACP_METHODS.sessionList:
          return {
            sessions: [...sessions.values()].map((s) => ({ sessionId: s.id, cwd: s.cwd })),
          };
        case ACP_METHODS.sessionClose:
          session(params["sessionId"]).turn?.abort();
          sessions.delete(String(params["sessionId"]));
          return {};
        case ACP_METHODS.sessionSetMode: {
          const s = session(params["sessionId"]);
          s.mode = String(params["modeId"]);
          await update(s.id, { sessionUpdate: "current_mode_update", currentModeId: s.mode });
          return {};
        }
        case ACP_METHODS.sessionSetConfigOption: {
          if (!hasConfig)
            throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
          const s = session(params["sessionId"]);
          const value = String(params["value"]);
          if (params["configId"] === "model" && options.configOptions === true) {
            if (!MODEL_VALUES.includes(value))
              throw new RpcError(RPC_ERRORS.invalidParams, `unknown model: ${value}`);
            s.model = value;
          } else if (params["configId"] === "mode" && options.configOnly === true) {
            if (!MODE_VALUES.includes(value))
              throw new RpcError(RPC_ERRORS.invalidParams, `unknown mode: ${value}`);
            s.mode = value;
          } else {
            throw new RpcError(
              RPC_ERRORS.invalidParams,
              `unknown config: ${String(params["configId"])}`,
            );
          }
          return { configOptions: configOf(s) };
        }
        case ACP_METHODS.sessionPrompt:
          return prompt(raw as AcpPromptParams);
        default:
          throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
      }
    },
    onNotification(method, raw) {
      if (method !== ACP_METHODS.sessionCancel) return;
      const id = (raw as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof id === "string") sessions.get(id)?.turn?.abort();
    },
  });
  return peer.closed;
}
