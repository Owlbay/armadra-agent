import { describe, expect, it } from "vitest";
import type { OAuthAuthEntry } from "../../config/types-w6.js";
import { oauthDoctorLines } from "./doctor.js";

const base: OAuthAuthEntry = {
  type: "oauth",
  flavor: "siwc",
  planType: "pro",
  accessToken: "at-SECRET",
  refreshToken: "rt-SECRET",
  expiresAt: 10 * 60_000,
};

describe("doctor 的 OAuth 行", () => {
  it("siwc：有效期与配额查看位置；不发请求", async () => {
    let calls = 0;
    const lines = await oauthDoctorLines("chatgpt", base, {
      now: 0,
      fetch: async () => (calls++, new Response("{}")),
    });
    expect(lines).toEqual({
      line: "oauth（siwc · pro · 剩 10m）",
      quota: "配额：只在超限时可知；在 ChatGPT → 设置 → Usage 查看",
    });
    expect(calls).toBe(0);
  });

  it("needsLogin → problem；codex 查 wham/usage，失败显示不可用；输出不含 token", async () => {
    const expired = await oauthDoctorLines("chatgpt", { ...base, needsLogin: true }, { now: 0 });
    expect(expired.problem).toBe("chatgpt：登录已失效，运行 ama auth login chatgpt");
    const urls: string[] = [];
    const codex = await oauthDoctorLines(
      "chatgpt",
      { ...base, flavor: "codex", accountId: "acct" },
      {
        now: 0,
        env: {},
        fetch: async (url) => (urls.push(String(url)), new Response("nope", { status: 500 })),
      },
    );
    expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
    expect(codex.quota).toBe("配额：暂不可用");
    expect(JSON.stringify([expired, codex])).not.toContain("SECRET");
  });
});
