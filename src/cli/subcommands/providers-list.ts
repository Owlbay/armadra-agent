/**
 * `ama providers list|channels|remove`（docs/providers.md「一键接入」）：供应商 → 渠道 → 模型数与 key 来源
 * （从不显示 key）；remove 删配置条目（先备份）与 auth.json 里该供应商及其渠道的 key。
 */

import { apiShortName } from "../../ai/providers/channels.js";
import type { ProviderRegistryApi } from "../../ai/types.js";
import { classifyKeyValue, readAuthFile, removeAuthKey } from "../../config/auth-file.js";
import type { ProviderConfig } from "../../config/types.js";
import { writeConfigFile } from "../../config/write.js";
import { ExitCode } from "../exit-codes.js";
import { buildRegistry } from "./context.js";
import { userConfig, type Ctx } from "./providers.js";
import { msg } from "../../i18n/index.js";

async function keySource(
  registry: ProviderRegistryApi,
  config: ProviderConfig | undefined,
  id: string,
  channel?: string,
): Promise<string> {
  const m = msg().subcommands.providersList;
  const raw = channel !== undefined ? config?.channels?.[channel]?.apiKey : config?.apiKey;
  if (raw !== undefined) {
    const kind = classifyKeyValue(raw);
    return kind === "env-ref" ? raw : kind === "command" ? m.keyCommand : m.keyLiteral;
  }
  const resolved = await registry.resolveApiKey(id, channel);
  if (resolved.apiKey === undefined) return channel !== undefined ? m.keySameProvider : m.keyNone;
  if (channel !== undefined && resolved.source !== "auth-file") return m.keySameProvider;
  return resolved.source === "env"
    ? m.keyEnv(resolved.origin ?? "")
    : resolved.source === "auth-file"
      ? "auth.json"
      : resolved.source;
}

export async function listProviders(ctx: Ctx): Promise<number> {
  const registry = await buildRegistry(ctx.level, ctx.io, ctx.deps);
  const config = userConfig(ctx.level);
  let shown = 0;
  for (const provider of registry.list()) {
    const own = config.providers?.[provider.id];
    if (
      own === undefined &&
      !(
        provider.builtin &&
        provider.requiresApiKey &&
        (await registry.resolveApiKey(provider.id)).apiKey !== undefined
      )
    )
      continue;
    shown++;
    const channels = provider.channels ?? [];
    const t = msg().subcommands.providersList;
    ctx.io.stdout(
      t.providerLine({
        id: provider.id,
        builtin: provider.builtin,
        channels: channels.length,
        endpoint: `${provider.api} ${provider.baseUrl}`,
        models: provider.models.length,
        key: await keySource(registry, own, provider.id),
      }),
    );
    for (const c of channels) {
      const count = provider.models.filter((m) => m.channels?.includes(c.name)).length;
      const key = await keySource(registry, own, provider.id, c.name);
      ctx.io.stdout(t.channelLine(c.name, c.api, c.baseUrl, count, key));
    }
  }
  if (shown === 0) ctx.io.stdout(msg().subcommands.providersList.noProviders);
  return ExitCode.Ok;
}

export async function listChannels(ctx: Ctx, id: string): Promise<number> {
  const registry = await buildRegistry(ctx.level, ctx.io, ctx.deps);
  const provider = registry.get(id);
  if (provider === undefined) {
    ctx.io.stderr(msg().subcommands.common.providerNotFound(id));
    return ExitCode.NoModel;
  }
  const own = userConfig(ctx.level).providers?.[id];
  if (provider.channels === undefined) {
    ctx.io.stdout(
      msg().subcommands.providersList.singleChannel(
        id,
        provider.api,
        provider.baseUrl,
        provider.models.length,
      ),
    );
    return ExitCode.Ok;
  }
  for (const c of provider.channels) {
    const models = provider.models.filter((m) => m.channels?.includes(c.name));
    ctx.io.stdout(
      msg().subcommands.providersList.channelDetail({
        name: c.name,
        isDefault: c.name === provider.defaultChannel,
        short: apiShortName(c.api),
        api: c.api,
        url: c.baseUrl,
        key: await keySource(registry, own, id, c.name),
        models: models.map((m) => m.id),
      }),
    );
  }
  return ExitCode.Ok;
}

export function removeProvider(ctx: Ctx, id: string): number {
  const config = userConfig(ctx.level);
  const had = config.providers?.[id] !== undefined;
  if (had) {
    delete config.providers?.[id];
    writeConfigFile(ctx.level.userConfigPath, config, { backup: true });
    ctx.io.stdout(msg().subcommands.providersList.removed(ctx.level.userConfigPath, id));
  }
  const auth = readAuthFile(ctx.level.authFile).file;
  let keys = 0;
  for (const name of Object.keys(auth.providers))
    if (name === id || name.startsWith(`${id}@`))
      keys += removeAuthKey(ctx.level.authFile, name) ? 1 : 0;
  if (keys > 0)
    ctx.io.stdout(msg().subcommands.providersList.keysRemoved(ctx.level.authFile, id, keys));
  if (!had && keys === 0) {
    ctx.io.stderr(msg().subcommands.providersList.noSuchProvider(id));
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}
