/**
 * 图片预算扩展（docs/history/wave5-plan.md §4、D11、D30）。[W5-I]
 *
 * 每次请求前检查图片总量：超预算（或有超单图上限的旧图、> 20 张时的大图）就按
 * `planImageBudget` 把旧图换成占位文本，写成 `context_edit{reason:"image_budget"}` 持久化、
 * 重建上下文，并通知缓存控制器「下一条是重置点」（前缀只在这里变一次，之后稳定）。
 *
 * 两个检查点：
 * - `beforePrompts`：新回合投递前；本回合提示里的附件计入总量但不降级；
 * - `wrapStream`：回合内（工具结果里新读的图）每次 `turn` 请求前；已发出的消息都已落盘时才降级，
 *   并把本次请求的转录换成降级后的（就地改 context，缓存控制器看到的也是降级后的请求）。
 *
 * 模型不收图片时不处理：`normalizeContext` 已把图片换成占位（ai/context.ts）。
 */

import { MANY_IMAGES_COUNT, imageLimits, type ImageLimits } from "../ai/image-limits.js";
import type { ImageBlock, Message, Model } from "../ai/types.js";
import { planImageBudget, type ImageBudgetEdit } from "../compaction/image-budget.js";
import { buildProjection } from "../session/projection.js";
import type { AgentMessage } from "../session/types.js";
import type { StreamFn } from "./loop.js";
import type { SessionCore } from "./session-core.js";
import type { SessionExtension } from "./session-extensions.js";
import { convertToLlm } from "./transform.js";

export interface ImageBudgetExtensionDeps {
  /** 测试注入：按模型的上限。缺省 `imageLimits(model)`。 */
  limits?(model: Model): ImageLimits;
}

function imagesIn(message: AgentMessage | Message): ImageBlock[] {
  if (!("content" in message) || !Array.isArray(message.content)) return [];
  return (message.content as readonly { type: string }[]).filter(
    (block): block is ImageBlock => block.type === "image",
  );
}

/** 粗查：总量、单张、张数都没越线就不必建投影。 */
function withinLimits(
  messages: readonly (AgentMessage | Message)[],
  reserve: readonly ImageBlock[],
  limits: ImageLimits,
): boolean {
  let total = 0;
  let count = 0;
  for (const message of [...messages.map(imagesIn), reserve]) {
    for (const image of message) {
      if (image.data.length > limits.perImageBase64) return false;
      total += image.data.length;
      count++;
    }
  }
  return total <= limits.perRequestBase64 && count <= MANY_IMAGES_COUNT;
}

export function createImageBudgetExtension(
  core: SessionCore,
  deps: ImageBudgetExtensionDeps = {},
): SessionExtension {
  const limitsOf = deps.limits ?? ((model: Model) => imageLimits(model));

  /** 返回写下的降级条目；`synced`：要求 Agent 的消息与落盘的投影一致（回合内）。 */
  const enforce = (
    model: Model,
    reserve: readonly ImageBlock[],
    synced: boolean,
  ): ImageBudgetEdit[] => {
    if (!model.input.includes("image")) return [];
    const limits = limitsOf(model);
    if (withinLimits(core.agent.messages, reserve, limits)) return [];
    const projection = buildProjection(core.manager.branch());
    if (synced && projection.messages.length !== core.agent.messages.length) return [];
    const plan = planImageBudget(projection.items, limits.perRequestBase64, {
      perImageBytes: limits.perImageBase64,
      reserve,
    });
    if (plan.length === 0) return [];
    for (const edit of plan) {
      core.appendEntry({
        type: "context_edit",
        targetId: edit.targetId,
        replacement: edit.replacement,
        reason: "image_budget",
      });
    }
    core.reloadMessages();
    core.cache?.onContextChanged();
    const images = plan.reduce((sum, edit) => sum + edit.images, 0);
    core.log(
      "info",
      `image budget: omitted ${images} earlier image(s) in ${plan.length} message(s) to fit the request size`,
    );
    return plan;
  };

  return {
    id: "images",
    beforePrompts(_ctx, prompts) {
      const reserve = prompts.flatMap(imagesIn);
      enforce(core.model(), reserve, false);
      return [];
    },
    wrapStream(stream: StreamFn): StreamFn {
      return (model, context, options) => {
        if ((options.purpose ?? "turn") === "turn") {
          try {
            if (enforce(model, [], true).length > 0) {
              const messages = convertToLlm(core.agent.messages, {
                provider: model.provider,
                model: model.id,
              });
              (context as { messages: readonly Message[] }).messages = messages;
            }
          } catch (error) {
            core.log("warn", `image budget check failed: ${String(error)}`);
          }
        }
        return stream(model, context, options);
      };
    },
  };
}
