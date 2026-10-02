/**
 * 图片预算扩展端到端（fake 流）：超预算写 context_edit{image_budget}、投影与请求都换成占位、
 * 之后的请求前缀稳定；新回合附件计入总量；模型不收图时不处理。[W5-I]
 */

import { describe, expect, it } from "vitest";
import type { ContentBlock, ImageBlock, Message, TranscriptContext } from "../ai/types.js";
import { IMAGE_OMITTED_FOR_BUDGET } from "../compaction/image-budget.js";
import { buildProjection } from "../session/projection.js";
import type { ContextEditEntry, SessionEntry } from "../session/types.js";
import type { SessionExtensionFactory } from "./session-extensions.js";
import { createImageBudgetExtension } from "./session-images.js";
import { createHarness } from "./testing/harness.js";
import { fakeModel, stubTool } from "./testing/stubs.js";

const LIMITS = { perImageBase64: 1000, perRequestBase64: 1000 };
const budget: SessionExtensionFactory = ({ core }) =>
  createImageBudgetExtension(core, { limits: () => LIMITS });

function image(bytes: number, tag: string): ImageBlock {
  return { type: "image", mimeType: "image/png", data: tag.repeat(bytes) };
}

const shotTool = stubTool({
  name: "shot",
  run: (input) => ({
    content: [{ type: "text", text: `shot ${String(input["n"])}` }, image(400, String(input["n"]))],
  }),
});

function imageTags(context: TranscriptContext): string[] {
  return context.messages.flatMap((message: Message) =>
    (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
      ? (message.content as ContentBlock[]).flatMap((block) =>
          block.type === "image" ? [block.data.slice(0, 1)] : [],
        )
      : [],
  );
}

function budgetEdits(entries: readonly SessionEntry[]): ContextEditEntry[] {
  return entries.filter(
    (entry): entry is ContextEditEntry =>
      entry.type === "context_edit" && entry.reason === "image_budget",
  );
}

describe("session-images：图片预算扩展", () => {
  it("回合内工具结果累积超预算 → 最旧的图降级、持久化、请求即时生效、之后前缀稳定", async () => {
    const h = createHarness({
      model: fakeModel({ input: ["text", "image"] }),
      tools: [shotTool],
      extensions: [budget],
      script: [
        { toolCalls: [{ name: "shot", args: { n: 1 } }] },
        { toolCalls: [{ name: "shot", args: { n: 2 } }] },
        { toolCalls: [{ name: "shot", args: { n: 3 } }] },
        { toolCalls: [{ name: "shot", args: { n: 4 } }] },
        { text: "done" },
      ],
    });
    await h.session.prompt("截图");
    const calls = h.scripted.calls.map((call) => imageTags(call.context));
    // 第 4 次请求前累计 1200 > 1000 → 降到 ≤ 600：1、2 降级，只留 3
    expect(calls).toEqual([[], ["1"], ["1", "2"], ["3"], ["3", "4"]]);
    const edits = budgetEdits(h.manager.branch());
    expect(edits).toHaveLength(2);
    expect(edits[0]?.replacement).toBe(`shot 1\n${IMAGE_OMITTED_FOR_BUDGET}`);
    // 投影与请求一致；降级后第 5 次请求以第 4 次为前缀（只多了新内容）
    const projected = buildProjection(h.manager.branch()).messages;
    const omitted = projected.filter(
      (message) => message.role === "toolResult" && message.content === edits[0]?.replacement,
    );
    expect(omitted).toHaveLength(1);
    const fourth = h.scripted.calls[3]?.context.messages ?? [];
    const fifth = h.scripted.calls[4]?.context.messages ?? [];
    expect(JSON.stringify(fifth.slice(0, fourth.length))).toBe(JSON.stringify(fourth));
  });

  it("新回合：提示附件计入总量，降历史里最旧的图", async () => {
    const h = createHarness({
      model: fakeModel({ input: ["text", "image"] }),
      tools: [shotTool],
      extensions: [budget],
      script: [
        { toolCalls: [{ name: "shot", args: { n: 1 } }] },
        { toolCalls: [{ name: "shot", args: { n: 2 } }] },
        { text: "ok" },
        { text: "看到了" },
      ],
    });
    await h.session.prompt("两张");
    expect(budgetEdits(h.manager.branch())).toHaveLength(0);
    await h.session.prompt("再看这张", { images: [image(300, "9")] });
    // 400 + 400 + 300 = 1100 > 1000 → 降 1（最新的历史图 2 保留）
    expect(budgetEdits(h.manager.branch()).map((e) => e.replacement)).toEqual([
      `shot 1\n${IMAGE_OMITTED_FOR_BUDGET}`,
    ]);
    expect(imageTags(h.scripted.calls[3]?.context as TranscriptContext)).toEqual(["2", "9"]);
  });

  it("模型不收图：不写 context_edit（normalizeContext 负责占位）", async () => {
    const h = createHarness({
      model: fakeModel({ input: ["text"] }),
      tools: [shotTool],
      extensions: [budget],
      script: [
        { toolCalls: [{ name: "shot", args: { n: 1 } }] },
        { toolCalls: [{ name: "shot", args: { n: 2 } }] },
        { toolCalls: [{ name: "shot", args: { n: 3 } }] },
        { text: "done" },
      ],
    });
    await h.session.prompt("截图");
    expect(budgetEdits(h.manager.branch())).toHaveLength(0);
  });
});
