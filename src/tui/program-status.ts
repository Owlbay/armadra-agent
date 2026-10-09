/**
 * 终端程序状态协议 OSC 7501（Program Status Protocol rev 0.3，2026-10-07）：
 * https://www.superlogical.com/rex/docs/build/program-status
 *
 * - 编码（纯函数）：`ESC ] 7501 ; key=value:… ESC \`。state 必填；id 每段 `[A-Za-z0-9_.+-]{1,32}`、
 *   ≤ 8 层、≤ 128 字节；kind 只随 blocked、progress（0–100 整数）只随 working / blocked；app 同 id 段；
 *   title / msg 去控制字符、压成一行后按 UTF-8 字节截断（192 / 2048，不切坏字符），再 base64。
 *   字段不合法就丢掉该字段（state / id 不合法整条不发），不发终端会整条丢弃的坏报告；整条 ≤ 4096 字节。
 * - 检测：发 `OSC 7501 ; ?` 紧跟 `CSI c`（DA1）；先收到 `?` 回复 = 支持，DA1 回复先到或超时 = 不支持。
 *   两种回复都在输入解析里吞掉（`handleInput`），不会当成按键进输入框；迟到的回复同样吞掉。
 * - tmux：缺省丢弃未知 OSC，`on` 时用 DCS passthrough（`ESC P tmux; … ESC \`，内容里 ESC 翻倍）包裹，
 *   需要 `set -g allow-passthrough on`；tmux 不把外层终端对透传查询的回复转给窗格，所以 tmux 里 `auto`
 *   不检测、等同 `off`。
 * - 发射器：每个 id 记最后一次写出的报告，同值不重写；同一 state 下只换 msg / title 的更新按节流合并。
 */

export type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear";
export type BlockedKind = "permission" | "question" | "auth";
export type ProgramStatusMode = "auto" | "on" | "off";

export interface ProgramStatusReport {
  state: ProgramState;
  /** 层级 id（`task/abc`）；缺省是根记录。 */
  id?: string;
  kind?: BlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export const PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\";
export const DA1_QUERY = "\x1b[c";
export const MAX_SEQUENCE_BYTES = 4096;
export const MAX_TITLE_BYTES = 192;
export const MAX_MSG_BYTES = 2048;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const STATES: readonly ProgramState[] = ["idle", "working", "done", "blocked", "error", "clear"];
const KINDS: readonly BlockedKind[] = ["permission", "question", "auth"];
const ELLIPSIS = "…";

/** 控制字符（C0、DEL、C1）换成空格，空白压成一个，去首尾。 */
export function sanitizeLine(text: string): string {
  return text
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 按 UTF-8 字节截断到 maxBytes（按码点切，不出半个字符）；截断时末尾带 `…`。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(ELLIPSIS, "utf8");
  let used = 0;
  let out = "";
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > budget) break;
    used += n;
    out += ch;
  }
  return out + ELLIPSIS;
}

/** id 是否合法（空串不合法；根记录不带 id）。 */
export function validId(id: string): boolean {
  if (Buffer.byteLength(id, "utf8") > MAX_ID_BYTES) return false;
  const segments = id.split("/");
  return segments.length <= MAX_ID_DEPTH && segments.every((s) => SEGMENT.test(s));
}

/** 任意字符串 → 合法的单段 id（非法字符换 `_`，截到 n 个字符）；空串给 `x`。 */
export function idSegment(raw: string, n = 12): string {
  const s = raw.replace(/[^A-Za-z0-9_.+-]/g, "_").slice(0, n);
  return s === "" ? "x" : s;
}

function encodeText(text: string | undefined, maxBytes: number): string | undefined {
  if (text === undefined) return undefined;
  const line = sanitizeLine(text);
  if (line === "") return undefined;
  return Buffer.from(truncateUtf8(line, maxBytes), "utf8").toString("base64");
}

/** 报告 → pairs（不含 OSC 包裹）；state / id 不合法返回 undefined。 */
export function encodePairs(report: ProgramStatusReport): string | undefined {
  if (!STATES.includes(report.state)) return undefined;
  if (report.id !== undefined && !validId(report.id)) return undefined;
  const pairs: string[] = [`state=${report.state}`];
  if (report.id !== undefined) pairs.push(`id=${report.id}`);
  if (report.state === "blocked" && report.kind !== undefined && KINDS.includes(report.kind))
    pairs.push(`kind=${report.kind}`);
  const p = report.progress;
  if (
    (report.state === "working" || report.state === "blocked") &&
    p !== undefined &&
    Number.isInteger(p) &&
    p >= 0 &&
    p <= 100
  )
    pairs.push(`progress=${p}`);
  if (report.app !== undefined && SEGMENT.test(report.app)) pairs.push(`app=${report.app}`);
  if (report.state !== "clear") {
    const title = encodeText(report.title, MAX_TITLE_BYTES);
    if (title !== undefined) pairs.push(`title=${title}`);
    const msg = encodeText(report.msg, MAX_MSG_BYTES);
    if (msg !== undefined) pairs.push(`msg=${msg}`);
  }
  // 各字段已有上限，整条最多约 3.2 KB；仍超限就依次丢 msg、title
  while (osc(pairs.join(":")).length > MAX_SEQUENCE_BYTES) {
    const last = pairs.at(-1)!;
    if (!last.startsWith("msg=") && !last.startsWith("title=")) return undefined;
    pairs.pop();
  }
  return pairs.join(":");
}

function osc(body: string): string {
  return `\x1b]7501;${body}\x1b\\`;
}

/** 完整的 OSC 7501 序列；报告不合法返回 undefined（不发坏报告）。 */
export function encodeProgramStatus(report: ProgramStatusReport): string | undefined {
  const pairs = encodePairs(report);
  return pairs === undefined ? undefined : osc(pairs);
}

/** tmux DCS passthrough：`ESC P tmux; <内容，ESC 翻倍> ESC \`。 */
export function tmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** 终端对 `OSC 7501 ; ?` 的回复（`?` 之后的内容忽略）。 */
export function isProgramStatusReply(sequence: string): boolean {
  return /^\x1b\]7501;\?/.test(sequence);
}

/** DA1 回复 `CSI ? … c`。 */
export function isDa1Reply(sequence: string): boolean {
  return /^\x1b\[\?[\d;]*c$/.test(sequence);
}

export interface ProgramStatusEmitterOptions {
  write(data: string): void;
  mode: ProgramStatusMode;
  /** 用来判断 tmux（`TMUX`）。 */
  env?: NodeJS.ProcessEnv;
  /** 检测超时，缺省 300 ms。 */
  timeoutMs?: number;
  /** 同一 state 下只改 msg / title 的最小间隔，缺省 500 ms。 */
  throttleMs?: number;
  now?: () => number;
  /** 固定加的 app 键（缺省不加）。 */
  app?: string;
}

type Support = "unknown" | "probing" | "yes" | "no";

/** 发射器：检测、同值去重、节流；只在 `supported` 后写。 */
export class ProgramStatusEmitter {
  private support: Support = "unknown";
  private readonly tmux: boolean;
  private readonly desired = new Map<string, ProgramStatusReport>();
  private readonly sent = new Map<string, { body: string; head: string; at: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private probeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: ProgramStatusEmitterOptions) {
    this.tmux = Boolean(options.env?.["TMUX"]);
    this.now = options.now ?? Date.now;
  }

  /** 当前是否会写出报告。 */
  get supported(): boolean {
    return this.support === "yes";
  }

  /** 按模式开始：on 直接启用，auto 发检测查询（tmux 里不检测，等同 off），off 什么都不做。 */
  start(): void {
    if (this.support !== "unknown") return;
    const mode = this.options.mode;
    if (mode === "off" || (mode === "auto" && this.tmux)) {
      this.support = "no";
      return;
    }
    if (mode === "on") return this.enable();
    this.support = "probing";
    this.options.write(PROGRAM_STATUS_QUERY + DA1_QUERY);
    this.probeTimer = setTimeout(() => this.settleProbe(false), this.options.timeoutMs ?? 300);
    this.probeTimer.unref?.();
  }

  /** 输入解析里调用：吞掉检测回复（返回 true），其余返回 false。 */
  handleInput(sequence: string): boolean {
    if (isProgramStatusReply(sequence)) {
      if (this.support === "probing") this.settleProbe(true);
      return true;
    }
    if (isDa1Reply(sequence)) {
      if (this.support === "probing") this.settleProbe(false);
      return true;
    }
    return false;
  }

  /** 设定某个 id（缺省根记录）的状态；`clear` 同时忘掉该 id 及其下层的记录。 */
  report(report: ProgramStatusReport): void {
    const key = report.id ?? "";
    const full = this.options.app !== undefined ? { ...report, app: this.options.app } : report;
    if (report.state === "clear") {
      for (const id of [...this.desired.keys()])
        if (key === "" || id === key || id.startsWith(`${key}/`)) this.forget(id);
    }
    this.desired.set(key, full);
    if (this.support === "yes") this.flush(key);
    if (report.state === "clear") this.desired.delete(key);
  }

  /** 停止计时器（不再写任何东西）。 */
  dispose(): void {
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.support === "probing") this.support = "no";
  }

  private settleProbe(ok: boolean): void {
    if (this.probeTimer !== undefined) clearTimeout(this.probeTimer);
    this.probeTimer = undefined;
    if (ok) this.enable();
    else this.support = "no";
  }

  private enable(): void {
    this.support = "yes";
    for (const key of this.desired.keys()) this.flush(key);
  }

  private forget(id: string): void {
    this.desired.delete(id);
    this.sent.delete(id);
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private flush(key: string): void {
    const report = this.desired.get(key);
    if (report === undefined) return;
    const body = encodePairs(report);
    if (body === undefined) return;
    const last = this.sent.get(key);
    if (last?.body === body) return;
    const throttle = this.options.throttleMs ?? 500;
    const head = `${report.state}:${report.kind ?? ""}`;
    const wait = last !== undefined && last.head === head ? last.at + throttle - this.now() : 0;
    if (wait > 0 && report.state !== "clear") {
      if (!this.timers.has(key)) {
        const timer = setTimeout(() => {
          this.timers.delete(key);
          this.flush(key);
        }, wait);
        timer.unref?.();
        this.timers.set(key, timer);
      }
      return;
    }
    const timer = this.timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(key);
    const sequence = osc(body);
    this.options.write(this.tmux ? tmuxPassthrough(sequence) : sequence);
    if (report.state === "clear") this.sent.delete(key);
    else this.sent.set(key, { body, head, at: this.now() });
  }
}
