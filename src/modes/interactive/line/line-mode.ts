/**
 * 行式界面（`--no-tui`、非 TTY、`TERM=dumb`；B7 的终端界面合入前也承担交互模式）。[B6]
 *
 * - stdin 是 TTY 且可开 raw：自带单行编辑器（line-editor.ts：历史、括号粘贴折叠），运行中回车
 *   = steer；Ctrl+C 运行中中断、空闲时连按两次退出（130）；空行 Ctrl+D 退出；审批 y / a / N 单键问答。
 *   问句之前逐行打印执行前预览（`request.preview`，W3-B9a-2）。
 * - 否则（管道）：逐行读 stdin，每行依次执行（等上一条运行结束）；没有审批 UI，ask → deny。
 * - 斜杠命令走 commands-core（与 B7 同一语义），`pick` 退化为列出候选。
 */

import type { AgentSession } from "../../../agent/types.js";
import { currentSession, switchSession } from "../../../cli/compose-session.js";
import type { ModeContext } from "../../../cli/deps.js";
import { ExitCode } from "../../../cli/exit-codes.js";
import { previewDisplayLines } from "../../../permissions/preview.js";
import type { Runtime } from "../../../cli/runtime.js";
import { AMA_VERSION } from "../../../version.js";
import { runSlashCommand, type CommandContext } from "../../commands-core.js";
import { createLineReader } from "../../rpc/jsonl.js";
import { errorText, onTerminationSignals } from "../../shared.js";
import { LineEditor } from "./line-editor.js";
import { EventPrinter, approvalQuestion, pickHint } from "./line-render.js";

export interface LineModeOptions {
  stdin?: NodeJS.ReadableStream & { setRawMode?(raw: boolean): unknown; isTTY?: boolean };
  /** 强制 raw / 管道（测试）；缺省按 io.stdinIsTTY 与 setRawMode 判断。 */
  raw?: boolean;
}

const DOUBLE_INTERRUPT_MS = 1500;

export async function runLineMode(
  runtime: Runtime,
  context: ModeContext,
  options: LineModeOptions = {},
): Promise<number> {
  const { io } = context;
  const stdin = options.stdin ?? (process.stdin as NonNullable<LineModeOptions["stdin"]>);
  const raw = options.raw ?? (io.stdinIsTTY && typeof stdin.setRawMode === "function");
  let editor: LineEditor | undefined;
  const out = (text: string): void => {
    editor?.hide();
    io.stdout(text);
  };
  const err = (text: string): void => {
    editor?.hide();
    io.stderr(text);
  };
  const printer = new EventPrinter(out, err);
  let session = currentSession(runtime);
  let unsubscribe = session.subscribe((event) => printer.handle(event));
  const commands: CommandContext = {
    runtime,
    session: () => session,
    async switchSession(request) {
      const next = await switchSession(runtime, request);
      unsubscribe();
      session = next;
      unsubscribe = next.subscribe((event) => printer.handle(event));
      return next;
    },
  };

  /** 一行输入：命令或提示；返回 "exit" 表示结束。 */
  const handle = async (line: string): Promise<"exit" | undefined> => {
    if (line.trim() === "") return undefined;
    try {
      const result = await runSlashCommand(line, commands);
      if (result === undefined) await prompt(session, line);
      else if (result.kind === "exit") return "exit";
      else if (result.kind === "prompt") await prompt(session, result.text);
      else if (result.kind === "pick") out(`${await pickHint(result.what, runtime, session)}\n`);
      else if (result.message !== undefined) out(`${result.message}\n`);
    } catch (error) {
      printer.endLine();
      err(`ama: ${errorText(error)}\n`);
    }
    return undefined;
  };
  const prompt = async (target: AgentSession, text: string): Promise<void> => {
    await target.prompt(text);
    printer.endLine();
  };

  if (!raw)
    return runPiped(
      stdin,
      context,
      handle,
      () => session,
      () => unsubscribe(),
    );

  // ---- raw 终端 ----
  const tty = stdin as NonNullable<LineModeOptions["stdin"]>;
  editor = new LineEditor({ prompt: "› ", write: (t) => io.stdout(t) });
  const ed = editor;
  if (runtime.config.ui?.quietStartup !== "silent") {
    const model = session.state.model;
    io.stdout(
      `ama ${AMA_VERSION} · ${model?.provider}/${model?.id} · /help 查看命令，Ctrl+D 退出\n`,
    );
  }
  runtime.approvals.setUiBroker({
    ask: (request, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(undefined);
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
        const preview = previewDisplayLines(request.preview).map((l) => `  ${l}\n`);
        void ed.ask(`\n${preview.join("")}${approvalQuestion(request)}`, "n").then((answer) => {
          resolve(answer === "y" ? "allow" : answer === "a" ? "allow_session" : "deny");
          if (!busy) ed.render();
        });
      }),
  });
  runtime.notifier.set((message, level) => err(`ama: [${level}] ${message}\n`));
  let busy = false;
  let lastInterrupt = 0;
  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      tty.off("data", onData);
      ed.hide();
      io.stdout("\x1b[?2004l");
      tty.setRawMode?.(false);
      (tty as { pause?: () => void }).pause?.();
      runtime.approvals.setUiBroker(undefined);
      runtime.notifier.set(undefined);
      void session
        .abort()
        .catch(() => undefined)
        .finally(() => {
          unsubscribe();
          resolve(code);
        });
    };
    const run = (text: string): void => {
      busy = true;
      void handle(text).then((outcome) => {
        busy = false;
        if (outcome === "exit") finish(ExitCode.Ok);
        else ed.render();
      });
    };
    let flushTimer: NodeJS.Timeout | undefined;
    const apply = (actions: ReturnType<LineEditor["feed"]>): void => {
      for (const action of actions) {
        if (action.kind === "eof") return finish(ExitCode.Ok);
        if (action.kind === "interrupt") {
          if (busy) {
            void session.abort();
            err("^C 已中断\n");
          } else if (Date.now() - lastInterrupt < DOUBLE_INTERRUPT_MS) {
            return finish(ExitCode.Sigint);
          } else {
            lastInterrupt = Date.now();
            io.stdout("\n（再按一次 Ctrl+C 退出）\n");
            ed.render();
          }
          continue;
        }
        if (busy) {
          if (action.text.trim() !== "") {
            void session.steer(action.text).catch(() => undefined);
            out(`↳ steer：${action.text}\n`);
          }
          continue;
        }
        run(action.text);
      }
    };
    const onData = (chunk: Buffer | string): void => {
      apply(ed.feed(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
      if (flushTimer !== undefined) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => apply(ed.flush()), 50);
    };
    tty.setRawMode?.(true);
    io.stdout("\x1b[?2004h");
    tty.on("data", onData);
    (tty as { resume?: () => void }).resume?.();
    if (context.prompt !== undefined) {
      io.stdout(`› ${context.prompt}\n`);
      run(context.prompt);
    } else ed.render();
  });
}

/** 管道：逐行依次执行；stdin 结束后等最后一条跑完退出 0。 */
function runPiped(
  stdin: NodeJS.ReadableStream,
  context: ModeContext,
  handle: (line: string) => Promise<"exit" | undefined>,
  session: () => AgentSession,
  unsubscribe: () => void,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let chain: Promise<"exit" | undefined> = Promise.resolve(undefined);
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      reader.close();
      offSignals();
      (stdin as { pause?: () => void }).pause?.();
      unsubscribe();
      resolve(code);
    };
    const enqueue = (line: string): void => {
      chain = chain.then((state) => (state === "exit" ? state : handle(line)));
      void chain.then((state) => {
        if (state === "exit") finish(ExitCode.Ok);
      });
    };
    const reader = createLineReader(stdin, enqueue, () => {
      void chain.then(() => finish(ExitCode.Ok));
    });
    const offSignals = onTerminationSignals((code) => {
      void session()
        .abort()
        .finally(() => finish(code));
    });
    if (context.prompt !== undefined) enqueue(context.prompt);
  });
}
