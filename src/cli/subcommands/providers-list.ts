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

async function keySource(
  registry: ProviderRegistryApi,
  config: ProviderConfig | undefined,
  id: string,
  channel?: string,
): Promise<string> {
  const raw = channel !== undefined ? config?.channels?.[channel]?.apiKey : config?.apiKey;
  if (raw !== undefined) {
    const kind = classifyKeyValue(raw);
    return kind === "env-ref"
      ? raw
      : kind === "command"
        ? "!命令（config.json）"
        : "字面量（config.json）";
  }
  const resolved = await registry.resolveApiKey(id, channel);
  if (resolved.apiKey === undefined) return channel !== undefined ? "同供应商" : "无";
  if (channel !== undefined && resolved.source !== "auth-file") return "同供应商";
  return resolved.source === "env"
    ? `环境变量 ${resolved.origin ?? ""}`
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
    const kind = provider.builtin ? "内置" : "自定义";
    const channels = provider.channels ?? [];
    ctx.io.stdout(
      `${provider.id}  ${kind} · ${channels.length > 0 ? `${channels.length} 渠道` : `${provider.api} ${provider.baseUrl}`} · ` +
        `${provider.models.length} 模型 · key ${await keySource(registry, own, provider.id)}\n`,
    );
    for (const c of channels) {
      const count = provider.models.filter((m) => m.channels?.includes(c.name)).length;
      ctx.io.stdout(
        `  @${c.name}  ${c.api}  ${c.baseUrl}  ${count} 模型 · key ${await keySource(registry, own, provider.id, c.name)}\n`,
      );
    }
  }
  if (shown === 0) ctx.io.stdout(`没有配置供应商（ama providers add <id> --base-url <url>）\n`);
  return ExitCode.Ok;
}

export async function listChannels(ctx: Ctx, id: string): Promise<number> {
  const registry = await buildRegistry(ctx.level, ctx.io, ctx.deps);
  const provider = registry.get(id);
  if (provider === undefined) {
    ctx.io.stderr(`ama: 供应商不存在：${id}\n`);
    return ExitCode.NoModel;
  }
  const own = userConfig(ctx.level).providers?.[id];
  if (provider.channels === undefined) {
    ctx.io.stdout(
      `${id}：单渠道（${provider.api} ${provider.baseUrl}），${provider.models.length} 模型\n`,
    );
    return ExitCode.Ok;
  }
  for (const c of provider.channels) {
    const models = provider.models.filter((m) => m.channels?.includes(c.name));
    const mark = c.name === provider.defaultChannel ? "（缺省）" : "";
    ctx.io.stdout(
      `@${c.name}${mark}  ${apiShortName(c.api)}  ${c.api}  ${c.baseUrl}  key ${await keySource(registry, own, id, c.name)}\n` +
        `  ${models.length} 模型${models.length > 0 ? `：${models.map((m) => m.id).join(", ")}` : ""}\n`,
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
    ctx.io.stdout(`已从 ${ctx.level.userConfigPath} 删除 ${id}（原文件备份为 config.json.bak）\n`);
  }
  const auth = readAuthFile(ctx.level.authFile).file;
  let keys = 0;
  for (const name of Object.keys(auth.providers))
    if (name === id || name.startsWith(`${id}@`))
      keys += removeAuthKey(ctx.level.authFile, name) ? 1 : 0;
  if (keys > 0) ctx.io.stdout(`已删除 ${ctx.level.authFile} 里 ${id} 的 ${keys} 个 key\n`);
  if (!had && keys === 0) {
    ctx.io.stderr(`ama: 没有供应商 ${id}\n`);
    return ExitCode.RuntimeError;
  }
  return ExitCode.Ok;
}
