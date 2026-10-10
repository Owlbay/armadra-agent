/**
 * 内置驱动表（数据，docs/history/wave5-plan.md §5.1 catalog.ts，D14）。[W5-E]
 *
 * agentId → 候选链；按 D14 的优先级排：原生 ACP > 已装 ACP 适配器 > 原生结构化协议 > 一次性打印。
 * 探测时取第一个已安装的候选。`verified` 是实测过的版本区间：越界仍可用，但发一条 warn 提示
 * （R3：Claude stream-json 不是公开接口、Codex app-server 标 experimental）。没有实测过的
 * ACP Agent 不写 `verified`，`/agents` 标「未验证」。
 *
 * `runner: acp:<program>` 时先按程序名找本表里的 ACP 候选（拿到参数与模式映射），找不到就以
 * 无参数的通用 ACP 启动。
 */

import type { PermissionMode } from "../permissions/types.js";
import type { DriverCapabilities, DriverKind } from "./types.js";

export type CandidateKind = Exclude<DriverKind, "host">;

export interface CatalogCandidate {
  kind: CandidateKind;
  program: string;
  args: readonly string[];
  /** `--version` 以外的版本参数。 */
  versionArgs?: readonly string[];
  /** 实测过的版本区间（`>=x.y.z <x.y.z`）。 */
  verified?: string;
  /** ama 模式 → 该 Agent 的 ACP 模式 id（`session/set_mode`）；缺省按同名匹配。 */
  modes?: Partial<Record<PermissionMode, string>>;
  permissions?: DriverCapabilities["permissions"];
  usage?: DriverCapabilities["usage"];
  /** `session/prompt` 答复的 usage 是会话累计（缺省按本回合）。 */
  acpUsage?: "session";
  /** 一次性打印模式的方言。 */
  oneshot?: "claude" | "codex" | "gemini";
}

export interface CatalogEntry {
  agentId: string;
  label: string;
  candidates: readonly CatalogCandidate[];
}

const ALL_MODES: readonly PermissionMode[] = [
  "plan",
  "allowlist",
  "default",
  "auto-edit",
  "auto",
  "full-auto",
];

/**
 * 模式 id 与 ama 不同名的 ACP Agent 的映射（2026-10 实测）。没有映射时 ama 会留在 Agent 自己的当前模式，
 * 而它可能比 ama 宽（如用户把 Claude 的缺省设成 bypassPermissions），所以已知的 Agent 一律写全。
 * 从不映射到放开全部权限的模式（Claude `bypassPermissions`、Codex `agent-full-access`、Copilot autopilot）。
 */
const CLAUDE_ACP_MODES: Partial<Record<PermissionMode, string>> = {
  plan: "plan",
  default: "default",
  "auto-edit": "acceptEdits",
  auto: "auto",
  "full-auto": "auto",
};
/** codex-acp：`read-only` 是只读沙箱、写操作要审批（等同 app-server 的 on-request / read-only）。 */
const CODEX_ACP_MODES: Partial<Record<PermissionMode, string>> = {
  plan: "read-only",
  default: "read-only",
  "auto-edit": "workspace-write",
  auto: "agent",
  "full-auto": "agent",
};
const COPILOT_MODE = "https://agentclientprotocol.com/protocol/session-modes#";
const COPILOT_MODES: Partial<Record<PermissionMode, string>> = {
  plan: `${COPILOT_MODE}plan`,
  default: `${COPILOT_MODE}agent`,
  "auto-edit": `${COPILOT_MODE}agent`,
  auto: `${COPILOT_MODE}agent`,
  "full-auto": `${COPILOT_MODE}agent`,
};

/** Cursor CLI（官方 ACP 文档）：`plan` 只读，`agent` 是完整工具权限（需要授权的仍发 request_permission）。 */
const CURSOR_MODES: Partial<Record<PermissionMode, string>> = {
  plan: "plan",
  default: "agent",
  "auto-edit": "agent",
  auto: "agent",
  "full-auto": "agent",
};

export const DRIVER_CATALOG: readonly CatalogEntry[] = [
  {
    agentId: "claude",
    label: "Claude Code",
    candidates: [
      {
        kind: "acp-adapter",
        program: "claude-agent-acp",
        args: [],
        verified: ">=0.89.0 <1.0.0",
        usage: "usd",
        modes: CLAUDE_ACP_MODES,
      },
      {
        kind: "claude-stream",
        program: "claude",
        args: [],
        verified: ">=2.1.0 <3.0.0",
        usage: "usd",
      },
      { kind: "oneshot", program: "claude", args: [], oneshot: "claude", usage: "usd" },
    ],
  },
  {
    agentId: "codex",
    label: "Codex",
    candidates: [
      {
        kind: "acp-adapter",
        program: "codex-acp",
        args: [],
        verified: ">=2.2.0 <3.0.0",
        usage: "tokens",
        modes: CODEX_ACP_MODES,
      },
      {
        kind: "codex-app-server",
        program: "codex",
        args: ["app-server"],
        verified: ">=0.160.0 <0.200.0",
        usage: "tokens",
      },
      { kind: "oneshot", program: "codex", args: [], oneshot: "codex", usage: "tokens" },
    ],
  },
  {
    agentId: "gemini",
    label: "Gemini CLI",
    candidates: [
      { kind: "acp", program: "gemini", args: ["--acp"], usage: "tokens" },
      { kind: "oneshot", program: "gemini", args: [], oneshot: "gemini", usage: "tokens" },
    ],
  },
  {
    agentId: "qwen",
    label: "Qwen Code",
    // #11887：0.23.x 受限模式下不发 request_permission 就执行 → 只在 plan 下用
    candidates: [{ kind: "acp", program: "qwen", args: ["--acp"], permissions: "unreliable" }],
  },
  {
    agentId: "kimi",
    label: "Kimi Code",
    candidates: [{ kind: "acp", program: "kimi", args: ["acp"] }],
  },
  {
    agentId: "opencode",
    label: "OpenCode",
    candidates: [{ kind: "acp", program: "opencode", args: ["acp"], verified: ">=1.18.0 <2.0.0" }],
  },
  {
    agentId: "copilot",
    label: "GitHub Copilot CLI",
    candidates: [
      {
        kind: "acp",
        program: "copilot",
        args: ["--acp", "--stdio"],
        verified: ">=1.0.95 <2.0.0",
        usage: "requests",
        modes: COPILOT_MODES,
        acpUsage: "session",
      },
    ],
  },
  {
    agentId: "pi",
    label: "Pi",
    // 社区 ACP 适配器 pi-acp 不发 request_permission（pi 没有审批通道），会让工具不经人直接执行，不收录
    candidates: [
      {
        kind: "pi-rpc",
        program: "pi",
        args: ["--mode", "rpc"],
        verified: ">=1.1.0 <2.0.0",
        usage: "usd",
      },
    ],
  },
  {
    agentId: "cursor",
    label: "Cursor CLI",
    // 未实测（本机未装）：按官方文档 `cursor-agent acp`，模式 agent / plan / ask；`cursor/ask_question`
    // 等阻塞式扩展方法 ama 不实现（回 method not found，不代答）
    candidates: [{ kind: "acp", program: "cursor-agent", args: ["acp"], modes: CURSOR_MODES }],
  },
  {
    agentId: "goose",
    label: "Goose",
    candidates: [{ kind: "acp", program: "goose", args: ["acp"] }],
  },
  {
    agentId: "ama",
    label: "ama",
    candidates: [
      {
        kind: "acp",
        program: "ama",
        args: ["--mode", "acp"],
        usage: "usd",
        modes: Object.fromEntries(ALL_MODES.map((m) => [m, m])),
      },
    ],
  },
];

export function catalogEntry(agentId: string): CatalogEntry | undefined {
  return DRIVER_CATALOG.find((entry) => entry.agentId === agentId);
}

/**
 * `runner` 规格 → 候选链：`claude` / `codex` 与表中 id 走表；`acp:<program>` 取表里同程序名的
 * ACP 候选，否则通用 ACP（无参数）。
 */
export function candidatesFor(
  spec: string,
): { agentId: string; candidates: CatalogCandidate[] } | undefined {
  if (spec.startsWith("acp:")) {
    const program = spec.slice(4).trim();
    if (program === "") return undefined;
    for (const entry of DRIVER_CATALOG)
      for (const c of entry.candidates)
        if (c.kind === "acp" && c.program === program) return { agentId: spec, candidates: [c] };
    return { agentId: spec, candidates: [{ kind: "acp", program, args: [] }] };
  }
  const entry = catalogEntry(spec);
  return entry === undefined ? undefined : { agentId: spec, candidates: [...entry.candidates] };
}

/** 候选的静态能力（ACP 的会话能力要到 initialize 才知道，这里取保守值）。 */
export function candidateCapabilities(c: CatalogCandidate): DriverCapabilities {
  switch (c.kind) {
    case "claude-stream":
      return {
        resume: "resume",
        list: false,
        permissions: "interactive",
        steer: true,
        modes: ALL_MODES,
        usage: "usd",
        images: true,
      };
    case "codex-app-server":
      return {
        resume: "resume",
        list: true,
        permissions: "interactive",
        steer: true,
        modes: ALL_MODES,
        usage: "tokens",
        images: false,
      };
    case "pi-rpc":
      // 审批经 ama 加载的审批闸扩展交给人（native/pi-gate.ts）
      return {
        resume: "resume",
        list: false,
        permissions: "interactive",
        steer: true,
        modes: ALL_MODES,
        usage: "usd",
        images: true,
      };
    case "oneshot":
      return {
        resume: c.oneshot === "gemini" ? "none" : "resume",
        list: false,
        permissions: "none",
        steer: false,
        // 不能审批：只在只读任务下用（§5.1 oneshot）
        modes: ["plan"],
        usage: c.usage ?? "none",
        images: false,
      };
    default:
      return {
        resume: "resume",
        list: true,
        permissions: c.permissions ?? "interactive",
        steer: false,
        modes: c.permissions === "unreliable" ? ["plan"] : ALL_MODES,
        usage: c.usage ?? "tokens",
        images: false,
      };
  }
}
