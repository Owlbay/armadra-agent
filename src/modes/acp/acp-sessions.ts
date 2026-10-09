/**
 * `ama --mode acp` 的多会话：会话池条目、FIFO 提示队列、`session/list` 的分页与标题（docs/acp-plan.md
 * D1、D2、D11、§2.1）。[ACP-B]
 *
 * - 每个 ACP sessionId 一个常驻会话（{@link PooledSession}），各有自己的事件映射器与权限模式；
 * - 同一时刻只跑一个回合，其它会话的 `session/prompt` 进 {@link PromptQueue}（FIFO），不再回 busy；
 * - `session/list`：按 `updatedAt` 降序、`sessionId` 次序分页，cursor 是 `updatedAt|sessionId` 的 base64。
 */

import type { ImageBlock } from "../../ai/types.js";
import type { AgentSessionImpl } from "../../agent/session.js";
import type { AgentMessage, SessionListItem } from "../../session/types.js";
import {
  RPC_ERRORS,
  type AcpPromptResult,
  type AcpSessionInfo,
  type AcpListSessionsResult,
} from "../../drivers/acp/types.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { AmaError } from "../../errors.js";
import type { PermissionMode } from "../../permissions/types.js";
import { msg } from "../../i18n/index.js";
import type { AcpEventMapper } from "./acp-events.js";

/** `session/list` 每页条数。 */
export const LIST_PAGE_SIZE = 50;
/** 列表与 `session_info_update` 的标题上限（字符）。 */
export const TITLE_LIMIT = 80;

/** 会话池里的一个会话。 */
export interface PooledSession {
  readonly id: string;
  readonly session: AgentSessionImpl;
  readonly mapper: AcpEventMapper;
  readonly unsubscribe: () => void;
  /** 这个会话的权限模式（共享管线只在它是前台时等于它，出队时重放）。 */
  mode: PermissionMode;
}

/** 排队或在跑的一次 `session/prompt`。 */
export interface PromptJob {
  readonly sessionId: string;
  readonly text: string;
  readonly images: ImageBlock[];
  /** `session/cancel` / `session/close` / `$/cancel_request` 要求中断。 */
  cancelRequested: boolean;
  resolve(result: AcpPromptResult): void;
  reject(error: unknown): void;
}

export const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  totalTokens: 0,
} as const;

/** 还没开始就被取消的提示：直接回 cancelled。 */
export function cancelledResult(): AcpPromptResult {
  return { stopReason: "cancelled", usage: { ...ZERO_USAGE } };
}

/**
 * 全进程一个回合：FIFO，出队时调 `run`。`run` 的结果 / 错误原样交回该提示的调用方。
 */
export class PromptQueue {
  private readonly waiting: PromptJob[] = [];
  private current: { job: PromptJob; done: Promise<void> } | undefined;

  constructor(private readonly run: (job: PromptJob) => Promise<AcpPromptResult>) {}

  /** 在跑的提示。 */
  get running(): PromptJob | undefined {
    return this.current?.job;
  }

  /** 排队中的提示数。 */
  get size(): number {
    return this.waiting.length;
  }

  push(job: PromptJob): void {
    this.waiting.push(job);
    this.drain();
  }

  /** 排队中属于该会话的提示全部回 cancelled 并出队；返回出队条数。 */
  cancelQueued(sessionId?: string): number {
    let removed = 0;
    for (let i = this.waiting.length - 1; i >= 0; i--) {
      const job = this.waiting[i]!;
      if (sessionId !== undefined && job.sessionId !== sessionId) continue;
      this.waiting.splice(i, 1);
      job.cancelRequested = true;
      job.resolve(cancelledResult());
      removed++;
    }
    return removed;
  }

  /** 等在跑的那个提示结束（`sessionId` 给了且在跑的不是它 → 立即返回）。 */
  async settled(sessionId?: string): Promise<void> {
    while (this.current !== undefined) {
      if (sessionId !== undefined && this.current.job.sessionId !== sessionId) return;
      await this.current.done;
    }
  }

  private drain(): void {
    if (this.current !== undefined) return;
    const job = this.waiting.shift();
    if (job === undefined) return;
    const done = this.run(job).then(
      (result) => job.resolve(result),
      (error: unknown) => job.reject(error),
    );
    this.current = { job, done };
    void done.finally(() => {
      this.current = undefined;
      this.drain();
    });
  }
}

/**
 * 标题清洗：去掉嵌入资源块（`<resource …>…</resource>`，被截断没有结尾的也去），取第一个非空行，
 * 压成一行，≤ {@link TITLE_LIMIT} 字。空 → null。
 */
export function cleanTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const stripped = raw.replace(/<resource\b[^>]*>[\s\S]*?(?:<\/resource>|$)/g, "");
  const line = stripped
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l !== "");
  if (line === undefined) return null;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line;
}

/** 会话标题：会话名，否则首条用户提示（清洗后）。 */
export function sessionTitle(
  name: string | undefined,
  messages: readonly AgentMessage[],
): string | null {
  if (name !== undefined && name.trim() !== "") return cleanTitle(name);
  for (const message of messages) {
    if (!("role" in message) || message.role !== "user") continue;
    const { content } = message;
    const text =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return cleanTitle(text);
  }
  return null;
}

export function encodeCursor(updatedAt: string, sessionId: string): string {
  return Buffer.from(`${updatedAt}|${sessionId}`, "utf8").toString("base64");
}

/** 非法 cursor → invalid params。 */
export function decodeCursor(cursor: unknown): { updatedAt: string; sessionId: string } {
  if (typeof cursor === "string" && cursor !== "") {
    const text = Buffer.from(cursor, "base64").toString("utf8");
    const at = text.indexOf("|");
    if (
      at > 0 &&
      at < text.length - 1 &&
      encodeCursor(text.slice(0, at), text.slice(at + 1)) === cursor
    )
      return { updatedAt: text.slice(0, at), sessionId: text.slice(at + 1) };
  }
  throw new RpcError(RPC_ERRORS.invalidParams, msg().acp.session.invalidCursor);
}

interface ListKey {
  updatedAt: string;
  sessionId: string;
}

/** 排序键：`updatedAt` 降序，同时刻按 `sessionId` 降序。 */
function before(a: ListKey, b: ListKey): boolean {
  return a.updatedAt === b.updatedAt ? a.sessionId > b.sessionId : a.updatedAt > b.updatedAt;
}

/** 一页会话（`cursor` 缺省从头）。 */
export function pageSessions(
  items: readonly SessionListItem[],
  cursor: unknown,
  pageSize = LIST_PAGE_SIZE,
): AcpListSessionsResult {
  const all = items
    .map((item) => ({
      sessionId: item.id,
      cwd: item.cwd,
      title: cleanTitle(item.name) ?? cleanTitle(item.firstPrompt),
      updatedAt: item.modifiedAt,
    }))
    .sort((a, b) => (before(a, b) ? -1 : 1));
  let start = 0;
  if (cursor !== undefined && cursor !== null) {
    const after = decodeCursor(cursor);
    start = all.findIndex((s) => before(after, s));
    if (start < 0) start = all.length;
  }
  const sessions: AcpSessionInfo[] = all.slice(start, start + pageSize);
  const last = all[start + pageSize - 1];
  return start + pageSize < all.length && last !== undefined
    ? { sessions, nextCursor: encodeCursor(last.updatedAt, last.sessionId) }
    : { sessions };
}

/**
 * 跑一个出队的提示（docs/memory-plan.md D4、§2.2，Issue #139）。[M-A]
 *
 * 后台子 Agent 的完成通知以 `followUp` 在会话空闲时开回合，不经 {@link PromptQueue}；那一回合在跑时
 * 直接 `prompt` 会报 busy。这里先等它结束；与通知器竞速输了（等到空闲后它抢先开了回合）再等一轮。
 * 不用 `streamingBehavior: "followUp"` 入队：`abort()` 不清队列，等待期间的 `session/cancel`
 * 会让这条提示在之后的周期里冒出来。`job.cancelRequested`（cancel / close / 撤回）→ 不再发，直接返回。
 */
export async function promptWhenIdle(session: AgentSessionImpl, job: PromptJob): Promise<void> {
  for (;;) {
    // 等周期而不是看 `state.isStreaming`：busy 以周期为准，周期的收尾阶段 isStreaming 已是 false
    await session.waitForIdle();
    if (job.cancelRequested) return;
    try {
      await session.prompt(job.text, job.images.length > 0 ? { images: job.images } : {});
      return;
    } catch (error) {
      if (!(error instanceof AmaError && error.code === "busy")) throw error;
    }
  }
}
