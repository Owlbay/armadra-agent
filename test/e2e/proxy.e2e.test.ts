/**
 * 代理（W4-C）：设了 HTTP_PROXY 时 bundle 子进程的模型请求经过代理。本地起一个「代理」，收到
 * absolute-URI 请求就直接回一段 OpenAI 兼容的 SSE。Node 没有 setGlobalProxyFromEnv 时跳过。
 */

import { createServer, type Server } from "node:http";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { hasBundle, runAma } from "./spawn.js";

const supported =
  typeof (http as unknown as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv ===
  "function";

let home: TmpHome | undefined;
let proxy: Server | undefined;
afterEach(async () => {
  home?.cleanup();
  home = undefined;
  await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
  proxy = undefined;
});

describe.skipIf(!hasBundle || !supported)("e2e：环境变量代理", () => {
  it("HTTP_PROXY 生效：请求经过本地代理；doctor 显示已启用", async () => {
    const seen: string[] = [];
    proxy = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: object, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.end(`${chunk({ content: "via proxy" })}${chunk({}, "stop")}data: [DONE]\n\n`);
      });
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
    expect(seen).toEqual(["POST http://upstream.invalid/v1/chat/completions"]);
    const doctor = await runAma(home, ["doctor"], { env });
    expect(doctor.stdout).toMatch(/代理\n {2}HTTP_PROXY=http:\/\/127\.0\.0\.1:\d+\n {2}已启用/);
  });
});
