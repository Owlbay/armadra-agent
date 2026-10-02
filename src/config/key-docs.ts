/**
 * config.json 每个键的说明与缺省值：config.schema.json（编辑器悬停）与 `ama config show`（来源 default
 * 的行）共用这一张表。
 *
 * - `description` 写在 `CONFIG_KEY_DOCS`；缺省值不手写，从 `DEFAULT_CONFIG`（merge.ts）、
 *   `DEFAULT_CACHE_CONFIG`（types.ts）与代码里的隐式缺省（`IMPLICIT_DEFAULTS`）合成 `DISPLAY_DEFAULTS`；
 * - 缺省值取决于运行时的键（自动选模型、跟随预设等）列在 `DYNAMIC_DEFAULTS`，schema 里不写 `default`，
 *   说明里写规则；
 * - 一致性由 json-schema.test.ts 守住：schema 的每个键都在表里，表里的每个键 schema 都有，缺省值与
 *   DISPLAY_DEFAULTS 相同，DISPLAY_DEFAULTS 本身通过 `validateConfig`。
 */

import { DEFAULT_IDLE_TIMEOUT_MS } from "../ai/http.js";
import { DEFAULT_INLINE_BUDGET } from "../codemode/declarations.js";
import { DEFAULT_CONFIG, mergeConfig } from "./merge.js";
import { DEFAULT_CACHE_CONFIG, DEFAULT_CHECKPOINTS_CONFIG, type AmaConfig } from "./types.js";

/** 代码里生效、但 DEFAULT_CONFIG 不写的缺省（写进去会改变合并结果或 `config.codemode` 的有无）。 */
const IMPLICIT_DEFAULTS: Partial<AmaConfig> = {
  providers: {},
  permission: { builtinDeny: true, autoSafeCommands: [] },
  tools: { default: [] },
  codemode: { inlineBudget: DEFAULT_INLINE_BUDGET, requireStrict: false },
  cache: { ...DEFAULT_CACHE_CONFIG },
  request: { idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS },
  ui: { compact: false, animation: true, restoreOnCancel: true },
  checkpoints: { ...DEFAULT_CHECKPOINTS_CONFIG },
  sandbox: { enabled: "auto", bash: "off", network: "deny", writable: [] },
  // [W5-C0] 第五波键的缺省（行为由各批次实现）
  compaction: { prune: { keepResults: 5, clearAtLeast: "auto" }, pruneExclude: [] },
  images: { resize: "auto" },
  plan: { bash: "readonly", unattended: "stop" },
  agents: { maxConcurrent: 3, dirs: [] },
  subagents: { maxConcurrent: 4, maxPending: 16 },
  reminders: { todo: true, fileChanges: true, contextPressure: true, budget: true },
  todo: { reminder: 10 },
};

/** 全部有固定缺省值的键（展示用；运行时仍以 DEFAULT_CONFIG 合并）。 */
export const DISPLAY_DEFAULTS: Readonly<AmaConfig> = Object.freeze(
  mergeConfig(DEFAULT_CONFIG as AmaConfig, IMPLICIT_DEFAULTS),
);

/** 缺省值由运行时决定的键 → 规则（schema 不写 default）。 */
export const DYNAMIC_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  $schema: "ama init 写 ./config.schema.json",
  defaultModel: "零配置自动选择",
  "permission.autoModel": "当前会话模型",
  "codemode.mode": "跟随预设",
  "ui.ascii": "自动检测",
  // [W5-C0]
  "ui.statusLine": "独立终端 full，嵌入宿主（有 profile）compact",
  "plan.directory": "<数据目录>/plans",
  "plan.model": "不设：沿用当前模型",
  "plan.thinkingLevel": "不设：沿用当前思考强度",
  "agents.sessionBudgetUsd": "不设：不限",
  "subagents.defaultModel": "不设：继承父会话模型",
  "models.aliases.fast": "不设：fast 按 inherit 处理",
  "models.aliases.strong": "不设：strong 按 inherit 处理",
  fallbackModel: "不设：不回退",
  "limits.maxTurns": "不设：不限",
  "limits.maxCostUsd": "不设：不限",
});

/** 键路径 → 说明（段落本身也有一条）。 */
export const CONFIG_KEY_DOCS: Readonly<Record<string, string>> = Object.freeze({
  $schema: "编辑器用的 JSON Schema 路径",
  version: "配置文件格式版本，固定为 1",
  defaultModel:
    "缺省模型 provider/model 或 provider/model@channel；不写时零配置自动选择（ama config show 显示选了谁、为什么）",
  thinkingLevel: "思考强度",
  providers: "自定义供应商与对内置供应商的覆盖（docs/providers.md）",
  permission: "权限（docs/permissions.md）",
  "permission.mode": "权限模式；项目级只能更严",
  "permission.allow": "放行规则，如 bash(npm test)；项目级不能加",
  "permission.deny": "拒绝规则，如 write(**/.env)；各层累加",
  "permission.builtinDeny":
    "内置 deny 表（.git/** 写、.ssh/** 读写）：true 全部启用，false 全部移除，数组 = 要移除的规则原文；只认用户级",
  "permission.autoModel": "auto 模式分类器的模型 provider/model；不写时用当前会话模型；只认用户级",
  "permission.autoSafeCommands": "auto 模式安全名单追加（词前缀或含 * 的通配）；只认用户级",
  compaction: "自动压缩",
  "compaction.enabled": "上下文接近上限时自动压缩",
  "compaction.reserveTokens": "为回复预留的 token；剩余不足时触发压缩",
  "compaction.keepRecentTokens": "压缩时原样保留的最近消息 token",
  "compaction.prune": "档一裁剪（旧工具结果换成占位）；只认用户级（第五波 W5-H1 起生效）",
  "compaction.prune.keepResults": "保留最近 N 个工具结果不裁",
  "compaction.prune.clearAtLeast":
    "一次至少能省这么多 token 才裁（避免频繁打断缓存）；auto = max(20000, 0.1 × 上下文预算)",
  "compaction.pruneExclude": "不被档一裁剪的工具名；只认用户级（第五波 W5-H1 起生效）",
  retry: "请求失败重试",
  "retry.enabled": "可重试的错误（限流、服务端错误、连接中断等）自动重试",
  "retry.maxRetries": "最多重试次数",
  "retry.baseDelayMs": "首次重试等待（毫秒，指数退避；有 Retry-After 时按它）",
  "retry.maxDelayMs": "单次等待上限（毫秒）",
  tools: "内置工具",
  "tools.preset":
    "工具预设：default（七个工具，含 todo；Node ≥ 25 时另加 codemode）、minimal、codemode-only、coordinator；codemode 是 codemode-only 的旧名；项目级只能更严",
  "tools.default":
    "在预设上微调：+name 加、-name 去，不带前缀的名字整组替换预设的内置工具；只认用户级",
  "tools.maxToolResultChars": "单条工具结果进上下文的字符上限，超出保留首尾",
  "tools.bashTimeoutMs": "bash 缺省超时（毫秒，单次调用可覆盖，最大 600000）",
  "tools.disabled": "禁用的工具名；各层累加",
  codemode: "codemode：模型写脚本批量调用工具（docs/codemode.md）",
  "codemode.mode":
    "off | on | only；不写时跟随预设：default → on（Node ≥ 25；Node 22 / 24 → off）、codemode-only → only、minimal / coordinator → off；项目级只接受 off",
  "codemode.inlineBudget": "only 模式在描述里内联工具声明的预算（估算 token），超出只列名字",
  "codemode.requireStrict": "true：运行时 Node 不隔离网络（Node 22 / 24）时直接禁用 codemode",
  hooks: "Hook 设置（Hook 本身写在 hooks.json）",
  "hooks.timeoutMs": "单个 Hook 命令的缺省超时（毫秒）",
  ui: "终端界面",
  "ui.theme": "配色主题：dark、light，或 auto（按 COLORFGBG 猜，不发终端查询，猜不出用 dark）",
  "ui.markdown": "按 Markdown 渲染回复",
  "ui.showThinking": "思考内容的显示方式",
  "ui.tuiMode": "终端界面形态（目前只有 regular）",
  "ui.quietStartup": "启动画面详略",
  "ui.ascii":
    "ASCII 字形（> * L、+ - |）；不写时自动检测：区域设置不含 UTF-8、TERM=linux、旧 conhost 时开启；AMA_ASCII=1/0 覆盖",
  "ui.compact": "消息区块间不空行、启动头不画框",
  "ui.animation": "false：运行中 spinner 静止，只在秒数变化时重绘",
  "ui.restoreOnCancel":
    "运行中 Esc 中断、本回合还没有任何回复或工具调用时，撤回该回合并把原消息放回输入框",
  "ui.statusLine":
    "底部信息行：full 两行（速率行 + 状态行），compact 一行；运行时 Ctrl+G 或 /statusline 切换（第五波 W5-A 起生效）",
  skills: "Skill",
  "skills.dirs": "追加的 Skill 目录；各层累加",
  cache: "提示缓存；整段只认用户级",
  request: "模型请求；整段只认用户级 / profile",
  "request.idleTimeoutMs":
    "流空闲超时（毫秒）：等响应头或两块数据之间超过即判卡住并按可重试错误重试；0 关闭；AMA_IDLE_TIMEOUT_MS 覆盖",
  "cache.warming": "保温：off 关闭，streaming 生成期间保温，idle 空闲时也保温",
  "cache.retention": "缓存时长档：none、short、long（供应商支持时）",
  "cache.minSavingsUsd": "保温的最低期望节省（美元）",
  "cache.missNotices": "在消息区提示缓存未命中与上下文余量",
  "cache.warmSubagents": "子会话（task）也保温",
  checkpoints: "检查点：回滚代码用的文件备份（docs/sessions.md「检查点与文件备份」）",
  "checkpoints.mode":
    "tools：跟踪 edit / write 改过的文件；shadow-git：另用影子 git 快照整个工作目录，bash 等直接改动也能回滚（需要 git，大目录自动降级为 tools）；off：关闭；AMA_CHECKPOINTS 覆盖；项目级只接受 off",
  "checkpoints.maxFileBytes":
    "单个文件的备份上限（字节），超出不备份、回滚时报告无法恢复；项目级只能调小",
  "checkpoints.keep": "可回滚的最近检查点数，更早的不再列为回滚点；只认用户级 / profile",
  sandbox: '操作系统级沙箱（docs/sandbox.md）；只认用户级 / profile，项目级只接受 network: "deny"',
  "sandbox.enabled":
    "auto：探测到可用的 macOS sandbox-exec / Linux bwrap、unshare 就用（codemode 子进程拒绝网络与写入；Node 22 / 24 上 codemode 因此网络隔离）；off：不用；AMA_SANDBOX=off 覆盖",
  "sandbox.bash":
    "auto：bash 经 sandbox-exec / bwrap 运行（unshare 不算），写入只限工作区、临时目录、输出目录与 sandbox.writable，default 模式下沙箱内命令免审批；off：不用；只认用户级 / profile",
  "sandbox.network":
    "bash 沙箱里的网络：deny 拒绝（沙箱内免审批的前提）；allow 允许联网但写入仍受限、照常审批；项目级只能设 deny",
  "sandbox.writable": "bash 沙箱追加的可写目录（绝对路径或 ~/…）；只认用户级 / profile",
  // [W5-C0] 第五波（docs/wave5-plan.md）；括号里是起生效的批次
  images: "图像输入；只认用户级（第五波 W5-I 起生效）",
  "images.resize":
    "auto：图片超过端点上限时用系统工具（sips / magick）缩放，找不到工具按原规则拒绝；off：从不缩放",
  plan: "Plan 模式（第五波 W5-F 起生效）",
  "plan.bash":
    "plan 模式下的 bash：readonly 只读命令放行其余拒绝，ask 其余询问，deny 全拒；项目级只能更严",
  "plan.directory": "计划文件目录（必须在项目根之内，否则回落缺省）；只认用户级",
  "plan.unattended":
    "无人值守（-p、RPC 未声明 plans 能力）时：stop 落盘计划后停下等人审批，approve 自动批准执行；只认用户级",
  "plan.model": "规划用模型 provider/model[@channel]：进入 plan 时切换、批准时切回；只认用户级",
  "plan.thinkingLevel": "规划时的思考强度；只认用户级",
  agents:
    "外部 Agent（claude / codex / ACP）与子 Agent 类型；agents.<id> 设单个 Agent 的 maxConcurrent / maxMode / model / env.passthrough；只认用户级（第五波 W5-E / W5-G 起生效）",
  "agents.maxConcurrent": "外部 Agent 的总并发",
  "agents.sessionBudgetUsd": "本会话外部 Agent 的美元预算",
  "agents.dirs": "追加的子 Agent 定义目录（*.md）；各层累加",
  subagents: "ama 自己的 task 子会话；只认用户级（第五波 W5-G 起生效）",
  "subagents.maxConcurrent": "同时运行的子会话数",
  "subagents.maxPending": "排队上限，超出时 task 报错",
  "subagents.defaultModel": "子会话缺省模型 provider/model[@channel]",
  models: "模型别名；只认用户级（第五波 W5-G 起生效）",
  "models.aliases": "子 Agent 定义里 model: fast / strong 指向的模型",
  "models.aliases.fast": "fast 别名的模型 provider/model[@channel]",
  "models.aliases.strong": "strong 别名的模型 provider/model[@channel]",
  fallbackModel:
    "回退模型 provider/model[@channel]：可重试错误用尽或过载时切换重试一次，下一回合回主模型；只认用户级（第五波 W5-H2 起生效）",
  limits:
    "会话预算，到限结束本次运行（-p 退出码 8）；--max-turns / --max-cost 覆盖；只认用户级（第五波 W5-H2 起生效）",
  "limits.maxTurns": "一次运行最多回合数",
  "limits.maxCostUsd": "一次运行的美元上限",
  reminders: "附在对话尾部的提醒（不改缓存前缀）；项目级可设（第五波 W5-H2 起生效）",
  "reminders.todo": "todo 有未完成项且多回合未更新时复述",
  "reminders.fileChanges": "读过的文件被外部改动时列出",
  "reminders.contextPressure": "上下文用量到 70% / 85% 时各提醒一次",
  "reminders.budget": "预算剩余不足 20% 时提醒",
  todo: "todo 工具；只认用户级（第五波 W5-F / W5-H2 起生效）",
  "todo.reminder": "连续 N 回合未更新且有未完成项时提醒复述；0 关闭",
});

/** 叶子路径（段落不算）。 */
export function documentedLeaves(): string[] {
  const keys = Object.keys(CONFIG_KEY_DOCS);
  return keys.filter((key) => !keys.some((other) => other.startsWith(`${key}.`)));
}

/** 键路径的缺省值（DISPLAY_DEFAULTS 里取；没有返回 undefined）。 */
export function defaultFor(path: string): unknown {
  let node: unknown = DISPLAY_DEFAULTS;
  for (const key of path.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
