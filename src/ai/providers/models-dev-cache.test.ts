import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODELS_DEV_URL,
  describeRefresh,
  loadModelsDevIndex,
  modelsDevCachePath,
  modelsDevUrl,
  readModelsDevCache,
  refreshModelsDev,
} from "./models-dev-cache.js";

const RAW = {
  acme: {
    id: "acme",
    name: "Acme",
    models: { m1: { id: "m1", description: "drop me", limit: { context: 1000, output: 100 } } },
  },
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ama-mdev-"));
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(
  responses: (() => Response)[],
  calls: Call[] = [],
): typeof fetch & { calls: Call[] } {
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("offline");
    return next();
  }) as typeof fetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

function json(body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status: 200, headers });
}

describe("models.dev 缓存", () => {
  it("首次拉取：裁剪后写缓存（带 ETag），之后只读缓存", async () => {
    const dir = tmp();
    expect(loadModelsDevIndex(dir)).toBeUndefined();
    const f = fakeFetch([json(RAW, { etag: '"v1"' })]);
    const result = await refreshModelsDev({ dataDir: dir, fetch: f, env: {} });
    expect(result.status).toBe("updated");
    expect(f.calls[0]?.url).toBe(MODELS_DEV_URL);
    const file = readModelsDevCache(dir);
    expect(file?.etag).toBe('"v1"');
    expect(file?.providers["acme"]?.models["m1"]).toEqual({
      id: "m1",
      limit: { context: 1000, output: 100 },
    });
    expect(readFileSync(modelsDevCachePath(dir), "utf8")).not.toContain("drop me");
    expect(loadModelsDevIndex(dir)?.get("acme/m1")?.limit?.context).toBe(1000);
    expect(describeRefresh(result)).toMatch(/已更新（1 家供应商、1 个模型/);
  });

  it("24 小时内不重拉；force 时带 If-None-Match，304 只刷新时间", async () => {
    const dir = tmp();
    let t = Date.parse("2026-10-01T00:00:00Z");
    const now = (): number => t;
    await refreshModelsDev({
      dataDir: dir,
      fetch: fakeFetch([json(RAW, { etag: "e1" })]),
      now,
      env: {},
    });
    t += 60_000;
    const idle = fakeFetch([]);
    expect((await refreshModelsDev({ dataDir: dir, fetch: idle, now, env: {} })).status).toBe(
      "fresh",
    );
    expect(idle.calls).toHaveLength(0);
    t += 1000;
    const forced = fakeFetch([() => new Response(null, { status: 304 })]);
    const result = await refreshModelsDev({
      dataDir: dir,
      fetch: forced,
      now,
      force: true,
      env: {},
    });
    expect(result.status).toBe("not-modified");
    expect(forced.calls[0]?.headers["if-none-match"]).toBe("e1");
    expect(readModelsDevCache(dir)?.fetchedAt).toBe(new Date(t).toISOString());
  });

  it("过期后拉取失败：沿用旧缓存并 warning；没有缓存时 unavailable", async () => {
    const dir = tmp();
    let t = Date.parse("2026-10-01T00:00:00Z");
    const now = (): number => t;
    await refreshModelsDev({ dataDir: dir, fetch: fakeFetch([json(RAW)]), now, env: {} });
    t += 25 * 3600_000;
    const stale = await refreshModelsDev({ dataDir: dir, fetch: fakeFetch([]), now, env: {} });
    expect(stale.status).toBe("stale");
    expect(stale.warning).toMatch(/offline/);
    expect(stale.index?.get("acme/m1")).toBeDefined();
    const empty = tmp();
    const none = await refreshModelsDev({
      dataDir: empty,
      fetch: fakeFetch([() => new Response("x", { status: 500 })]),
      env: {},
    });
    expect(none).toMatchObject({ status: "unavailable" });
    expect(none.warning).toMatch(/HTTP 500/);
    expect(existsSync(modelsDevCachePath(empty))).toBe(false);
  });

  it("AMA_MODELS_DEV_URL 换数据源；换源后不沿用旧源的 TTL", async () => {
    expect(modelsDevUrl({ AMA_MODELS_DEV_URL: " http://mirror/api.json " })).toBe(
      "http://mirror/api.json",
    );
    const dir = tmp();
    await refreshModelsDev({ dataDir: dir, fetch: fakeFetch([json(RAW)]), env: {} });
    const f = fakeFetch([json(RAW)]);
    const env = { AMA_MODELS_DEV_URL: "http://mirror/api.json" };
    expect((await refreshModelsDev({ dataDir: dir, fetch: f, env })).status).toBe("updated");
    expect(f.calls[0]?.url).toBe("http://mirror/api.json");
  });

  it("损坏的缓存视为没有", () => {
    const dir = tmp();
    writeFileSync(modelsDevCachePath(dir), "{not json");
    expect(readModelsDevCache(dir)).toBeUndefined();
    expect(loadModelsDevIndex(dir)).toBeUndefined();
  });
});
