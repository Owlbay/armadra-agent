/**
 * RPC 模式测试驱动（stdin / stdout 走 PassThrough）与黄金记录的归一化。[W5-F]
 * 与 src/modes/rpc/rpc-mode.test.ts 里的同名辅助一致，供新的 RPC 用例复用。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import type { FakeResponse } from "../../src/ai/fake/fake-script.js";
import { emptyArgs } from "../../src/cli/args.js";
import type { ComposeOptions } from "../../src/cli/compose.js";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.js";
import { composeHarness, type ComposeHarness } from "./compose-harness.js";

export type Line = Record<string, unknown>;

export interface Driver {
  send(command: object): void;
  waitFor(predicate: (line: Line) => boolean, label?: string): Promise<Line>;
  lines: Line[];
}

export async function driveRpc(
  script: FakeResponse[] | undefined,
  steps: (d: Driver, h: ComposeHarness) => Promise<void>,
  options: { compose?: ComposeOptions; setup?(h: ComposeHarness): void } = {},
): Promise<{ code: number; lines: Line[]; h: ComposeHarness }> {
  const h = composeHarness(script);
  options.setup?.(h);
  const runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo"], options.compose);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: Line[] = [];
  let buffer = "";
  stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)) as Line);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  });
  const done = runRpcMode(
    runtime,
    { args: emptyArgs(), prompt: undefined, io: h.io },
    { stdin, stdout },
  );
  const driver: Driver = {
    lines,
    send: (command) => void stdin.write(`${JSON.stringify(command)}\n`),
    async waitFor(predicate, label = "line") {
      const started = Date.now();
      for (;;) {
        const hit = lines.findLast(predicate);
        if (hit !== undefined) return hit;
        if (Date.now() - started > 5000)
          throw new Error(`timeout waiting for ${label}: ${lines.map((l) => l["type"]).join(",")}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
  try {
    await steps(driver, h);
  } finally {
    stdin.end();
  }
  const code = await done;
  await runtime.dispose();
  return { code, lines, h };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 归一化时间戳、id、版本、临时路径。 */
export function normalizeLine(line: Line, root: string): string {
  return JSON.stringify(line, (key, value: unknown) => {
    if (key === "timestamp" || key === "durationMs") return 0;
    if (key === "version" && typeof value === "string") return "<version>";
    if (typeof value !== "string") return value;
    if (UUID.test(value)) return "<uuid>";
    if (/^[0-9a-f]{8}$/.test(value)) return "<id>";
    return value
      .split(root)
      .join("<root>")
      .replace(/<root>[^\s"]*/g, (path) => path.replace(/\\/g, "/"))
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-v/g, "/<uuid>-v");
  });
}

export function rpcGolden(name: string, actual: string): void {
  const file = new URL(`../fixtures/rpc/${name}`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
}
