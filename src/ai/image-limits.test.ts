import { describe, expect, it } from "vitest";
import {
  MB,
  base64Size,
  formatMb,
  imageEndpoint,
  imageLimits,
  requestImageBudget,
} from "./image-limits.js";

describe("image-limits", () => {
  it("base64Size = ceil(bytes/3)*4", () => {
    expect(base64Size(0)).toBe(0);
    expect(base64Size(1)).toBe(4);
    expect(base64Size(3)).toBe(4);
    expect(base64Size(4)).toBe(8);
    expect(base64Size(3 * MB)).toBe(4 * MB);
    expect(Buffer.alloc(1000).toString("base64").length).toBe(base64Size(1000));
  });

  it.each([
    ["https://api.anthropic.com", "anthropic-messages", "anthropic", 10, 32],
    ["https://api.anthropic.com/", "anthropic-messages", "anthropic", 10, 32],
    ["https://generativelanguage.googleapis.com/v1beta", "google-generative-ai", "gemini", 20, 20],
    ["https://api.openai.com/v1", "openai-responses", "openai", 20, 20],
    ["https://api.openai.com/v1", "openai-completions", "openai", 20, 20],
    ["https://relay.example/v1", "anthropic-messages", "other", 5, 32],
    ["https://www.packyapi.com/v1", "openai-completions", "other", 5, 20],
    ["https://api.deepseek.com/anthropic", "anthropic-messages", "other", 5, 32],
    [undefined, "openai-completions", "other", 5, 20],
    ["not a url", "custom-api", "other", 5, 20],
  ] as const)("%s %s → %s 单图 %d MB / 请求 %d MB", (baseUrl, api, endpoint, per, total) => {
    const model = { baseUrl, api };
    expect(imageEndpoint(model)).toBe(endpoint);
    expect(imageLimits(model)).toEqual({
      perImageBase64: per * MB,
      perRequestBase64: total * MB,
    });
  });

  it("显式 api 覆盖模型的 api；formatMb", () => {
    expect(
      imageLimits({ baseUrl: undefined, api: "openai-completions" }, "anthropic-messages"),
    ).toMatchObject({ perRequestBase64: 32 * MB });
    expect(requestImageBudget("google-generative-ai")).toBe(20 * MB);
    expect(formatMb(5 * MB)).toBe("5 MB");
    expect(formatMb(3.75 * MB)).toBe("3.8 MB");
  });
});
