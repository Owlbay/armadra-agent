// 内存采样探针（docs/history/memory-plan.md D14）：`node --require scripts/lib/mem-probe.cjs <entry> …` 预加载。
// 只用 node:*，dev 工具，不进 npm 包。scripts/bench-memory.mjs 用它采样；也可以单独挂到任何 ama 进程上。
//
// 环境变量：
//   AMA_MEM_LOG        JSONL 输出文件（必填；不设则探针什么也不做）
//   AMA_MEM_INTERVAL   采样间隔毫秒，缺省 250
//   AMA_MEM_TAG        写进每行的标签，缺省 "ama"
//   AMA_MEM_SNAP_EXIT  退出时把堆快照写到这个路径
//   AMA_MEM_ALLOC      退出时把采样分配剖析（含已回收的分配）写到这个路径
//   AMA_MEM_VMMAP_AT   仅 macOS：启动后这些毫秒数（逗号分隔，如 "3000,8000"）各跑一次 `vmmap -summary <pid>`，
//                      输出写到 `<AMA_MEM_LOG>.vmmap-<ms>.txt`，并同时记一行 ev:"vmmap" 便于对齐
// 信号（Windows 无）：SIGUSR1 → 若以 --expose-gc 启动则先 GC，再记一行 ev:"gc"。
//
// 每行：{ tag, pid, ev, t, rss, heapUsed, heapTotal, external, arrayBuffers, other,
//         oldSpace, oldSpaceUsed, largeObjectSpace, largeObjectSpaceUsed, codeSpace, codeSpaceUsed, maxRss? }，
// ev ∈ start | tick | gc | vmmap | exit；exit 行带 maxRss（process.resourceUsage().maxRSS，字节），
// 这是进程整个生命周期的峰值 RSS，不受采样间隔影响。
// other = rss − heapTotal − external：既不在 V8 堆（含已提交未使用的页）也不在 external 里的常驻内存
// （原生 malloc、代码、线程栈等）；*Space / *SpaceUsed 取自 v8.getHeapSpaceStatistics() 的
// space_size / space_used_size（old_space、large_object_space、code_space）。
"use strict";

const fs = require("node:fs");
const v8 = require("node:v8");

const SPACES = {
  old_space: "oldSpace",
  large_object_space: "largeObjectSpace",
  code_space: "codeSpace",
};

function heapSpaces(line) {
  for (const space of v8.getHeapSpaceStatistics()) {
    const key = SPACES[space.space_name];
    if (key === undefined) continue;
    line[key] = space.space_size;
    line[`${key}Used`] = space.space_used_size;
  }
}

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
      other: m.rss - m.heapTotal - m.external,
    };
    heapSpaces(line);
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

  const vmmapAt = process.env.AMA_MEM_VMMAP_AT;
  if (vmmapAt && process.platform === "darwin") {
    const { execFile } = require("node:child_process");
    for (const ms of vmmapAt
      .split(",")
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 0)) {
      setTimeout(() => {
        write("vmmap");
        const out = `${log}.vmmap-${ms}.txt`;
        const args = ["-summary", String(process.pid)];
        execFile("vmmap", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
          try {
            fs.writeFileSync(out, error ? `vmmap failed: ${error.message}\n${stderr}` : stdout);
          } catch {
            // 同上
          }
        });
      }, ms).unref();
    }
  }
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
