/**
 * 工具可用性的固定英文文案（docs/model-efficiency-plan.md §1.4、D5）：执行层拒绝与尾部提醒共用，
 * 发给模型，两种界面语言下逐字节相同。[ME-C0]
 */

/** 执行层拒绝：工具不在本会话可用（未注册，或在 `unavailableTools` 里）。 */
export const toolUnavailableText = (name: string): string =>
  `Tool "${name}" is not available in this session.`;

/** 对话开始后移除工具：声明保留，尾部提醒。 */
export const toolRemovedReminder = (name: string): string =>
  `Tool "${name}" is no longer available in this session; calls to it are rejected.`;

/** 移除后又加回。 */
export const toolRestoredReminder = (name: string): string => `Tool "${name}" is available again.`;
