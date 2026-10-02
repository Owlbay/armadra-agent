/**
 * 记忆的组装（docs/wave6-plan.md §3、D8、D9、D11、D12）。[W6-M]
 *
 * - 开关：独立终端看合并后的 `memory.enabled`（用户级 / profile.config；项目级只能设 false；`--memory` /
 *   `--no-memory`；`AMA_MEMORY=0|1` 经 bootstrap 并入命令行覆盖，命令行优先）。缺省关闭：不建运行期、不读盘、
 *   不注册工具、不渲染节。
 * - 嵌入宿主（有 profile；SDK `createAgentSession`）：只看 `profile.memory = { enabled, dir }`，作用域只有
 *   `workspace`（= dir），不读用户级；合并配置里显式 `memory.enabled: false`（项目级、`--no-memory`、
 *   `AMA_MEMORY=0`）仍可关掉。
 * - 项目作用域要求项目已受信任，否则跳过（`/memory` 提示）。
 * - 系统节：会话开始（新会话）渲染一次；resume / fork 沿用会话里已有的 `memory` 节；压缩结束后重渲染
 *   （`compaction_end` 时 `updateSystem`，压缩本就是前缀重置点）；`/memory reload` 显式重渲染。
 */

import type { AgentSessionImpl } from "../agent/session.js";
import type { AgentSession } from "../agent/types.js";
import type { AmaConfig, ProfileMemoryOptions } from "../config/types.js";
import { AmaError } from "../errors.js";
import { projectRootOf, standaloneRoots, type ScopeRoots } from "../memory/paths.js";
import { MemoryRuntime, type SkippedScope } from "../memory/runtime.js";
import { DEFAULT_MEMORY_LIMITS, MemoryStore } from "../memory/store.js";
import { replaySystem } from "../session/projection.js";
import type { SessionManager } from "../session/manager.js";

/** `AMA_MEMORY=0|1`（也认 true / false / on / off）；其它值或未设 → undefined。 */
export function memoryEnvOverride(
  env: Readonly<Record<string, string | undefined>>,
): boolean | undefined {
  const raw = env["AMA_MEMORY"]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return undefined;
}

export interface MemorySetupInput {
  config: Pick<AmaConfig, "memory">;
  cwd: string;
  dataDir: string;
  trusted: boolean;
  /** 嵌入宿主：profile 存在（或 SDK 会话）时给出（`memory` 可缺省 = 禁用）。 */
  embedded?: { memory?: ProfileMemoryOptions | undefined } | undefined;
  today?(): string;
}

/** 按配置建运行期；关闭时返回 undefined（什么都不做）。 */
export function resolveMemory(input: MemorySetupInput): MemoryRuntime | undefined {
  const config = input.config.memory ?? {};
  const limits = {
    indexMaxBytes: config.indexMaxBytes ?? DEFAULT_MEMORY_LIMITS.indexMaxBytes,
    fileMaxBytes: config.fileMaxBytes ?? DEFAULT_MEMORY_LIMITS.fileMaxBytes,
    maxFiles: config.maxFiles ?? DEFAULT_MEMORY_LIMITS.maxFiles,
  };
  const subagents = config.subagents ?? "read";
  const storeOptions = input.today === undefined ? {} : { today: input.today };
  if (input.embedded !== undefined) {
    const profile = input.embedded.memory;
    if (profile?.enabled !== true || config.enabled === false) return undefined;
    if (profile.dir === undefined || profile.dir === "")
      throw new AmaError(
        "invalid_arguments",
        "memory.enabled is true but memory.dir is missing (embedded hosts must give a per-workspace directory)",
      );
    const roots: ScopeRoots = { workspace: profile.dir };
    return new MemoryRuntime(new MemoryStore(roots, limits, storeOptions), {
      subagents,
      embedded: true,
    });
  }
  if (config.enabled !== true) return undefined;
  const scopes = config.scopes ?? ["user", "project"];
  const skipped: SkippedScope[] = [];
  let projectRoot: string | undefined;
  if (scopes.includes("project")) {
    if (input.trusted) projectRoot = projectRootOf(input.cwd);
    else skipped.push({ scope: "project", reason: "untrusted" });
  }
  const roots = standaloneRoots({
    dataDir: input.dataDir,
    projectRoot,
    user: scopes.includes("user"),
  });
  const store = new MemoryStore(roots, limits, {
    ...storeOptions,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });
  return new MemoryRuntime(store, {
    subagents,
    embedded: false,
    skipped,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });
}

const attached = new WeakMap<AgentSession, MemoryRuntime>();

/** 会话的记忆运行期（未开启 → undefined）。 */
export function memoryOf(session: AgentSession): MemoryRuntime | undefined {
  return attached.get(session);
}

/**
 * 新会话渲染当前索引；会话里已有 system 状态（resume / fork）时沿用其中的 `memory` 节（可能没有）。
 * 未开启 → undefined。
 */
export function initialMemorySection(
  runtime: MemoryRuntime | undefined,
  manager: Pick<SessionManager, "branch">,
): string | undefined {
  if (runtime === undefined) return undefined;
  const messages = manager
    .branch()
    .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
  const existing = replaySystem(messages);
  if (existing !== undefined) return existing.sections["memory"];
  return runtime.renderSection();
}

/** 把 `memory` 节并进静态系统输入（未开启时原样返回同一对象，字节不变）。 */
export function withMemorySection<T extends { memory?: string }>(
  system: T,
  runtime: MemoryRuntime | undefined,
  manager: Pick<SessionManager, "branch">,
): T {
  const section = initialMemorySection(runtime, manager);
  return section === undefined ? system : { ...system, memory: section };
}

/** 会话建好后：登记运行期，压缩结束后重渲染 `memory` 节。 */
export function attachMemory(session: AgentSessionImpl, runtime: MemoryRuntime | undefined): void {
  if (runtime === undefined) return;
  attached.set(session, runtime);
  session.subscribe((event) => {
    if (event.type === "compaction_end" && event.result !== undefined)
      session.updateSystem({ memory: runtime.renderSection() ?? "" });
  });
}

/**
 * `/memory reload`：按磁盘重渲染 `memory` 节。返回 undefined = 会话未开启记忆；`changed` = 节有变化
 * （下次请求产生一条 system 补丁，缓存前缀断一次）。
 */
export function reloadMemorySection(session: AgentSession): { changed: boolean } | undefined {
  const runtime = memoryOf(session);
  if (runtime === undefined) return undefined;
  const impl = session as AgentSessionImpl;
  const before = impl.childBase().system?.memory;
  const next = runtime.renderSection() ?? "";
  if ((before ?? "") === next) return { changed: false };
  impl.updateSystem({ memory: next });
  return { changed: true };
}
