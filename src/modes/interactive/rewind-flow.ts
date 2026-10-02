/**
 * 回滚交互流程（rewind-plan §3.5、§3.6、§4）：列表 → 确认面板 → 执行 → 结果通知。[RW-C]
 *
 * - `open()`（`/rewind`、空闲时双击 Esc）：运行中只提示；没有回滚点提示一行。
 * - 执行：对话类（恢复代码和对话 / 恢复对话 / 从这里摘要）之后重画消息区并把原消息回填输入框
 *   （文本进编辑器，图片随下一条消息发送）；结果写一条通知，错误码换成中文说明。
 * - `afterInterrupt()`（中断即撤回）：Esc 中断后等运行结束；输入框仍为空且会话判定可撤回
 *   （`ui.restoreOnCancel`、本回合没有任何助手文本 / 工具调用）→ 撤回并回填原消息。
 */

import { AgentSessionImpl } from "../../agent/session.js";
import type { AgentSession, RewindDraftText } from "../../agent/types.js";
import type { RewindPoint, RewindResult } from "../../checkpoints/types.js";
import type { OverlayHandle } from "../../tui.js";
import type { NoticeLevel } from "./message-view.js";
import { PreviewCache, openRewindList, type RewindListHost } from "./rewind-list.js";
import { RewindPanel, type RewindChoice, type RewindPanelModel } from "./rewind-panel.js";
import { rewindErrorText, rewindResultLines } from "./rewind-text.js";

export interface RewindFlowHost extends RewindListHost {
  session(): AgentSession;
  notice(level: NoticeLevel, text: string): void;
  /** 底部提示行。 */
  hint(text: string): void;
  /** 对话变了：重画消息区。 */
  reload(): void;
  /** 原消息回填输入框（图片随下一条消息发送）。 */
  setDraft(draft: RewindDraftText): void;
  editorEmpty(): boolean;
  /** 终端行数（面板放不下时紧凑排版）。 */
  rows?(): number;
}

export const REFILLED = "原消息已放回输入框";

/** 打开确认面板（底部覆盖层）；返回选择或 undefined（取消）。 */
export function openRewindPanel(
  host: RewindFlowHost,
  model: RewindPanelModel,
): Promise<RewindChoice | undefined> {
  return new Promise((resolve) => {
    let handle: OverlayHandle | undefined;
    const panel = new RewindPanel(
      model,
      {
        theme: host.theme,
        ...(host.keybindings !== undefined ? { keybindings: host.keybindings } : {}),
        ...(host.rows !== undefined ? { rows: host.rows } : {}),
      },
      (choice) => {
        handle?.hide();
        resolve(choice);
      },
    );
    handle = host.showOverlay(panel, { anchor: "bottom" });
  });
}

function draftNote(draft: RewindDraftText): string {
  const images = draft.images?.length ?? 0;
  return images > 0 ? `${REFILLED}（${images} 张图片随下一条消息发送）` : REFILLED;
}

/** 执行面板里的选择，结果与错误都写成通知。 */
export async function executeRewind(
  host: RewindFlowHost,
  point: RewindPoint,
  choice: RewindChoice,
): Promise<void> {
  const session = host.session();
  try {
    switch (choice.action) {
      case "both":
      case "conversation":
      case "code": {
        host.hint("回滚中…");
        const result: RewindResult = await session.rewind({
          entryId: point.entryId,
          mode: choice.action,
          ...(choice.onConflict !== undefined ? { onConflict: choice.onConflict } : {}),
        });
        const draft = result.conversation?.draft;
        if (draft !== undefined) {
          host.reload();
          host.setDraft(draft);
        }
        const shown: RewindResult = { ...result };
        if (choice.action === "conversation") delete shown.gitHint;
        const lines = rewindResultLines(shown, {
          overwrite: choice.onConflict === "overwrite",
          ...(draft !== undefined
            ? { conversation: `对话已回到这条消息之前，${draftNote(draft)}` }
            : {}),
        });
        const code = result.code;
        const nothing =
          code !== undefined &&
          code.restored.length + code.deleted.length === 0 &&
          (choice.onConflict !== "overwrite" || code.conflicts.length === 0);
        host.notice(nothing && choice.action === "code" ? "warn" : "info", lines.join("\n"));
        break;
      }
      case "summarize-from": {
        host.hint("正在为离开的部分写摘要…");
        const result = await session.summarizeFrom(point.entryId, choice.instructions);
        host.reload();
        host.setDraft(result.draft);
        host.notice("info", `已从这里分叉，离开的部分写成了摘要；${draftNote(result.draft)}`);
        break;
      }
      case "summarize-up-to": {
        host.hint("正在摘要…");
        const result = await session.summarizeUpTo(point.entryId, choice.instructions);
        const after = result.tokensAfter !== undefined ? ` → ${result.tokensAfter}` : "";
        host.notice("info", `已摘要到这里：${result.tokensBefore}${after} token`);
        break;
      }
    }
  } catch (error) {
    host.notice("error", rewindErrorText(error));
  } finally {
    host.hint("");
  }
}

export interface RewindFlow {
  open(): Promise<void>;
  afterInterrupt(editorWasEmpty: boolean): Promise<void>;
}

export function createRewindFlow(host: RewindFlowHost): RewindFlow {
  let opening = false;
  return {
    async open() {
      const session = host.session();
      if (session.state.isStreaming) {
        host.notice("warn", "正在运行，不能回滚（先按 Esc 中断）");
        return;
      }
      if (opening) return;
      opening = true;
      try {
        const points = session.rewindPoints();
        if (points.length === 0) {
          host.notice("info", "还没有可回滚的消息");
          return;
        }
        const cache = new PreviewCache((entryId) =>
          session.rewind({ entryId, mode: "code", dryRun: true }),
        );
        const point = await openRewindList(host, points, cache);
        if (point === undefined) return;
        const model: RewindPanelModel = { point, now: host.now() };
        if (point.hasCheckpoint) {
          const state = await cache.ensure(point.entryId);
          if (state.state === "done") model.preview = state.result;
          else if (state.state === "error") model.previewError = state.message;
        }
        const choice = await openRewindPanel(host, model);
        if (choice !== undefined) await executeRewind(host, point, choice);
      } finally {
        opening = false;
      }
    },

    async afterInterrupt(editorWasEmpty) {
      const session = host.session();
      await session.waitForIdle();
      if (!editorWasEmpty || !host.editorEmpty()) return;
      if (!(session instanceof AgentSessionImpl) || !session.canUndoAbortedTurn()) return;
      try {
        const draft = await session.undoAbortedTurn();
        if (draft === undefined) return;
        host.reload();
        host.setDraft(draft);
        host.notice("info", `已撤回被中断的消息，${draftNote(draft)}`);
      } catch (error) {
        host.notice("error", rewindErrorText(error));
      }
    },
  };
}
