import { afterEach, describe, expect, it } from "vitest";
import { composeHarness, type ComposeHarness } from "../../../test/helpers/compose-harness.js";
import type { AgentSession } from "../../agent/types.js";
import { currentSession, switchSession } from "../../cli/compose-session.js";
import type { Runtime } from "../../cli/runtime.js";
import { setLocale } from "../../i18n/index.js";
import type { SelectItem } from "../../tui.js";
import { ALL_COMMANDS, keyHints, runInteractiveCommand, type CommandUi } from "./commands.js";
import { golden } from "./test-support.js";
import type { PickerSpec } from "./pickers.js";

let h: ComposeHarness;
let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  h?.cleanup();
});

/** 记录界面动作；pick 按队列作答（函数可看到 spec）。 */
function recordingUi(rt: Runtime, answers: ((spec: PickerSpec) => SelectItem | undefined)[] = []) {
  const notices: string[] = [];
  const picks: PickerSpec[] = [];
  const prompts: string[] = [];
  const state = { editor: "", reloads: 0, exit: undefined as number | undefined };
  const ui: CommandUi = {
    runtime: rt,
    session: () => currentSession(rt),
    switchSession: async (request) => {
      const next = await switchSession(rt, request);
      return next;
    },
    pick: async (spec) => {
      picks.push(spec);
      return answers.shift()?.(spec);
    },
    notice: (level, text) => notices.push(`${level}:${text}`),
    setEditorText: (text) => (state.editor = text),
    prompt: (text) => prompts.push(text),
    reload: () => state.reloads++,
    exit: (code) => (state.exit = code),
    now: () => Date.now(),
  };
  return { ui, notices, picks, prompts, state };
}

async function boot(script?: Parameters<typeof composeHarness>[0]): Promise<Runtime> {
  h = composeHarness(script, { stdinIsTTY: true, stdoutIsTTY: true });
  runtime = await h.boot(["--model", "fake/echo"]);
  return runtime;
}

const byValue = (value: string) => (spec: PickerSpec) => spec.items.find((i) => i.value === value);

describe("交互命令", () => {
  it("不是命令（普通文本、模板、/skill:）返回 false", async () => {
    const rt = await boot();
    const { ui } = recordingUi(rt);
    expect(await runInteractiveCommand("你好", ui)).toBe(false);
    expect(await runInteractiveCommand("/skill:none 参数", ui)).toBe(false);
    expect(await runInteractiveCommand("/unknown", ui)).toBe(false);
  });

  it("/help 追加 /tree、/permissions 与按键说明；完整命令表含两者", async () => {
    const rt = await boot();
    const { ui, notices } = recordingUi(rt);
    expect(await runInteractiveCommand("/help", ui)).toBe(true);
    expect(notices[0]).toContain("/model");
    expect(notices[0]).toContain("/tree  浏览会话树");
    expect(notices[0]).toContain(keyHints().split("\n")[0]);
    expect(ALL_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining(["tree", "permissions"]),
    );
  });

  it("/model 选择器不列测试供应商 fake（AMA_SHOW_FAKE=1 或 AMA_FAKE_SCRIPT 时照列）", async () => {
    const rt = await boot();
    const hidden = recordingUi(rt);
    await runInteractiveCommand("/model", { ...hidden.ui, env: {} });
    // 只剩置顶的当前模型（正在用的模型总是列出），fake 的其它模型不列
    expect(
      hidden.picks[0]?.items.filter((i) => i.value.startsWith("fake/")).map((i) => i.group),
    ).toEqual(["当前"]);
    const shown = recordingUi(rt);
    await runInteractiveCommand("/model", { ...shown.ui, env: { AMA_SHOW_FAKE: "1" } });
    expect(shown.picks[0]?.items.some((i) => i.value === "fake/echo")).toBe(true);
    expect(shown.picks[0]?.currentValue).toBe("fake/echo");
  });

  it("/model 无参数：选择器按供应商分组、预选当前模型，选中后切换", async () => {
    const rt = await boot();
    const { ui, picks, notices } = recordingUi(rt, [byValue("fake/reasoning")]);
    await runInteractiveCommand("/model", ui);
    expect(picks[0]?.selected).toBe("fake/echo");
    expect(picks[0]?.items.find((i) => i.value === "fake/echo")?.group).toBe("fake · 本地");
    expect(currentSession(rt).state.model).toEqual({ provider: "fake", id: "reasoning" });
    expect(notices).toContain("info:模型：fake/reasoning");
  });

  it("/permission、/thinking 无参数走选择器；取消不改", async () => {
    const rt = await boot();
    const { ui, picks } = recordingUi(rt, [byValue("auto-edit"), () => undefined, byValue("high")]);
    await runInteractiveCommand("/permission", ui);
    expect(currentSession(rt).state.permissionMode).toBe("auto-edit");
    await runInteractiveCommand("/thinking", ui);
    expect(picks[1]?.items[1]?.description).toBe("当前模型不支持思考");
    expect(picks[1]).toMatchObject({ numberKeys: true, filterable: false });
    expect(picks[1]?.footer).toContain("直接选");
    const before = currentSession(rt).state.thinkingLevel;
    expect(before).not.toBe("high");
    await runInteractiveCommand("/thinking", ui);
    expect(currentSession(rt).state.thinkingLevel).toBe("high");
  });

  it("/permission 选择器：标题权限模式、当前打勾、配置缺省标 Default；选中后提示显示名；参数可写显示名", async () => {
    const rt = await boot();
    const { ui, picks, notices } = recordingUi(rt, [byValue("auto")]);
    await runInteractiveCommand("/permission", ui);
    expect(picks[0]).toMatchObject({
      title: "权限模式",
      selected: "default",
      currentValue: "default",
      numberKeys: true,
    });
    expect(picks[0]?.items.find((i) => i.value === "default")).toMatchObject({
      label: "Manual",
      badge: "Default",
    });
    expect(picks[0]?.items.find((i) => i.value === "auto")?.badge).toBe("Recommended");
    expect(currentSession(rt).state.permissionMode).toBe("auto");
    expect(notices).toContain("info:权限模式：Auto");
    await runInteractiveCommand("/permission Accept edits", ui);
    expect(currentSession(rt).state.permissionMode).toBe("auto-edit");
    expect(notices.at(-1)).toBe("info:权限模式：Accept edits");
    await runInteractiveCommand("/permission yolo", ui);
    expect(notices.at(-1)).toMatch(/^error:权限模式应为 default \| auto-edit \| plan \| auto/);
  });

  it("/permissions 在 auto 下列出三层顺序与最近判定", async () => {
    const rt = await boot();
    const { ui, notices } = recordingUi(rt);
    currentSession(rt).setPermissionMode("auto");
    rt.permission.recordAutoDecision?.(
      "bash",
      { command: "ls -la" },
      {
        layer: "static",
        decision: "allow",
        reason: "every command is in the auto safe list",
      },
    );
    rt.permission.recordAutoDecision?.(
      "bash",
      { command: "node gen.js" },
      {
        layer: "classifier",
        decision: "allow",
        reason: "runs a generator",
        cached: true,
      },
    );
    await runInteractiveCommand("/permissions", ui);
    expect(notices[0]).toContain("权限模式：Auto（auto）");
    expect(notices[0]).toContain("模型分类器");
    expect(notices[0]).toContain("最近的 auto 判定（2）：");
    expect(notices[0]).toContain(
      "  静态判定  allow  bash ls -la — every command is in the auto safe list",
    );
    expect(notices[0]).toContain("  分类器  allow  bash node gen.js — runs a generator（缓存）");
  });

  it("/permissions 列出模式、判定顺序与内置规则", async () => {
    const rt = await boot();
    const { ui, notices } = recordingUi(rt);
    await runInteractiveCommand("/permissions", ui);
    expect(notices[0]).toContain("权限模式：Manual（default）");
    expect(notices[0]).toContain("判定顺序");
    expect(notices[0]).toContain("deny   write(**/.git/**)  [builtin]");
  });

  it("/tree：换叶子到选中消息之前，文本回填编辑器并重画；再发形成新分支", async () => {
    const rt = await boot([{ text: "一" }, { text: "二" }, { text: "三" }]);
    let session: AgentSession = currentSession(rt);
    await session.prompt("第一问");
    await session.prompt("第二问");
    const { ui, picks, state } = recordingUi(rt, [
      (spec) => spec.items.find((i) => i.label.includes("第二问")),
    ]);
    await runInteractiveCommand("/tree", ui);
    expect(picks[0]?.items.map((i) => i.label)).toEqual(["● 第一问", "● 第二问"]);
    expect(picks[0]?.selected).toBe(picks[0]?.items[1]?.value);
    expect(state.editor).toBe("第二问");
    expect(state.reloads).toBe(1);
    session = currentSession(rt);
    expect(session.messages.map((m) => m.role).filter((r) => r !== "system")).toEqual([
      "user",
      "assistant",
    ]);
    await session.prompt("第二问（改）");
    const again = recordingUi(rt, [() => undefined]);
    await runInteractiveCommand("/tree", again.ui);
    expect(again.picks[0]?.items.map((i) => i.label)).toEqual([
      "● 第一问",
      "  ○ 第二问",
      "  ● 第二问（改）",
    ]);
  });

  it("/fork 无参数：从选中消息之前分叉到新会话，文本回填；/resume 列出其它会话", async () => {
    const rt = await boot([{ text: "一" }, { text: "二" }]);
    const first = currentSession(rt);
    await first.prompt("第一问");
    await first.prompt("第二问");
    const firstId = first.state.sessionId;
    const { ui, state, notices } = recordingUi(rt, [
      (spec) => spec.items.find((i) => i.label.includes("第二问")),
      byValue(firstId),
    ]);
    await runInteractiveCommand("/fork", ui);
    const forked = currentSession(rt);
    expect(forked.state.sessionId).not.toBe(firstId);
    expect(forked.messages.map((m) => m.role).filter((r) => r !== "system")).toEqual([
      "user",
      "assistant",
    ]);
    expect(state.editor).toBe("第二问");
    expect(notices.at(-1)).toMatch(/^info:已分叉到新会话/);
    await runInteractiveCommand("/resume", ui);
    expect(currentSession(rt).state.sessionId).toBe(firstId);
  });

  it("没有可恢复的会话、没有消息时给提示；错误显示为 error；/exit 退出", async () => {
    const rt = await boot();
    const { ui, notices, state, picks } = recordingUi(rt);
    await runInteractiveCommand("/resume", ui);
    await runInteractiveCommand("/tree", ui);
    await runInteractiveCommand("/thinking bogus", ui);
    expect(picks).toHaveLength(0);
    expect(notices).toEqual([
      "info:本目录没有其它会话",
      "info:还没有用户消息",
      expect.stringMatching(/^error:思考级别应为/),
    ]);
    await runInteractiveCommand("/quit", ui);
    expect(state.exit).toBe(0);
  });
});

describe("/help（en）", () => {
  afterEach(() => setLocale("zh"));
  it("/help 全文", async () => {
    setLocale("en");
    const rt = await boot();
    const { ui, notices } = recordingUi(rt);
    expect(await runInteractiveCommand("/help", ui)).toBe(true);
    golden("en/help", `${notices[0]}\n`);
  });
});
