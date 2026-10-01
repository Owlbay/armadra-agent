import { afterEach, describe, expect, it } from "vitest";
import { createTmpHome, type TmpHome } from "../helpers/tmp-home.js";
import { spawn } from "node:child_process";
import { BUNDLE, hasBundle, runAma } from "./spawn.js";

let home: TmpHome | undefined;
afterEach(() => {
  home?.cleanup();
  home = undefined;
});

type Line = Record<string, unknown>;

describe.skipIf(!hasBundle)("e2e：ama --mode rpc（bundle 子进程）", () => {
  it("hello → prompt → agent_settled；关 stdin 后退出 0，无 parse 错误", async () => {
    home = createTmpHome();
    const input = [
      { id: "1", type: "prompt", message: "hi" },
      { id: "2", type: "get_state" },
    ]
      .map((c) => JSON.stringify(c))
      .join("\n");
    const r = await runAma(home, ["--mode", "rpc", "--model", "fake/echo"], {
      input: `${input}\n`,
    });
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Line);
    expect(lines[0]).toMatchObject({ type: "hello", protocolVersion: 1 });
    expect(lines.find((l) => l["id"] === "1")).toMatchObject({ success: true });
    expect(lines.find((l) => l["id"] === "2")).toMatchObject({ success: true });
    expect(lines.some((l) => l["command"] === "parse")).toBe(false);
    expect(lines.at(-1)?.["type"]).toBe("agent_settled");
    const text = lines.find(
      (l) => l["type"] === "message_end" && (l["message"] as { role: string }).role === "assistant",
    );
    expect(JSON.stringify(text)).toContain('"text":"hi"');
  });

  it("声明 approvals 后 permission_response 作答一次 ask，工具执行", async () => {
    home = createTmpHome();
    const script = home.write("work/script.json", {
      version: 1,
      responses: [
        { steps: [{ toolCall: { name: "bash", arguments: { command: "echo e2e-ok" } } }] },
        { text: "done" },
      ],
    });
    const child = spawn(process.execPath, [BUNDLE, "--mode", "rpc", "--model", "fake/echo"], {
      cwd: home.cwd,
      env: { ...home.env, AMA_NO_LOCAL_PROBE: "1", AMA_FAKE_SCRIPT: script },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: Line[] = [];
    let buffer = "";
    const send = (command: object) => child.stdin.write(`${JSON.stringify(command)}\n`);
    const settled = new Promise<void>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let at = buffer.indexOf("\n");
        while (at >= 0) {
          const line = JSON.parse(buffer.slice(0, at)) as Line;
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
          lines.push(line);
          if (line["type"] === "permission_request")
            send({ type: "permission_response", requestId: line["requestId"], decision: "allow" });
          if (line["type"] === "agent_settled") resolve();
        }
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    send({ type: "set_client_capabilities", capabilities: ["approvals"] });
    send({ type: "prompt", message: "run" });
    await settled;
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(lines.find((l) => l["type"] === "permission_resolved")).toMatchObject({
      decision: "allow",
    });
    const end = lines.find((l) => l["type"] === "tool_execution_end") as {
      isError: boolean;
      result: { content: unknown };
    };
    expect(end.isError).toBe(false);
    expect(JSON.stringify(end.result.content)).toContain("e2e-ok");
  });
});
