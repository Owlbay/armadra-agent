import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACP_METHODS } from "../../src/drivers/acp/types.js";
import {
  acpMethodDefs,
  acpWireErrors,
  assertAcpWire,
  readAcpWire,
  validateAcp,
  type AcpWireLine,
} from "./acp-schema.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/acp/", import.meta.url));

const rpc = (body: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: "2.0",
  ...body,
});
const update = (u: Record<string, unknown>) => ({ sessionId: "s1", update: u });

describe("[ACP-C0] schema 校验器（v1.24.1）", () => {
  it("四份黄金记录逐条通过（基线 0 失败）", () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));
    expect(files.sort()).toEqual([
      "driver-allow.jsonl",
      "driver-cancel.jsonl",
      "driver-reject.jsonl",
      "mode-prompt.jsonl",
    ]);
    for (const file of files) {
      const wire = readAcpWire(`${FIXTURES}${file}`);
      expect(wire.length).toBeGreaterThan(0);
      expect(acpWireErrors(wire), file).toEqual([]);
    }
  });

  it("ACP_METHODS 里的方法 schema 都有定义（扩展的 $/cancel_request 也在）", () => {
    const table = acpMethodDefs();
    for (const method of Object.values(ACP_METHODS)) expect(table.has(method), method).toBe(true);
    expect(table.get(ACP_METHODS.cancelRequest)).toEqual({
      notification: "CancelRequestNotification",
    });
    expect(table.get(ACP_METHODS.sessionSetConfigOption)).toEqual({
      request: "SetSessionConfigOptionRequest",
      response: "SetSessionConfigOptionResponse",
    });
    expect(table.get(ACP_METHODS.authenticate)).toEqual({
      request: "AuthenticateRequest",
      response: "AuthenticateResponse",
    });
  });

  it("allOf + properties 的判别（sessionUpdate）：变体内字段照样检查，未知变体拒绝", () => {
    expect(
      validateAcp(
        "SessionNotification",
        update({ sessionUpdate: "tool_call", toolCallId: "c1", title: "x" }),
      ),
    ).toEqual([]);
    expect(
      validateAcp("SessionNotification", update({ sessionUpdate: "tool_call", title: "x" })),
    ).not.toEqual([]);
    expect(
      validateAcp(
        "SessionNotification",
        update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "done" }),
      ),
    ).not.toEqual([]);
    expect(validateAcp("SessionNotification", update({ sessionUpdate: "nope", x: 1 }))).not.toEqual(
      [],
    );
    // 新增契约里的变体
    expect(
      validateAcp(
        "SessionNotification",
        update({
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "skill:x", description: "d", input: { hint: "path" } }],
        }),
      ),
    ).toEqual([]);
    expect(
      validateAcp(
        "SessionNotification",
        update({ sessionUpdate: "session_info_update", title: "t", updatedAt: "2026-10-04" }),
      ),
    ).toEqual([]);
    expect(
      validateAcp(
        "SessionNotification",
        update({
          sessionUpdate: "tool_call",
          toolCallId: "c2",
          title: "codemode › read",
          name: "read",
          _meta: { ama: { parentToolCallId: "c1" } },
        }),
      ),
    ).toEqual([]);
  });

  it("其它契约形状：terminal 认证方法、config option、$/cancel_request、错误码、stopReason", () => {
    const init = (authMethods: unknown[]) => ({ protocolVersion: 1, authMethods });
    expect(
      validateAcp(
        "InitializeResponse",
        init([{ type: "terminal", id: "api-key", name: "API key", args: ["auth", "set"] }]),
      ),
    ).toEqual([]);
    expect(validateAcp("InitializeResponse", init([{ type: "terminal", id: "x" }]))).not.toEqual(
      [],
    );
    // 规范的 anyOf 让坏 args 的 terminal 方法退成 agent 型而通过（ajv 结论相同）：形状要靠类型约束
    expect(
      validateAcp("InitializeResponse", init([{ type: "terminal", id: "x", name: "x", args: 1 }])),
    ).toEqual([]);
    expect(
      validateAcp("InitializeRequest", {
        protocolVersion: 1,
        clientCapabilities: { auth: { terminal: true }, session: { configOptions: {} } },
      }),
    ).toEqual([]);
    const select = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "a/b",
      options: [{ group: "a", name: "A", options: [{ value: "a/b", name: "B" }] }],
    };
    expect(validateAcp("SetSessionConfigOptionResponse", { configOptions: [select] })).toEqual([]);
    expect(
      validateAcp("SetSessionConfigOptionResponse", {
        configOptions: [{ ...select, type: "slider" }],
      }),
    ).not.toEqual([]);
    expect(
      validateAcp("SetSessionConfigOptionRequest", {
        sessionId: "s",
        configId: "thinking",
        value: "high",
      }),
    ).toEqual([]);
    expect(validateAcp("CancelRequestNotification", { requestId: 3 })).toEqual([]);
    expect(validateAcp("CancelRequestNotification", {})).not.toEqual([]);
    expect(validateAcp("Error", { code: -32800, message: "cancelled" })).toEqual([]);
    expect(validateAcp("Error", { code: "x", message: "m" })).not.toEqual([]);
    expect(validateAcp("PromptResponse", { stopReason: "refusal" })).toEqual([]);
    expect(validateAcp("PromptResponse", { stopReason: "aborted" })).not.toEqual([]);
    expect(validateAcp("NoSuchDef", {})).toEqual(["no $defs/NoSuchDef"]);
  });

  it("线路级：请求 / 答复配对按方向，错误答复校验 Error；未知通知、无主答复、坏行、缺 jsonrpc 报错", () => {
    const ok: AcpWireLine[] = [
      { dir: "in", msg: rpc({ id: 1, method: "initialize", params: { protocolVersion: 1 } }) },
      // 对方方向的同号请求不混淆
      {
        dir: "out",
        msg: rpc({
          id: 1,
          method: "session/request_permission",
          params: {
            sessionId: "s",
            toolCall: { toolCallId: "c" },
            options: [{ optionId: "a", name: "A", kind: "allow_once" }],
          },
        }),
      },
      { dir: "out", msg: rpc({ id: 1, result: { protocolVersion: 1 } }) },
      { dir: "out", msg: rpc({ method: "$/cancel_request", params: { requestId: 1 } }) },
      { dir: "in", msg: rpc({ id: 1, result: { outcome: { outcome: "cancelled" } } }) },
      { dir: "in", msg: rpc({ id: 2, method: "foo/bar", params: {} }) },
      { dir: "out", msg: rpc({ id: 2, error: { code: -32601, message: "nope" } }) },
      { dir: "in", msg: rpc({ id: 3, method: "_ama/ext", params: { any: 1 } }) },
      { dir: "out", msg: rpc({ id: 3, result: { whatever: true } }) },
    ];
    expect(acpWireErrors(ok)).toEqual([]);
    expect(() => assertAcpWire(ok)).not.toThrow();

    const bad: AcpWireLine[] = [
      { dir: "in", msg: { id: 1, method: "initialize", params: { protocolVersion: 1 } } },
      { dir: "out", msg: rpc({ id: 1, result: {} }) },
      { dir: "out", msg: rpc({ method: "session/whatever", params: {} }) },
      { dir: "out", msg: rpc({ id: 9, result: {} }) },
      { dir: "out", msg: { raw: "not json" } },
      { dir: "in", msg: rpc({ id: 2, method: "foo/bar" }) },
      { dir: "out", msg: rpc({ id: 2, result: {} }) },
    ];
    const errors = acpWireErrors(bad);
    expect(errors.some((e) => e.startsWith("#1 in envelope"))).toBe(true);
    expect(errors.some((e) => e.startsWith("#2 out initialize result: /: missing"))).toBe(true);
    expect(errors).toContain("#3 out session/whatever: unknown notification");
    expect(errors).toContain("#4 out response: no pending request with id 9");
    expect(errors.some((e) => e.startsWith("#5 out line"))).toBe(true);
    expect(errors).toContain(
      "#7 out foo/bar result: result for a method the schema does not define",
    );
    expect(() => assertAcpWire(bad)).toThrow(/violates schema/);
  });
});
