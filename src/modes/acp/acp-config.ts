/**
 * `ama --mode acp` 的会话配置项与命令表（docs/acp-plan.md §1.6、D8、D9）。[ACP-C0 建壳，ACP-D 实现]
 *
 * - `buildConfigOptions`：`mode`（select，category `mode`，值是 ama 的权限模式，与 `modes` 同一状态）、
 *   `model`（select，category `model`，按供应商分组，值 `provider/model-id`）与 `thinking`（select，
 *   category `thought_level`，只列当前模型支持的级别）；没有 boolean 项。规范：Agent 给了 `configOptions`，
 *   客户端 SHOULD 用它代替 `modes`（Zed 给了就不再看 `modes`），所以模式也必须在这里；`modes` 照给，留给
 *   只认 `modes` 的客户端。`mode` 的设置由服务端处理（按会话记、只对前台会话生效），不经 `applyConfigOption`。
 *   模型清单与 TUI `/model` 的「已配置」视图同一口径（`catalogItems`）：只列有 key、OAuth 已登录或本地的
 *   供应商，`models.enabled` 设置时只列清单内的；`fake` 按 `hideFakeProvider` 规则藏起；当前模型总在列。
 *   判断有没有 key 要异步解析，所以先 `await prepareConfigOptions(providers)` 缓存各供应商的可用状态，
 *   之后 `buildConfigOptions` 同步取（映射器的 `extras()` 是同步的）。没准备过时只列本地供应商与当前模型。
 * - `applyConfigOption`：`session/set_config_option` → `setModel()` / `setThinkingLevel()`；未知 id、
 *   非字符串值、找不到的模型、不认识的级别回 invalid params。
 * - `availableCommands`：skills → `skill:<name>`，提示模板 → `<name>`（`argumentHint` → `input.hint`）。
 *   内置斜杠命令（`/new`、`/compact`…）在 ACP 下不执行，不列。
 */

import type { AgentSession } from "../../agent/types.js";
import { formatModelRef } from "../../ai/providers/channels.js";
import { providerAccess, type ProviderAccess } from "../../ai/providers/model-visibility.js";
import {
  clampThinkingLevel,
  getSupportedLevels,
  isThinkingLevel,
  THINKING_LEVELS,
} from "../../ai/thinking.js";
import type { ModelThinkingLevel, ProviderRegistryApi } from "../../ai/types.js";
import { hideFakeProvider } from "../../cli/fake-visibility.js";
import type { LoadedResources } from "../../cli/runtime.js";
import {
  RPC_ERRORS,
  type AcpAvailableCommand,
  type AcpConfigSelectGroup,
  type AcpSessionConfigOption,
  type AcpSetConfigOptionParams,
} from "../../drivers/acp/types.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { AmaError } from "../../errors.js";
import { msg } from "../../i18n/index.js";
import { catalogItems, type CatalogProvider } from "../interactive/model-items.js";
import type { PermissionMode } from "../../permissions/types.js";
import { permissionModes } from "./acp-events.js";

/** 配置项 id（机器字段，不翻译）。 */
export const CONFIG_IDS = { mode: "mode", model: "model", thinking: "thinking" } as const;

/** 各注册表上次解析出的供应商可用状态（providerId → access）。 */
const accessCache = new WeakMap<ProviderRegistryApi, Map<string, ProviderAccess>>();

/**
 * 解析各供应商的可用状态并缓存（读 key / OAuth，毫秒级）；开会话前调一次，登录后再调一次可刷新。
 * 缓存挂在传入的注册表上，`buildConfigOptions` 须传同一个对象。
 */
export async function prepareConfigOptions(providers: ProviderRegistryApi): Promise<void> {
  const access = new Map<string, ProviderAccess>();
  for (const provider of providers.list())
    access.set(provider.id, await providerAccess(providers, provider));
  accessCache.set(providers, access);
}

export interface ConfigOptionsExtras {
  /** `models.enabled`（用户级清单）；不给或空表示不限。 */
  enabled?: readonly string[] | undefined;
  /** 这个会话的权限模式（服务端按会话记）；不给时取 `session.state.permissionMode`。 */
  mode?: PermissionMode | undefined;
}

export function buildConfigOptions(
  session: AgentSession,
  providers: ProviderRegistryApi,
  env: NodeJS.ProcessEnv,
  extras: ConfigOptionsExtras = {},
): AcpSessionConfigOption[] {
  const m = msg().acp.config;
  const current =
    session.state.model === undefined ? undefined : formatModelRef(session.state.model);
  const known = accessCache.get(providers);
  const catalog: CatalogProvider[] = hideFakeProvider(providers, env)
    .list()
    .map((provider) => ({
      provider,
      access: known?.get(provider.id) ?? (provider.requiresApiKey ? "none" : "local"),
    }));
  const items = catalogItems(
    { providers: catalog },
    { view: "configured", enabled: extras.enabled, current, hints: false },
  );
  // 按供应商重新分组（`catalogItems` 的组标题带可用状态，当前模型另成一组）
  const groups = new Map<string, AcpConfigSelectGroup>();
  for (const item of items) {
    const providerId = item.value.slice(0, item.value.indexOf("/"));
    let group = groups.get(providerId);
    if (group === undefined) {
      group = {
        group: providerId,
        name: providers.get(providerId)?.name ?? providerId,
        options: [],
      };
      groups.set(providerId, group);
    }
    if (group.options.some((o) => o.value === item.value)) continue;
    group.options.push({
      value: item.value,
      name: item.label,
      ...(item.description !== undefined ? { description: item.description } : {}),
    });
  }
  const modes = permissionModes(extras.mode ?? session.state.permissionMode);
  const options: AcpSessionConfigOption[] = [
    {
      id: CONFIG_IDS.mode,
      name: m.mode,
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map(({ id, name, description }) => ({
        value: id,
        name,
        description,
      })),
    },
  ];
  if (current !== undefined)
    options.push({
      id: CONFIG_IDS.model,
      name: m.model,
      category: "model",
      type: "select",
      currentValue: current,
      options: [...groups.values()],
    });
  const lookup = current === undefined ? undefined : providers.findModel(current);
  const model = lookup?.ok === true ? lookup.model : undefined;
  const levels = model === undefined ? [...THINKING_LEVELS] : getSupportedLevels(model);
  const level = session.state.thinkingLevel;
  options.push({
    id: CONFIG_IDS.thinking,
    name: m.thinking,
    category: "thought_level",
    type: "select",
    currentValue:
      model === undefined || levels.includes(level) ? level : clampThinkingLevel(model, level),
    options: levels.map((value) => ({ value, name: m.levels[value] })),
  });
  return options;
}

/** 未知 id / value → RpcError invalidParams。 */
export async function applyConfigOption(
  session: AgentSession,
  params: AcpSetConfigOptionParams,
): Promise<void> {
  const m = msg().acp.config;
  const value: unknown = (params as { value?: unknown }).value;
  switch (params.configId) {
    case CONFIG_IDS.model:
      if (typeof value !== "string" || value === "")
        throw new RpcError(
          RPC_ERRORS.invalidParams,
          m.invalidValue(params.configId, String(value)),
        );
      try {
        await session.setModel(value);
      } catch (error) {
        if (error instanceof AmaError && error.code === "model_not_found")
          throw new RpcError(RPC_ERRORS.invalidParams, m.unknownModel(value));
        throw error;
      }
      return;
    case CONFIG_IDS.thinking:
      if (!isThinkingLevel(value))
        throw new RpcError(
          RPC_ERRORS.invalidParams,
          m.invalidValue(params.configId, String(value)),
        );
      if (value !== session.state.thinkingLevel)
        session.setThinkingLevel(value as ModelThinkingLevel);
      return;
    default:
      throw new RpcError(
        RPC_ERRORS.invalidParams,
        msg().acp.core.unknownConfigOption(String(params.configId)),
      );
  }
}

export function availableCommands(resources: LoadedResources): AcpAvailableCommand[] {
  const commands: AcpAvailableCommand[] = resources.skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
  }));
  for (const prompt of resources.prompts)
    commands.push({
      name: prompt.name,
      description: prompt.description ?? "",
      ...(prompt.argumentHint !== undefined ? { input: { hint: prompt.argumentHint } } : {}),
    });
  return commands;
}
