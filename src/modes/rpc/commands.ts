/**
 * RPC 命令分派表（设计 §13.2、src/rpc.ts 的 33 条命令）。[B6]
 *
 * - 提示类（prompt / steer / follow_up）不等运行结束：会话开始运行（`before_agent_start` /
 *   `agent_start`）、入队或被处理后立刻应答 `{ disposition }`；运行中的进展走事件。
 * - 会话类（new_session / switch_session / fork）经组装根 `switchSession`，`ctx.onSessionChanged`
 *   让模式重新订阅事件。
 * - 审批：`RpcApprovals` 是 UI broker（`set_client_capabilities` 声明 approvals 后挂上），
 *   `permission_response` 按 requestId 作答；先到的回答暂存，等 broker 被问到时取用。
 * - 密钥不离开进程：`get_available_models` 只回 `hasKey` 与 `keySource`。
 */

import { formatModelRef } from "../../ai/providers/channels.js";
import { AgentSessionImpl } from "../../agent/session.js";
import type { AgentSession, PromptDisposition } from "../../agent/types.js";
import { getSupportedLevels } from "../../ai/thinking.js";
import { switchSession } from "../../cli/compose-session.js";
import type { Runtime } from "../../cli/runtime.js";
import type { RewindRequest } from "../../checkpoints/types.js";
import { AmaError } from "../../errors.js";
import { isPermissionMode } from "../../permissions/modes.js";
import { PERMISSION_MODES_STRICT_FIRST } from "../../permissions/types.js";
import type { ApprovalBroker, ApprovalDecision, ApprovalRequest } from "../../permissions/types.js";
import type {
  RpcCapability,
  RpcCommandInfo,
  RpcCommandMap,
  RpcCommandType,
  RpcModelInfo,
} from "../../rpc.js";
import { BUILTIN_COMMANDS } from "../commands-core.js";

/** 审批 broker：等客户端 `permission_response`。 */
export class RpcApprovals implements ApprovalBroker {
  private readonly pending = new Map<string, (decision: ApprovalDecision | undefined) => void>();
  private readonly early = new Map<string, ApprovalDecision>();

  ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | undefined> {
    const ready = this.early.get(request.requestId);
    if (ready !== undefined) {
      this.early.delete(request.requestId);
      return Promise.resolve(ready);
    }
    return new Promise((resolve) => {
      const done = (decision: ApprovalDecision | undefined): void => {
        this.pending.delete(request.requestId);
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = (): void => done(undefined);
      if (signal.aborted) return done(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.requestId, done);
    });
  }

  /** 返回 false = 当前没有在等这个 requestId（已暂存，稍后被问到时生效）。 */
  respond(requestId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pending.get(requestId);
    if (resolve !== undefined) {
      resolve(decision);
      return true;
    }
    this.early.set(requestId, decision);
    return false;
  }

  /** 关 stdin / 撤下时：全部弃权（会话按无人作答 deny）。 */
  cancelAll(): void {
    for (const resolve of [...this.pending.values()]) resolve(undefined);
    this.early.clear();
  }
}

export interface RpcContext {
  readonly runtime: Runtime;
  session(): AgentSession;
  capabilities: Set<RpcCapability>;
  readonly approvals: RpcApprovals;
  /** 会话被换掉后调用（模式据此重新订阅）。 */
  onSessionChanged(next: AgentSession): void;
  /** 运行开始后提示命令自身的失败（应答已发出）。 */
  onBackgroundError(error: unknown): void;
}

export type RpcHandlers = {
  [K in RpcCommandType]: (params: RpcCommandMap[K], ctx: RpcContext) => Promise<unknown>;
};

function impl(session: AgentSession): AgentSessionImpl {
  if (session instanceof AgentSessionImpl) return session;
  throw new AmaError("not_implemented", "该会话不支持此命令");
}

/** 开始一次运行：开始 / 入队 / 被处理后即返回，不等运行结束。 */
async function startRun(
  ctx: RpcContext,
  run: () => Promise<PromptDisposition | "queued" | "handled">,
): Promise<{ disposition: PromptDisposition }> {
  const session = ctx.session();
  let settled = false;
  let off: () => void = () => undefined;
  const started = new Promise<"started">((resolve) => {
    off = session.subscribe((event) => {
      if (event.type === "before_agent_start" || event.type === "agent_start") resolve("started");
    });
  });
  const running = run().finally(() => {
    settled = true;
  });
  try {
    const first = await Promise.race([running, started]);
    if (!settled) running.catch((error: unknown) => ctx.onBackgroundError(error));
    return { disposition: first };
  } finally {
    off();
  }
}

async function switched(
  ctx: RpcContext,
  next: Promise<AgentSession>,
  reason: "new" | "resume" | "fork",
): Promise<unknown> {
  const session = await next;
  ctx.onSessionChanged(session);
  if (session instanceof AgentSessionImpl) session.announceStart(reason);
  return { sessionId: session.state.sessionId, sessionFile: session.state.sessionFile };
}

async function availableModels(runtime: Runtime): Promise<RpcModelInfo[]> {
  const out: RpcModelInfo[] = [];
  for (const provider of runtime.providers.list()) {
    const key = await runtime.providers.resolveApiKey(provider.id);
    const hasKey = key.apiKey !== undefined || !provider.requiresApiKey;
    for (const model of provider.models) {
      const info: RpcModelInfo = {
        provider: provider.id,
        id: model.id,
        name: model.name,
        hasKey,
        keySource: key.apiKey !== undefined ? key.source : "none",
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        input: [...model.input],
      };
      if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow;
      out.push(info);
    }
  }
  return out;
}

function commands(runtime: Runtime): RpcCommandInfo[] {
  return [
    ...BUILTIN_COMMANDS.map((c) => ({
      name: c.name,
      description: c.description,
      source: "builtin" as const,
    })),
    ...runtime.resources.prompts.map((p) => ({ name: p.name, source: "template" as const })),
    ...runtime.resources.skills.map((s) => ({
      name: `skill:${s.name}`,
      description: s.description,
      source: "skill" as const,
    })),
  ];
}

export const handlers: RpcHandlers = {
  prompt: (p, ctx) =>
    startRun(ctx, () =>
      ctx.session().prompt(p.message, {
        ...(p.images !== undefined ? { images: p.images } : {}),
        ...(p.streamingBehavior !== undefined ? { streamingBehavior: p.streamingBehavior } : {}),
      }),
    ),
  steer: (p, ctx) => startRun(ctx, () => ctx.session().steer(p.message)),
  follow_up: (p, ctx) => startRun(ctx, () => ctx.session().followUp(p.message)),
  abort: async (_p, ctx) => {
    await ctx.session().abort();
    return {};
  },
  clear_queue: async (_p, ctx) => ctx.session().clearQueue(),
  get_state: async (_p, ctx) => ctx.session().state,
  get_messages: async (_p, ctx) => ({ messages: ctx.session().messages }),
  get_last_assistant_text: async (_p, ctx) => ({ text: ctx.session().getLastAssistantText() }),
  // [W3-C2] 含 `cache`（三态、最近 / 会话命中率、未命中、保温、余量；第三波 §1.10）。
  get_session_stats: async (_p, ctx) => ctx.session().getStats(),
  set_model: async (p, ctx) => {
    await ctx.session().setModel(
      formatModelRef({
        provider: p.provider,
        id: p.modelId,
        ...(p.channel !== undefined ? { channel: p.channel } : {}),
      }),
    );
    return { model: ctx.session().state.model };
  },
  get_available_models: async (_p, ctx) => ({ models: await availableModels(ctx.runtime) }),
  set_thinking_level: async (p, ctx) => {
    ctx.session().setThinkingLevel(p.level);
    return { level: p.level };
  },
  get_available_thinking_levels: async (_p, ctx) => {
    const ref = ctx.session().state.model;
    const found =
      ref === undefined ? undefined : ctx.runtime.providers.findModel(formatModelRef(ref));
    return { levels: found?.ok === true ? getSupportedLevels(found.model) : ["off"] };
  },
  set_steering_mode: async (p, ctx) => {
    impl(ctx.session()).agent.steeringQueue.mode = p.mode;
    return { mode: p.mode };
  },
  set_follow_up_mode: async (p, ctx) => {
    impl(ctx.session()).agent.followUpQueue.mode = p.mode;
    return { mode: p.mode };
  },
  compact: async (p, ctx) => ctx.session().compact(p.customInstructions),
  set_auto_compaction: async (p, ctx) => {
    impl(ctx.session()).setAutoCompaction(p.enabled);
    return { enabled: p.enabled };
  },
  set_auto_retry: async (p, ctx) => {
    impl(ctx.session()).setAutoRetry(p.enabled);
    return { enabled: p.enabled };
  },
  abort_retry: async (_p, ctx) => {
    const session = ctx.session();
    const retrying = session.state.isRetrying;
    if (retrying) await session.abort();
    return { aborted: retrying };
  },
  new_session: (_p, ctx) => switched(ctx, switchSession(ctx.runtime, { kind: "new" }), "new"),
  switch_session: (p, ctx) =>
    switched(ctx, switchSession(ctx.runtime, { kind: "open", file: p.sessionPath }), "resume"),
  fork: (p, ctx) =>
    switched(ctx, switchSession(ctx.runtime, { kind: "fork", entryId: p.entryId }), "fork"),
  get_entries: async (p, ctx) => impl(ctx.session()).manager.getEntries(p.since),
  get_tree: async (_p, ctx) => ({ tree: impl(ctx.session()).manager.getTree() }),
  set_session_name: async (p, ctx) => {
    impl(ctx.session()).manager.setName(p.name);
    return { name: p.name };
  },
  get_fork_messages: async (_p, ctx) => ({
    messages: impl(ctx.session())
      .manager.branch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user"
          ? [
              {
                entryId: entry.id,
                text:
                  typeof entry.message.content === "string"
                    ? entry.message.content
                    : entry.message.content.map((b) => (b.type === "text" ? b.text : "")).join(""),
              },
            ]
          : [],
      ),
  }),
  get_rewind_points: async (_p, ctx) => ({ points: ctx.session().rewindPoints() }),
  rewind: async (p, ctx) => {
    const request: RewindRequest = { entryId: p.entryId, mode: p.mode };
    if (p.dryRun !== undefined) request.dryRun = p.dryRun;
    if (p.onConflict !== undefined) request.onConflict = p.onConflict;
    return ctx.session().rewind(request);
  },
  summarize_from: async (p, ctx) => ctx.session().summarizeFrom(p.entryId, p.instructions),
  summarize_up_to: async (p, ctx) => ctx.session().summarizeUpTo(p.entryId, p.instructions),
  set_client_capabilities: async (p, ctx) => {
    ctx.capabilities = new Set(p.capabilities);
    const approvals = ctx.capabilities.has("approvals");
    ctx.runtime.approvals.setUiBroker(approvals ? ctx.approvals : undefined);
    if (!approvals) ctx.approvals.cancelAll();
    return { capabilities: [...ctx.capabilities] };
  },
  permission_response: async (p, ctx) => ({
    accepted: ctx.approvals.respond(p.requestId, p.decision),
  }),
  get_tools: async (_p, ctx) => {
    const active = new Set(
      ctx
        .session()
        .getTools()
        .map((t) => t.name),
    );
    return {
      tools: ctx.runtime.tools.list().flatMap((name) => {
        const tool = ctx.runtime.tools.get(name);
        return tool === undefined
          ? []
          : [
              {
                name,
                description: tool.description,
                parameters: tool.parameters,
                permission: tool.permission,
                active: active.has(name),
              },
            ];
      }),
    };
  },
  set_active_tools: async (p, ctx) => {
    ctx.session().setActiveTools(p.names);
    return {
      names: ctx
        .session()
        .getTools()
        .map((t) => t.name),
    };
  },
  set_permission_mode: async (p, ctx) => {
    if (!isPermissionMode(p.mode)) {
      throw new AmaError(
        "invalid_arguments",
        `mode 应为 ${PERMISSION_MODES_STRICT_FIRST.join(" | ")}`,
      );
    }
    ctx.session().setPermissionMode(p.mode);
    return { mode: p.mode };
  },
  get_commands: async (_p, ctx) => ({ commands: commands(ctx.runtime) }),
  get_skills: async (_p, ctx) => ({ skills: ctx.runtime.resources.skills }),
};

export const RPC_COMMAND_TYPES = Object.keys(handlers) as RpcCommandType[];
