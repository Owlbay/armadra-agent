/**
 * 消息目录：session（键名规范见 docs/i18n.md）。[W6-C0 建空壳，W6-I3 迁入]
 *
 * 范围：`src/session/**`（含 Markdown 导出）、`src/checkpoints/**`、`src/plan/store.ts`、
 * `src/agent/session-plan.ts` 的待审批提示、`src/sandbox/**` 的状态说明、`src/codemode/capability.ts`
 * 与 `src/tools/presets.ts` 的警告（presets 在模型侧目录里，返回结构，由调用方经这里渲染）。
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 */

import type { PresetWarning } from "../../tools/presets.js";
import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  /** `--from`、会话 id 查找。 */
  lookup: {
    fromNeedsId: "--from needs a session id",
    fromInvalid: (spec: string) =>
      `--from must be <session id> or <session id>#<number> (got ${spec})`,
    noUserMessages: (id: string) => `session ${id} has no user messages`,
    tooFewMessages: (id: string, count: number, n: number) =>
      `session ${id} has only ${plural(count, "user message")} (got #${n})`,
    ambiguousPrefix: (id: string, candidates: string) =>
      `session id prefix ${id} is ambiguous; candidates: ${candidates}`,
    notFound: (id: string) => `session not found: ${id}`,
  },
  /** `ama sessions export --format md`（按导出时的界面语言渲染）。 */
  export: {
    truncated: (length: number) => `…(truncated, originally ${plural(length, "character")})`,
    image: (mime: string) => `[image ${mime}]`,
    title: (shortId: string) => `Session ${shortId}`,
    id: (id: string) => `- id: ${id}`,
    cwd: (cwd: string) => `- Directory: ${cwd}`,
    created: (time: string) => `- Created: ${time}`,
    scope: (all: boolean, count: number) =>
      `- Scope: ${all ? "all entries" : "current branch"} (${plural(count, "entry", "entries")})`,
    parent: (id: string) => `- Source session: ${id}`,
    user: (n: number | undefined, origin: string | undefined, time: string) =>
      `## User${n !== undefined ? ` #${n}` : ""}${origin !== undefined ? ` (${origin})` : ""} · ${time}`,
    assistant: (model: string, time: string) => `## Assistant · ${model} · ${time}`,
    toolCall: (name: string) => `**Tool call** \`${name}\``,
    stopped: (reason: string, error: string | undefined) =>
      `> Stopped: ${reason}${error !== undefined ? ` · ${error}` : ""}`,
    toolResult: (name: string, isError: boolean) =>
      `**Result** \`${name}\`${isError ? " (error)" : ""}`,
    compaction: (time: string) => `## Compaction summary · ${time}`,
    branchSummary: (time: string) => `## Branch summary · ${time}`,
    modelChange: (model: string) => `_Switched model: ${model}_`,
    usage: "## Usage",
    usageHeader: "| Requests | Input | Output | Cache read | Cache write | Cost |",
  },
  /** 检查点（file-history / 影子 git）。 */
  checkpoints: {
    registerFailed: (error: string) =>
      `checkpoints: failed to register the session directory (${error})`,
    shadowUnavailable: (reason: string) =>
      `checkpoints: shadow git unavailable (${reason}); this session uses tools mode instead`,
    gitMissing: "git not found on PATH",
    createFailed: (error: string) => `checkpoints: failed to create (${error})`,
    shadowRestoreFailed: (error: string) =>
      `checkpoints: restoring from the shadow commit failed (${error}); restoring from the tools record instead`,
    replacedDuringRestore: "the file was replaced during restore",
    invalidEnv: (raw: string, modes: readonly string[]) =>
      `AMA_CHECKPOINTS=${raw} is invalid (${modes.join(" | ")}); ignored`,
    cwdIsRoot: "the working directory is the filesystem root",
    cwdIsHome: "the working directory is the home directory",
    gitNotFound: "git not found",
    tooManyFiles: (files: number, max: number) =>
      `the working directory has ${plural(files, "file")} (limit ${max})`,
    tooSlow: (seconds: string, max: number) => `the snapshot took ${seconds} s (limit ${max} s)`,
    gitFailed: (command: string, code: string, detail: string) =>
      `git ${command} failed (${code})${detail === "" ? "" : `: ${detail}`}`,
    noShadowCommit: "the checkpoint has no shadow commit",
    shadowCommitMissing: (commit: string) => `shadow commit ${commit} does not exist`,
    backupFailed: (key: string, error: string) =>
      `checkpoints: backing up ${key} failed (${error}); this write cannot be rewound`,
    recordFailed: (path: string, error: string) =>
      `checkpoints: recording the write to ${path} failed (${error})`,
    snapshotFailed: (key: string, error: string) =>
      `checkpoints: snapshot of ${key} failed (${error}); rewinding to here uses an earlier record for this file`,
  },
  /** Plan 的存放与待审批提示。 */
  plan: {
    directoryOutside: (configured: string, root: string, fallback: string) =>
      `plan.directory ${configured} is outside the project root ${root}; plan files go to ${fallback}`,
    pendingNotice: (version: number, file: string | undefined, target: string) =>
      `Plan v${version} awaits approval${file === undefined ? "" : ` (${file})`}: reply 1 to approve and execute (${target}) · 2 to execute with Accept edits · 3 to execute with Auto; any other reply is taken as feedback and stays in Plan mode.`,
  },
  /** 操作系统沙箱与 bash 沙箱的说明（`ama doctor`、`ama config`、状态区）。 */
  sandbox: {
    notConfigured: "not configured",
    bashOff: "off (sandbox.bash: off)",
    bashUnshareOnly: "unavailable: unshare only isolates the network and cannot restrict writes",
    bashUnavailable: (detail: string) => `unavailable: ${detail}`,
    bashActive: (kind: string, network: string, extra: readonly string[]) =>
      `${kind}, network ${network}, writable: workspace, temp dir, output dir${extra.length > 0 ? `, ${extra.join(", ")}` : ""}`,
    noOsSandbox: "no OS sandbox available",
    disabled: "disabled (sandbox.enabled: off or AMA_SANDBOX=off)",
    missing: (path: string) => `no ${path}`,
    sandboxExecFailed: (code: number | null) =>
      `sandbox-exec probe failed (${code === null ? "could not start" : `exit code ${code}`}; maybe already inside another sandbox)`,
    bwrapFailed: (code: number | null) =>
      `bwrap probe failed (${code === null ? "could not start" : `exit code ${code}`})`,
    noBwrap: "no bwrap",
    unshareOnly: (failures: readonly string[]) =>
      `Linux unshare -r -n (network only; ${failures.join(", ")})`,
    unshareFailed: (code: number | null) =>
      `unshare probe failed (${code === null ? "could not start" : `exit code ${code}`}; unprivileged user namespaces may be disallowed)`,
    noUnshare: "no unshare",
    failures: (failures: readonly string[]) => failures.join(", "),
    unsupportedPlatform: (platform: string) => `no OS sandbox implementation on ${platform}`,
  },
  /** codemode 可用性与工具预设的警告。 */
  codemode: {
    disabled: (node: number, detail: string) =>
      `codemode disabled: Node ${node}'s permission model does not isolate the network and no OS sandbox is available (${detail}; codemode.requireStrict is true; Node ≥ 25 or macOS sandbox-exec / Linux bwrap can isolate)`,
    unisolated: (node: number, detail: string) =>
      `codemode: the network is not isolated under Node ${node} (no OS sandbox available: ${detail}; set codemode.requireStrict to require isolation)`,
    presetWarning: (w: PresetWarning): string => {
      switch (w.kind) {
        case "codemode_only_fallback":
          return "tool preset codemode-only needs the codemode tool (unavailable); fell back to default";
        case "codemode_unavailable":
          return `codemode.mode ${w.mode} needs the codemode tool (unavailable); ignored`;
        case "unknown_tool":
          return `tools.default: unknown tool ${w.name}; ignored`;
      }
    },
  },
};

export const zh = {
  lookup: {
    fromNeedsId: "--from 需要会话 id",
    fromInvalid: (spec) => `--from 应为 <会话 id> 或 <会话 id>#<编号>（收到 ${spec}）`,
    noUserMessages: (id) => `会话 ${id} 没有用户消息`,
    tooFewMessages: (id, count, n) => `会话 ${id} 只有 ${count} 条用户消息（收到 #${n}）`,
    ambiguousPrefix: (id, candidates) => `会话 id 前缀 ${id} 不唯一，候选：${candidates}`,
    notFound: (id) => `会话不存在：${id}`,
  },
  export: {
    truncated: (length) => `…（截断，原长 ${length} 字符）`,
    image: (mime) => `[图片 ${mime}]`,
    title: (shortId) => `会话 ${shortId}`,
    id: (id) => `- id：${id}`,
    cwd: (cwd) => `- 目录：${cwd}`,
    created: (time) => `- 创建：${time}`,
    scope: (all, count) => `- 范围：${all ? "全部条目" : "当前分支"}（${count} 条条目）`,
    parent: (id) => `- 来源会话：${id}`,
    user: (n, origin, time) =>
      `## 用户${n !== undefined ? ` #${n}` : ""}${origin !== undefined ? `（${origin}）` : ""} · ${time}`,
    assistant: (model, time) => `## 助手 · ${model} · ${time}`,
    toolCall: (name) => `**工具调用** \`${name}\``,
    stopped: (reason, error) => `> 停止：${reason}${error !== undefined ? ` · ${error}` : ""}`,
    toolResult: (name, isError) => `**结果** \`${name}\`${isError ? "（出错）" : ""}`,
    compaction: (time) => `## 压缩摘要 · ${time}`,
    branchSummary: (time) => `## 分支摘要 · ${time}`,
    modelChange: (model) => `_切换模型：${model}_`,
    usage: "## 用量",
    usageHeader: "| 请求 | 输入 | 输出 | 缓存读 | 缓存写 | 费用 |",
  },
  checkpoints: {
    registerFailed: (error) => `检查点：登记会话目录失败（${error}）`,
    shadowUnavailable: (reason) => `检查点：影子 git 不可用（${reason}），本会话改用 tools 模式`,
    gitMissing: "PATH 里找不到 git",
    createFailed: (error) => `检查点：建立失败（${error}）`,
    shadowRestoreFailed: (error) => `检查点：按影子提交恢复失败（${error}），改按 tools 记录恢复`,
    replacedDuringRestore: "文件在恢复期间被替换",
    invalidEnv: (raw, modes) => `AMA_CHECKPOINTS=${raw} 无效（${modes.join(" | ")}），已忽略`,
    cwdIsRoot: "工作目录是文件系统根目录",
    cwdIsHome: "工作目录是家目录",
    gitNotFound: "找不到 git",
    tooManyFiles: (files, max) => `工作目录有 ${files} 个文件（上限 ${max}）`,
    tooSlow: (seconds, max) => `快照用了 ${seconds} 秒（上限 ${max} 秒）`,
    gitFailed: (command, code, detail) =>
      `git ${command} 失败（${code}）${detail === "" ? "" : `：${detail}`}`,
    noShadowCommit: "检查点没有影子提交",
    shadowCommitMissing: (commit) => `影子提交 ${commit} 不存在`,
    backupFailed: (key, error) => `检查点：备份 ${key} 失败（${error}），本次写入不可回滚`,
    recordFailed: (path, error) => `检查点：记录 ${path} 的写入失败（${error}）`,
    snapshotFailed: (key, error) =>
      `检查点：快照 ${key} 失败（${error}），该文件回滚到此处时用更早的记录`,
  },
  plan: {
    directoryOutside: (configured, root, fallback) =>
      `plan.directory ${configured} 不在项目根 ${root} 之内，计划文件改写到 ${fallback}`,
    pendingNotice: (version, file, target) =>
      `计划 v${version} 待审批${file === undefined ? "" : `（${file}）`}：回复 1 批准并执行（${target}）· 2 以 Accept edits 执行 · 3 以 Auto 执行；回复其它内容作为修改意见，留在 Plan 模式。`,
  },
  sandbox: {
    notConfigured: "未配置",
    bashOff: "关闭（sandbox.bash: off）",
    bashUnshareOnly: "不可用：unshare 只隔离网络、不能限制写入",
    bashUnavailable: (detail) => `不可用：${detail}`,
    bashActive: (kind, network, extra) =>
      `${kind}，网络 ${network}，可写：工作区、临时目录、输出目录${extra.length > 0 ? `、${extra.join("、")}` : ""}`,
    noOsSandbox: "没有可用的操作系统沙箱",
    disabled: "已关闭（sandbox.enabled: off 或 AMA_SANDBOX=off）",
    missing: (path) => `没有 ${path}`,
    sandboxExecFailed: (code) =>
      `sandbox-exec 探针失败（${code === null ? "无法启动" : `退出码 ${code}`}；可能已在别的沙箱里）`,
    bwrapFailed: (code) => `bwrap 探针失败（${code === null ? "无法启动" : `退出码 ${code}`}）`,
    noBwrap: "没有 bwrap",
    unshareOnly: (failures) => `Linux unshare -r -n（只隔离网络；${failures.join("，")}）`,
    unshareFailed: (code) =>
      `unshare 探针失败（${code === null ? "无法启动" : `退出码 ${code}`}；可能不允许非特权用户命名空间）`,
    noUnshare: "没有 unshare",
    failures: (failures) => failures.join("，"),
    unsupportedPlatform: (platform) => `${platform} 上没有操作系统沙箱实现`,
  },
  codemode: {
    disabled: (node, detail) =>
      `codemode 已禁用：Node ${node} 的权限模型不隔离网络，也没有可用的操作系统沙箱（${detail}；codemode.requireStrict 为 true；Node ≥ 25 或 macOS sandbox-exec / Linux bwrap 可隔离）`,
    unisolated: (node, detail) =>
      `codemode：Node ${node} 下网络未隔离（没有可用的操作系统沙箱：${detail}；要求隔离可设 codemode.requireStrict）`,
    presetWarning: (w) => {
      switch (w.kind) {
        case "codemode_only_fallback":
          return "工具预设 codemode-only 需要 codemode 工具（不可用），已回退到 default";
        case "codemode_unavailable":
          return `codemode.mode ${w.mode} 需要 codemode 工具（不可用），已忽略`;
        case "unknown_tool":
          return `tools.default：未知工具 ${w.name}，已忽略`;
      }
    },
  },
} satisfies Messages<typeof en>;
