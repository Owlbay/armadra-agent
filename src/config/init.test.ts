import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../cli/main.js";
import { CONFIG_SCHEMA_FILE, configSchemaText } from "./json-schema.js";
import { autoInitConfigDir, describeInit, initConfigDir, minimalConfig } from "./init.js";
import { loadConfigFile } from "./load.js";
import { DEFAULT_CONFIG, mergeConfigLayers } from "./merge.js";

const posix = process.platform !== "win32";

function fresh(): string {
  return join(mkdtempSync(join(tmpdir(), "ama-init-")), "home", ".config", "ama");
}

describe("ama init", () => {
  it("建目录（0700）、config.json 与 schema；不建 auth.json；$schema 不触发未知字段警告", () => {
    const dir = fresh();
    const result = initConfigDir(dir);
    expect(result.dirCreated).toBe(true);
    expect(result.files.map((f) => f.status)).toEqual(["created", "created"]);
    if (posix) expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
    const loaded = loadConfigFile("config", join(dir, "config.json"));
    expect(loaded?.warnings).toEqual([]);
    expect(loaded?.value).toEqual(minimalConfig());
    expect(readFileSync(join(dir, CONFIG_SCHEMA_FILE), "utf8")).toBe(configSchemaText());
    // 只写 $schema / version / 空 providers：不写死缺省值，以后调整缺省值对老用户同样生效
    expect(Object.keys(minimalConfig()).sort()).toEqual(["$schema", "providers", "version"]);
    expect(minimalConfig().providers).toEqual({});
    const merged = mergeConfigLayers({ user: minimalConfig() }).config as unknown as Record<
      string,
      unknown
    >;
    const { $schema: _schema, providers: _providers, ...rest } = merged;
    expect(rest).toEqual(mergeConfigLayers({}).config);
    expect(merged.thinkingLevel).toBe(DEFAULT_CONFIG.thinkingLevel);
  });

  it("幂等、不覆盖用户文件；schema 过期时重写；--force 先备份再重写 config，永不动 auth.json", () => {
    const dir = fresh();
    initConfigDir(dir);
    writeFileSync(join(dir, "config.json"), '{ "version": 1, "defaultModel": "x/y" }\n');
    writeFileSync(join(dir, "auth.json"), '{"version":1,"providers":{}}', { mode: 0o600 });
    writeFileSync(join(dir, CONFIG_SCHEMA_FILE), "{}");
    const again = initConfigDir(dir);
    expect(again.dirCreated).toBe(false);
    expect(again.files.map((f) => f.status)).toEqual(["exists", "updated", "exists"]);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("x/y");
    expect(initConfigDir(dir).files[1]?.status).toBe("unchanged");
    const forced = initConfigDir(dir, { force: true });
    expect(forced.files[0]?.status).toBe("overwritten");
    expect(readFileSync(join(dir, "config.json.bak"), "utf8")).toContain("x/y");
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toBe('{"version":1,"providers":{}}');
    if (posix) expect(statSync(join(dir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(describeInit(again)).toContain("已存在，未改动");
  });

  it("自动初始化：只在目录不存在时；AMA_NO_INIT=1 关闭", () => {
    const dir = fresh();
    expect(autoInitConfigDir(dir, { AMA_NO_INIT: "1" })).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect(autoInitConfigDir(dir, {})).toBe(true);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(autoInitConfigDir(dir, {})).toBe(false);
  });

  it("CLI 首次运行自动创建；ama init 打印每个文件的状态；config path 列出路径", async () => {
    const dir = fresh();
    const out: string[] = [];
    const io = {
      stdout: (t: string) => void out.push(t),
      stderr: () => undefined,
      env: { AMA_CONFIG_DIR: dir, AMA_DATA_DIR: join(dir, "..", "data"), HOME: join(dir, "..") },
      stdinIsTTY: false,
      stdoutIsTTY: false,
    };
    expect(await main(["config", "path"], { io, processHooks: false })).toBe(0);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(out.join("")).toContain(`config.json         ${join(dir, "config.json")}\n`);
    expect(out.join("")).toContain("auth.json           ");
    out.length = 0;
    expect(await main(["init"], { io, processHooks: false })).toBe(0);
    expect(out.join("")).toContain("config.json  已存在，未改动");
    expect(out.join("")).toContain("下一步：");
    expect(out.join("")).toContain("ama providers add <id> --base-url <url>");
    expect(out.join("")).toContain(`${CONFIG_SCHEMA_FILE}  已是当前版本`);
    out.length = 0;
    expect(
      await main(["config", "edit"], {
        io: { ...io, env: { ...io.env, EDITOR: "" } },
        processHooks: false,
      }),
    ).toBe(0);
    expect(out.join("")).toContain("没有设置 $VISUAL / $EDITOR");
    if (posix) {
      const edit = { ...io, env: { ...io.env, VISUAL: "test -f" } };
      expect(await main(["config", "edit"], { io: edit, processHooks: false })).toBe(0);
      const missing = { ...io, env: { ...io.env, VISUAL: "false" } };
      expect(await main(["config", "edit"], { io: missing, processHooks: false })).toBe(1);
    }
  });
});
