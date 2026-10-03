/**
 * `ama models enable <ref…>` / `ama models disable <ref…>` / `ama models list --enabled`：编辑与查看用户级
 * `models.enabled`（模型选择器的显式清单，见 ai/providers/model-visibility.ts）。
 *
 * 写回走 config/edit.ts（重读目标文件、校验、`.bak` 备份、原子写）；`models` 只认用户级，没有 `--project`。
 * 引用要是 `provider/model[@channel]` 或 `provider/*`，供应商必须存在；模型不在模型表里只警告（中转站与
 * 订阅后端接受任意 id）。清单移空时删掉这个键。
 */

import {
  accessReady,
  addEnabled,
  enabledList,
  providerAccess,
  removeEnabled,
  splitEnabledRef,
} from "../../ai/providers/model-visibility.js";
import { readSnapshot, setConfigValue, type ConfigLayerInput } from "../../config/edit.js";
import { MODELS_ENABLED_REF } from "../../config/types-w5.js";
import { msg } from "../../i18n/index.js";
import { UsageError } from "../args.js";
import { ExitCode } from "../exit-codes.js";
import type { ModelsAction, ModelsActionContext } from "./models.js";

function layerInput(ctx: ModelsActionContext): ConfigLayerInput {
  const input: ConfigLayerInput = {
    configDir: ctx.level.configDir,
    cwd: ctx.io.cwd,
    env: ctx.io.env,
  };
  if (ctx.level.profile !== undefined) {
    input.profile = { config: ctx.level.profile.config };
    input.hasProfile = true;
  }
  return input;
}

/** 校验引用；供应商不存在返回退出码，模型不在表里只警告。 */
function checkRefs(ctx: ModelsActionContext, refs: readonly string[]): number | undefined {
  const m = msg().subcommands.modelsEnabled;
  for (const ref of refs) {
    const parts = splitEnabledRef(ref);
    if (!MODELS_ENABLED_REF.test(ref) || parts === undefined) throw new UsageError(m.badRef(ref));
    const provider = ctx.registry.get(parts.provider);
    if (provider === undefined) {
      ctx.io.stderr(msg().subcommands.common.providerNotFound(parts.provider));
      return ExitCode.NoModel;
    }
    if (
      parts.model !== "*" &&
      provider.models.length > 0 &&
      !provider.models.some((model) => model.id === parts.model)
    )
      ctx.io.stderr(m.unknownModel(ref));
  }
  return undefined;
}

function userList(input: ConfigLayerInput): readonly string[] | undefined {
  return enabledList(readSnapshot(input).user?.models?.enabled);
}

async function enable(ctx: ModelsActionContext): Promise<number> {
  const m = msg().subcommands.modelsEnabled;
  const refs = [...new Set(ctx.args)];
  const bad = checkRefs(ctx, refs);
  if (bad !== undefined) return bad;
  const input = layerInput(ctx);
  const current = userList(input);
  const fresh = refs.filter((ref) => !(current ?? []).includes(ref));
  if (fresh.length === 0) {
    ctx.io.stdout(m.alreadyListed(refs.join(", ")));
    return ExitCode.Ok;
  }
  const result = setConfigValue({
    ...input,
    scope: "user",
    key: "models.enabled",
    value: addEnabled(current, fresh),
  });
  ctx.io.stdout(m.added(fresh.join(", "), result.path));
  return ExitCode.Ok;
}

async function disable(ctx: ModelsActionContext): Promise<number> {
  const m = msg().subcommands.modelsEnabled;
  const refs = [...new Set(ctx.args)];
  for (const ref of refs) if (!MODELS_ENABLED_REF.test(ref)) throw new UsageError(m.badRef(ref));
  const input = layerInput(ctx);
  const current = userList(input) ?? [];
  const listed = refs.filter((ref) => current.includes(ref));
  const missing = refs.filter((ref) => !current.includes(ref));
  if (missing.length > 0) ctx.io.stderr(m.notListed(missing.join(", ")));
  if (listed.length === 0) return missing.length > 0 ? ExitCode.RuntimeError : ExitCode.Ok;
  const next = removeEnabled(current, listed);
  const result = setConfigValue({ ...input, scope: "user", key: "models.enabled", value: next });
  ctx.io.stdout(
    next === undefined ? m.cleared(result.path) : m.removed(listed.join(", "), result.path),
  );
  return ExitCode.Ok;
}

/** `ama models list --enabled`：清单（及各项供应商状态）；没设清单时列出选择器缺省显示的模型。 */
export async function listEnabled(ctx: ModelsActionContext): Promise<number> {
  const m = msg().subcommands.modelsEnabled;
  const labels = msg().panels.model;
  const list = enabledList(ctx.level.merged.config.models?.enabled);
  const status = async (providerId: string): Promise<string> => {
    const provider = ctx.registry.get(providerId);
    if (provider === undefined) return "?";
    const access = await providerAccess(ctx.registry, provider);
    return access === "none" ? labels.noKey : labels[access];
  };
  if (list !== undefined) {
    ctx.io.stdout(m.listHeader(ctx.level.userConfigPath));
    for (const ref of list) {
      const parts = splitEnabledRef(ref);
      const provider = parts === undefined ? undefined : ctx.registry.get(parts.provider);
      const known =
        parts === undefined ||
        parts.model === "*" ||
        provider === undefined ||
        provider.models.length === 0 ||
        provider.models.some((model) => model.id === parts.model);
      const notes = [
        parts === undefined ? "?" : await status(parts.provider),
        ...(known ? [] : [m.notInTable]),
      ];
      ctx.io.stdout(`  ${ref}  ${notes.join(" · ")}\n`);
    }
    return ExitCode.Ok;
  }
  ctx.io.stdout(m.listUnset);
  let shown = 0;
  for (const provider of ctx.registry.list()) {
    const access = await providerAccess(ctx.registry, provider);
    if (!accessReady(access)) continue;
    const label = access === "none" ? labels.noKey : labels[access];
    for (const model of provider.models) {
      ctx.io.stdout(`  ${provider.id}/${model.id}  ${label}\n`);
      shown++;
    }
  }
  if (shown === 0) ctx.io.stdout(m.nothing);
  return ExitCode.Ok;
}

export const ENABLE_ACTION: ModelsAction = {
  usage: "ama models enable <provider/model[@channel]|provider/*>…",
  required: "<provider/model>",
  run: enable,
};

export const DISABLE_ACTION: ModelsAction = {
  usage: "ama models disable <provider/model[@channel]|provider/*>…",
  required: "<provider/model>",
  run: disable,
};
