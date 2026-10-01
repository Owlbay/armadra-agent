/**
 * B2 测试辅助：桩注册表、桩工具、放行权限管线 / Hook 分派器。[B2]
 *
 * 只依赖 B0 契约类型；B1 / B3 / B5 的实现就绪后，集成测试换成真实现即可。
 */

import type {
  ApiImplementation,
  ApiKeyResolution,
  Model,
  ModelLookup,
  ProviderData,
  ProviderRegistryApi,
} from "../../ai/types.js";
import type {
  HookDispatcherApi,
  HookEvent,
  HookEventPayload,
  HookOutcome,
  HookOutput,
} from "../../hooks/types.js";
import type {
  PermissionCheckInput,
  PermissionMode,
  PermissionPipelineApi,
  PermissionVerdict,
  Rule,
} from "../../permissions/types.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../../tools/types.js";

export function fakeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "echo",
    name: "Fake Echo",
    provider: "fake",
    api: "fake",
    input: ["text"],
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}

export function stubRegistry(models: Model[], apis: ApiImplementation[]): ProviderRegistryApi {
  const providers = new Map<string, ProviderData>();
  for (const model of models) {
    const existing = providers.get(model.provider);
    if (existing !== undefined) existing.models.push(model);
    else {
      providers.set(model.provider, {
        id: model.provider,
        name: model.provider,
        api: model.api,
        baseUrl: "http://fake.invalid",
        envKeys: [],
        models: [model],
        requiresApiKey: false,
        builtin: false,
      });
    }
  }
  return {
    list: () => [...providers.values()],
    get: (id) => providers.get(id),
    findModel(ref): ModelLookup {
      const [provider, id] = ref.includes("/") ? ref.split("/", 2) : [undefined, ref];
      const found = models.find(
        (m) => m.id === id && (provider === undefined || m.provider === provider),
      );
      if (found === undefined) {
        return {
          ok: false,
          reason: "not_found",
          candidates: models.map((m) => `${m.provider}/${m.id}`),
        };
      }
      return { ok: true, model: found, provider: providers.get(found.provider) as ProviderData };
    },
    resolveApiKey: async (): Promise<ApiKeyResolution> => ({ apiKey: "test-key", source: "none" }),
    getApi: (api) => apis.find((impl) => impl.id === api),
  };
}

export interface StubToolOptions {
  name: string;
  permission?: ToolDefinition["permission"];
  executionMode?: ToolDefinition["executionMode"];
  run?(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
  properties?: Record<string, { type: "string" | "number" | "boolean" | "integer" }>;
  required?: string[];
}

export function stubTool(options: StubToolOptions): ToolDefinition<Record<string, unknown>> {
  const tool: ToolDefinition<Record<string, unknown>> = {
    name: options.name,
    description: `${options.name} test tool`,
    parameters: {
      type: "object",
      properties: options.properties ?? {},
      required: options.required ?? [],
    },
    permission: options.permission ?? "read",
    async execute(input, ctx) {
      if (options.run !== undefined) return options.run(input, ctx);
      return { content: `${options.name} ok` };
    },
  };
  return options.executionMode === undefined
    ? tool
    : { ...tool, executionMode: options.executionMode };
}

/** 中断友好的等待：signal abort 时立即返回。 */
export function waitOrAbort(ms: number, signal: AbortSignal): Promise<"done" | "aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("aborted");
    const timer = setTimeout(() => resolve("done"), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve("aborted");
      },
      { once: true },
    );
  });
}

/** 放行管线；`decide` 可覆盖单次决定。 */
export function stubPermission(
  decide?: (input: PermissionCheckInput) => PermissionVerdict | undefined,
): PermissionPipelineApi & { remembered: string[] } {
  let mode: PermissionMode = "default";
  const remembered: string[] = [];
  const rules: Rule[] = [];
  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next;
    },
    rules,
    check(input) {
      return decide?.(input) ?? { decision: "allow", step: "mode" };
    },
    rememberForSession(toolName) {
      remembered.push(toolName);
    },
    remembered,
  };
}

export function emptyOutcome(output: HookOutput = {}): HookOutcome {
  const outcome: HookOutcome = {
    hasUpdatedInput: output.updatedInput !== undefined,
    stop: output.continue === false,
    suppressOutput: false,
    results: [],
    warnings: [],
  };
  if (output.decision !== undefined) outcome.decision = output.decision;
  if (output.reason !== undefined) outcome.reason = output.reason;
  if (output.updatedInput !== undefined) outcome.updatedInput = output.updatedInput;
  if (output.updatedPrompt !== undefined) outcome.updatedPrompt = output.updatedPrompt;
  if (output.additionalContext !== undefined) outcome.additionalContext = output.additionalContext;
  if (output.customInstructions !== undefined)
    outcome.customInstructions = output.customInstructions;
  return outcome;
}

/** 进程内 Hook 分派器桩：按事件给出固定 / 计算出的输出，记录调用。 */
export function stubHooks(
  handlers: Partial<Record<HookEvent, (payload: HookEventPayload) => HookOutput | undefined>>,
): HookDispatcherApi & { calls: { event: HookEvent; payload: HookEventPayload }[] } {
  const calls: { event: HookEvent; payload: HookEventPayload }[] = [];
  return {
    calls,
    has: (event) => handlers[event] !== undefined,
    async run(event, payload) {
      calls.push({ event, payload });
      const output = handlers[event]?.(payload) ?? {};
      const outcome = emptyOutcome(output);
      outcome.results.push({
        event,
        command: `stub:${event}`,
        source: "sdk",
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
        stdout: JSON.stringify(output),
        stderr: "",
        output,
      });
      return outcome;
    },
    list: () =>
      (Object.keys(handlers) as HookEvent[]).map((event) => ({
        event,
        command: `stub:${event}`,
        source: "sdk" as const,
      })),
  };
}
