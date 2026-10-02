/**
 * 测试供应商 `fake` 的可见性：零配置的模型选择器、`ama doctor`、`ama models list`、`ama providers list`、
 * `ama config show` 缺省不列出它（实测零配置 TUI 的首项是 `fake › echo`，直接回车就用上了测试供应商）。
 *
 * - `AMA_SHOW_FAKE=1` 或设置了 `AMA_FAKE_SCRIPT` 时照常列出；
 * - 只藏 `list()`：`--model fake/…`、`findModel`、`resolveApiKey` 等显式引用不受影响。
 */

import { FAKE_SCRIPT_ENV } from "../ai/fake/fake-provider.js";
import type { ProviderRegistryApi } from "../ai/types.js";

export const SHOW_FAKE_ENV = "AMA_SHOW_FAKE";
export const FAKE_PROVIDER_ID = "fake";

export function fakeVisible(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SHOW_FAKE_ENV] === "1" || (env[FAKE_SCRIPT_ENV] ?? "") !== "";
}

/** 列表里藏起 fake 的注册表视图（其余方法原样转给原注册表）；可见时原样返回。 */
export function hideFakeProvider<T extends ProviderRegistryApi>(
  registry: T,
  env: Readonly<Record<string, string | undefined>>,
): T {
  if (fakeVisible(env)) return registry;
  return new Proxy(registry, {
    get(target, prop) {
      if (prop === "list")
        return () => target.list().filter((provider) => provider.id !== FAKE_PROVIDER_ID);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
}
