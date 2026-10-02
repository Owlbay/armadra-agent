/**
 * 启动期问答的文本回退（`--no-tui`、stdout 非 TTY、`TERM=dumb`）：问题写 stderr，从 stdin 读一行。
 * 与 `interactive/startup-ui.ts` 同一组 `InteractiveUi` 回调，但不加载终端组件库。[W3-B9a-1]
 *
 * 读一行只消费到换行为止，多读的部分 `unshift` 回流里，留给随后的行式界面；EOF = 取消。
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { InteractiveUi } from "../cli/deps.js";
import { msg } from "../i18n/index.js";

export interface TextUiIo {
  stdin: NodeJS.ReadableStream & { readableEnded?: boolean };
  write(text: string): void;
}

/** 读一行（不含行尾）；EOF 且无内容返回 undefined。 */
export function readOneLine(stdin: TextUiIo["stdin"]): Promise<string | undefined> {
  if (stdin.readableEnded === true) return Promise.resolve(undefined);
  return new Promise((done) => {
    let buffer = "";
    const finish = (line: string | undefined, rest: string): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      if (rest !== "") stdin.unshift(Buffer.from(rest));
      done(line);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      const at = buffer.indexOf("\n");
      if (at >= 0) finish(buffer.slice(0, at).replace(/\r$/, ""), buffer.slice(at + 1));
    };
    const onEnd = (): void => finish(buffer === "" ? undefined : buffer, "");
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}

/** 按编号或值（前缀唯一）选一项；空行 / 无匹配 / EOF 返回 undefined。 */
function choose(answer: string | undefined, values: readonly string[]): string | undefined {
  const text = answer?.trim() ?? "";
  if (text === "") return undefined;
  const index = Number(text);
  if (Number.isInteger(index) && index >= 1 && index <= values.length) return values[index - 1];
  if (values.includes(text)) return text;
  const matches = values.filter((value) => value.startsWith(text));
  return matches.length === 1 ? matches[0] : undefined;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createTextStartupUi(io: TextUiIo): Required<InteractiveUi> {
  const ask = async (lines: readonly string[], question: string): Promise<string | undefined> => {
    io.write([...lines, question].join("\n"));
    return readOneLine(io.stdin);
  };
  const list = (values: readonly string[], labels: readonly string[]): string[] =>
    values.map((_, i) => `  ${i + 1}. ${labels[i]}`);
  return {
    async promptTrust(cwd, resources) {
      const m = msg().report.startup;
      const shown = resources.slice(0, 6).map((p) => `  ${p}`);
      if (resources.length > shown.length) shown.push(m.more(resources.length - shown.length));
      const answer = await ask([m.trustQuestion(cwd), ...shown], m.trustChoices);
      const key = answer?.trim().toLowerCase();
      if (key === "a") return { trusted: true, remember: true };
      return { trusted: key === "y" || key === "yes", remember: false };
    },

    async pickSession(items) {
      if (items.length === 0) return undefined;
      const sorted = [...items].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      const ids = sorted.map((item) => item.id);
      const labels = sorted.map(
        (item) =>
          `${item.id.slice(0, 8)}  ${(item.name ?? item.firstPrompt ?? "").replace(/\s+/g, " ").slice(0, 60)}`,
      );
      const m = msg().report.startup;
      return choose(await ask([m.resumeQuestion, ...list(ids, labels)], m.resumeAnswer), ids);
    },

    async pickModel(providers, reason) {
      const refs: string[] = [];
      for (const provider of providers.list())
        for (const model of provider.models) refs.push(`${provider.id}/${model.id}`);
      if (refs.length === 0) return undefined;
      const m = msg().report.startup;
      const answer = await ask([reason, m.pickModel, ...list(refs, refs)], m.pickModelAnswer);
      return choose(answer, refs);
    },

    async askCwd(missing) {
      const m = msg().report.startup;
      const answer = (await ask([m.cwdMissing(missing)], m.cwdAnswer))?.trim();
      if (answer === undefined || answer === "") return undefined;
      const abs = resolve(answer);
      if (!existsSync(abs) || !isDirectory(abs)) {
        io.write(m.notDirectory(abs));
        return undefined;
      }
      return abs;
    },
  };
}
