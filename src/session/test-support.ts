/**
 * 测试用：直接写会话 JSONL（与 manager 写出的形状相同：type 是第一个键）。[W4-D]
 * 只给 stats / search / export / --from 的测试用，文件放调用方的临时目录。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "../ai/types.js";
import { sessionDirForCwd, sessionFileName } from "./store.js";

export interface FixtureSession {
  id: string;
  cwd: string;
  start: Date;
  /** 不含头。每行可不写 id / parentId / timestamp（自动补，时间每条 +1 s）。 */
  entries: Array<Record<string, unknown>>;
  /** 每条之间的秒数（缺省 1）。 */
  stepSeconds?: number;
}

export function usageOf(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  cost?: number,
): Usage {
  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
  if (cost !== undefined)
    usage.cost = { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost };
  return usage;
}

export const userEntry = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "message",
  message: { role: "user", content, timestamp: 0, ...extra },
});

export const assistantEntry = (
  text: string,
  usage: Usage,
  options: {
    provider?: string;
    model?: string;
    tools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
    stopReason?: string;
  } = {},
) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [
      ...(text !== "" ? [{ type: "text", text }] : []),
      ...(options.tools ?? []).map((t, i) => ({
        type: "toolCall",
        id: `call-${i}`,
        name: t.name,
        arguments: t.arguments ?? {},
      })),
    ],
    api: "fake",
    provider: options.provider ?? "fake",
    model: options.model ?? "echo",
    usage,
    stopReason: options.stopReason ?? ((options.tools ?? []).length > 0 ? "toolUse" : "stop"),
    timestamp: 0,
  },
});

export const toolResultEntry = (name: string, text: string, isError = false) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "call-0",
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: 0,
  },
});

/** 写到 `<root>/<编码 cwd>/<时间>_<id>.jsonl`，返回文件路径。 */
export function writeFixtureSession(root: string, session: FixtureSession): string {
  const dir = sessionDirForCwd(root, session.cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, sessionFileName(session.start, session.id));
  const step = (session.stepSeconds ?? 1) * 1000;
  const lines: string[] = [
    JSON.stringify({
      type: "session",
      version: 1,
      id: session.id,
      timestamp: session.start.toISOString(),
      cwd: session.cwd,
      agent: { name: "ama", version: "0.0.0" },
    }),
  ];
  let parentId: string | null = null;
  session.entries.forEach((entry, i) => {
    if (entry["type"] === "leaf") {
      lines.push(JSON.stringify(entry));
      return;
    }
    const id = typeof entry["id"] === "string" ? entry["id"] : `e${i + 1}`;
    const line = {
      ...entry,
      id,
      parentId: "parentId" in entry ? entry["parentId"] : parentId,
      timestamp: new Date(session.start.getTime() + (i + 1) * step).toISOString(),
    };
    lines.push(JSON.stringify(line));
    parentId = id;
  });
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
