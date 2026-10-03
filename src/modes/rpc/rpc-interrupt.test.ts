/**
 * RPC `prompt / steer` 的 `interrupt: true`（打断并立即发送）：黄金记录 interrupt.out.jsonl——长回复流式中，
 * 先排一条 steer，再 `steer{interrupt}` → 旧回合以 aborted 收尾，新回合立即以「steer + 本条」开始（origin
 * interrupt）；`interrupt` 类型不对 → invalid_arguments；空闲时 `prompt{interrupt}` 等同普通提示。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { FakeResponse } from "../../ai/fake/fake-script.js";
import type { PromptOptions } from "../../agent/types.js";
import { emptyArgs } from "../../cli/args.js";
import type { RpcCommandMap } from "../../rpc.js";
import { runRpcMode } from "./rpc-mode.js";

let h: ComposeHarness;
afterEach(() => h?.cleanup());

type Line = Record<string, unknown>;

const script: FakeResponse[] = [
  { steps: [{ text: "working" }, { delayMs: 5_000 }, { text: " never" }] },
  { text: "switched", usage: { input: 30, output: 2 } },
  { text: "idle answer", usage: { input: 40, output: 2 } },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function normalize(line: Line, root: string): string {
  return JSON.stringify(line, (key, value: unknown) => {
    if (["timestamp", "durationMs"].includes(key)) return 0;
    if (typeof value !== "string") return value;
    return value.split(root).join("<root>").replace(/\\/g, "/").replace(UUID, "<uuid>");
  });
}

function golden(name: string, actual: string): void {
  const file = new URL(`../../../test/fixtures/rpc/${name}`, import.meta.url);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, actual);
  expect(actual).toBe(readFileSync(file, "utf8"));
}

async function until(lines: Line[], match: (l: Line) => boolean, from = 0): Promise<Line> {
  const started = Date.now();
  for (;;) {
    const found = lines.slice(from).find(match);
    if (found !== undefined) return found;
    if (Date.now() - started > 5000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("RPC interrupt", () => {
  it("接口形状：prompt / steer 的 interrupt 与 SDK 选项", () => {
    expectTypeOf<RpcCommandMap["prompt"]["interrupt"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<RpcCommandMap["steer"]["interrupt"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<PromptOptions["interrupt"]>().toEqualTypeOf<boolean | undefined>();
  });

  it("interrupt.out.jsonl：流式中 steer{interrupt} → 旧回合 aborted → 新回合收到「steer + 本条」", async () => {
    h = composeHarness(script);
    const runtime = await h.boot(["--mode", "rpc", "--model", "fake/echo"]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: Line[] = [];
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, at)) as Line);
        buffer = buffer.slice(at + 1);
      }
    });
    const done = runRpcMode(
      runtime,
      { args: emptyArgs(), prompt: undefined, io: h.io },
      { stdin, stdout },
    );
    const send = (command: Line): void => void stdin.write(`${JSON.stringify(command)}\n`);
    send({ id: "p", type: "prompt", message: "start" });
    await until(lines, (l) => l["type"] === "message_update");
    send({ id: "s", type: "steer", message: "note first" });
    await until(lines, (l) => l["id"] === "s");
    send({ id: "bad", type: "steer", message: "x", interrupt: "yes" });
    await until(lines, (l) => l["id"] === "bad");
    send({ id: "i", type: "steer", message: "do B now", interrupt: true });
    const isSwitched = (l: Line): boolean =>
      l["type"] === "message_end" && JSON.stringify(l["message"]).includes('"switched"');
    const at = lines.indexOf(await until(lines, isSwitched));
    await until(lines, (l) => l["type"] === "agent_settled", at);
    // 空闲时 prompt{interrupt} 等同普通提示
    send({ id: "idle", type: "prompt", message: "hello", interrupt: true });
    const idle = lines.length;
    await until(lines, (l) => l["type"] === "agent_settled", idle);
    stdin.end();
    expect(await done).toBe(0);
    await runtime.dispose();

    expect(lines.find((l) => l["id"] === "bad")).toMatchObject({
      success: false,
      code: "invalid_arguments",
    });
    expect(lines.find((l) => l["id"] === "i")).toMatchObject({
      success: true,
      data: { disposition: "started" },
    });
    expect(h.fake.calls).toHaveLength(3);
    // 缓存：新请求以上一请求的全部消息为前缀
    const [first, second] = h.fake.calls as [(typeof h.fake.calls)[0], (typeof h.fake.calls)[0]];
    expect(second.context.messages.slice(0, first.context.messages.length)).toEqual(
      first.context.messages,
    );
    expect(second.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: "note first\n\ndo B now",
    });
    const kept = lines.filter((l) => {
      const type = String(l["type"]);
      const role = (l["message"] as { role?: string } | undefined)?.role;
      return (
        (type === "response" && ["p", "s", "i", "idle"].includes(String(l["id"]))) ||
        type === "agent_start" ||
        type === "agent_settled" ||
        type === "queue_update" ||
        (type === "message_end" && role !== "system")
      );
    });
    golden("interrupt.out.jsonl", kept.map((l) => normalize(l, h.home.root)).join("\n") + "\n");
  });
});
