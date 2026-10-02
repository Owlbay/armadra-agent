/**
 * `/rewind` 的带参数形式（rewind-plan §4，line 模式与交互模式共用；交互模式无参数时开列表）。[RW-C]
 *
 * - `/rewind`：列出回滚点，编号从旧到新（1 = 最早）。
 * - `/rewind <n> [both|conversation|code] [overwrite]`：缺省 both（没有检查点时 conversation）；
 *   `overwrite` 覆盖冲突文件（`onConflict: "overwrite"`）。
 * - `/rewind <n> summarize-from|summarize-up-to [说明]`。
 * 错误码换成中文说明后照原 code 抛出。
 */

import type { AgentSession, RewindDraftText } from "../../agent/types.js";
import type { RewindPoint } from "../../checkpoints/types.js";
import { AmaError } from "../../errors.js";
import type { RewindAction } from "./rewind-panel.js";
import { oneLine, rewindErrorText, rewindResultLines } from "./rewind-text.js";
import { relativeTime } from "./startup-ui.js";

const FORMS =
  "/rewind <n> [both|conversation|code] [overwrite]，/rewind <n> summarize-from|summarize-up-to [说明]";
export const REWIND_USAGE = `用法：/rewind，${FORMS}`;

const ACTIONS: readonly RewindAction[] = [
  "both",
  "conversation",
  "code",
  "summarize-from",
  "summarize-up-to",
];

export interface RewindArgs {
  /** 1 起的编号。 */
  index: number;
  action?: RewindAction;
  instructions?: string;
  overwrite?: boolean;
}

export function parseRewindArgs(args: string): RewindArgs {
  const m = /^(\d+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim());
  const index = m === null ? NaN : Number(m[1]);
  if (m === null || !Number.isInteger(index) || index < 1) {
    throw new AmaError("invalid_arguments", REWIND_USAGE);
  }
  const out: RewindArgs = { index };
  const action = m[2];
  const rest = (m[3] ?? "").trim();
  if (action === undefined) return out;
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new AmaError("invalid_arguments", REWIND_USAGE);
  }
  out.action = action as RewindAction;
  if (action === "summarize-from" || action === "summarize-up-to") {
    if (rest !== "") out.instructions = rest;
  } else if (rest === "overwrite" && action !== "conversation") out.overwrite = true;
  else if (rest !== "") throw new AmaError("invalid_arguments", REWIND_USAGE);
  return out;
}

export function rewindListText(points: readonly RewindPoint[], now: number): string {
  if (points.length === 0) return "还没有可回滚的消息";
  const lines = points.map((point, i) => {
    const time = relativeTime(new Date(point.timestamp).toISOString(), now);
    const only = point.hasCheckpoint ? "" : "  [仅对话]";
    return `  ${i + 1}. ${time}  ${oneLine(point.text, 60) || "（空）"}${only}`;
  });
  return [`回滚点（${FORMS}）：`, ...lines].join("\n");
}

export interface RewindCommandResult {
  message: string;
  /** 对话变了：原消息草稿（界面回填输入框）。 */
  draft?: RewindDraftText;
  /** 消息区要重画。 */
  reload?: boolean;
}

/** 执行 `/rewind <args>`；args 为空时只列出回滚点。 */
export async function rewindCommand(
  session: AgentSession,
  args: string,
  now = Date.now(),
): Promise<RewindCommandResult> {
  const points = session.rewindPoints();
  if (args.trim() === "") return { message: rewindListText(points, now) };
  const parsed = parseRewindArgs(args);
  const point = points[parsed.index - 1];
  if (point === undefined) {
    throw new AmaError(
      "invalid_arguments",
      `没有第 ${parsed.index} 个回滚点（共 ${points.length} 个，/rewind 查看）`,
    );
  }
  const action = parsed.action ?? (point.hasCheckpoint ? "both" : "conversation");
  try {
    if (action === "summarize-from") {
      const result = await session.summarizeFrom(point.entryId, parsed.instructions);
      return {
        message: `已从这里分叉，离开的部分写成了摘要；原消息：${oneLine(result.draft.text, 80)}`,
        draft: result.draft,
        reload: true,
      };
    }
    if (action === "summarize-up-to") {
      const result = await session.summarizeUpTo(point.entryId, parsed.instructions);
      const after = result.tokensAfter !== undefined ? ` → ${result.tokensAfter}` : "";
      return { message: `已摘要到这里：${result.tokensBefore}${after} token` };
    }
    const result = await session.rewind({
      entryId: point.entryId,
      mode: action,
      ...(parsed.overwrite === true ? { onConflict: "overwrite" as const } : {}),
    });
    if (action === "conversation") delete result.gitHint;
    const draft = result.conversation?.draft;
    const lines = rewindResultLines(result, {
      overwrite: parsed.overwrite === true,
      ...(draft !== undefined
        ? { conversation: `对话已回到这条消息之前；原消息：${oneLine(draft.text, 80)}` }
        : {}),
    });
    return draft !== undefined
      ? { message: lines.join("\n"), draft, reload: true }
      : { message: lines.join("\n") };
  } catch (error) {
    if (error instanceof AmaError) {
      throw new AmaError(error.code, rewindErrorText(error), { cause: error });
    }
    throw error;
  }
}
