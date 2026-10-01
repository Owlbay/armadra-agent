/**
 * 临时 HOME：给需要隔离文件系统的测试（配置层级、信任、会话目录、auth.json 0600）。[B0] 所有。
 *
 * `createTmpHome()` 建一棵目录：
 *   <root>/home            HOME / USERPROFILE
 *   <root>/home/.config/ama  configDir（AMA_CONFIG_DIR）
 *   <root>/home/.local/share/ama  dataDir（AMA_DATA_DIR）
 *   <root>/work            项目 cwd
 * `env` 是可直接传给子进程的环境（已去掉 API Key 变量）；`apply()` 把它写进当前进程并返回还原函数。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** §3.3 里不以 _API_KEY 结尾的候选名也算（setup.ts 与 env 构造共用）。 */
const EXTRA_KEY_VARS = ["KIMI_API_KEY", "ZAI_API_KEY", "QWEN_API_KEY", "GOOGLE_API_KEY"];

export function isApiKeyVar(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    upper.endsWith("_API_KEY") || upper.startsWith("AMA_API_KEY_") || EXTRA_KEY_VARS.includes(upper)
  );
}

export interface TmpHome {
  readonly root: string;
  readonly home: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** 相对 root 写文件（自动建父目录），返回绝对路径。 */
  write(relativePath: string, content: string | object, mode?: number): string;
  read(relativePath: string): string;
  path(...segments: string[]): string;
  /** 把 env 中的 HOME / AMA_* 写进 process.env；返回还原函数。 */
  apply(): () => void;
  cleanup(): void;
}

const APPLIED_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "AMA_CONFIG_DIR",
  "AMA_DATA_DIR",
] as const;

export function createTmpHome(prefix = "ama-home-"): TmpHome {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const configDir = join(home, ".config", "ama");
  const dataDir = join(home, ".local", "share", "ama");
  const cwd = join(root, "work");
  for (const dir of [configDir, dataDir, cwd]) mkdirSync(dir, { recursive: true });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isApiKeyVar(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    APPDATA: join(home, "AppData", "Roaming"),
    AMA_CONFIG_DIR: configDir,
    AMA_DATA_DIR: dataDir,
  });

  const abs = (relativePath: string): string => resolve(root, relativePath);

  return {
    root,
    home,
    configDir,
    dataDir,
    cwd,
    env,
    write(relativePath, content, mode) {
      const target = abs(relativePath);
      mkdirSync(dirname(target), { recursive: true });
      const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
      writeFileSync(target, text, mode === undefined ? undefined : { mode });
      return target;
    },
    read(relativePath) {
      return readFileSync(abs(relativePath), "utf8");
    },
    path(...segments) {
      return join(root, ...segments);
    },
    apply() {
      const saved = new Map<string, string | undefined>();
      for (const key of APPLIED_KEYS) {
        saved.set(key, process.env[key]);
        process.env[key] = env[key];
      }
      return () => {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 在临时 HOME 中运行 fn，结束后还原环境并删除目录。 */
export async function withTmpHome<T>(fn: (home: TmpHome) => T | Promise<T>): Promise<T> {
  const tmp = createTmpHome();
  const restore = tmp.apply();
  try {
    return await fn(tmp);
  } finally {
    restore();
    tmp.cleanup();
  }
}
