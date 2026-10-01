/**
 * 模式层共用的小工具：最后一条助手消息、信号处理、错误文本。[B6]
 */

import type { AgentSession } from "../agent/types.js";
import type { AssistantMessage } from "../ai/types.js";
import { ExitCode } from "../cli/exit-codes.js";

export function lastAssistant(session: AgentSession): AssistantMessage | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const message = session.messages[i];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 装 SIGINT / SIGTERM：调用 `onSignal(退出码)`；返回卸载函数。只在当前模式运行期间生效
 * （设计 §11.1 第 1 步：信号交给当前模式）。
 */
export function onTerminationSignals(onSignal: (exitCode: number) => void): () => void {
  const sigint = (): void => onSignal(ExitCode.Sigint);
  const sigterm = (): void => onSignal(ExitCode.Sigterm);
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  return () => {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  };
}
