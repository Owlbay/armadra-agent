/**
 * 协议实现注册表（设计 §3.1）：按协议 id 懒加载实现模块。
 *
 * `get(id)` 同步返回一个包装实现：`stream()` 先同步做 key 预检（缺 key 同步抛
 * `AmaError{code:"no_api_key"}`），再在首次调用时 `import()` 真正的实现并转发事件。bundle 里
 * esbuild 把这些 `import()` 内联成同步 require，懒加载只在 ESM 产物里省启动时间。
 *
 * 内置四条协议（anthropic-messages、openai-completions、openai-responses、google-generative-ai）
 * 与 fake；新增协议在 `createDefaultApiRegistry()` 里加一条 `register({ id, load, detectCompat })`。
 */

import { AssistantEventStreamImpl } from "../event-stream.js";
import { errorText } from "../http.js";
import type {
  Api,
  ApiImplementation,
  AssistantEventStream,
  Model,
  ProviderData,
  StreamOptions,
  TranscriptContext,
} from "../types.js";
import { detectAnthropicCompat } from "./anthropic-request.js";
import { detectGoogleCompat } from "./google-request.js";
import { detectCompat as detectOpenAICompat } from "./openai-compat.js";
import { detectResponsesCompat } from "./openai-responses-request.js";
import { createOutput, requireApiKey } from "./shared.js";

export interface ApiEntry {
  readonly id: Api;
  load(): Promise<ApiImplementation>;
  /** 同步可用的 compat 推断（不必等实现模块加载）。 */
  detectCompat?(model: Model, provider: ProviderData): unknown;
}

function isImplementation(value: ApiEntry | ApiImplementation): value is ApiImplementation {
  return typeof (value as ApiImplementation).stream === "function";
}

function lazyImplementation(entry: ApiEntry): ApiImplementation {
  let loaded: Promise<ApiImplementation> | undefined;
  const impl: ApiImplementation = {
    id: entry.id,
    stream(model: Model, context: TranscriptContext, options: StreamOptions): AssistantEventStream {
      requireApiKey(model, options);
      const outer = new AssistantEventStreamImpl();
      loaded ??= entry.load();
      void loaded
        .then(async (inner) => {
          for await (const event of inner.stream(model, context, options)) outer.push(event);
          outer.end();
        })
        .catch((error: unknown) => {
          const message = outer.partial ?? createOutput(model);
          message.stopReason = options.signal.aborted ? "aborted" : "error";
          message.errorMessage = errorText(error);
          outer.push({
            type: "error",
            reason: options.signal.aborted ? "aborted" : "error",
            message,
          });
          outer.end();
        });
      return outer;
    },
  };
  if (entry.detectCompat) {
    const detect = entry.detectCompat.bind(entry);
    impl.detectCompat = (model, provider) => detect(model, provider);
  }
  return impl;
}

export class ApiRegistry {
  private readonly entries = new Map<Api, ApiImplementation>();

  /** 注册（同 id 覆盖）：可以是现成实现，也可以是懒加载条目。 */
  register(entry: ApiEntry | ApiImplementation): void {
    this.entries.set(entry.id, isImplementation(entry) ? entry : lazyImplementation(entry));
  }

  unregister(id: Api): boolean {
    return this.entries.delete(id);
  }

  get(id: Api): ApiImplementation | undefined {
    return this.entries.get(id);
  }

  has(id: Api): boolean {
    return this.entries.has(id);
  }

  ids(): Api[] {
    return [...this.entries.keys()];
  }
}

/** 内置协议 + fake。每次返回新实例（测试可自由覆盖）。 */
export function createDefaultApiRegistry(): ApiRegistry {
  const registry = new ApiRegistry();
  registry.register({
    id: "anthropic-messages",
    load: async () => (await import("./anthropic-messages.js")).anthropicMessagesApi,
    detectCompat: (model, provider) => detectAnthropicCompat(model, provider),
  });
  registry.register({
    id: "openai-completions",
    load: async () => (await import("./openai-completions.js")).openAICompletionsApi,
    detectCompat: (model, provider) => detectOpenAICompat(model, provider),
  });
  registry.register({
    id: "openai-responses",
    load: async () => (await import("./openai-responses.js")).openAIResponsesApi,
    detectCompat: (model, provider) => detectResponsesCompat(model, provider),
  });
  registry.register({
    id: "google-generative-ai",
    load: async () => (await import("./google-generative-ai.js")).googleGenerativeAiApi,
    detectCompat: (model, provider) => detectGoogleCompat(model, provider),
  });
  registry.register({
    id: "fake",
    load: async () => (await import("../fake/fake-provider.js")).fakeApi,
  });
  return registry;
}
