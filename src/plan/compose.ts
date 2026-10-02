/**
 * plan 扩展的装配（`cli/compose-extensions.ts` 的一行）。[W5-F]
 *
 * 交互 / line 模式由用户在输入框里回复审批（文本回复，正式审批框归 W5-U），TUI 且无宿主时显示一行
 * 提示；print / rpc 缺省按 `plan.unattended`，RPC 客户端声明 `plans` 能力后改由客户端作答。
 */

import { createPlanExtensionFactory } from "../agent/session-plan.js";
import type { SessionExtensionFactory } from "../agent/session-extensions.js";
import type { ComposeExtensionDeps } from "../cli/compose-extensions.js";

export function planExtensionFor(deps: ComposeExtensionDeps): SessionExtensionFactory {
  const { assembly } = deps;
  const attended = assembly.mode === "interactive" || assembly.mode === "line";
  return createPlanExtensionFactory({
    ...(assembly.config.plan !== undefined ? { config: assembly.config.plan } : {}),
    // 组装表测试只给 config：其余材料按可缺省读取
    ...(assembly.paths?.dataDir !== undefined ? { dataDir: assembly.paths.dataDir } : {}),
    attendance: attended && !assembly.unattended ? "text" : "unattended",
    notice: assembly.mode === "interactive" && assembly.host?.handle === undefined,
    log: deps.log,
  });
}
