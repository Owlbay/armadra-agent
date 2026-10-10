/**
 * 请求体序列化的增长上限（docs/memory-plan.md D3、D13、[M-B] 测试 2）：6 张 3 MB base64 的请求体
 * （每张以 data URL 与裸 base64 各出现一次，≈ 36 MB）序列化后，堆只多出零头，堆外只多出结果 Buffer 本身；字节与原生一致。
 */

import { describe, expect, it } from "vitest";
import { buildResponsesRequest } from "../../src/ai/apis/openai-responses-request.js";
import {
  jsonFetchBody,
  plainScans,
  STREAM_CHUNK_CHARS,
  serializeJsonBody,
} from "../../src/ai/json-body.js";
import type { Message, Model } from "../../src/ai/types.js";
import { measureGrowth } from "../helpers/memory.js";

const MB = 1024 * 1024;

function imageBody(): Record<string, unknown> {
  const input: unknown[] = [];
  for (let i = 0; i < 6; i++) {
    // 每张字符不同，避免任何共享；内容是合法 base64 字符
    const data = Buffer.alloc(((3 * MB) / 4) * 3, i + 1).toString("base64");
    input.push({
      role: "user",
      content: [
        { type: "input_text", text: `image ${i}: 中文 😀` },
        { type: "input_image", image_url: `data:image/png;base64,${data}` },
        { type: "input_image", data, detail: "auto" },
      ],
    });
  }
  return { model: "m", stream: true, instructions: "be brief", input, store: false };
}

describe("serializeJsonBody 内存", () => {
  it("≈ 36 MB 图片请求体：堆增长 < 3 MB，堆外增长 ≈ 结果长度", async () => {
    const body = imageBody();
    const growth = await measureGrowth(() => serializeJsonBody(body));
    const length = growth.result.length;
    expect(length).toBeGreaterThan(30 * MB);
    expect(growth.heapUsed).toBeLessThan(3 * MB);
    // external 已包含 arrayBuffers，两者各自增长约一个结果 Buffer
    expect(growth.arrayBuffers).toBeGreaterThanOrEqual(0.95 * length);
    expect(growth.arrayBuffers).toBeLessThanOrEqual(1.15 * length);
    expect(growth.external).toBeGreaterThanOrEqual(0.95 * length);
    expect(growth.external).toBeLessThanOrEqual(1.15 * length);
    // 序列化过程中也不在堆上拼整份中间字符串（GC 只会让这个数更小，上界不受时序影响）
    expect(growth.beforeGc.heapUsed).toBeLessThan(8 * MB);
    expect(growth.result.equals(Buffer.from(JSON.stringify(body), "utf8"))).toBe(true);
  });

  it("postJson 用的流式请求体：读完不留增长，每块不超过 256 KiB（不再整张图一块）", async () => {
    const body = imageBody();
    const want = Buffer.byteLength(JSON.stringify(body));
    let largest = 0;
    const growth = await measureGrowth(async () => {
      const { body: stream, contentLength } = jsonFetchBody(body);
      const chunks: Buffer[] = [];
      let sent = 0;
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
        sent += chunk.length;
        largest = Math.max(largest, chunk.length);
      }
      // 拼接后逐字节相同（拼接与比较都在这里完成，返回值只留布尔，不影响增长测量）
      const same = Buffer.concat(chunks).equals(Buffer.from(JSON.stringify(body), "utf8"));
      chunks.length = 0;
      return { sent, same, contentLength };
    });
    expect(growth.result).toEqual({ sent: want, same: true, contentLength: want });
    // 图片片段是 ASCII：一块的字节数 = 码元数；+4 容纳块首的引号等结构字符
    expect(largest).toBeLessThanOrEqual(STREAM_CHUNK_CHARS + 4);
    expect(growth.total).toBeLessThan(2 * MB);
  });

  it("转换器构造的带图请求体（6 张 3 MB）：读完流，堆上不留整图字符串（不再扁平化 data URL），同块不再扫", async () => {
    const messages: Message[] = [];
    for (let i = 0; i < 6; i++) {
      const data = Buffer.alloc(((3 * MB) / 4) * 3, i + 1).toString("base64");
      messages.push({
        role: "user",
        content: [
          { type: "text", text: `image ${i}` },
          { type: "image", data, mimeType: "image/png" },
        ],
        timestamp: i,
      });
    }
    const model: Model = {
      id: "gpt-5",
      name: "gpt-5",
      provider: "p",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      input: ["text", "image"],
      reasoning: false,
      maxTokens: 4096,
    };
    const signal = new AbortController().signal;
    const read = async () => {
      // 每次请求都重新转换（与 agent 循环相同），data URL 由 prefix + 原 base64 组成
      const { body } = buildResponsesRequest(model, { messages }, { signal });
      const { body: stream } = jsonFetchBody(body);
      let sent = 0;
      for await (const chunk of stream as ReadableStream<Uint8Array>) sent += chunk.length;
      return sent;
    };
    await read(); // 首次：每张图扫一次转义并记住
    const scans = plainScans.count;
    const growth = await measureGrowth(read);
    expect(growth.result).toBeGreaterThan(6 * 3 * MB);
    expect(plainScans.count).toBe(scans);
    // 以前每张图每请求都扁平化出一份 ≈ 3 MB 的 data URL（6 张 ≥ 18 MB）；GC 前的增长也只剩零头
    expect(growth.beforeGc.heapUsed).toBeLessThan(2 * MB);
    expect(growth.total).toBeLessThan(2 * MB);
  });
});
