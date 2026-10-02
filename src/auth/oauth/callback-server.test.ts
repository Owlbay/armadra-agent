import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { browserCommand } from "./browser.js";
import { parseCallbackUrl, startCallbackServer } from "./callback-server.js";
import { generatePkce, randomToken, s256 } from "./pkce.js";

describe("PKCE", () => {
  it("RFC 7636 附录 B 的向量", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier 43 字符 base64url，challenge 与之对应", () => {
    const pair = generatePkce();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(s256(pair.verifier));
    expect(pair.method).toBe("S256");
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("回调服务", () => {
  const blockers: Server[] = [];
  afterEach(async () => {
    await Promise.all(blockers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  function block(): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer();
      blockers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
  }

  it("合法回调：返回 code，页面不回显 code", async () => {
    const server = await startCallbackServer({ ports: [0], state: "s1" });
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/auth/callback`);
    const res = await fetch(`${server.redirectUri}?code=SECRET-CODE-1&state=s1`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("SECRET-CODE-1");
    await expect(server.result).resolves.toEqual({ code: "SECRET-CODE-1" });
  });

  it("state 不符的请求不结束等待；随后的合法回调照常完成", async () => {
    const server = await startCallbackServer({ ports: [0], state: "good" });
    expect((await fetch(`${server.redirectUri}?code=x&state=bad`)).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${server.port}/other`)).status).toBe(404);
    await fetch(`${server.redirectUri}?code=ok&state=good&client_id=oaiapp_1&scope=openid+email`);
    await expect(server.result).resolves.toEqual({
      code: "ok",
      clientId: "oaiapp_1",
      scope: "openid email",
    });
  });

  it("error 回调 → oauth_denied", async () => {
    const server = await startCallbackServer({ ports: [0], state: "s" });
    await fetch(`${server.redirectUri}?error=access_denied&error_description=no&state=s`);
    await expect(server.result).rejects.toMatchObject({ code: "oauth_denied" });
  });

  it("端口被占用退到下一个；全被占用 → oauth_ports_busy", async () => {
    const busy = await block();
    const server = await startCallbackServer({ ports: [busy, 0], state: "s" });
    expect(server.port).not.toBe(busy);
    await server.close();
    const busy2 = await block();
    await expect(startCallbackServer({ ports: [busy, busy2], state: "s" })).rejects.toMatchObject({
      code: "oauth_ports_busy",
    });
  });

  it("超时与中止", async () => {
    const server = await startCallbackServer({ ports: [0], state: "s", timeoutMs: 20 });
    await expect(server.result).rejects.toMatchObject({ code: "oauth_timeout" });
    const controller = new AbortController();
    const second = await startCallbackServer({ ports: [0], state: "s", signal: controller.signal });
    controller.abort();
    await expect(second.result).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("--paste 解析", () => {
  it("整条 URL 或查询串；state 校验", () => {
    expect(parseCallbackUrl("http://127.0.0.1:1455/auth/callback?code=c1&state=s", "s")).toEqual({
      code: "c1",
    });
    expect(parseCallbackUrl("  ?code=c2&state=s\n", "s").code).toBe("c2");
    expect(() => parseCallbackUrl("http://x/auth/callback?code=c&state=t", "s")).toThrow(
      expect.objectContaining({ code: "oauth_state_mismatch" }),
    );
    expect(() => parseCallbackUrl("http://x/?state=s", "s")).toThrow(
      expect.objectContaining({ code: "oauth_no_code" }),
    );
  });
});

describe("浏览器命令", () => {
  it("URL 作为 argv 传入", () => {
    const url = "https://auth.example/authorize?a=1&b=2";
    expect(browserCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(browserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(browserCommand(url, "win32").args.at(-1)).toBe(
      "https://auth.example/authorize?a=1^&b=2",
    );
  });
});
