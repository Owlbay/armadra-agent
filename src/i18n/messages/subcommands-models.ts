/**
 * 消息目录：subcommands 里 `ama models enable | disable | list --enabled`（`modelsEnabled`）。由
 * messages/subcommands.ts 引用。
 */

import type { Messages } from "../types.js";

export const en = {
  modelsEnabled: {
    badRef: (ref: string) => `ama: ${ref} is not provider/model[@channel] or provider/*\n`,
    unknownModel: (ref: string) =>
      `ama: warning: ${ref} is not in the model table; written anyway (relays accept any id)\n`,
    added: (refs: string, path: string) => `Added to models.enabled: ${refs} → ${path}\n`,
    alreadyListed: (refs: string) => `Already in models.enabled: ${refs}\n`,
    removed: (refs: string, path: string) => `Removed from models.enabled: ${refs} → ${path}\n`,
    notListed: (refs: string) => `Not in models.enabled: ${refs}\n`,
    cleared: (path: string) =>
      `models.enabled is empty and was removed; /model shows every configured model again → ${path}\n`,
    listHeader: (path: string) => `models.enabled (${path}):\n`,
    listUnset: "models.enabled is not set; /model shows the models of configured providers:\n",
    notInTable: "not in the model table",
    nothing: "  (none)\n",
  },
};

export const zh = {
  modelsEnabled: {
    badRef: (ref) => `ama: ${ref} 不是 provider/model[@channel] 或 provider/*\n`,
    unknownModel: (ref) => `ama: 警告：${ref} 不在模型表里，照样写入（中转站接受任意 id）\n`,
    added: (refs, path) => `已加入 models.enabled：${refs} → ${path}\n`,
    alreadyListed: (refs) => `已在 models.enabled 里：${refs}\n`,
    removed: (refs, path) => `已移出 models.enabled：${refs} → ${path}\n`,
    notListed: (refs) => `不在 models.enabled 里：${refs}\n`,
    cleared: (path) => `models.enabled 已清空并删除，/model 恢复显示全部已配置的模型 → ${path}\n`,
    listHeader: (path) => `models.enabled（${path}）：\n`,
    listUnset: "未设置 models.enabled；/model 显示已配置供应商的模型：\n",
    notInTable: "不在模型表里",
    nothing: "  （无）\n",
  },
} satisfies Messages<typeof en>;
