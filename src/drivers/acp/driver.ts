/**
 * AcpDriver：经 ACP 驱动外部 Agent（docs/wave5-plan.md §5.1–§5.2，D14）。[W5-E]
 *
 * open：起进程 → `initialize` → 续聊优先 `session/resume`（不回放），其次 `session/load`
 * （回放的历史通知在 open 期间丢弃），都不支持则新开并发 notice「已新开」→ 按 ama 模式
 * `session/set_mode`（只读模式没有映射时拒绝启动，避免以 Agent 缺省模式跑写操作）。
 * prompt：`session/update` → DriverEvent；`session/request_permission` → hooks.onPermission
 * （只交给人）；回合以 `session/prompt` 的 stopReason 结束。
 * cancel：`session/cancel`，挂起的权限请求回 cancelled，15 s 内无回合结束 → 关 stdin → 杀进程树。
 */

import { AmaError } from "../../errors.js";
import type { ContentBlock } from "../../ai/types.js";
import type { PermissionMode } from "../../permissions/types.js";
import {
  armCancelWatchdog,
  isReadOnlyMode,
  probeCandidate,
  spawnOf,
  type DriverDeps,
} from "../base.js";
import type { CatalogCandidate } from "../catalog.js";
import { stderrHint, type AgentTransport } from "../process.js";
import { TurnCollector, oneLine } from "../turn.js";
import type {
  AgentDriver,
  DriverOpenOptions,
  DriverPermissionOutcome,
  DriverProbe,
  DriverPromptHooks,
  DriverSession,
  DriverTurnResult,
} from "../types.js";
import { AcpClient } from "./client.js";
import type {
  AcpContentBlock,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionModeState,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpToolCallLocation,
} from "./types.js";
import { AMA_VERSION } from "../../version.js";
import { msg } from "../../i18n/index.js";

export function toAcpContent(blocks: readonly ContentBlock[], images: boolean): AcpContentBlock[] {
  const out: AcpContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (images) out.push({ type: "image", data: block.data, mimeType: block.mimeType });
  }
  return out;
}

function locationsOf(locations: readonly AcpToolCallLocation[] | undefined): string[] | undefined {
  return locations === undefined ? undefined : locations.map((l) => l.path);
}

/** session/update → DriverEvent（用户消息回放、命令表等忽略）。 */
export function pushAcpUpdate(update: AcpSessionUpdate, turn: TurnCollector): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text")
        turn.push({ type: "message_delta", text: update.content.text });
      return;
    case "agent_thought_chunk":
      if (update.content.type === "text")
        turn.push({ type: "thought_delta", text: update.content.text });
      return;
    case "tool_call":
    case "tool_call_update": {
      const known = turn.tool(update.toolCallId);
      const locations = locationsOf(update.locations);
      turn.push({
        type: "tool_call",
        id: update.toolCallId,
        title: oneLine(update.title ?? known?.title ?? ""),
        kind: update.kind ?? known?.kind ?? "other",
        status: update.status ?? known?.status ?? "pending",
        ...(locations !== undefined ? { locations } : {}),
      });
      return;
    }
    case "plan":
      turn.push({
        type: "plan",
        entries: update.entries.map((e) => ({ content: e.content, status: e.status })),
      });
      return;
    case "usage_update":
      turn.push({
        type: "usage",
        contextTokens: update.used,
        contextWindow: update.size,
        ...(update.cost?.currency === "USD" ? { costUsd: update.cost.amount } : {}),
      });
      return;
    default:
      return;
  }
}

/** ama 模式 → 该 Agent 的模式 id（显式映射 > 同名）。 */
export function pickModeId(
  mode: PermissionMode,
  candidate: CatalogCandidate,
  state: AcpSessionModeState | null | undefined,
): string | undefined {
  const wanted = [candidate.modes?.[mode] ?? mode];
  // allowlist 在外部 Agent 那边没有等价物：退到只读的 plan
  if (mode === "allowlist") wanted.push(candidate.modes?.plan ?? "plan");
  return wanted.find((id) => state?.availableModes.some((m) => m.id === id) === true);
}

export class AcpDriver implements AgentDriver {
  readonly kind: "acp" | "acp-adapter";

  constructor(
    readonly agentId: string,
    private readonly candidate: CatalogCandidate,
    private readonly deps: DriverDeps = {},
  ) {
    this.kind = candidate.kind === "acp-adapter" ? "acp-adapter" : "acp";
  }

  probe(): Promise<DriverProbe> {
    return probeCandidate(this.candidate, this.deps);
  }

  async open(options: DriverOpenOptions): Promise<DriverSession> {
    // 与原生驱动一致：用探测到的完整路径启动。Windows 上 npm 装的 ACP Agent 是 `.cmd` 垫片，
    // 裸程序名 spawn 会 ENOENT（commandLine 只认带扩展名的路径改走 cmd.exe）。[W5-Z]
    const probed = await probeCandidate(this.candidate, this.deps);
    const transport = spawnOf(this.deps)({
      program: probed.path ?? this.candidate.program,
      args: this.candidate.args,
      cwd: options.cwd,
      env: options.env,
    });
    const session = new AcpDriverSession(this.agentId, transport, this.deps);
    try {
      await session.start(options, this.candidate);
    } catch (error) {
      await session.close();
      if (error instanceof AmaError) throw error;
      const hint = stderrHint(transport);
      throw new AmaError(
        "agent_start_failed",
        `${this.agentId}: ACP failed to start (${(error as Error).message})${hint !== "" ? `: ${hint}` : ""}`,
        { cause: error },
      );
    }
    return session;
  }
}

class AcpDriverSession implements DriverSession {
  private id = "";
  private client!: AcpClient;
  private hooks: DriverPromptHooks | undefined;
  private turn: TurnCollector | undefined;
  private replaying = false;
  private running: Promise<unknown> | undefined;
  private closed = false;
  private notices: string[] = [];

  constructor(
    private readonly agentId: string,
    private readonly transport: AgentTransport,
    private readonly deps: DriverDeps,
  ) {}

  get sessionId(): string {
    return this.id;
  }

  async start(options: DriverOpenOptions, candidate: CatalogCandidate): Promise<void> {
    this.client = new AcpClient({
      input: this.transport.stdout,
      output: this.transport.stdin,
      clientInfo: { name: "ama", version: AMA_VERSION },
      onUpdate: (n) => this.onUpdate(n),
      onPermission: (p, signal) => this.onPermission(p, signal),
      onProtocolError: (_line, reason) => this.deps.log?.("debug", `${this.agentId}: ${reason}`),
    });
    const signal = options.signal;
    await this.client.initialize(signal);
    let modes: AcpSessionModeState | null | undefined;
    if (options.resume !== undefined) {
      if (this.client.supportsResume()) {
        modes = (await this.client.resumeSession(options.resume, options.cwd, signal)).modes;
        this.id = options.resume;
      } else if (this.client.supportsLoad()) {
        this.replaying = true;
        try {
          modes = (await this.client.loadSession(options.resume, options.cwd, signal)).modes;
        } finally {
          this.replaying = false;
        }
        this.id = options.resume;
      } else {
        this.notices.push(msg().drivers.agent.resumeUnsupported(this.agentId));
      }
    }
    if (this.id === "") {
      const created = await this.client.newSession(options.cwd, signal);
      this.id = created.sessionId;
      modes = created.modes;
    }
    const modeId = pickModeId(options.mode, candidate, modes);
    if (modeId !== undefined) {
      if (modes?.currentModeId !== modeId) await this.client.setMode(this.id, modeId);
    } else if (isReadOnlyMode(options.mode)) {
      throw new AmaError(
        "agent_mode_unsupported",
        `${this.agentId} has no read-only mode matching ama's "${options.mode}"; its default mode cannot stand in for it`,
      );
    } else if (modes != null) {
      this.notices.push(msg().drivers.agent.noMatchingMode(this.agentId, options.mode));
    }
  }

  async prompt(content: ContentBlock[], hooks: DriverPromptHooks): Promise<DriverTurnResult> {
    if (this.closed) throw new AmaError("agent_closed", `${this.agentId} session is closed`);
    if (this.running !== undefined)
      throw new AmaError("busy", `${this.agentId} is already running`);
    const turn = new TurnCollector((e) => hooks.onEvent(e));
    for (const text of this.notices.splice(0)) turn.push({ type: "notice", level: "info", text });
    this.hooks = hooks;
    this.turn = turn;
    const images = this.client.supportsImages();
    if (!images && content.some((b) => b.type === "image"))
      turn.push({
        type: "notice",
        level: "warn",
        text: msg().drivers.agent.noImages(this.agentId),
      });
    const request = this.client.prompt(this.id, toAcpContent(content, images));
    this.running = request;
    try {
      const result = await request.catch((error: unknown) => {
        if (this.client.isOpen) throw error;
        const hint = stderrHint(this.transport);
        throw new AmaError(
          "agent_exited",
          `${this.agentId} process exited${hint !== "" ? `: ${hint}` : ""}`,
          {
            cause: error,
          },
        );
      });
      const usage = result.usage;
      if (usage != null) {
        turn.mergeUsage({
          ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}),
          ...(usage.cachedReadTokens !== undefined ? { cacheRead: usage.cachedReadTokens } : {}),
        });
      }
      return turn.result(result.stopReason);
    } finally {
      this.running = undefined;
      this.hooks = undefined;
      this.turn = undefined;
    }
  }

  async cancel(): Promise<void> {
    const running = this.running;
    if (running === undefined || this.closed) return;
    await this.client.cancel(this.id).catch(() => undefined);
    armCancelWatchdog(
      this.transport,
      running.catch(() => undefined),
      this.deps,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client !== undefined) {
      if (this.running !== undefined) await this.client.cancel(this.id).catch(() => undefined);
      if (this.id !== "" && this.client.isOpen && this.client.supportsClose()) {
        const timer = new Promise((resolve) => setTimeout(resolve, 2_000).unref());
        await Promise.race([this.client.closeSession(this.id).catch(() => undefined), timer]);
      }
      this.client.close();
    }
    await this.transport.terminate();
  }

  private onUpdate(notification: AcpSessionNotification): void {
    if (this.replaying || notification.sessionId !== this.id || this.turn === undefined) return;
    pushAcpUpdate(notification.update, this.turn);
  }

  private async onPermission(
    params: AcpRequestPermissionParams,
    signal: AbortSignal,
  ): Promise<AcpRequestPermissionResult> {
    const hooks = this.hooks;
    if (hooks === undefined || params.sessionId !== this.id)
      return { outcome: { outcome: "cancelled" } };
    const call = params.toolCall;
    const known = this.turn?.tool(call.toolCallId);
    const locations = locationsOf(call.locations) ?? known?.locations;
    const outcome: DriverPermissionOutcome = await hooks.onPermission(
      {
        toolCall: {
          title: oneLine(call.title ?? known?.title ?? call.toolCallId),
          kind: call.kind ?? known?.kind ?? "other",
          ...(locations !== undefined && locations.length > 0 ? { locations: [...locations] } : {}),
          ...(call.rawInput !== undefined
            ? { inputSummary: oneLine(JSON.stringify(call.rawInput), 300) }
            : {}),
        },
        options: params.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
      },
      signal,
    );
    return { outcome };
  }
}
