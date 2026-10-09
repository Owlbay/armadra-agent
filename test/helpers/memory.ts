/**
 * 内存回归测试的工具（docs/memory-plan.md D13、§1.5）。[M-C0]
 *
 * 断言只用确定性的量：`WeakRef` + 显式 GC 判可回收、GC 之后的堆增长上限、`FinalizationRegistry`
 * 计数存活实例；不以 RSS 作硬断言。vitest 以 `--expose-gc` 启动 worker（vitest.config.ts），
 * 缺失时回落 `v8.setFlagsFromString("--expose-gc")` + `vm.runInNewContext("gc")`。
 *
 * - `forceGc()`：一次完整 GC；
 * - `gcUntil(pred, rounds)`：每轮先让出事件循环（清掉 WeakRef 的任务内保活）、GC、再让出
 *   （FinalizationRegistry 回调在宏任务里跑），直到 `pred()` 为真；轮数缺省 10，`AMA_GC_ROUNDS` 可在慢机器上放宽；
 * - `measureGrowth(fn)`：热身一次后，前后各两轮 GC，比较 `heapUsed` / `external` / `arrayBuffers`；
 *   `fn` 的返回值在测量后才释放（结果本身计入增长）；`beforeGc` 是 `fn` 刚结束、尚未 GC 时的增长
 *   （含未回收的临时对象，只作诊断）；
 * - `trackInstances(ctor)`：登记的实例里还活着几个；
 * - `makeTextFile` / `makeSessionFile`：生成测试大文件（分块写，生成过程本身不占大内存）。
 */

import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { ContentBlock } from "../../src/ai/types.js";
import { SessionManager } from "../../src/session/manager.js";

let cachedGc: (() => void) | undefined;

function gcFunction(): () => void {
  if (cachedGc !== undefined) return cachedGc;
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (typeof exposed === "function") {
    cachedGc = exposed;
  } else {
    setFlagsFromString("--expose-gc");
    cachedGc = runInNewContext("gc") as () => void;
  }
  return cachedGc;
}

/** `globalThis.gc` 是否由启动参数提供（而不是回落路径）。 */
export function gcExposed(): boolean {
  return typeof (globalThis as { gc?: unknown }).gc === "function";
}

/** 一次完整（同步）GC。 */
export function forceGc(): void {
  gcFunction()();
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 缺省轮数；CI 慢机器可用 `AMA_GC_ROUNDS` 放宽。 */
export function defaultGcRounds(): number {
  const fromEnv = Number(process.env["AMA_GC_ROUNDS"]);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 10;
}

/** 反复 GC 直到 `pred()` 为真；返回最终的 `pred()`。 */
export async function gcUntil(pred: () => boolean, rounds = defaultGcRounds()): Promise<boolean> {
  for (let i = 0; i < rounds; i++) {
    // 先让出：本任务里新建或 deref 过的 WeakRef 目标在任务结束前不会被回收（KeepDuringJob）
    await tick();
    forceGc();
    await tick();
    if (pred()) return true;
  }
  return pred();
}

export interface MemorySample {
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface Growth extends MemorySample {
  /** `heapUsed + external + arrayBuffers` 的增长。 */
  total: number;
}

export interface GrowthResult<T> extends Growth {
  /** `fn` 刚结束、尚未 GC 时的增长（含未回收的临时分配，只作诊断）。 */
  beforeGc: Growth;
  result: T;
}

export function sampleMemory(): MemorySample {
  const { heapUsed, external, arrayBuffers } = process.memoryUsage();
  return { heapUsed, external, arrayBuffers };
}

function diff(after: MemorySample, before: MemorySample): Growth {
  const heapUsed = after.heapUsed - before.heapUsed;
  const external = after.external - before.external;
  const arrayBuffers = after.arrayBuffers - before.arrayBuffers;
  return { heapUsed, external, arrayBuffers, total: heapUsed + external + arrayBuffers };
}

async function settle(): Promise<MemorySample> {
  for (let i = 0; i < 2; i++) {
    forceGc();
    await tick();
  }
  return sampleMemory();
}

/** 测 `fn` 之后留下的内存增长（GC 之后）；`warmup` 缺省先跑一次（加载模块、JIT、缓存）。 */
export async function measureGrowth<T>(
  fn: () => T | Promise<T>,
  options: { warmup?: boolean } = {},
): Promise<GrowthResult<T>> {
  if (options.warmup !== false) await fn();
  const before = await settle();
  const result = await fn();
  const beforeGc = diff(sampleMemory(), before);
  const after = await settle();
  return { ...diff(after, before), beforeGc, result };
}

export interface InstanceTracker<T extends object> {
  /** 登记一个实例（类型不符时抛错）；返回原对象。 */
  add(instance: T): T;
  readonly created: number;
  readonly collected: number;
  /** 登记过且尚未被回收的个数（需配合 `gcUntil`）。 */
  readonly alive: number;
}

/** 以 `FinalizationRegistry` 计数 `ctor` 的存活实例（实例由调用方登记）。 */
export function trackInstances<T extends object>(
  ctor: abstract new (...args: never[]) => T,
): InstanceTracker<T> {
  let created = 0;
  let collected = 0;
  const registry = new FinalizationRegistry<number>(() => {
    collected++;
  });
  return {
    add(instance) {
      if (!(instance instanceof ctor)) throw new TypeError(`not an instance of ${ctor.name}`);
      registry.register(instance, created++);
      return instance;
    },
    get created() {
      return created;
    },
    get collected() {
      return collected;
    },
    get alive() {
      return created - collected;
    },
  };
}

export interface TextFileOptions {
  /** 行尾用 `\r\n`。 */
  crlf?: boolean;
  /** 文件以 UTF-8 BOM 开头。 */
  bom?: boolean;
  /** 行内混入中文与 emoji（多字节字符）。 */
  cjk?: boolean;
  /** 末行也有换行（缺省 true）。 */
  trailingNewline?: boolean;
  /** 每行约多少字节（缺省 80，含行尾）。 */
  lineBytes?: number;
}

export interface GeneratedFile {
  path: string;
  bytes: number;
  lines: number;
}

const WRITE_BATCH = 1024 * 1024;

/** 写一个至少 `bytes` 字节的文本文件（整行为单位，最后一行可能略超）。 */
export function makeTextFile(
  path: string,
  bytes: number,
  options: TextFileOptions = {},
): GeneratedFile {
  const eol = options.crlf === true ? "\r\n" : "\n";
  const lineBytes = Math.max(16, options.lineBytes ?? 80);
  const fd = openSync(path, "w");
  let written = 0;
  let lines = 0;
  try {
    if (options.bom === true) written += writeSync(fd, Buffer.from([0xef, 0xbb, 0xbf]));
    let batch: string[] = [];
    let batchBytes = 0;
    const flush = (): void => {
      if (batch.length === 0) return;
      written += writeSync(fd, batch.join(""));
      batch = [];
      batchBytes = 0;
    };
    while (written + batchBytes < bytes) {
      const head = `${lines + 1}:${options.cjk === true ? " 中文🙂 " : " "}`;
      const room = lineBytes - Buffer.byteLength(head) - eol.length;
      let line = head + "x".repeat(Math.max(0, room));
      lines++;
      const done = written + batchBytes + Buffer.byteLength(line) + eol.length >= bytes;
      if (!done || options.trailingNewline !== false) line += eol;
      batch.push(line);
      batchBytes += Buffer.byteLength(line);
      if (batchBytes >= WRITE_BATCH) flush();
    }
    flush();
  } finally {
    closeSync(fd);
  }
  return { path, bytes: written, lines };
}

export interface SessionFileOptions {
  /** 消息条数（user / assistant 交替，从 user 开始）。 */
  messages: number;
  /** 每条消息的文本字节数（含中文，缺省 1024）。 */
  textBytes?: number;
  /** 附图的张数（放在最前面的几条 user 消息里），缺省有 `imageBytes` 时 1 张。 */
  images?: number;
  /** 每张图的原始字节数（落盘为 base64，约 4/3 倍）。 */
  imageBytes?: number;
  cwd?: string;
}

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

function filler(bytes: number, seed: number): string {
  const unit = `第${seed}条 message 内容 ${"abc".repeat(4)} `;
  const unitBytes = Buffer.byteLength(unit);
  return unit.repeat(Math.max(1, Math.ceil(bytes / unitBytes)));
}

/** 用真实 `SessionManager` 在 `dir` 下写一个会话文件（格式与运行时一致），返回文件信息。 */
export function makeSessionFile(dir: string, options: SessionFileOptions): GeneratedFile {
  mkdirSync(dir, { recursive: true });
  const manager = SessionManager.create(dir, options.cwd ?? dir, {
    now: () => new Date(Date.UTC(2026, 9, 1)),
  });
  const textBytes = options.textBytes ?? 1024;
  let images = options.images ?? (options.imageBytes !== undefined ? 1 : 0);
  try {
    for (let i = 0; i < options.messages; i++) {
      const text = filler(textBytes, i);
      const timestamp = Date.UTC(2026, 9, 1) + i;
      if (i % 2 === 0) {
        const content: ContentBlock[] = [{ type: "text", text }];
        if (images > 0 && options.imageBytes !== undefined) {
          images--;
          const data = Buffer.alloc(options.imageBytes, (i + 1) & 0xff).toString("base64");
          content.push({ type: "image", data, mimeType: "image/png" });
        }
        manager.append({ type: "message", message: { role: "user", content, timestamp } });
      } else {
        manager.append({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "anthropic-messages",
            provider: "fake",
            model: "fake",
            usage: { ...ZERO_USAGE },
            stopReason: "stop",
            timestamp,
          },
        });
      }
    }
    const path = manager.flush();
    if (path === undefined) throw new Error("makeSessionFile: session was not written");
    return { path, bytes: statSync(path).size, lines: options.messages + 1 };
  } finally {
    manager.close();
  }
}
