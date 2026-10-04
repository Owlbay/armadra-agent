/**
 * `ama --mode acp` 的会话配置项与命令表（docs/acp-plan.md §1.6、D8、D9）。[ACP-C0 建壳，ACP-D 实现]
 *
 * - `buildConfigOptions`：`model`（select，按供应商分组）与 `thinking`（select，category `thought_level`）；
 * - `applyConfigOption`：`session/set_config_option` → `setModel()` / `setThinkingLevel()`，未知 id / value 回
 *   invalid params；
 * - `availableCommands`：skills（`skill:<name>`）与提示模板（`<name>`），不列内置斜杠命令。
 *
 * C0 只给空实现：没有配置项、没有命令，线上形状与之前相同。
 */

import type { AgentSession } from "../../agent/types.js";
import type { ProviderRegistryApi } from "../../ai/types.js";
import type { LoadedResources } from "../../cli/runtime.js";
import {
  RPC_ERRORS,
  type AcpAvailableCommand,
  type AcpSessionConfigOption,
  type AcpSetConfigOptionParams,
} from "../../drivers/acp/types.js";
import { RpcError } from "../../drivers/jsonrpc.js";
import { msg } from "../../i18n/index.js";

export function buildConfigOptions(
  _session: AgentSession,
  _providers: ProviderRegistryApi,
  _env: NodeJS.ProcessEnv,
): AcpSessionConfigOption[] {
  return [];
}

/** 未知 id / value → RpcError invalidParams。 */
export async function applyConfigOption(
  _session: AgentSession,
  params: AcpSetConfigOptionParams,
): Promise<void> {
  throw new RpcError(
    RPC_ERRORS.invalidParams,
    msg().acp.core.unknownConfigOption(String(params.configId)),
  );
}

export function availableCommands(_resources: LoadedResources): AcpAvailableCommand[] {
  return [];
}
