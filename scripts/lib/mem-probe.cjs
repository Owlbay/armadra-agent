// 内存采样探针（docs/memory-plan.md D14）：`node --require scripts/lib/mem-probe.cjs <entry> …` 预加载。
// 只用 node:*，dev 工具，不进 npm 包。scripts/bench-memory.mjs 用它采样；也可以单独挂到任何 ama 进程上。
//
// 环境变量：
//   AMA_MEM_LOG        JSONL 输出文件（必填；不设则探针什么也不做）
//   AMA_MEM_INTERVAL   采样间隔毫秒，缺省 250
//   AMA_MEM_TAG        写进每行的标签，缺省 "ama"
//   AMA_MEM_SNAP_EXIT  退出时把堆快照写到这个路径
//   AMA_MEM_ALLOC      退出时把采样分配剖析（含已回收的分配）写到这个路径
// 信号（Windows 无）：SIGUSR1 → 若以 --expose-gc 启动则先 GC，再记一行 ev:"gc"。
//
// 每行：{ tag, pid, ev, t, rss, heapUsed, heapTotal, external, arrayBuffers, maxRss? }，
// ev ∈ start | tick | gc | exit；exit 行带 maxRss（process.resourceUsage().maxRSS，字节），
// 这是进程整个生命周期的峰值 RSS，不受采样间隔影响。
"use strict";

const fs = require("node:fs");
const v8 = require("node:v8");

const log = process.env.AMA_MEM_LOG;
// 子进程（bash、codemode、外部 Agent）不继承探针
if (process.env.NODE_OPTIONS !== undefined && process.env.NODE_OPTIONS.includes("mem-probe")) {
  delete process.env.NODE_OPTIONS;
}

if (log) {
  const tag = process.env.AMA_MEM_TAG || "ama";
  const t0 = Date.now();
  const write = (ev) => {
    const m = process.memoryUsage();
    const line = {
      tag,
      pid: process.pid,
      ev,
      t: Date.now() - t0,
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    };
    if (ev === "exit") line.maxRss = process.resourceUsage().maxRSS * 1024;
    try {
      fs.appendFileSync(log, JSON.stringify(line) + "\n");
    } catch {
      // 采样失败不影响被测进程
    }
  };
  const interval = Number(process.env.AMA_MEM_INTERVAL) || 250;
  setInterval(() => write("tick"), interval).unref();
  if (process.platform !== "win32") {
    process.on("SIGUSR1", () => {
      if (typeof globalThis.gc === "function") {
        globalThis.gc();
        globalThis.gc();
      }
      write("gc");
    });
  }
  process.on("exit", () => {
    write("exit");
    const snap = process.env.AMA_MEM_SNAP_EXIT;
    if (snap) v8.writeHeapSnapshot(snap);
  });
  write("start");
}

const allocOut = process.env.AMA_MEM_ALLOC;
if (allocOut) {
  const inspector = require("node:inspector");
  const session = new inspector.Session();
  session.connect();
  session.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  process.on("exit", () => {
    session.post("HeapProfiler.stopSampling", (error, result) => {
      if (!error) fs.writeFileSync(allocOut, JSON.stringify(result.profile));
    });
  });
}
