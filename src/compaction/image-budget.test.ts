import { describe, expect, it } from "vitest";
import type { ContentBlock, ImageBlock } from "../ai/types.js";
import type { ContextItem } from "../session/projection.js";
import type { AgentMessage, SessionEntry } from "../session/types.js";
import {
  IMAGE_OMITTED_FOR_BUDGET,
  IMAGE_OMITTED_TOO_LARGE,
  base64ImageSize,
  budgetReplacement,
  planImageBudget,
} from "./image-budget.js";

function image(bytes: number, tag = "A"): ImageBlock {
  return { type: "image", mimeType: "image/png", data: tag.repeat(bytes) };
}

let seq = 0;
function item(
  role: "user" | "toolResult" | "assistant" | "custom",
  content: ContentBlock[] | string,
): ContextItem {
  const id = `e${++seq}`;
  let message: AgentMessage;
  if (role === "user") message = { role, content, timestamp: 0 };
  else if (role === "toolResult")
    message = {
      role,
      toolCallId: `c${seq}`,
      toolName: "read",
      content,
      isError: false,
      timestamp: 0,
    } as AgentMessage;
  else if (role === "custom")
    message = { role, customType: "x", content, display: false, timestamp: 0 };
  else message = { role: "assistant", content: [{ type: "text", text: "a" }] } as AgentMessage;
  const entry = (
    role === "custom"
      ? { type: "custom_message", id, parentId: null, timestamp: "" }
      : { type: "message", id, parentId: null, timestamp: "", message }
  ) as SessionEntry;
  return { entry, message };
}

const shot = (bytes: number, text = "Image: a.png"): ContextItem =>
  item("toolResult", [{ type: "text", text }, image(bytes)]);

describe("planImageBudget", () => {
  it("未超预算不动", () => {
    const items = [shot(300), shot(300), shot(300)];
    expect(planImageBudget(items, 1000)).toEqual([]);
  });

  it("超预算：最旧先降，降到 ≤ 60%；最新一条不降", () => {
    const items = [shot(300), item("assistant", ""), shot(300), shot(300), shot(300)];
    // 1200 > 1000 → 降到 ≤ 600：降掉前两条
    const plan = planImageBudget(items, 1000);
    expect(plan.map((p) => p.targetId)).toEqual([items[0]?.entry.id, items[2]?.entry.id]);
    expect(plan.every((p) => p.cause === "budget")).toBe(true);
    expect(plan[0]).toMatchObject({
      replacement: `Image: a.png\n${IMAGE_OMITTED_FOR_BUDGET}`,
      images: 1,
      bytes: 300,
    });
    // 只有一条带图：哪怕超预算也不降
    expect(planImageBudget([shot(2000)], 1000)).toEqual([]);
  });

  it("本回合附件计入总量但不降级", () => {
    const items = [shot(300), shot(300)];
    expect(planImageBudget(items, 1000)).toEqual([]);
    const plan = planImageBudget(items, 1000, { reserve: [image(500)] });
    // 1100 > 1000 → 目标 600：降第一条后 800，仍 > 600，但最新一条不降
    expect(plan.map((p) => p.targetId)).toEqual([items[0]?.entry.id]);
  });

  it("单张超过端点上限的必降（包括最新一条），换另一条占位", () => {
    const items = [shot(100), shot(900)];
    const plan = planImageBudget(items, 10_000, { perImageBytes: 800 });
    expect(plan).toEqual([
      expect.objectContaining({
        targetId: items[1]?.entry.id,
        cause: "per_image",
        replacement: `Image: a.png\n${IMAGE_OMITTED_TOO_LARGE}`,
      }),
    ]);
  });

  it("> 20 张且有长边 > 2000 px 的图：从最旧降到 ≤ 20 张或没有大图", () => {
    const items = Array.from({ length: 23 }, () => shot(10));
    const wide = items[22]?.message as { content: ContentBlock[] };
    const sizes = new Map<ImageBlock, { width: number; height: number }>();
    sizes.set(wide.content[1] as ImageBlock, { width: 2400, height: 100 });
    const sizeOf = (block: ImageBlock) => sizes.get(block) ?? { width: 100, height: 100 };
    const plan = planImageBudget(items, 10_000, { sizeOf });
    expect(plan.map((p) => p.targetId)).toEqual(items.slice(0, 3).map((i) => i.entry.id));
    expect(plan.every((p) => p.cause === "many_images")).toBe(true);
    // 没有大图：张数再多也不动
    expect(planImageBudget(items, 10_000, { sizeOf: () => ({ width: 10, height: 10 }) })).toEqual(
      [],
    );
    // ≤ 20 张：不检查边长
    expect(planImageBudget(items.slice(3), 10_000, { sizeOf })).toEqual([]);
  });

  it("只看带图的 user / toolResult / custom；字符串内容、助手消息、无图消息跳过", () => {
    const items = [
      item("user", "plain"),
      item("assistant", ""),
      item("user", [{ type: "text", text: "看" }, image(600), image(600)]),
      item("custom", [image(10)]),
      item("toolResult", [{ type: "text", text: "no image" }]),
    ];
    const plan = planImageBudget(items, 1000);
    expect(plan).toEqual([
      expect.objectContaining({
        targetId: items[2]?.entry.id,
        images: 2,
        bytes: 1200,
        replacement: `看\n${IMAGE_OMITTED_FOR_BUDGET}\n${IMAGE_OMITTED_FOR_BUDGET}`,
      }),
    ]);
  });

  it("budgetReplacement 与 base64ImageSize", () => {
    expect(budgetReplacement([image(1)])).toBe(IMAGE_OMITTED_FOR_BUDGET);
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d494844520000012c000000c808060000001f15c489",
      "hex",
    );
    const block: ImageBlock = {
      type: "image",
      mimeType: "image/png",
      data: png.toString("base64"),
    };
    expect(base64ImageSize(block)).toEqual({ width: 300, height: 200 });
    expect(base64ImageSize(block)).toEqual({ width: 300, height: 200 });
  });
});
