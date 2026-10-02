/**
 * 进程退出码（设计 §11.3）。[B0] 契约文件。
 */

import { msg } from "../i18n/index.js";

export const ExitCode = {
  /** 正常。 */
  Ok: 0,
  /** 运行期错误（模型最终失败等）。 */
  RuntimeError: 1,
  /** 参数用法错误。 */
  Usage: 2,
  /** 配置 / profile / 路径错误。 */
  Config: 3,
  /** 无可用模型或密钥。 */
  NoModel: 4,
  /** 会话不存在 / 损坏 / cwd 不匹配。 */
  Session: 5,
  /** 宿主 / Hook 加载或启动失败。 */
  HostOrHook: 6,
  /** `-p` 运行中有工具调用被拒（无人审批、deny 规则、plan 等），要求的动作没有完成。 */
  ToolDenied: 7,
  /**
   * [W5-C0] `-p` 到达 `--max-turns` / `--max-cost` / `limits.*` 上限（`limit_reached`，W5-H2）。
   * 设计稿写的是 7，但 7 已发布为 ToolDenied，这里用 8。
   */
  LimitReached: 8,
  /**
   * [W5-H2] `-p` 在 plan 模式产出计划、已落盘但没有人审批（`plan.unattended: stop`，缺省）：
   * 计划还没执行。不复用 7（7 已发布为「工具调用被拒」）。
   */
  PlanPending: 9,
  /** HOST_API_VERSION 不匹配。 */
  HostVersion: 78,
  /** SIGINT 退出（两次 Ctrl+C）。 */
  Sigint: 130,
  /** SIGTERM。 */
  Sigterm: 143,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCode = (typeof ExitCode)[ExitCodeName];

/** [W6-I1] 退出码说明按界面语言取（`msg().cli.exitCodes`，键是 `ExitCode` 名字的 camelCase）。 */
export function describeExitCode(code: number): string {
  const texts = msg().cli.exitCodes;
  const name = (Object.keys(ExitCode) as ExitCodeName[]).find((key) => ExitCode[key] === code);
  if (name === undefined) return texts.unknown;
  return texts[`${name[0]!.toLowerCase()}${name.slice(1)}` as Uncapitalize<ExitCodeName>];
}
