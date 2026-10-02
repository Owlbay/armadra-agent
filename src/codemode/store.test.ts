import { describe, expect, it } from "vitest";
import { SessionManager } from "../session/manager.js";
import type { ToolContext } from "../tools/types.js";
import {
  MAX_STORE_TOTAL_CHARS,
  MAX_STORE_VALUE_CHARS,
  STORE_CUSTOM_TYPE,
  commitStore,
  readStore,
  validateStore,
} from "./store.js";

/** 与 AgentSession 的 createToolContext 相同的 session 访问：按活动分支找最近一条。 */
function access(manager: SessionManager): ToolContext["session"] {
  return {
    appendCustom: (customType, data) => {
      manager.append({ type: "custom", customType, data });
    },
    lastCustom: (customType) => {
      const branch = manager.branch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry?.type === "custom" && entry.customType === customType) return entry.data;
      }
      return undefined;
    },
  };
}

function userEntry(manager: SessionManager, text: string): string {
  return manager.append({
    type: "message",
    message: { role: "user", content: text, timestamp: 0 },
  }).id;
}

describe("codemode store", () => {
  it("没有条目 → 空；提交后读到完整快照，写成 custom 条目", () => {
    const manager = SessionManager.inMemory("/w");
    const session = access(manager);
    expect(readStore(session)).toEqual({});
    expect(commitStore(session, { cursor: 3, ids: ["a"] })).toBeUndefined();
    expect(readStore(session)).toEqual({ cursor: 3, ids: ["a"] });
    const custom = manager.entries().filter((e) => e.type === "custom");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({
      customType: STORE_CUSTOM_TYPE,
      data: { entries: { cursor: 3, ids: ["a"] } },
    });
  });

  it("超限拒绝且不写条目：单值 > 256 KiB、合计 > 1 MiB、不可序列化", () => {
    const manager = SessionManager.inMemory("/w");
    const session = access(manager);
    const big = "x".repeat(MAX_STORE_VALUE_CHARS);
    expect(commitStore(session, { big })).toMatch(/limit 262144/);
    const quarter = "y".repeat(MAX_STORE_VALUE_CHARS - 10);
    expect(commitStore(session, { a: quarter, b: quarter, c: quarter, d: quarter, e: "z" })).toBe(
      undefined,
    );
    expect(validateStore({ a: quarter, b: quarter, c: quarter, d: quarter, e: quarter })).toMatch(
      new RegExp(`limit ${MAX_STORE_TOTAL_CHARS}`),
    );
    expect(validateStore({ n: 1n as unknown })).toMatch(/not JSON-serializable/);
    expect(manager.entries().filter((e) => e.type === "custom")).toHaveLength(1);
  });

  it("分支隔离：回到分叉点后只看本分支的快照；fork 出的会话带着分叉点之前的值", () => {
    const manager = SessionManager.inMemory("/w");
    const session = access(manager);
    commitStore(session, { v: "base" });
    const fork = userEntry(manager, "fork point");
    commitStore(session, { v: "branch-a" });
    expect(readStore(session)).toEqual({ v: "branch-a" });
    manager.setLeaf(fork);
    expect(readStore(session)).toEqual({ v: "base" });
    commitStore(session, { v: "branch-b" });
    expect(readStore(session)).toEqual({ v: "branch-b" });
    const forked = manager.fork(fork);
    expect(readStore(access(forked))).toEqual({ v: "base" });
  });

  it("形状不对的条目当作空", () => {
    const manager = SessionManager.inMemory("/w");
    manager.append({ type: "custom", customType: STORE_CUSTOM_TYPE, data: { entries: [1] } });
    expect(readStore(access(manager))).toEqual({});
  });
});

describe("子进程与父进程的上限一致", () => {
  it("sandbox-entry 的常量与 store / protocol 相同", async () => {
    const sandbox = await import("./sandbox-entry.js");
    const { MAX_CONCURRENT_TOOL_CALLS } = await import("./protocol.js");
    expect(sandbox.MAX_STORE_VALUE_CHARS).toBe(MAX_STORE_VALUE_CHARS);
    expect(sandbox.MAX_STORE_TOTAL_CHARS).toBe(MAX_STORE_TOTAL_CHARS);
    expect(sandbox.MAX_CONCURRENT).toBe(MAX_CONCURRENT_TOOL_CALLS);
  });
});
