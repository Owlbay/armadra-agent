/**
 * 代理（W4-C）：设了 HTTP_PROXY 时 bundle 子进程的模型请求经过代理。本地起一个「代理」：absolute-URI
 * 请求（Node 26）直接回一段 OpenAI 兼容的 SSE，CONNECT 隧道（Node 24）接到本地目标站点。Node 没有
 * setGlobalProxyFromEnv 时跳过。
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import * as http from "node:http";
import { connect, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, runAma } from "./spawn.js";

const supported =
  typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv ===
  "function";

let home: TmpHome | undefined;
let proxy: Server | undefined;
let upstream: Server | undefined;
afterEach(async () => {
  home?.cleanup();
  home = undefined;
  for (const server of [proxy, upstream]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
  proxy = undefined;
  upstream = undefined;
});

describe.skipIf(!hasBundle || !supported)("e2e：环境变量代理", () => {
  it("HTTP_PROXY 生效：请求经过本地代理；doctor 显示已启用", async () => {
    const seen: string[] = [];
    const reply: Parameters<typeof createServer>[1] = (req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.end(`${chunk({ content: "via proxy" })}${chunk({}, "stop")}data: [DONE]\n\n`);
      });
    };
    // 目标站点：Node 24 对 http 目标也走 CONNECT 隧道，隧道接到这里
    upstream = createServer(reply);
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    // 代理：absolute-URI 请求直接回（Node 26），CONNECT 转到目标站点（Node 24）
    proxy = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      reply(req, res);
    });
    proxy.on("connect", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      seen.push(`CONNECT ${req.url}`);
      const tunnel = connect(upstreamPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) tunnel.write(head);
        tunnel.pipe(socket);
        socket.pipe(tunnel);
      });
      tunnel.on("error", () => socket.destroy());
      socket.on("error", () => tunnel.destroy());
    });
    await new Promise<void>((resolve) => proxy?.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as AddressInfo;
    home = createTmpHome();
    home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        upstream: {
          api: "openai-completions",
          baseUrl: "http://upstream.invalid/v1",
          apiKey: "k",
          models: [{ id: "m" }],
        },
      },
    });
    const env = { HTTP_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "" };
    const r = await runAma(home, ["-p", "hi", "--model", "upstream/m"], { env });
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("via proxy\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(
      /^(?:POST http:\/\/upstream\.invalid\/v1\/chat\/completions|CONNECT upstream\.invalid:80)$/,
    );
    const doctor = await runAma(home, ["doctor"], { env });
    expect(doctor.stdout).toMatch(/代理\n {2}HTTP_PROXY=http:\/\/127\.0\.0\.1:\d+\n {2}已启用/);
  });
});
