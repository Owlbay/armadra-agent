/**
 * 外部编辑器（计划审批框的「编辑计划」与「继续修改」）：`$VISUAL` → `$EDITOR` → `vi`（Windows `notepad`）。
 * [W5-U] 编辑期间 TUI 挂起（交还终端），回来后整屏重画。临时文件在系统临时目录，读完即删。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExternalEditorDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** 挂起 / 恢复界面。 */
  suspend(): void;
  resume(): void;
  platform?: NodeJS.Platform;
  /** 测试注入：代替真实启动编辑器（参数：命令行、文件路径），返回退出码。 */
  run?(command: string, file: string): number | null;
}

export function editorCommand(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env["VISUAL"]?.trim() || env["EDITOR"]?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return platform === "win32" ? "notepad" : "vi";
}

function runEditor(command: string, file: string): number | null {
  // 编辑器变量常带参数（`code --wait`），交给 shell 拆；路径加引号
  const result = spawnSync(`${command} "${file}"`, { stdio: "inherit", shell: true });
  return result.status;
}

/** 在外部编辑器里改 `text`；编辑器非零退出或读不回来返回 undefined。 */
export async function editExternally(
  text: string,
  name: string,
  deps: ExternalEditorDeps,
): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "ama-edit-"));
  const file = join(dir, name);
  writeFileSync(file, text);
  deps.suspend();
  try {
    const code = (deps.run ?? runEditor)(editorCommand(deps.env, deps.platform), file);
    if (code !== 0) return undefined;
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  } finally {
    deps.resume();
    rmSync(dir, { recursive: true, force: true });
  }
}
