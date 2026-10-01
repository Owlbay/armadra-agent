import { describe, expect, it } from "vitest";
import { authHeaders, describeErrorJson, formatErrorBody, joinUrl, mergeHeaders } from "./http.js";

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
});
