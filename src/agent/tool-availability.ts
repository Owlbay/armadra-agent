/**
 * 工具可用性的固定英文文案（docs/model-efficiency-plan.md §1.4、D5）：执行层拒绝与尾部提醒共用，
 * 发给模型，两种界面语言下逐字节相同。[ME-C0]
 * [ME-B] 两条提醒由 `ai/context.ts` 渲染（ai 不 import agent），定义移到那里、这里再导出。
 */

export { toolRemovedReminder, toolRestoredReminder } from "../ai/context.js";

/** 执行层拒绝：工具不在本会话可用（未注册，或在 `unavailableTools` 里）。 */
export const toolUnavailableText = (name: string): string =>
  `Tool "${name}" is not available in this session.`;
