/**
 * B1 测试辅助：跑一个 SSE 样本（三种切分方式），断言流契约与三种方式一致，比对黄金文件。
 * `UPDATE_GOLDEN=1` 时重写黄金文件。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { collectEvents } from "../../src/ai/event-stream.js";
import type {
  ApiImplementation,
  AssistantEvent,
  AssistantMessage,
  Model,
  StreamOptions,
  TranscriptContext,
} from "../../src/ai/types.js";
import { assertStreamContract, simplifyEvents } from "./contract.js";
import {
  SSE_FIXTURE_DIR,
  loadFixture,
  stubFetchWithFixture,
  type CapturedRequest,
  type ChunkMode,
} from "./fixture-fetch.js";

export const BASIC_CONTEXT: TranscriptContext = {
  messages: [
    { role: "system", sections: { preamble: "You are a test assistant." }, timestamp: 1 },
    { role: "user", content: "hi", timestamp: 2 },
  ],
};

export interface FixtureRun {
  events: AssistantEvent[];
  final: AssistantMessage;
  terminal: Extract<AssistantEvent, { type: "done" | "error" }>;
  request: CapturedRequest | undefined;
}

export async function runFixture(
  impl: ApiImplementation,
  api: string,
  name: string,
  model: Model,
  options: Partial<StreamOptions> = {},
  context: TranscriptContext = BASIC_CONTEXT,
  golden: string | null = name,
): Promise<FixtureRun> {
  const fixture = loadFixture(api, name);
  const runs: FixtureRun[] = [];
  for (const mode of ["whole", "bytes7", "crlf"] as ChunkMode[]) {
    const captured = stubFetchWithFixture(fixture, mode);
    try {
      const stream = impl.stream(model, context, {
        signal: new AbortController().signal,
        apiKey: "sk-test",
        ...options,
      });
      const events = await collectEvents(stream);
      const final = await stream.result();
      const terminal = assertStreamContract(events, final);
      runs.push({ events, final, terminal, request: captured[0] });
    } finally {
      vi.unstubAllGlobals();
    }
  }
  const [first, ...rest] = runs;
  if (!first) throw new Error("no runs");
  const simplified = JSON.stringify(simplifyEvents(first.events));
  for (const run of rest) expect(JSON.stringify(simplifyEvents(run.events))).toBe(simplified);
  if (golden !== null) checkGolden(api, golden, simplifyEvents(first.events));
  return first;
}

export function checkGolden(api: string, name: string, value: unknown): void {
  const path = join(SSE_FIXTURE_DIR, api, `${name}.golden.json`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(path)) {
    if (process.env["UPDATE_GOLDEN"] !== "1") {
      throw new Error(`golden file missing: ${path} (run with UPDATE_GOLDEN=1)`);
    }
    writeFileSync(path, serialized);
    return;
  }
  expect(JSON.parse(serialized)).toEqual(JSON.parse(readFileSync(path, "utf8")));
}
