/**
 * codemode 子进程入口（设计 §5.5 沙箱第 1–3 条；第二个 bundle 入口 dist/bundle/ama-sandbox.cjs）。[B10]
 *
 * 父进程以 `<node> --permission --allow-fs-read=<本文件> --disallow-code-generation-from-strings
 * <本文件>`、空环境启动本文件。本文件**只能 import node: 内置模块与类型**：权限模型只允许读入口
 * 文件本身，其它源文件读不到。
 *
 * - 用 `node:vm` 建一个只含 ECMAScript 内建对象的上下文（`codeGeneration: { strings: false,
 *   wasm: false }`），没有 require / process / fetch / console / 定时器；
 * - 注入 `tools`（Proxy：已知工具 → 调用，`codemode` → 拒绝，其它名字 → 拒绝并列出可用工具）、
 *   `text / console.* / store / load / ALL_TOOLS / describeTool`；
 * - 上下文里的函数都在上下文内定义（引导脚本），只经一个宿主函数 `host(kind, json)` 与本进程
 *   交换 JSON 字符串；本进程主 realm 也禁止字符串生成代码，拿到宿主函数的 `constructor` 也无法
 *   `Function("return process")`；
 * - 脚本包成 `(async () => { ... })()`，`return v` 等同 `text(v)`；并发工具调用 ≤ 8（引导脚本
 *   内的信号量）；结束（成功 / 失败 / abort）时拒绝未完成调用，发 `store`（仅成功）与 `done` 后退出。
 *
 * 行协议见 protocol.ts（这里只 import 类型）。
 */

import { Script, createContext } from "node:vm";
import type { ChildMessage, ParentMessage, ToolDecl } from "./protocol.js";

/** 与 protocol.ts 的 MAX_CONCURRENT_TOOL_CALLS、store.ts 的上限一致（本文件不能 import 运行时代码）。 */
const MAX_CONCURRENT = 8;
const MAX_STORE_VALUE_CHARS = 262_144;
const MAX_STORE_TOTAL_CHARS = 1_048_576;
const SCRIPT_FILENAME = "codemode-script.js";

/** 在 vm 上下文里执行的引导脚本：返回 `{ deliver, finish, run }`，全部是上下文 realm 的函数。 */
const BOOTSTRAP = String.raw`(function (host, config) {
  "use strict";
  const MAX = config.maxConcurrent;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const pending = new Map();
  const waiting = [];
  let nextId = 0;
  let active = 0;
  let closed = false;
  const decls = parse(config.tools);
  const declByName = new Map();
  const callName = new Map();
  for (const decl of decls) {
    declByName.set(decl.name, decl.declaration);
    callName.set(decl.name.replace(/[^A-Za-z0-9_$]/g, "_"), decl.name);
  }
  const names = Object.freeze(decls.map((d) => d.name));

  function format(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    if (value instanceof Error) return value.name + ": " + value.message;
    try {
      const json = stringify(value, null, 2);
      return json === undefined ? String(value) : json;
    } catch (error) {
      return String(value);
    }
  }
  function text(...values) {
    host("output", values.map(format).join(" "));
  }

  function callTool(name, input) {
    if (closed) return Promise.reject(new Error("The script has already finished"));
    let payload;
    try {
      payload = stringify({ name: name, input: input === undefined ? {} : input });
    } catch (error) {
      return Promise.reject(new Error("tools." + name + ": arguments must be JSON-serializable"));
    }
    return new Promise((resolve, reject) => {
      const start = () => {
        if (closed) return reject(new Error("The script has already finished"));
        const id = ++nextId;
        active++;
        pending.set(id, { resolve: resolve, reject: reject });
        host("tool_call", stringify(id) + "\n" + payload);
      };
      if (active < MAX) start();
      else waiting.push(start);
    });
  }

  function deliver(id, ok, json) {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    active--;
    const next = waiting.shift();
    if (next !== undefined) next();
    if (ok) entry.resolve(json === undefined ? undefined : parse(json));
    else entry.reject(new Error(json));
  }

  const toolsTarget = Object.create(null);
  const tools = new Proxy(toolsTarget, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      const real = callName.get(prop);
      if (real !== undefined) return (args) => callTool(real, args);
      if (prop === "codemode") {
        return () => Promise.reject(new Error("codemode cannot be called from a codemode script"));
      }
      return () =>
        Promise.reject(new Error("Unknown tool " + prop + ". Callable tools: " + names.join(", ")));
    },
    has(target, prop) {
      return typeof prop === "string" && callName.has(prop);
    },
    ownKeys() {
      return [...callName.keys()];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== "string" || !callName.has(prop)) return undefined;
      return { configurable: true, enumerable: true, writable: false, value: tools[prop] };
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  });

  const storeMap = new Map(Object.entries(parse(config.store)).map(([k, v]) => [k, stringify(v)]));
  let storeChanged = false;
  function store(key, value) {
    if (typeof key !== "string" || key === "") throw new TypeError("store(key, value): key must be a non-empty string");
    if (value === undefined) {
      storeChanged = storeMap.delete(key) || storeChanged;
      return;
    }
    let json;
    try {
      json = stringify(value);
    } catch (error) {
      throw new TypeError("store(" + stringify(key) + "): value must be JSON-serializable");
    }
    if (json === undefined) throw new TypeError("store(" + stringify(key) + "): value must be JSON-serializable");
    if (json.length > config.maxValueChars) {
      throw new RangeError("store(" + stringify(key) + "): value is " + json.length + " characters of JSON (limit " + config.maxValueChars + ")");
    }
    let total = json.length;
    for (const [k, v] of storeMap) if (k !== key) total += v.length;
    if (total > config.maxTotalChars) {
      throw new RangeError("store(" + stringify(key) + "): store would hold " + total + " characters of JSON (limit " + config.maxTotalChars + ")");
    }
    storeMap.set(key, json);
    storeChanged = true;
  }
  function load(key) {
    const json = storeMap.get(key);
    return json === undefined ? undefined : parse(json);
  }
  function describeTool(name) {
    return declByName.get(callName.get(name) ?? name);
  }

  const consoleObject = Object.freeze({
    log: text, info: text, warn: text, error: text, debug: text,
  });
  const globals = {
    tools: tools,
    text: (value) => text(value),
    console: consoleObject,
    store: store,
    load: load,
    ALL_TOOLS: names,
    describeTool: describeTool,
  };
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value: value, writable: false, enumerable: false, configurable: false });
  }

  function finish() {
    closed = true;
    waiting.length = 0;
    for (const entry of pending.values()) entry.reject(new Error("The script has finished"));
    pending.clear();
    if (!storeChanged) return undefined;
    const out = {};
    for (const [k, v] of storeMap) out[k] = parse(v);
    return stringify(out);
  }

  async function run(main) {
    const value = await main;
    if (value !== undefined) text(value);
  }

  return { deliver: deliver, finish: finish, run: run };
})`;

interface Bridge {
  deliver(id: number, ok: boolean, json: string | undefined): void;
  finish(): string | undefined;
  run(main: unknown): Promise<void>;
}

function send(message: ChildMessage): void {
  process.stdout.write(
    `${JSON.stringify(message)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")}\n`,
  );
}

/** 错误 → 一行说明；带上脚本里的行号（若能从栈里找到）。 */
export function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const e = error as { name?: unknown; message?: unknown; stack?: unknown };
  const base =
    typeof e.message === "string"
      ? `${typeof e.name === "string" ? e.name : "Error"}: ${e.message}`
      : String(error);
  const stack = typeof e.stack === "string" ? e.stack : "";
  const at = new RegExp(`${SCRIPT_FILENAME.replace(".", "\\.")}:(\\d+)(?::(\\d+))?`).exec(stack);
  return at === null ? base : `${base} (line ${at[1]})`;
}

let started = false;
let finished = false;
let bridge: Bridge | undefined;
let startedAt = 0;

function done(ok: boolean, error?: string): void {
  if (finished) return;
  finished = true;
  if (bridge !== undefined) {
    const snapshot = bridge.finish();
    if (ok && snapshot !== undefined) {
      send({ type: "store", entries: JSON.parse(snapshot) as Record<string, unknown> });
    }
  }
  const message: ChildMessage = { type: "done", ok, elapsedMs: Date.now() - startedAt };
  if (error !== undefined) message.error = error;
  send(message);
  // 等 stdout 冲完再退出（macOS 上管道写是异步的）。
  process.stdout.write("", () => process.exit(0));
}

function host(kind: string, payload: string): void {
  if (finished) return;
  if (kind === "output") {
    send({ type: "output", text: payload });
    return;
  }
  if (kind === "tool_call") {
    const newline = payload.indexOf("\n");
    const id = Number(payload.slice(0, newline));
    const call = JSON.parse(payload.slice(newline + 1)) as { name: string; input: unknown };
    send({ type: "tool_call", id, name: call.name, input: call.input });
  }
}

function start(run: Extract<ParentMessage, { type: "run" }>): void {
  started = true;
  startedAt = Date.now();
  // 沙箱对象用空原型：上下文的全局属性查找不会落到本进程 realm 的 Object.prototype 上。
  const context = createContext(Object.create(null) as object, {
    name: "codemode",
    codeGeneration: { strings: false, wasm: false },
  });
  const config = {
    maxConcurrent: MAX_CONCURRENT,
    maxValueChars: MAX_STORE_VALUE_CHARS,
    maxTotalChars: MAX_STORE_TOTAL_CHARS,
    tools: JSON.stringify(run.tools satisfies ToolDecl[]),
    store: JSON.stringify(run.store ?? {}),
  };
  let main: unknown;
  try {
    const factory = new Script(BOOTSTRAP, { filename: "codemode-bootstrap.js" }).runInContext(
      context,
    ) as (h: typeof host, c: typeof config) => Bridge;
    bridge = factory(host, config);
    main = new Script(`(async () => {\n${run.script}\n})()`, {
      filename: SCRIPT_FILENAME,
      lineOffset: -1,
    }).runInContext(context);
  } catch (error) {
    done(false, describeError(error));
    return;
  }
  (bridge as Bridge).run(main).then(
    () => done(true),
    (error: unknown) => done(false, describeError(error)),
  );
}

function handle(line: string): void {
  let message: ParentMessage;
  try {
    message = JSON.parse(line) as ParentMessage;
  } catch {
    return;
  }
  if (message.type === "run") {
    if (!started) start(message);
  } else if (message.type === "tool_result") {
    if (message.ok) {
      const json = message.value === undefined ? undefined : JSON.stringify(message.value);
      bridge?.deliver(message.id, true, json);
    } else bridge?.deliver(message.id, false, message.error);
  } else if (message.type === "abort") {
    done(false, "Script aborted");
  }
}

function main(): void {
  // 脚本里未 await 的 Promise 被拒绝不应让子进程崩溃。
  process.on("unhandledRejection", () => {});
  process.on("uncaughtException", (error) => done(false, describeError(error)));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim() !== "") handle(line);
  });
  process.stdin.on("end", () => {
    if (buffer.trim() !== "") handle(buffer);
    buffer = "";
    done(false, "Script aborted: parent closed the channel");
  });
}

// 父进程启动时附加该参数（protocol.ts 的 SANDBOX_MAIN_FLAG）；没有它（例如被测试 import）就不启动。
if (process.argv.includes("--ama-codemode-sandbox")) main();
