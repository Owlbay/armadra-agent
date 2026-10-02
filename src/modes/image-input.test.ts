import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { parseArgs } from "../cli/args.js";
import type { Model } from "../ai/types.js";
import { findImageRefs, loadPromptImages, promptImages } from "./image-input.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f9d0000000049454e44ae426082",
  "hex",
);

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ama-imgin-"));
  writeFileSync(join(dir, "a.png"), PNG);
  mkdirSync(join(dir, "my pics"));
  writeFileSync(join(dir, "my pics", "b c.png"), PNG);
  return dir;
}

const VISION = { provider: "p", id: "vl", input: ["text", "image"] } as Model;
const TEXT_ONLY = { provider: "p", id: "txt", input: ["text"] } as Model;

let h: ComposeHarness | undefined;
afterEach(() => h?.cleanup());

describe("图片引用", () => {
  it("@路径（含引号）是显式；存在的图片路径（拖入的 \\ 转义）是隐式；其它词忽略", () => {
    const dir = workdir();
    const refs = findImageRefs(
      `看 @a.png 和 @"my pics/b c.png"，还有 ${dir}/my\\ pics/b\\ c.png、notes.txt、missing.png @gone.jpg`,
      dir,
    );
    expect(refs).toEqual([
      { path: join(dir, "a.png"), explicit: true },
      { path: join(dir, "my pics", "b c.png"), explicit: true },
      { path: join(dir, "gone.jpg"), explicit: true },
    ]);
    expect(findImageRefs(`${dir}/a.png 是什么`, "/")).toEqual([
      { path: join(dir, "a.png"), explicit: false },
    ]);
  });

  it("模型不收图片：显式附件报错并提示换模型，隐式的静默忽略", async () => {
    const dir = workdir();
    await expect(promptImages("看 @a.png", [], dir, TEXT_ONLY)).rejects.toThrow(
      /p\/txt 不接受图片输入.*换一个支持图像的模型/,
    );
    await expect(promptImages("a.png 是什么", [], dir, TEXT_ONLY)).resolves.toEqual([]);
    const blocks = await promptImages("a.png 是什么", ["my pics/b c.png"], dir, VISION);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    await expect(
      loadPromptImages([{ path: join(dir, "x.png"), explicit: true }], VISION),
    ).rejects.toThrow(/图片不存在/);
  });

  it("--image 只用于 -p，可重复", () => {
    const parsed = parseArgs(["-p", "hi", "--image", "a.png", "--image=b.jpg"]);
    expect(parsed.kind === "run" && parsed.args.images).toEqual(["a.png", "b.jpg"]);
    expect(() => parseArgs(["--image", "a.png"])).toThrow(/只用于 -p/);
  });

  it("ama -p --image：图片随首条提示发给模型；模型不收图片 → 退出 2 不发请求", async () => {
    h = composeHarness([{ text: "red" }]);
    writeFileSync(join(h.home.cwd, "x.png"), PNG);
    expect(await h.run(["-p", "图里有什么颜色", "--image", "x.png", "--model", "fake/echo"])).toBe(
      0,
    );
    expect(h.fake.calls[0]?.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "图里有什么颜色" },
        { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
      ],
    });
    h.cleanup();
    h = composeHarness([{ text: "never" }]);
    h.home.write("home/.config/ama/config.json", {
      version: 1,
      providers: {
        local: {
          api: "fake",
          baseUrl: "fake://local",
          requiresApiKey: false,
          models: [{ id: "text-only" }],
        },
      },
    });
    writeFileSync(join(h.home.cwd, "x.png"), PNG);
    expect(await h.run(["-p", "看图", "--image", "x.png", "--model", "local/text-only"])).toBe(2);
    expect(h.stderr()).toContain("local/text-only 不接受图片输入");
    expect(h.fake.calls).toHaveLength(0);
  });
});
