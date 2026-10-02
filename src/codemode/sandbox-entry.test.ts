/**
 * 子进程入口：直接按行协议驱动 esbuild 打出的入口（与 dist/bundle/ama-sandbox.cjs 同形），
 * 不经 host-side。
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sandboxEntryForTests } from "../../test/helpers/codemode-sandbox.js";
import { describeError } from "./sandbox-entry.js";
import {
  DEFAULT_SCRIPT_OPTIONS,
  MAX_CONCURRENT_TOOL_CALLS,
  SANDBOX_MAIN_FLAG,
  decodeChildLine,
  encodeLine,
  type ChildMessage,
  type StoreSnapshot,
} from "./protocol.js";
import { permissionFlagFor } from "./capability.js";

interface Drive {
  messages: ChildMessage[];
  outputs: string[];
  done: Extract<ChildMessage, { type: "done" }>;
  maxInFlight: number;
}

/**
 * 跑一段脚本：`answer` 决定每次 tool_call 的应答；`hold` 个调用到齐后才统一应答（验证并行发起）。
 */
function drive(
  script: string,
  options: {
    tools?: string[];
    store?: StoreSnapshot;
    answer?: (call: { name: string; input: unknown }) => { ok: boolean; value?: unknown };
    hold?: number;
    abortAfterFirstCall?: boolean;
  } = {},
): Promise<Drive> {
  const entry = sandboxEntryForTests();
  const child = spawn(
    process.execPath,
    [
      permissionFlagFor(),
      `--allow-fs-read=${entry}`,
      "--disallow-code-generation-from-strings",
      entry,
      SANDBOX_MAIN_FLAG,
    ],
    { env: {}, stdio: ["pipe", "pipe", "pipe"] },
  );
  const messages: ChildMessage[] = [];
  const held: { id: number; name: string; input: unknown }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const reply = (call: { id: number; name: string; input: unknown }): void => {
    const a = options.answer?.(call) ?? { ok: true, value: `${call.name}-result` };
    inFlight--;
    child.stdin.write(
      encodeLine(
        a.ok
          ? { type: "tool_result", id: call.id, ok: true, value: a.value }
          : { type: "tool_result", id: call.id, ok: false, error: String(a.value) },
      ),
    );
  };
  child.stdin.on("error", () => {});
  child.stdin.write(
    encodeLine({
      type: "run",
      script,
      options: { ...DEFAULT_SCRIPT_OPTIONS },
      tools: (options.tools ?? ["read", "grep", "glob"]).map((name) => ({
        name,
        declaration: `${name}(args: {}): Promise<string>;`,
      })),
      store: options.store ?? {},
    }),
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") continue;
        const message = decodeChildLine(line);
        messages.push(message);
        if (message.type === "tool_call") {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (options.abortAfterFirstCall === true) {
            child.stdin.write(encodeLine({ type: "abort" }));
            continue;
          }
          if (options.hold !== undefined) {
            held.push(message);
            if (held.length >= options.hold) for (const call of held.splice(0)) reply(call);
          } else setImmediate(() => reply(message));
        }
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      const done = messages.find(
        (m): m is Extract<ChildMessage, { type: "done" }> => m.type === "done",
      );
      if (done === undefined) return reject(new Error(`no done message; stderr: ${stderr}`));
      resolve({
        messages,
        outputs: messages
          .filter((m): m is Extract<ChildMessage, { type: "output" }> => m.type === "output")
          .map((m) => m.text),
        done,
        maxInFlight,
      });
    });
  });
}

describe("sandbox-entry（子进程）", () => {
  it("Promise.all 三个 tools.* 并行：三条 tool_call 先全部到达父进程，只有输出回父", async () => {
    const r = await drive(
      `const [a, b, c] = await Promise.all([
        tools.read({ path: "a.ts" }),
        tools.grep({ pattern: "x" }),
        tools.glob({ pattern: "*.md" }),
      ]);
      return [a, b, c].join(",");`,
      { hold: 3 },
    );
    const calls = r.messages.filter((m) => m.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", id: 1, name: "read", input: { path: "a.ts" } },
      { type: "tool_call", id: 2, name: "grep", input: { pattern: "x" } },
      { type: "tool_call", id: 3, name: "glob", input: { pattern: "*.md" } },
    ]);
    expect(r.maxInFlight).toBe(3);
    expect(r.outputs).toEqual(["read-result,grep-result,glob-result"]);
    expect(r.done.ok).toBe(true);
    expect(r.messages.map((m) => m.type)).toEqual([
      "tool_call",
      "tool_call",
      "tool_call",
      "output",
      "done",
    ]);
  });

  it("vm 内没有 require / process / fetch / 定时器；eval、new Function、构造器逃逸都被拒", async () => {
    const r = await drive(`
      console.log(typeof require, typeof process, typeof fetch, typeof setTimeout, typeof module);
      const tryIt = (label, fn) => { try { fn(); text(label + ": ran"); } catch (e) { text(label + ": " + e.name); } };
      tryIt("eval", () => eval("1 + 1"));
      tryIt("Function", () => new Function("return 1")());
      tryIt("AsyncFunction", () => (async () => {}).constructor("return 1"));
      tryIt("global-ctor", () => globalThis.constructor.constructor("return process")());
      tryIt("tools-ctor", () => tools.constructor.constructor("return process")());
      tryIt("text-ctor", () => text.constructor("return process")());
      tryIt("wasm", () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
    `);
    expect(r.done.ok).toBe(true);
    expect(r.outputs[0]).toBe("undefined undefined undefined undefined undefined");
    expect(r.outputs.slice(1)).toEqual([
      "eval: EvalError",
      "Function: EvalError",
      "AsyncFunction: EvalError",
      "global-ctor: EvalError",
      "tools-ctor: EvalError",
      "text-ctor: EvalError",
      "wasm: CompileError",
    ]);
  });

  it("输出：text / console.log / return，非字符串按 JSON", async () => {
    const r = await drive(
      `text("a"); console.log("b", 1, { c: [2] }); text({ d: true }); return 42;`,
    );
    expect(r.outputs).toEqual(["a", 'b 1 {\n  "c": [\n    2\n  ]\n}', '{\n  "d": true\n}', "42"]);
  });

  it("工具失败 → 脚本收到 Error，Promise.allSettled 其余成功", async () => {
    const r = await drive(
      `const results = await Promise.allSettled([
        tools.read({ path: "ok" }),
        tools.grep({ pattern: "denied" }),
      ]);
      for (const x of results) text(x.status + ":" + (x.status === "fulfilled" ? x.value : (x.reason instanceof Error) + " " + x.reason.message));`,
      {
        answer: (call) =>
          call.name === "grep"
            ? { ok: false, value: "Permission denied for grep" }
            : { ok: true, value: "R" },
      },
    );
    expect(r.outputs).toEqual(["fulfilled:R", "rejected:true Permission denied for grep"]);
  });

  it("脚本内不能调 codemode；未知工具给出可用清单；ALL_TOOLS / describeTool", async () => {
    const r = await drive(`
      await tools.codemode({ script: "1" }).catch((e) => text(e.message));
      await tools.nope({}).catch((e) => text(e.message));
      text(ALL_TOOLS.join(","));
      text(describeTool("read"));
      text(String(describeTool("zzz")));
      text(String("codemode" in tools) + " " + Object.keys(tools).join(","));
    `);
    expect(r.messages.some((m) => m.type === "tool_call")).toBe(false);
    expect(r.outputs).toEqual([
      "codemode cannot be called from a codemode script",
      "Unknown tool nope. Callable tools: read, grep, glob",
      "read,grep,glob",
      "read(args: {}): Promise<string>;",
      "undefined",
      "false read,grep,glob",
    ]);
  });

  it("并发工具调用上限 8", async () => {
    const r = await drive(
      `const all = await Promise.all(Array.from({ length: 20 }, (_, i) => tools.read({ path: String(i) })));
       return all.length;`,
    );
    expect(MAX_CONCURRENT_TOOL_CALLS).toBe(8);
    expect(r.maxInFlight).toBeLessThanOrEqual(8);
    expect(r.messages.filter((m) => m.type === "tool_call")).toHaveLength(20);
    expect(r.outputs).toEqual(["20"]);
  });

  it("失败：保留已产出输出，错误带脚本行号；语法错误", async () => {
    const r = await drive(`text("before");\nconst x = null;\nx.boom();`);
    expect(r.done.ok).toBe(false);
    expect(r.outputs).toEqual(["before"]);
    expect(r.done.error).toMatch(/^TypeError: .*null.* \(line 3\)$/);
    const syntax = await drive(`text("a");\nconst = ;`);
    expect(syntax.done.ok).toBe(false);
    expect(syntax.outputs).toEqual([]);
    expect(syntax.done.error).toMatch(/^SyntaxError/);
  });

  it("store / load：成功才发快照；超限抛错；undefined 删除", async () => {
    const r = await drive(
      `text(JSON.stringify(load("cursor"))); store("cursor", 5); store("gone", undefined);
       store("old", undefined); text(String(load("old")));
       try { store("big", "x".repeat(300000)); } catch (e) { text(e.name); }`,
      { store: { cursor: 1, old: "o" } },
    );
    expect(r.outputs).toEqual(["1", "undefined", "RangeError"]);
    expect(r.messages.find((m) => m.type === "store")).toEqual({
      type: "store",
      entries: { cursor: 5 },
    });
    const failed = await drive(`store("k", 1); throw new Error("no")`);
    expect(failed.messages.some((m) => m.type === "store")).toBe(false);
    const untouched = await drive(`load("k")`, { store: { k: 1 } });
    expect(untouched.messages.some((m) => m.type === "store")).toBe(false);
  });

  it("父进程 abort：未完成调用被拒，以失败结束", async () => {
    const r = await drive(`text("start"); await tools.read({ path: "slow" }); text("never");`, {
      abortAfterFirstCall: true,
    });
    expect(r.outputs).toEqual(["start"]);
    expect(r.done).toMatchObject({ ok: false, error: "Script aborted" });
  });

  it("describeError：非 Error 值与无栈错误", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError({ name: "X", message: "y" })).toBe("X: y");
    expect(describeError({ message: "m", stack: "at codemode-script.js:7:3" })).toBe(
      "Error: m (line 7)",
    );
  });
});
