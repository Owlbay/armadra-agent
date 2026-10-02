import { describe, expect, it } from "vitest";
import type { AgentSession, EnqueueOptions, PromptOptions } from "../agent/types.js";
import { createDefaultApiRegistry } from "../ai/apis/api.js";
import { ProviderRegistry } from "../ai/providers/registry.js";
import type { ProviderRegistryApi } from "../ai/types.js";
import { SessionManager } from "../session/manager.js";
import { emptyArgs } from "./args.js";
import { noModelGuidance } from "./default-model.js";
import type { RuntimeDeps } from "./deps.js";
import { defaultSendUser, resolveModel } from "./startup-steps.js";

function fakeSession(isStreaming: boolean): {
  session: AgentSession;
  calls: { method: "steer" | "prompt"; text: string; options: unknown }[];
} {
  const calls: { method: "steer" | "prompt"; text: string; options: unknown }[] = [];
  const session = {
    state: { isStreaming },
    async steer(text: string, options?: EnqueueOptions) {
      calls.push({ method: "steer", text, options });
    },
    async prompt(text: string, options?: PromptOptions) {
      calls.push({ method: "prompt", text, options });
      return "started" as const;
    },
  };
  return { session: session as unknown as AgentSession, calls };
}

describe("defaultSendUser：宿主 sendUser 的缺省实现", () => {
  it("运行中：steer 入队并带上 origin", async () => {
    const { session, calls } = fakeSession(true);
    expect(await defaultSendUser(session, "hi", "armadra")).toBe("queued");
    expect(calls).toEqual([{ method: "steer", text: "hi", options: { origin: "armadra" } }]);
  });

  it("空闲：prompt 立即开始，streamingBehavior 为 steer 并带上 origin", async () => {
    const { session, calls } = fakeSession(false);
    expect(await defaultSendUser(session, "hi", "host")).toBe("started");
    expect(calls).toEqual([
      { method: "prompt", text: "hi", options: { streamingBehavior: "steer", origin: "host" } },
    ]);
  });

  it("未给 origin 时不写 origin 键", async () => {
    const { session, calls } = fakeSession(true);
    await defaultSendUser(session, "hi");
    expect(calls[0]?.options).toEqual({});
  });
});

describe("零配置选模型：选择器不列 fake，没有模型时给出引导", () => {
  const registry = () =>
    new ProviderRegistry({
      apis: createDefaultApiRegistry(),
      keys: { env: {}, useEnv: true, userAuthFile: null },
    });

  async function pickWith(env: Record<string, string>) {
    const seen: string[][] = [];
    const reasons: string[] = [];
    const deps = {
      ui: {
        pickModel: async (providers: ProviderRegistryApi, reason: string) => {
          seen.push(providers.list().map((p) => p.id));
          reasons.push(reason);
          return undefined;
        },
      },
    } as unknown as RuntimeDeps;
    const error = await resolveModel(
      emptyArgs(),
      registry(),
      SessionManager.inMemory("/w"),
      undefined,
      deps,
      true,
      env,
    ).catch((e: unknown) => e);
    return { seen, reasons, error: error as Error };
  }

  it("选择器拿到的注册表不含 fake；AMA_SHOW_FAKE=1 时含", async () => {
    const hidden = await pickWith({});
    expect(hidden.seen[0]).not.toContain("fake");
    expect(hidden.seen[0]).toContain("anthropic");
    const shown = await pickWith({ AMA_SHOW_FAKE: "1" });
    expect(shown.seen[0]).toContain("fake");
  });

  it("引导写明环境变量、ama auth set 与 ama providers add", async () => {
    const { reasons, error } = await pickWith({});
    expect(reasons[0]).toContain("ANTHROPIC_API_KEY");
    expect(reasons[0]).toContain("ama auth set <provider>");
    expect(reasons[0]).toContain("ama providers add <id> --base-url <url>");
    expect(error.message).toBe(reasons[0]);
    expect(noModelGuidance(registry())).toBe(reasons[0]);
  });
});
