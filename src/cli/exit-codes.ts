/**
 * 进程退出码（设计 §11.3）。[B0] 契约文件。
 */

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
  /** HOST_API_VERSION 不匹配。 */
  HostVersion: 78,
  /** SIGINT 退出（两次 Ctrl+C）。 */
  Sigint: 130,
  /** SIGTERM。 */
  Sigterm: 143,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCode = (typeof ExitCode)[ExitCodeName];

export const EXIT_CODE_DESCRIPTIONS: Readonly<Record<ExitCode, string>> = {
  0: "正常",
  1: "运行期错误（模型最终失败等）",
  2: "参数用法错误",
  3: "配置 / profile / 路径错误",
  4: "无可用模型或密钥",
  5: "会话不存在 / 损坏 / cwd 不匹配",
  6: "宿主 / Hook 加载或启动失败",
  78: "HOST_API_VERSION 不匹配",
  130: "SIGINT 退出（两次 Ctrl+C）",
  143: "SIGTERM",
};

export function describeExitCode(code: number): string {
  return (EXIT_CODE_DESCRIPTIONS as Readonly<Record<number, string>>)[code] ?? "未知退出码";
}
