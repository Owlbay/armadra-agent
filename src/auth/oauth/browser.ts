/**
 * 打开系统浏览器（R6 §4.11）。[W6-O]
 *
 * macOS `open`、Windows `cmd /c start ""`、其余 `xdg-open`；URL 作为 argv 传入，不拼 shell 字符串。
 * 打不开（命令不存在、非零退出）返回 false，调用方改为只打印 URL。
 */

import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<boolean>;

export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` 的第一个带引号参数是窗口标题；URL 里的 & 需要 cmd 转义
  if (platform === "win32")
    return { command: "cmd", args: ["/c", "start", '""', url.replace(/&/g, "^&")] };
  return { command: "xdg-open", args: [url] };
}

export const openBrowser: BrowserOpener = (url) =>
  new Promise((resolve) => {
    const { command, args } = browserCommand(url);
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0 || code === null));
      child.unref();
    } catch {
      resolve(false);
    }
  });
