/**
 * 驱动测试辅助（不进构建产物）。[W5-E]
 *
 * - {@link memoryTransport}：进程内对端（假 ACP Agent、ama 自己的 `--mode acp`、录制回放），
 *   同时记下两个方向的线上消息用于黄金记录；
 * - {@link replayPeer}：按 `test/fixtures/drivers/<agent>/*.jsonl` 的录制回放原生协议
 *   （每行 `{"dir":"in"|"out","msg":…}`：`in` 是驱动应发出的消息（子集匹配），`out` 是对端的回应）；
 * - {@link golden}：读 `test/fixtures/` 下的黄金文件（`UPDATE_GOLDEN=1` 重写）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createLineReader } from "../modes/rpc/jsonl.js";
import type { AgentTransport, SpawnTransport, TransportSpec } from "./process.js";

export interface WireLine {
  dir: "in" | "out";
  msg: Record<string, unknown>;
}

export interface MemoryTransport {
  transport: AgentTransport;
  /** in = 驱动写给对端；out = 对端写给驱动。 */
  wire: WireLine[];
  /** 对端结束（serve resolve）。 */
  done: Promise<void>;
}

function tap(stream: PassThrough, dir: "in" | "out", wire: WireLine[]): void {
  createLineReader(stream, (line) => {
    try {
      wire.push({ dir, msg: JSON.parse(line) as Record<string, unknown> });
    } catch {
      wire.push({ dir, msg: { raw: line } });
    }
  });
}

/** `serve(input, output)`：对端从 input 读驱动的消息，写回 output。 */
export function memoryTransport(
  serve: (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => Promise<unknown>,
): MemoryTransport {
  const toPeer = new PassThrough();
  const fromPeer = new PassThrough();
  const wire: WireLine[] = [];
  tap(toPeer, "in", wire);
  tap(fromPeer, "out", wire);
  const done = serve(toPeer, fromPeer).then(
    () => undefined,
    () => undefined,
  );
  let exitCode: number | null = 0;
  const exited = done.then(() => {
    fromPeer.end();
    return exitCode;
  });
  return {
    wire,
    done,
    transport: {
      stdin: toPeer,
      stdout: fromPeer,
      stderrTail: () => "",
      exited,
      async terminate() {
        exitCode = 143;
        toPeer.end();
        fromPeer.end();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 50))]);
      },
    },
  };
}

/** 记下每次 spawn 的参数，并把对端交给 `serve`。 */
export function spawnRecorder(serve: (spec: TransportSpec) => MemoryTransport): {
  spawn: SpawnTransport;
  specs: TransportSpec[];
  last(): MemoryTransport | undefined;
} {
  const specs: TransportSpec[] = [];
  const made: MemoryTransport[] = [];
  return {
    specs,
    last: () => made.at(-1),
    spawn: (spec) => {
      specs.push(spec);
      const t = serve(spec);
      made.push(t);
      return t.transport;
    },
  };
}

/** 子集匹配：expected 的每个键都在 actual 里且相等（对象递归、数组逐项）。 */
export function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => matchesSubset(actual[i], v))
    );
  }
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
    matchesSubset((actual as Record<string, unknown>)[k], v),
  );
}

export function readRecording(name: string): WireLine[] {
  const file = fileURLToPath(new URL(`../../test/fixtures/drivers/${name}`, import.meta.url));
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("//"))
    .map((l) => JSON.parse(l) as WireLine);
}

/**
 * 回放对端：读到驱动的一条消息就与录制里下一条 `in` 做子集匹配（`$id` 占位符绑定为驱动实际用的
 * 请求 id，后续 `out` 里的 `"$id"` 替换成它），然后依次写出紧随其后的 `out` 行。
 * 不匹配时记进 `mismatches` 并停止。
 */
export function replayPeer(recording: readonly WireLine[]): {
  serve(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void>;
  mismatches: string[];
  consumed(): number;
} {
  const mismatches: string[] = [];
  let at = 0;
  const ids = new Map<string, unknown>();
  const bind = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value), (_k, v: unknown) =>
      typeof v === "string" && v.startsWith("$") && ids.has(v) ? ids.get(v) : v,
    );
  const flushOut = (output: NodeJS.WritableStream): void => {
    while (at < recording.length && recording[at]!.dir === "out") {
      output.write(`${JSON.stringify(bind(recording[at]!.msg))}\n`);
      at++;
    }
  };
  return {
    mismatches,
    consumed: () => at,
    serve: (input, output) =>
      new Promise<void>((resolve) => {
        flushOut(output);
        createLineReader(
          input,
          (line) => {
            const actual = JSON.parse(line) as Record<string, unknown>;
            const expected = recording[at];
            if (expected === undefined || expected.dir !== "in") {
              mismatches.push(`unexpected: ${line}`);
              return;
            }
            const pattern: Record<string, unknown> = { ...expected.msg };
            for (const [key, value] of Object.entries(pattern)) {
              if (typeof value === "string" && value.startsWith("$")) {
                ids.set(value, actual[key]);
                delete pattern[key];
              }
            }
            if (!matchesSubset(actual, bind(pattern))) {
              mismatches.push(`expected ${JSON.stringify(expected.msg)}\n   got ${line}`);
              return;
            }
            at++;
            flushOut(output);
          },
          resolve,
        );
      }),
  };
}

/** 黄金文件内容（`UPDATE_GOLDEN=1` 或文件不存在时先写入 actual）；调用方 `expect(actual).toBe(…)`。 */
export function golden(relative: string, actual: string): string {
  const file = fileURLToPath(new URL(`../../test/fixtures/${relative}`, import.meta.url));
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
  }
  return readFileSync(file, "utf8");
}

/** 线上记录 → 黄金文本：去掉不稳定字段（版本、临时路径）。 */
export function wireText(wire: readonly WireLine[], root?: string): string {
  return (
    wire
      .map((w) =>
        JSON.stringify(w, (key, value: unknown) => {
          if (key === "version" && typeof value === "string") return "<version>";
          if (typeof value === "string" && root !== undefined)
            return value.split(root).join("<root>").replace(/\\/g, "/");
          return value;
        }),
      )
      .join("\n") + "\n"
  );
}
