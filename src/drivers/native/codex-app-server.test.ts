import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryTransport, readRecording, replayPeer, spawnRecorder } from "../test-support.js";
import type { DriverEvent, DriverPermissionRequest, DriverPromptHooks } from "../types.js";
import { CodexAppServerDriver } from "./codex-app-server.js";
import { codexPolicy } from "./codex-normalize.js";

const candidate = { kind: "codex-app-server" as const, program: "codex", args: ["app-server"] };

function replay(name: string) {
  const peer = replayPeer(readRecording(`codex/${name}`));
  const rec = spawnRecorder(() => memoryTransport((i, o) => peer.serve(i, o)));
  const driver = new CodexAppServerDriver("codex", candidate, {
    spawn: rec.spawn,
    cancelGraceMs: 50,
  });
  return { peer, rec, driver };
}

const open = (
  driver: CodexAppServerDriver,
  extra: Partial<Parameters<CodexAppServerDriver["open"]>[0]> = {},
) =>
  driver.open({
    cwd: "/work",
    mode: "default",
    env: {},
    signal: new AbortController().signal,
    ...extra,
  });

function hooks(
  events: DriverEvent[],
  answer: DriverPromptHooks["onPermission"] = async () => ({ outcome: "cancelled" }),
): DriverPromptHooks {
  return { onEvent: (e) => events.push(e), onPermission: answer };
}

describe("codexPolicy", () => {
  it("模式 → approvalPolicy + sandbox；从不 danger-full-access；无人值守 never", () => {
    expect(codexPolicy("plan", false)).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(codexPolicy("default", false)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(codexPolicy("auto-edit", false)).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    expect(codexPolicy("auto", false)).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(codexPolicy("full-auto", false).sandbox).toBe("workspace-write");
    expect(codexPolicy("auto", true).approvalPolicy).toBe("never");
  });
});

describe("CodexAppServerDriver（录制回放）", () => {
  it("一轮：thread/start → 文本增量 / 思考 / 用量 → end_turn；线上不写 jsonrpc 字段", async () => {
    const { peer, rec, driver } = replay("turn-basic.jsonl");
    const session = await open(driver);
    expect(rec.specs[0]!.args).toEqual(["app-server"]);
    expect(session.sessionId).toBe("019a0000-0000-7000-8000-000000000001");
    const events: DriverEvent[] = [];
    const result = await session.prompt([{ type: "text", text: "say OK" }], hooks(events));
    expect(result).toMatchObject({
      stopReason: "end_turn",
      finalText: "OK",
      // Codex 的 inputTokens 含缓存（totalTokens = input + output）：ama 的 input 去掉缓存部分
      usage: { input: 200, output: 10, cacheRead: 1000 },
    });
    expect(events.map((e) => e.type)).toEqual([
      "thought_delta",
      "message_delta",
      "message_delta",
      "usage",
    ]);
    expect(events.at(-1)).toMatchObject({ contextTokens: 1210, contextWindow: 272000 });
    expect(
      rec
        .last()!
        .wire.filter((w) => w.dir === "in")
        .every((w) => !("jsonrpc" in w.msg)),
    ).toBe(true);
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("命令审批：acceptForSession；工具与计划事件；用量按 total 差值", async () => {
    const { peer, driver } = replay("approval-command.jsonl");
    const session = await open(driver, { mode: "auto" });
    const requests: DriverPermissionRequest[] = [];
    const events: DriverEvent[] = [];
    const result = await session.prompt(
      [{ type: "text", text: "run tests" }],
      hooks(events, async (req) => {
        requests.push(req);
        return { outcome: "selected", optionId: "acceptForSession" };
      }),
    );
    expect(requests[0]).toEqual({
      toolCall: {
        title: "$ pnpm test",
        kind: "execute",
        locations: ["/work"],
        inputSummary: "pnpm test — needs network",
      },
      options: [
        { optionId: "accept", kind: "allow_once" },
        { optionId: "acceptForSession", kind: "allow_always" },
        { optionId: "decline", kind: "reject_once" },
      ],
    });
    expect(result).toMatchObject({
      finalText: "Tests pass.",
      toolSummary: ["✓ execute $ pnpm test"],
      usage: { input: 210, output: 40, cacheRead: 50 },
    });
    expect(events.find((e) => e.type === "plan")).toEqual({
      type: "plan",
      entries: [{ content: "run tests", status: "completed" }],
    });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("文件修改审批：路径来自先前的 item/started；decline → 条目失败、无文件", async () => {
    const { peer, driver } = replay("approval-file-decline.jsonl");
    const session = await open(driver);
    let seen: DriverPermissionRequest | undefined;
    const result = await session.prompt(
      [{ type: "text", text: "edit" }],
      hooks([], async (req) => {
        seen = req;
        return { outcome: "selected", optionId: "decline" };
      }),
    );
    expect(seen?.toolCall).toMatchObject({ kind: "edit", locations: ["/work/a.ts"] });
    expect(result).toMatchObject({ filesTouched: [], toolSummary: ["✗ edit edit /work/a.ts"] });
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("中断：挂起的审批回 cancel，turn/interrupt，interrupted → cancelled", async () => {
    const { peer, driver } = replay("interrupt.jsonl");
    const session = await open(driver);
    const result = await session.prompt(
      [{ type: "text", text: "slow" }],
      hooks(
        [],
        (_req, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => resolve({ outcome: "cancelled" }));
            void session.cancel();
          }),
      ),
    );
    expect(result.stopReason).toBe("cancelled");
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });

  it("续接 thread/resume（excludeTurns）；requestUserInput 不代答", async () => {
    const { peer, driver } = replay("user-input.jsonl");
    const session = await open(driver, { resume: "t-old", mode: "plan", unattended: true });
    expect(session.sessionId).toBe("t-old");
    const events: DriverEvent[] = [];
    let asked = false;
    const result = await session.prompt(
      [{ type: "text", text: "go" }],
      hooks(events, async () => {
        asked = true;
        return { outcome: "selected", optionId: "accept" };
      }),
    );
    expect(asked).toBe(false);
    expect(events.some((e) => e.type === "notice" && e.text.includes("不代答"))).toBe(true);
    expect(result.finalText).toBe("Which option do you want?");
    expect(peer.mismatches).toEqual([]);
    await session.close();
  });
});

describe("Codex app-server schema 黄金文件", () => {
  const shapes = JSON.parse(
    readFileSync(
      new URL("../../../test/fixtures/drivers/codex-schema/shapes.json", import.meta.url),
      "utf8",
    ),
  ) as {
    objects: Record<string, { properties: string[]; required: string[] }>;
    definitions: Record<string, { enum?: string[]; properties?: string[] }>;
    methods: Record<string, { method: string; present: boolean }[]>;
    threadItemTypes: string[];
  };

  it("驱动用到的方法都在", () => {
    for (const list of Object.values(shapes.methods))
      for (const m of list) expect(m.present, m.method).toBe(true);
  });

  it("驱动发出的字段与枚举值都在 schema 里", () => {
    const has = (type: string, ...fields: string[]) =>
      expect(shapes.objects[type]!.properties).toEqual(expect.arrayContaining(fields));
    has("InitializeParams", "clientInfo", "capabilities");
    has("ThreadStartParams", "cwd", "approvalPolicy", "sandbox", "model");
    has("ThreadResumeParams", "threadId", "excludeTurns", "cwd", "approvalPolicy", "sandbox");
    has("TurnStartParams", "threadId", "input");
    has("TurnSteerParams", "threadId", "input", "expectedTurnId");
    has("TurnInterruptParams", "threadId", "turnId");
    has("CommandExecutionRequestApprovalParams", "itemId", "command", "cwd", "reason");
    has("FileChangeRequestApprovalParams", "itemId", "reason");
    has("PermissionsRequestApprovalResponse", "permissions", "scope");
    has("McpServerElicitationRequestResponse", "action", "content", "_meta");
    has("ThreadTokenUsageUpdatedNotification", "tokenUsage");
    has("AgentMessageDeltaNotification", "itemId", "delta");
    for (const p of ["untrusted", "on-request", "never"])
      expect(shapes.definitions["AskForApproval"]!.enum).toContain(p);
    for (const s of ["read-only", "workspace-write"])
      expect(shapes.definitions["SandboxMode"]!.enum).toContain(s);
    for (const d of ["accept", "acceptForSession", "decline", "cancel"]) {
      expect(shapes.definitions["CommandExecutionApprovalDecision"]!.enum).toContain(d);
      expect(shapes.definitions["FileChangeApprovalDecision"]!.enum).toContain(d);
    }
    expect(shapes.definitions["TurnStatus"]!.enum).toEqual(
      expect.arrayContaining(["completed", "interrupted", "failed"]),
    );
    expect(shapes.definitions["TokenUsageBreakdown"]!.properties).toEqual(
      expect.arrayContaining(["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens"]),
    );
    expect(shapes.threadItemTypes).toEqual(
      expect.arrayContaining([
        "agentMessage",
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "webSearch",
      ]),
    );
  });
});
