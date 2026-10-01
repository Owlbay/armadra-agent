/**
 * B2 集成测试装配：脚本化流 + 桩注册表 + AgentSessionImpl + 事件记录。[B2]
 */

import { readFileSync } from "node:fs";
import type { Model, TranscriptContext } from "../../ai/types.js";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../compaction/summarize-tier.js";
import { SessionManager } from "../../session/manager.js";
import type { SessionEntry, SessionLine } from "../../session/types.js";
import type { AgentSessionOptions } from "../session-core.js";
import { AgentSessionImpl } from "../session.js";
import type { SessionEvent } from "../types.js";
import { createScriptedApi, type ScriptSource, type ScriptedApi } from "./scripted-api.js";
import { fakeModel, stubRegistry } from "./stubs.js";

export interface HarnessOptions extends Partial<
  Omit<AgentSessionOptions, "sessionManager" | "providers">
> {
  script: ScriptSource;
  /** 会话目录；缺省内存会话。 */
  dir?: string;
  cwd?: string;
  delayMs?: number;
}

export interface Harness {
  session: AgentSessionImpl;
  manager: SessionManager;
  scripted: ScriptedApi;
  model: Model;
  events: SessionEvent[];
  types(): string[];
  fileLines(): SessionLine[];
  fileEntries(): SessionEntry[];
}

export function createHarness(options: HarnessOptions): Harness {
  const { script, dir, cwd = "/work", delayMs, ...rest } = options;
  const model = rest.model ?? fakeModel();
  const scripted = createScriptedApi(script, delayMs === undefined ? {} : { delayMs });
  const manager =
    dir === undefined ? SessionManager.inMemory(cwd) : SessionManager.create(dir, cwd);
  const session = new AgentSessionImpl({
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
    abortGraceMs: 50,
    ...rest,
    model,
    sessionManager: manager,
    providers: stubRegistry([model], [scripted.api]),
  });
  const events: SessionEvent[] = [];
  session.subscribe((event) => events.push(event));
  const fileLines = (): SessionLine[] => {
    const file = manager.file();
    if (file === undefined) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionLine);
  };
  return {
    session,
    manager,
    scripted,
    model,
    events,
    types: () => events.map((event) => event.type),
    fileLines,
    fileEntries: () => fileLines().filter((line): line is SessionEntry => line.type !== "session"),
  };
}

export function isSummaryRequest(context: TranscriptContext): boolean {
  const first = context.messages[0];
  return first?.role === "system" && first.sections["preamble"] === SUMMARIZATION_SYSTEM_PROMPT;
}

/** 请求里所有 user 消息的文本。 */
export function userTexts(context: TranscriptContext): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    );
}

/** 文件中每个 tool_call 的结果条数（不变式：恰好 1）。 */
export function toolResultCounts(entries: readonly SessionEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "assistant") {
      for (const block of message.content)
        if (block.type === "toolCall") counts.set(block.id, counts.get(block.id) ?? 0);
    } else if (message.role === "toolResult") {
      counts.set(message.toolCallId, (counts.get(message.toolCallId) ?? 0) + 1);
    }
  }
  return counts;
}
