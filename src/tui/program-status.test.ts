import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DA1_QUERY,
  MAX_MSG_BYTES,
  MAX_TITLE_BYTES,
  PROGRAM_STATUS_QUERY,
  ProgramStatusEmitter,
  encodePairs,
  encodeProgramStatus,
  idSegment,
  isDa1Reply,
  isProgramStatusReply,
  sanitizeLine,
  tmuxPassthrough,
  truncateUtf8,
  validId,
} from "./program-status.js";
import { MemoryTerminal } from "./terminal.js";
import { TUI } from "./tui.js";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

/** pairs → 对象（title / msg 解码）。 */
function parse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split(":")) {
    const [k, v] = pair.split("=") as [string, string];
    out[k] = k === "msg" || k === "title" ? unb64(v) : v;
  }
  return out;
}

describe("编码", () => {
  it("state 必填，各字段按规范写出", () => {
    expect(encodeProgramStatus({ state: "idle" })).toBe("\x1b]7501;state=idle\x1b\\");
    const body = encodePairs({
      state: "blocked",
      id: "task/a1",
      kind: "permission",
      progress: 40,
      app: "ama",
      title: "部署",
      msg: "bash · ls",
    });
    expect(body).toBe(
      `state=blocked:id=task/a1:kind=permission:progress=40:app=ama:title=${b64("部署")}:msg=${b64("bash · ls")}`,
    );
  });

  it("不合法的 state / id 整条不发", () => {
    expect(encodePairs({ state: "busy" as never })).toBeUndefined();
    expect(encodePairs({ state: "idle", id: "a b" })).toBeUndefined();
    expect(encodePairs({ state: "idle", id: "" })).toBeUndefined();
    expect(encodePairs({ state: "idle", id: "a//b" })).toBeUndefined();
    expect(validId("a/b/c/d/e/f/g/h")).toBe(true);
    expect(validId("a/b/c/d/e/f/g/h/i")).toBe(false);
    expect(validId("x".repeat(33))).toBe(false);
    expect(validId(Array.from({ length: 5 }, () => "y".repeat(30)).join("/"))).toBe(false);
  });

  it("不合法的可选字段丢掉而不是发坏报告", () => {
    expect(encodePairs({ state: "working", kind: "permission" })).toBe("state=working");
    expect(encodePairs({ state: "blocked", kind: "nope" as never })).toBe("state=blocked");
    expect(encodePairs({ state: "done", progress: 50 })).toBe("state=done");
    expect(encodePairs({ state: "working", progress: 101 })).toBe("state=working");
    expect(encodePairs({ state: "working", progress: 2.5 })).toBe("state=working");
    expect(encodePairs({ state: "idle", app: "a:b" })).toBe("state=idle");
    expect(encodePairs({ state: "idle", msg: "  \n\t " })).toBe("state=idle");
    expect(encodePairs({ state: "clear", msg: "x", title: "y" })).toBe("state=clear");
  });

  it("控制字符换成空格并压成一行", () => {
    expect(sanitizeLine("a\x1b[31mb\r\nc\x07\x9bd\x7f")).toBe("a [31mb c d");
    const body = encodePairs({ state: "error", msg: "line1\nline2\x1b]0;x\x07" })!;
    expect(parse(body)["msg"]).toBe("line1 line2 ]0;x");
  });

  it("按 UTF-8 字节截断，不切坏字符", () => {
    expect(truncateUtf8("abc", 3)).toBe("abc");
    const cut = truncateUtf8("汉字汉字", 8);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(8);
    expect(cut).toBe("汉…");
    const long = encodePairs({ state: "working", msg: "é".repeat(5000), title: "😀".repeat(100) })!;
    const parsed = parse(long);
    expect(Buffer.byteLength(parsed["msg"]!)).toBeLessThanOrEqual(MAX_MSG_BYTES);
    expect(Buffer.byteLength(parsed["title"]!)).toBeLessThanOrEqual(MAX_TITLE_BYTES);
    expect(parsed["msg"]!.endsWith("é…")).toBe(true);
    expect(parsed["title"]).not.toContain("�");
    expect(encodeProgramStatus({ state: "working", msg: "x".repeat(9000) })!.length).toBeLessThan(
      4096,
    );
  });

  it("idSegment 把任意 id 变成合法段", () => {
    expect(idSegment("ab:cd/ef", 12)).toBe("ab_cd_ef");
    expect(idSegment("")).toBe("x");
    expect(validId(`task/${idSegment("任务-1234567890abc")}`)).toBe(true);
  });

  it("tmux passthrough 包裹，内容里的 ESC 翻倍", () => {
    expect(tmuxPassthrough("\x1b]7501;state=idle\x1b\\")).toBe(
      "\x1bPtmux;\x1b\x1b]7501;state=idle\x1b\x1b\\\x1b\\",
    );
  });

  it("识别检测回复与 DA1 回复", () => {
    expect(isProgramStatusReply("\x1b]7501;?\x1b\\")).toBe(true);
    expect(isProgramStatusReply("\x1b]7501;?junk\x07")).toBe(true);
    expect(isProgramStatusReply("\x1b]7501;state=idle\x1b\\")).toBe(false);
    expect(isDa1Reply("\x1b[?62;22c")).toBe(true);
    expect(isDa1Reply("\x1b[?1;2c")).toBe(true);
    expect(isDa1Reply("\x1b[A")).toBe(false);
  });
});

describe("发射器", () => {
  afterEach(() => vi.useRealTimers());

  function emitter(mode: "auto" | "on" | "off", env: NodeJS.ProcessEnv = {}) {
    const writes: string[] = [];
    let t = 0;
    const e = new ProgramStatusEmitter({
      write: (d) => writes.push(d),
      mode,
      env,
      app: "ama",
      timeoutMs: 300,
      throttleMs: 500,
      now: () => t,
    });
    return { e, writes, tick: (ms: number) => (t += ms) };
  }

  it("on：不检测直接发，同值去重，状态变化才写", () => {
    const { e, writes } = emitter("on");
    e.start();
    e.report({ state: "idle" });
    e.report({ state: "idle" });
    e.report({ state: "working", msg: "Thinking" });
    expect(writes).toEqual([
      "\x1b]7501;state=idle:app=ama\x1b\\",
      `\x1b]7501;state=working:app=ama:msg=${b64("Thinking")}\x1b\\`,
    ]);
  });

  it("off 与 tmux 里的 auto 什么都不写", () => {
    for (const [mode, env] of [
      ["off", {}],
      ["auto", { TMUX: "/tmp/tmux-1/default,1,0" }],
    ] as const) {
      const { e, writes } = emitter(mode, env);
      e.start();
      e.report({ state: "working" });
      expect(writes).toEqual([]);
      expect(e.handleInput("\x1b]7501;?\x1b\\")).toBe(true);
      expect(writes).toEqual([]);
    }
  });

  it("tmux 里 on：报告经 passthrough 包裹", () => {
    const { e, writes } = emitter("on", { TMUX: "x" });
    e.start();
    e.report({ state: "done" });
    expect(writes).toEqual([tmuxPassthrough("\x1b]7501;state=done:app=ama\x1b\\")]);
  });

  it("auto：? 回复先到 → 启用并补发检测期间的状态", () => {
    const { e, writes } = emitter("auto");
    e.start();
    expect(writes).toEqual([PROGRAM_STATUS_QUERY + DA1_QUERY]);
    e.report({ state: "idle" });
    expect(writes).toHaveLength(1);
    expect(e.handleInput("\x1b]7501;?\x1b\\")).toBe(true);
    expect(e.handleInput("\x1b[?62;22c")).toBe(true);
    expect(e.supported).toBe(true);
    expect(writes.slice(1)).toEqual(["\x1b]7501;state=idle:app=ama\x1b\\"]);
  });

  it("auto：DA1 回复先到 → 不支持，迟到的 ? 回复也吞掉", () => {
    const { e, writes } = emitter("auto");
    e.start();
    expect(e.handleInput("\x1b[?1;2c")).toBe(true);
    expect(e.handleInput("\x1b]7501;?\x07")).toBe(true);
    e.report({ state: "working" });
    expect(e.supported).toBe(false);
    expect(writes).toHaveLength(1);
    expect(e.handleInput("a")).toBe(false);
  });

  it("auto：超时没有回复 → 不支持", () => {
    vi.useFakeTimers();
    const { e, writes } = emitter("auto");
    e.start();
    vi.advanceTimersByTime(299);
    expect(e.handleInput("\x1b]7501;?\x1b\\")).toBe(true);
    expect(e.supported).toBe(true);
    const late = emitter("auto");
    late.e.start();
    vi.advanceTimersByTime(300);
    late.e.handleInput("\x1b]7501;?\x1b\\");
    late.e.report({ state: "idle" });
    expect(late.e.supported).toBe(false);
    expect(late.writes).toHaveLength(1);
    expect(writes).toHaveLength(1);
  });

  it("同一状态下只改 msg 按节流合并，状态变化立即写", () => {
    vi.useFakeTimers();
    const { e, writes, tick } = emitter("on");
    e.start();
    e.report({ state: "working", msg: "a" });
    e.report({ state: "working", msg: "b" });
    e.report({ state: "working", msg: "c" });
    expect(writes).toHaveLength(1);
    tick(500);
    vi.advanceTimersByTime(500);
    expect(writes.map((w) => parse(w.slice(7, -2))["msg"])).toEqual(["a", "c"]);
    e.report({ state: "working", msg: "d" });
    e.report({ state: "blocked", kind: "permission", msg: "bash" });
    expect(writes).toHaveLength(3);
    expect(parse(writes[2]!.slice(7, -2))["state"]).toBe("blocked");
    vi.advanceTimersByTime(1000);
    expect(writes).toHaveLength(3);
  });

  it("clear 不带 id 清掉全部记录，之后同值报告重新写", () => {
    const { e, writes } = emitter("on");
    e.start();
    e.report({ id: "task/a", state: "working", title: "t" });
    e.report({ state: "done" });
    e.report({ state: "clear" });
    e.report({ state: "done" });
    expect(writes.map((w) => parse(w.slice(7, -2))["state"])).toEqual([
      "working",
      "done",
      "clear",
      "done",
    ]);
  });

  it("接在 TUI 输入监听上：检测回复不会进获焦组件", () => {
    const terminal = new MemoryTerminal();
    const tui = new TUI(terminal);
    const got: string[] = [];
    tui.setFocus({ render: () => [], handleInput: (d: string) => void got.push(d) } as never);
    const e = new ProgramStatusEmitter({ write: (d) => terminal.write(d), mode: "auto" });
    tui.addInputListener((d) => e.handleInput(d));
    tui.start();
    e.start();
    terminal.sendInput("\x1b]7501;?\x1b\\\x1b[?62;22cx");
    expect(got).toEqual(["x"]);
    expect(e.supported).toBe(true);
    tui.stop();
    e.dispose();
  });
});
