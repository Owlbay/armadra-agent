// scripts/bench-memory.mjs 的测量夹具：大文本、噪声 PNG、测量工作区，以及本地 OpenAI Responses 兼容的
// SSE 模拟服务（按脚本回放、记录每次请求体字节数）。零依赖，只用 node:*。

import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const MB = 1024 * 1024;

/**
 * 解析一行 JSON（stdout 的 JSONL 协议行、探针日志行）。被测进程中途退出时最后一行可能被截断，
 * 或者混入非 JSON 输出（如 `--trace-gc`）：这些情况返回 `undefined`，由调用方计入「坏行」，不抛错。
 */
export function parseJsonLine(line) {
  const text = line.trim();
  if (text === "") return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 探针样本（mem-probe.cjs 的 JSONL 行）的峰值。rss 同时取 exit 行的 maxRss（进程生命周期峰值）；
 * other = rss − heapTotal − external，旧探针没有 other 字段时按同式现算。
 */
export function samplePeaks(samples) {
  const max = (pick) => Math.max(0, ...samples.map((s) => pick(s) || 0));
  const exit = samples.find((s) => s.ev === "exit");
  return {
    rss: Math.max(
      max((s) => s.rss),
      exit?.maxRss ?? 0,
    ),
    heapUsed: max((s) => s.heapUsed),
    heapTotal: max((s) => s.heapTotal),
    external: max((s) => s.external),
    other: max((s) => s.other ?? s.rss - s.heapTotal - s.external),
  };
}

/** 至少 `bytes` 字节的文本文件，按 1 MB 批量写。 */
export function writeTextFile(path, bytes) {
  const fd = openSync(path, "w");
  let written = 0;
  let line = 0;
  try {
    while (written < bytes) {
      let batch = "";
      while (batch.length < MB) {
        batch += `line ${line} lorem ipsum dolor sit amet consectetur adipiscing elit ${(line * 7919) % 100003}\n`;
        line++;
      }
      written += writeSync(fd, batch);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * 写一个约 `bytes` 字节的会话文件（经构建产物里的真实 SessionManager 写，格式与运行时一致），返回会话 id。
 * `edited` > 0 时前 `edited` 个 toolResult 各带一张 3 MB base64 图，并各追加一条 `image_budget` 的
 * `context_edit`（#170 卸载的测量口径）；图片字节计入 `bytes`。
 */
export async function writeSession({ managerUrl, dir, cwd, bytes, label, edited = 0 }) {
  const { SessionManager } = await import(managerUrl);
  const manager = SessionManager.createForCwd(dir, cwd);
  const chunk = `${label} ${"tool output line 0123456789 abcdefghij\n".repeat(1600)}`;
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  const targets = [];
  let written = 0;
  manager.append({
    type: "message",
    message: { role: "user", content: `${label}: start`, timestamp: Date.now() },
  });
  for (let i = 0; written < bytes; i++) {
    const timestamp = Date.now();
    manager.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `call_${i}`, name: "read", arguments: { path: "x" } }],
        api: "openai-responses",
        provider: "fake",
        model: "echo",
        usage: zero,
        stopReason: "toolUse",
        timestamp,
      },
    });
    const content = [{ type: "text", text: chunk }];
    if (i < edited) {
      const data = Buffer.alloc(2.25 * MB, i + 1).toString("base64");
      content.push({ type: "image", data, mimeType: "image/png" });
      written += data.length;
    }
    const result = manager.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call_${i}`,
        toolName: "read",
        content,
        isError: false,
        timestamp,
      },
    });
    if (i < edited) targets.push(result.id);
    written += chunk.length + 400;
  }
  for (const targetId of targets) {
    manager.append({
      type: "context_edit",
      targetId,
      replacement: "[image omitted]",
      reason: "image_budget",
    });
  }
  manager.flush();
  const id = manager.header().id;
  manager.close();
  return id;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 随机噪声 PNG（不可压缩，900×900 约 2.4 MB）。 */
function noisePng(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    raw[i] = i % (w * 3 + 1) === 0 ? 0 : x & 255;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 测量工作区：约 4 MB 文本 + 3 张噪声 PNG。 */
export function makeWorkspace(work) {
  writeTextFile(join(work, "big.txt"), 4 * MB);
  for (let k = 0; k < 3; k++)
    writeFileSync(join(work, `img${k}.png`), noisePng(900, 900, 12345 + k));
}

// ---------------------------------------------------------------------------
// 内置 mock：OpenAI Responses 兼容的 SSE 服务，按脚本顺序回放（只为测量）
// ---------------------------------------------------------------------------

export function startMockResponses(responses) {
  const bodies = [];
  let n = 0;
  const server = createServer((req, res) => {
    let size = 0;
    req.on("data", (chunk) => (size += chunk.length));
    req.on("end", () => {
      bodies.push(size);
      const idx = n++;
      const r = responses[idx] ?? { text: "ok" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      let seq = 0;
      const ev = (type, payload) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`,
        );
      const id = `resp_${idx}`;
      ev("response.created", {
        response: { id, object: "response", status: "in_progress", output: [] },
      });
      const output = [];
      const steps = [...(r.steps ?? []), ...(r.text !== undefined ? [{ text: r.text }] : [])];
      steps.forEach((step, oi) => {
        if (step.text !== undefined) {
          const item = {
            id: `msg_${idx}_${oi}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          };
          ev("response.output_item.added", { output_index: oi, item });
          ev("response.content_part.added", {
            output_index: oi,
            item_id: item.id,
            content_index: 0,
            part: { type: "output_text", text: "" },
          });
          ev("response.output_text.delta", {
            output_index: oi,
            item_id: item.id,
            content_index: 0,
            delta: step.text,
          });
          ev("response.output_text.done", {
            output_index: oi,
            item_id: item.id,
            content_index: 0,
            text: step.text,
          });
          const done = {
            ...item,
            status: "completed",
            content: [{ type: "output_text", text: step.text, annotations: [] }],
          };
          ev("response.output_item.done", { output_index: oi, item: done });
          output.push(done);
        } else if (step.toolCall !== undefined) {
          const args = JSON.stringify(step.toolCall.arguments ?? {});
          const item = {
            id: `fc_${idx}_${oi}`,
            type: "function_call",
            call_id: `call_${idx}_${oi}`,
            name: step.toolCall.name,
            arguments: "",
            status: "in_progress",
          };
          ev("response.output_item.added", { output_index: oi, item });
          ev("response.function_call_arguments.delta", {
            output_index: oi,
            item_id: item.id,
            delta: args,
          });
          ev("response.function_call_arguments.done", {
            output_index: oi,
            item_id: item.id,
            arguments: args,
          });
          const done = { ...item, arguments: args, status: "completed" };
          ev("response.output_item.done", { output_index: oi, item: done });
          output.push(done);
        }
      });
      const usage = {
        input_tokens: 1000,
        output_tokens: 100,
        total_tokens: 1100,
        input_tokens_details: { cached_tokens: 0 },
      };
      ev("response.completed", {
        response: { id, object: "response", status: "completed", output, usage },
      });
      res.end();
    });
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      res({ port: server.address().port, bodies, close: () => server.close() });
    });
  });
}
