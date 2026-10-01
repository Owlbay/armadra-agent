/**
 * B1 测试辅助：把 SSE 样本文件变成 fetch 响应（vi.stubGlobal 替换全局 fetch）。
 * 样本格式见 test/fixtures/sse/README.md。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

export const SSE_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "sse",
);

export interface Fixture {
  status: number;
  headers: Record<string, string>;
  body: string;
  errorAfterBody: boolean;
}

export function loadFixture(api: string, name: string): Fixture {
  const raw = readFileSync(join(SSE_FIXTURE_DIR, api, `${name}.txt`), "utf8");
  const lines = raw.split("\n");
  const fixture: Fixture = { status: 200, headers: {}, body: "", errorAfterBody: false };
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("#status ")) fixture.status = Number(line.slice(8));
    else if (line.startsWith("#header ")) {
      const rest = line.slice(8);
      const colon = rest.indexOf(":");
      fixture.headers[rest.slice(0, colon).trim()] = rest.slice(colon + 1).trim();
    } else if (line === "#error-after-body") fixture.errorAfterBody = true;
    else break;
  }
  fixture.body = lines.slice(i).join("\n");
  return fixture;
}

export type ChunkMode = "whole" | "bytes7" | "crlf";

export function bodyStream(
  body: string,
  mode: ChunkMode = "whole",
  errorAfterBody = false,
): ReadableStream<Uint8Array> {
  const text = mode === "crlf" ? body.replace(/\n/g, "\r\n") : body;
  const bytes = new TextEncoder().encode(text);
  const size = mode === "bytes7" ? 7 : Math.max(1, bytes.length);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        if (errorAfterBody) controller.error(new TypeError("terminated: other side closed"));
        else controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

export interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 用样本替换 fetch；返回捕获到的请求列表。调用方在 afterEach 里 vi.unstubAllGlobals()。 */
export function stubFetchWithFixture(
  fixture: Fixture,
  mode: ChunkMode = "whole",
): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(bodyStream(fixture.body, mode, fixture.errorAfterBody), {
      status: fixture.status,
      headers: fixture.headers,
    });
  });
  return captured;
}

/** 一个永不结束的 SSE 流：先发 `prefix`，之后挂起（用于 abort 测试）。 */
export function stubFetchHanging(prefix: string, status = 200): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    captured.push({ url: String(input), headers: {}, body: undefined });
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    const bytes = new TextEncoder().encode(prefix);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        return new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
            resolve();
          });
        });
      },
    });
    return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
  });
  return captured;
}
