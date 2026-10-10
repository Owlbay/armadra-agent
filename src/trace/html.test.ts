/**
 * 轨迹 HTML（docs/history/wave6-plan.md §2.5、§2.7 T2）：9 类夹具的整页黄金、确定性、注入与脱敏、`--no-content`、
 * 子会话预览开关、预览预算、空闲压缩、体积与脚本可解析。[W6-T2]
 * 更新黄金：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/trace/html.test.ts`。
 */

import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n/index.js";
import type { SessionEntry } from "../session/types.js";
import { buildTrace, type TraceInput } from "./build.js";
import { entryLookup } from "./detail.js";
import {
  axisPoints,
  IDLE_CAP_MS,
  mapTime,
  renderTraceHtml,
  scriptSafeJson,
  traceHtmlData,
  type HtmlData,
  type TraceHtmlOptions,
} from "./html.js";
import { renderPage } from "./html-template.js";
import {
  TRACE_FIXTURES,
  fixtureChild,
  loadFixture,
  synthetic,
  traceGolden,
} from "./test-support.js";

afterEach(() => setLocale("zh"));

const GENERATED_AT = Date.UTC(2026, 9, 3, 12, 0, 0);

function render(input: TraceInput, opts: Partial<TraceHtmlOptions> = {}): string {
  const trace = buildTrace(input, { loadChild: fixtureChild });
  const child = fixtureChild("subagent-child");
  return renderTraceHtml(trace, {
    content: true,
    children: true,
    generatedAt: GENERATED_AT,
    version: "0.0.0-test",
    lookup: entryLookup([...input.entries, ...(child?.entries ?? [])], input.header.cwd),
    ...opts,
  });
}

function dataOf(html: string): HtmlData {
  const m = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error("no data block");
  return JSON.parse(m[1] as string) as HtmlData;
}

function scriptOf(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  return (m?.[1] as string) ?? "";
}

/** basic 夹具注入恶意 / 机密正文。 */
const SECRET = "sk-ant-api03-T2SECRETMARKERxyzxyzxyzxyz";
const PAT = "ghp_T2PATMARKER0123456789abcdefABCDEF";
const EVIL = '</script><img src=x onerror="alert(1)"><!-- \u2028\u2029';

function poisoned(): TraceInput {
  const input = loadFixture("basic");
  const entries = input.entries.map((entry): SessionEntry => {
    if (entry.type !== "message") return entry;
    const m = entry.message;
    if (entry.id === "ba004" && m.role === "user")
      return { ...entry, message: { ...m, content: `${EVIL} key=${SECRET}` } };
    if (entry.id === "ba005" && m.role === "assistant")
      return {
        ...entry,
        message: {
          ...m,
          content: m.content.map((b) =>
            b.type === "toolCall"
              ? { ...b, arguments: { path: `${EVIL}.md`, apiKey: "plainvalue12345678" } }
              : b,
          ),
        },
      };
    if (entry.id === "ba006" && m.role === "toolResult")
      return { ...entry, message: { ...m, content: `token: ${PAT}\n${EVIL}` } };
    return entry;
  });
  return { ...input, entries };
}

describe("HTML 黄金（9 类夹具）", () => {
  for (const name of TRACE_FIXTURES)
    it(name, () => traceGolden(`${name}.trace.html`, render(loadFixture(name))));
});

describe("页面", () => {
  it("确定性：同输入同输出；生成时间只改页脚", () => {
    const a = render(loadFixture("subagent"));
    expect(render(loadFixture("subagent"))).toBe(a);
    const b = render(loadFixture("subagent"), { generatedAt: GENERATED_AT + 1000 });
    expect(b).not.toBe(a);
    const da = dataOf(a);
    const db = dataOf(b);
    expect({ ...db, footer: da.footer }).toEqual(da);
    expect(da.footer).toContain("2026-10-03T12:00:00.000Z");
    expect(da.footer).toContain("0.0.0-test");
  });

  it("CSP、零外链；脚本能被解析；静态部分 ≤ 25 KB", () => {
    const html = render(loadFixture("basic"));
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`,
    );
    expect(html).not.toMatch(/\b(?:src|href)\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("url(");
    expect(() => new Script(scriptOf(html))).not.toThrow();
    const shell = renderPage({ lang: "en", title: "t", json: "{}" });
    expect(Buffer.byteLength(shell)).toBeLessThanOrEqual(25 * 1024);
  });

  it("中英文案按导出时语言", () => {
    setLocale("en");
    const data = dataOf(render(loadFixture("basic")));
    expect(data.lang).toBe("en");
    expect(data.i18n["search"]).toBe("Search");
    expect(data.title).toBe("Trace · sess-basic");
    setLocale("zh");
    expect(dataOf(render(loadFixture("basic"))).i18n["search"]).toBe("搜索");
  });
});

describe("注入与脱敏", () => {
  const html = render(poisoned());

  it("数据块里的 </script>、<img onerror>、<!--、U+2028/2029 都被转义", () => {
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<!--");
    expect(html).not.toMatch(/[\u2028\u2029]/);
    // 转义后仍是原文（页面用 textContent 显示）
    const data = dataOf(html);
    const turn = data.rows.find((r) => r.k === "turn");
    expect(turn?.l).toContain("</script><img");
    expect(turn?.pv?.[0]?.[1]).toContain('onerror="alert(1)"');
  });

  it("密钥样例不出现在文件里（标签、详情、参数、结果都遮掉）", () => {
    expect(html).not.toContain("T2SECRETMARKER");
    expect(html).not.toContain("T2PATMARKER");
    expect(html).not.toContain("plainvalue12345678");
    expect(html).toContain("[REDACTED]");
  });

  it("scriptSafeJson 可还原", () => {
    const value = { a: EVIL, b: "&<>" };
    const text = scriptSafeJson(value);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe("内容开关与预算", () => {
  it("--no-content：不含提示 / 参数 / 结果正文，没有预览，详情不带错误原文", () => {
    const html = render(poisoned(), { content: false });
    const data = dataOf(html);
    expect(data.content).toBe(false);
    expect(data.rows.some((r) => r.pv !== undefined)).toBe(false);
    for (const needle of ["README", "Demo", "onerror", "演示项目", "读一下"])
      expect(html).not.toContain(needle);
    const retry = dataOf(render(loadFixture("retry-fallback"), { content: false }));
    const labels = retry.rows.flatMap((r) => r.kv.map(([label]) => label));
    expect(labels).not.toContain("错误");
    expect(labels).not.toContain("原因");
  });

  it("children=false：子会话结构照样嵌，预览不嵌并标注", () => {
    const data = dataOf(render(loadFixture("subagent"), { children: false }));
    const agent = data.rows.findIndex((r) => r.k === "subagent");
    const inside = data.rows.filter((r, i) => i > agent && r.d > (data.rows[agent]?.d ?? 0));
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((r) => r.pc === 1 && r.pv === undefined)).toBe(true);
    const withKids = dataOf(render(loadFixture("subagent")));
    expect(withKids.rows.some((r, i) => i > agent && r.pv !== undefined && r.d > 2)).toBe(true);
  });

  it("预览总预算：从后往前保留，超出的更早预览置空并标 pd", () => {
    const data = dataOf(render(loadFixture("basic"), { previewBudget: 40 }));
    const withPv = data.rows.filter((r) => r.pv !== undefined);
    const dropped = data.rows.filter((r) => r.pd === 1);
    expect(dropped.length).toBeGreaterThan(0);
    const lastDropped = data.rows.lastIndexOf(dropped.at(-1) as (typeof data.rows)[number]);
    for (const r of withPv) expect(data.rows.indexOf(r)).toBeGreaterThan(lastDropped);
  });
});

describe("横轴", () => {
  it("回合之间的空闲压到 IDLE_CAP_MS；映射单调", () => {
    const trace = buildTrace(loadFixture("basic"));
    const points = axisPoints(trace);
    const turns = trace.turns;
    const gap = (turns[1]?.startedAt ?? 0) - (turns[0]?.endedAt ?? 0);
    expect(gap).toBeGreaterThan(IDLE_CAP_MS);
    const t0 = trace.startedAt;
    const a = mapTime(points, (turns[0]?.endedAt ?? 0) - t0);
    const b = mapTime(points, (turns[1]?.startedAt ?? 0) - t0);
    expect(b - a).toBe(IDLE_CAP_MS);
    let prev = -Infinity;
    for (let t = 0; t < 80_000; t += 997) {
      const m = mapTime(points, t);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it("每行的分段落在轴内；步骤分 ttft / 解码两段", () => {
    const data = traceHtmlData(buildTrace(loadFixture("basic")), {
      content: false,
      children: false,
      generatedAt: 0,
      version: "x",
    });
    const step = data.rows.find((r) => r.k === "step");
    expect(step?.g?.map((g) => g[2])).toEqual(["ttft", "dec"]);
    for (const r of data.rows)
      for (const [from, to] of r.g ?? []) {
        expect(from).toBeGreaterThanOrEqual(0);
        expect(to).toBeLessThanOrEqual(data.span);
      }
  });
});

describe("长会话", () => {
  it("5000 回合（10k 行）：数据完整、页面按虚拟列表渲染，生成足够快", () => {
    const input = synthetic(5000);
    const started = performance.now();
    const html = render(input);
    const elapsed = performance.now() - started;
    const data = dataOf(html);
    expect(data.rows).toHaveLength(10_000);
    expect(data.rows.filter((r) => r.t !== undefined)).toHaveLength(5000);
    // 页面只建可见 ±50 行（脚本常量），不按行数输出 DOM
    expect(scriptOf(html)).toContain("OV=50");
    expect(html.match(/class="row/g)).toBeNull();
    expect(elapsed).toBeLessThan(5000);
  });
});
