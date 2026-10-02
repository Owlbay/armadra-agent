import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../../test/helpers/tmp-home.js";
import { writeConfigFile } from "./write.js";

let home: TmpHome;
beforeEach(() => {
  home = createTmpHome();
});
afterEach(() => home.cleanup());

describe("writeConfigFile", () => {
  it("新文件：建目录、2 空格缩进、换行结尾，不留 .bak", () => {
    const path = join(home.root, "new", "dir", "config.json");
    writeConfigFile(path, { version: 1, defaultModel: "a/b" });
    expect(readFileSync(path, "utf8")).toBe('{\n  "version": 1,\n  "defaultModel": "a/b"\n}\n');
    expect(() => statSync(`${path}.bak`)).toThrow();
  });

  it("已有文件：先备份原文、沿用权限；backup:false 不备份", () => {
    const path = home.write("home/.config/ama/config.json", '{"version":1}', 0o600);
    writeConfigFile(path, { version: 1, defaultModel: "x/y" });
    expect(readFileSync(`${path}.bak`, "utf8")).toBe('{"version":1}');
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, defaultModel: "x/y" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(`${path}.bak`, "old");
    writeConfigFile(path, { version: 1 }, { backup: false });
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("old");
  });
});
