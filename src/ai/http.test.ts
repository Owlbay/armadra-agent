import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authHeaders,
  describeErrorJson,
  formatErrorBody,
  joinUrl,
  mergeHeaders,
  postJson,
} from "./http.js";
import { STREAM_CHUNK_CHARS } from "./json-body.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http", () => {
  it("mergeHeaders：大小写不敏感覆盖，null 删除，undefined 跳过", () => {
    expect(
      mergeHeaders(
        { "Content-Type": "a", "User-Agent": "ama", "X-Keep": "1" },
        { "content-type": "b", "user-agent": null, "x-skip": undefined },
        undefined,
      ),
    ).toEqual({ "content-type": "b", "X-Keep": "1" });
  });

  it("authHeaders 四种形状", () => {
    expect(authHeaders("k", undefined, "authorization-bearer")).toEqual({
      Authorization: "Bearer k",
    });
    expect(authHeaders("k", "x-api-key", "authorization-bearer")).toEqual({ "x-api-key": "k" });
    expect(authHeaders("k", "x-goog-api-key", "x-api-key")).toEqual({ "x-goog-api-key": "k" });
    expect(authHeaders("k", { header: "api-key", prefix: "Key " }, "x-api-key")).toEqual({
      "api-key": "Key k",
    });
    expect(authHeaders(undefined, undefined, "x-api-key")).toEqual({});
  });

  it("joinUrl", () => {
    expect(joinUrl("https://a/v1/", "/chat/completions")).toBe("https://a/v1/chat/completions");
  });

  it("错误体：各家形状", () => {
    expect(
      formatErrorBody(
        429,
        "Too Many Requests",
        '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}',
      ),
    ).toBe("429 rate_limit_error: slow");
    expect(formatErrorBody(400, "", '{"error":{"message":"bad","code":"x"}}')).toBe("400 x: bad");
    expect(formatErrorBody(500, "", '{"error":"plain"}')).toBe("500 plain");
    expect(formatErrorBody(422, "", '{"detail":"nope"}')).toBe("422 nope");
    expect(formatErrorBody(502, "Bad Gateway", "")).toBe("502 Bad Gateway (no body)");
    expect(formatErrorBody(503, "", "<html>down</html>")).toBe("503 <html>down</html>");
    expect(formatErrorBody(400, "", "x".repeat(5000)).length).toBeLessThan(4100);
    expect(describeErrorJson(42)).toBeUndefined();
  });

  // 比一块长：流式请求体会分多块发出
  const image = "A".repeat(STREAM_CHUNK_CHARS * 2 + 3);
  const small = { model: "m", input: [{ text: "中文 😀\u2028" }], n: NaN, skip: undefined };
  const large = { ...small, input: [...small.input, { type: "image", data: image }] };
  const post = (url: string, body: unknown) =>
    postJson(url, {
      headers: { "content-type": "application/json", "Content-Length": "1" },
      body,
      signal: new AbortController().signal,
    });

  it("postJson：无大字符串照旧发 JSON 字符串；含大字符串发流，带 content-length 与 duplex", async () => {
    const calls: (Omit<RequestInit, "body"> & { body: unknown })[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push({
        ...init,
        body:
          init.body instanceof ReadableStream ? await new Response(init.body).text() : init.body,
      });
      return new Response("data: {}\n\n", { status: 200 });
    });
    await post("https://example.test/v1/x", small);
    await post("https://example.test/v1/x", large);
    const [plain, streamed] = calls as [(typeof calls)[0], (typeof calls)[0]];
    expect(plain.body).toBe(JSON.stringify(small));
    expect(plain.duplex).toBeUndefined();
    expect(plain.headers).toEqual({ "content-type": "application/json", "Content-Length": "1" });
    expect(streamed.body).toBe(JSON.stringify(large));
    expect(streamed.duplex).toBe("half");
    expect(streamed.headers).toEqual({
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify(large))),
    });
  });

  it("postJson 经真实 HTTP 发流式请求体：服务端收到 content-length、不是 chunked，字节相同", async () => {
    const received: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { "content-type": "text/event-stream" }).end("data: {}\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await post(`http://127.0.0.1:${port}/v1/x`, large);
      await response.text();
    } finally {
      server.close();
    }
    const [got] = received;
    const want = Buffer.from(JSON.stringify(large), "utf8");
    expect(got?.headers["content-length"]).toBe(String(want.length));
    expect(got?.headers["transfer-encoding"]).toBeUndefined();
    expect(got?.body.equals(want)).toBe(true);
  });
});
