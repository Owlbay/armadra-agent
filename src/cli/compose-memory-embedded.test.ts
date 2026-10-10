/**
 * 嵌入宿主的记忆（docs/history/wave6-plan.md D11、§3.1）：profile / SDK 缺省禁用；开启必须给按工作空间隔离的 dir，
 * 只有 workspace 作用域、不读用户级；没有 dir 的 enabled: true 是配置错误。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../test/helpers/compose-harness.js";
import { createDefaultApiRegistry } from "../ai/apis/api.js";
import { FakeProvider } from "../ai/fake/fake-provider.js";
import type { SystemMessage } from "../ai/types.js";
import type { AgentSession } from "../agent/types.js";
import { MemoryStore } from "../memory/store.js";
import { createAgentSession } from "../sdk.js";
import { memoryOf } from "./compose-memory.js";

let h: ComposeHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function memorySection(session: AgentSession): string | undefined {
  const first = session.entries.find((e) => e.type === "message" && e.message.role === "system");
  return first?.type === "message"
    ? ((first.message as SystemMessage).sections["memory"] ?? undefined)
    : undefined;
}

describe("profile.memory", () => {
  it("有 profile 时缺省禁用（用户级 memory.enabled: true 也不开）", async () => {
    h = composeHarness([{ text: "a" }]);
    h.home.write("home/.config/ama/config.json", { version: 1, memory: { enabled: true } });
    const profile = h.home.write("profile.json", { version: 1 });
    const runtime = await h.boot(["--model", "fake/echo", "--profile", profile]);
    expect(runtime.tools.list()).not.toContain("memory");
    expect(memoryOf(runtime.session)).toBeUndefined();
    await runtime.dispose();
  });

  it("enabled + dir：只有 workspace 作用域，节里是 dir 的条目，不碰用户级目录", async () => {
    h = composeHarness([{ text: "a" }]);
    const dir = h.home.path("workspace-1/memory");
    await new MemoryStore({ workspace: dir }).create("/memories/workspace/w.md", "工作空间约定");
    h.home.write("home/.local/share/ama/memory/user/u.md", "用户级条目不该出现");
    const profile = h.home.write("profile.json", {
      version: 1,
      memory: { enabled: true, dir },
    });
    const runtime = await h.boot(["--model", "fake/echo", "--profile", profile, "--memory"]);
    await runtime.session.prompt("q");
    expect(memoryOf(runtime.session)?.scopes).toEqual(["workspace"]);
    const section = memorySection(runtime.session)!;
    expect(section).toContain("[w](/memories/workspace/w.md) — 工作空间约定");
    expect(section).not.toContain("u.md");
    expect(runtime.tools.active().map((t) => t.name)).toContain("memory");
    await runtime.dispose();
  });

  it("--no-memory 仍可关掉 profile 开启的记忆", async () => {
    h = composeHarness([{ text: "a" }]);
    const profile = h.home.write("profile.json", {
      version: 1,
      memory: { enabled: true, dir: h.home.path("ws") },
    });
    const runtime = await h.boot(["--model", "fake/echo", "--profile", profile, "--no-memory"]);
    expect(memoryOf(runtime.session)).toBeUndefined();
    await runtime.dispose();
  });

  it("enabled: true 没有 dir → 配置错误（退出码 3）", async () => {
    h = composeHarness([{ text: "a" }]);
    const profile = h.home.write("profile.json", { version: 1, memory: { enabled: true } });
    expect(await h.run(["-p", "--model", "fake/echo", "--profile", profile, "hi"])).toBe(3);
    expect(h.stderr()).toContain("memory.dir");
  });
});

describe("SDK createAgentSession({ memory })", () => {
  function apis() {
    const fake = new FakeProvider([{ text: "a" }]);
    const registry = createDefaultApiRegistry();
    registry.register(fake.api);
    return registry;
  }

  it("缺省不开（config.memory.enabled 也不开）；给 dir 只有 workspace；没 dir 报错", async () => {
    h = composeHarness();
    const base = {
      model: "fake/echo",
      apis: apis(),
      auth: { kind: "none" as const },
      cwd: h.home.cwd,
    };
    const off = await createAgentSession({ ...base, config: { memory: { enabled: true } } });
    expect(off.getTools().map((t) => t.name)).not.toContain("memory");
    await off.dispose();
    const dir = h.home.path("sdk-ws");
    const on = await createAgentSession({ ...base, memory: { enabled: true, dir } });
    expect(on.getTools().map((t) => t.name)).toContain("memory");
    expect(memoryOf(on)?.scopes).toEqual(["workspace"]);
    await on.prompt("hi");
    expect(memorySection(on)).toContain('<scope name="workspace">(empty)</scope>');
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
    await on.dispose();
    await expect(createAgentSession({ ...base, memory: { enabled: true } })).rejects.toThrow(
      "memory.dir is missing",
    );
  });
});
