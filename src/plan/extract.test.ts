import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PLAN_STEPS, extractProposedPlan, parsePlanSteps } from "./extract.js";
import { executionMode, resolvePlanDirectory, writePlanFile } from "./store.js";

const PLAN = `Some intro.

<proposed_plan>

# Fix login

## Background
Session cookie expires early.

## Steps
- [ ] S1 Read auth flow (files: src/auth.ts)
- [ ] S2 Extend TTL [depends: S1] [agent: codex]
- [x] S3 Add test [depends: S1, S2]

## Verification
1. pnpm test
2. manual login

</proposed_plan>
Done.`;

describe("extractProposedPlan（§6.3）", () => {
  it("取块内正文与清单步骤，标注解析进 dependsOn / agent", () => {
    const plan = extractProposedPlan(PLAN);
    expect(plan?.markdown.startsWith("# Fix login")).toBe(true);
    expect(plan?.markdown.endsWith("2. manual login")).toBe(true);
    expect(plan?.steps).toEqual([
      { id: "S1", text: "Read auth flow (files: src/auth.ts)" },
      { id: "S2", text: "Extend TTL", dependsOn: ["S1"], agent: "codex" },
      { id: "S3", text: "Add test", dependsOn: ["S1", "S2"] },
    ]);
    expect(plan?.truncated).toBeUndefined();
  });

  it("不闭合的块忽略；标签不独占一行不算", () => {
    expect(extractProposedPlan("<proposed_plan>\n# x\n- [ ] S1 a\n")).toBeUndefined();
    expect(extractProposedPlan("text <proposed_plan> # x </proposed_plan>")).toBeUndefined();
    expect(extractProposedPlan("<proposed_plan>\n\n</proposed_plan>")).toBeUndefined();
  });

  it("代码围栏里的标签不算；块内的围栏不会提前闭合", () => {
    const fenced = "```\n<proposed_plan>\n# a\n</proposed_plan>\n```\n";
    expect(extractProposedPlan(fenced)).toBeUndefined();
    const inner = "<proposed_plan>\n# a\n```\n</proposed_plan>\n```\n- [ ] S1 do\n</proposed_plan>";
    const plan = extractProposedPlan(inner);
    expect(plan?.markdown).toContain("```\n</proposed_plan>\n```");
    expect(plan?.steps).toEqual([{ id: "S1", text: "do" }]);
  });

  it("多个块取最后一个完整块", () => {
    const text = `<proposed_plan>\n# v1\n</proposed_plan>\n<proposed_plan>\n# v2\n</proposed_plan>\n<proposed_plan>\n# v3 open`;
    expect(extractProposedPlan(text)?.markdown).toBe("# v2");
  });

  it("没有清单时取「步骤」小节的编号列表；没有该小节取全部编号列表", () => {
    const md = "# T\n## 步骤\n1. 读代码\n2) 改实现 [depends: S1]\n## 验证\n1. 跑测试";
    expect(parsePlanSteps(md).steps).toEqual([
      { id: "S1", text: "读代码" },
      { id: "S2", text: "改实现", dependsOn: ["S1"] },
    ]);
    expect(parsePlanSteps("1. a\n2. b\n   1. nested").steps.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(parsePlanSteps("just prose").steps).toEqual([]);
  });

  it(`超过 ${MAX_PLAN_STEPS} 条截断并标记`, () => {
    const md = Array.from({ length: 35 }, (_, i) => `- [ ] S${i + 1} step ${i + 1}`).join("\n");
    const parsed = parsePlanSteps(md);
    expect(parsed.steps).toHaveLength(MAX_PLAN_STEPS);
    expect(parsed.truncated).toBe(true);
    expect(extractProposedPlan(`<proposed_plan>\n${md}\n</proposed_plan>`)?.truncated).toBe(true);
  });

  it("清单项没有 Sx 时按序号生成，重复 id 改用序号", () => {
    expect(parsePlanSteps("- [ ] first\n- [ ] S1 second\n- [ ] S1 third").steps).toEqual([
      { id: "S1", text: "first" },
      { id: "S2", text: "second" },
      { id: "S3", text: "third" },
    ]);
  });
});

describe("计划文件与执行模式", () => {
  it("plan.directory 在项目根内才用，否则 warning 回落数据目录", () => {
    const root = resolve("/work/proj");
    const data = resolve("/data");
    expect(resolvePlanDirectory(undefined, root, data)).toEqual({ dir: join(data, "plans") });
    expect(resolvePlanDirectory(".ama/plans", root, data)).toEqual({
      dir: join(root, ".ama", "plans"),
    });
    const outside = resolvePlanDirectory("../elsewhere", root, data);
    expect(outside.dir).toBe(join(data, "plans"));
    expect(outside.warning).toContain("../elsewhere");
    expect(resolvePlanDirectory(resolve("/tmp/x"), root, data).warning).toBeDefined();
  });

  it("写 <sessionId>-v<N>.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "ama-plan-"));
    try {
      const file = writePlanFile(join(dir, "plans"), "sess", 3, "# T");
      expect(file).toBe(join(dir, "plans", "sess-v3.md"));
      expect(readFileSync(file, "utf8")).toBe("# T\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("执行模式：指定 > 进入前；进入前就是 plan 时用 default", () => {
    expect(executionMode(undefined, "auto-edit")).toBe("auto-edit");
    expect(executionMode("auto", "auto-edit")).toBe("auto");
    expect(executionMode(undefined, "plan")).toBe("default");
    expect(executionMode(undefined, undefined)).toBe("default");
  });
});
