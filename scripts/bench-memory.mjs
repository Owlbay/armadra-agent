#!/usr/bin/env node
// 内存场景基准（docs/memory-plan.md §1.5、D14；结论见 docs/research/memory-2026-10.md）。
//
// 用法：pnpm build && node scripts/bench-memory.mjs [场景…] [选项]
//   场景：version print read-huge resume list acp-pool rpc-bytes mock-http（缺省全部）
//   选项：--entry <ama.cjs>   被测入口，缺省 dist/bundle/ama.cjs
//         --runs <n>          每个场景跑 n 次取中位数，缺省 1
//         --huge-mb <n>       read-huge 的文件大小，缺省 256
//         --session-mb <n>    resume / list 的单个会话大小，缺省 55
//         --steps <n>         mock-http / rpc-bytes 的工具步数，缺省 300 / 100
//         --images <n>        mock-http 的读图次数，缺省 15
//         --sessions <n>      acp-pool 会话数，缺省 8；--rounds <n> 每会话轮数，缺省 4
//         --compact           rpc-bytes 先声明 compact_events 能力
//         --keep              保留临时目录（打印路径）
//
// 约束：零依赖，只用 node:*；只读写 os.tmpdir() 下的临时目录——HOME / AMA_CONFIG_DIR / AMA_DATA_DIR 全部
// 指向临时目录，子进程环境从零构造（不带任何 API key），绝不触碰真实的配置与会话。只用 fake 供应商或
// 本脚本内置的 mock Responses SSE 服务（127.0.0.1），不发真实请求。
// 采样：子进程以 `--expose-gc --require scripts/lib/mem-probe.cjs` 启动；峰值 RSS 取
// process.resourceUsage().maxRSS（整个进程生命周期），heap / external 取采样峰值。

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { makeWorkspace, startMockResponses, writeTextFile } from "./lib/bench-memory-fixtures.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(ROOT, "scripts", "lib", "mem-probe.cjs");
const MB = 1024 * 1024;
const ALL = [
  "version",
  "print",
  "read-huge",
  "resume",
  "list",
  "acp-pool",
  "rpc-bytes",
  "mock-http",
];

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { scenarios: [], runs: 1, keep: false, compact: false };
  const numeric = new Set([
    "runs",
    "huge-mb",
    "session-mb",
    "steps",
    "images",
    "sessions",
    "rounds",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") opts.keep = true;
    else if (arg === "--compact") opts.compact = true;
    else if (arg === "--entry") opts.entry = resolve(argv[++i]);
    else if (arg.startsWith("--") && numeric.has(arg.slice(2)))
      opts[arg.slice(2)] = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (ALL.includes(arg)) opts.scenarios.push(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.scenarios.length === 0) opts.scenarios = [...ALL];
  opts.entry ??= join(ROOT, "dist", "bundle", "ama.cjs");
  return opts;
}

// ---------------------------------------------------------------------------
// 隔离环境与工作区
// ---------------------------------------------------------------------------

const roots = [];

function isolatedEnv(name) {
  // realpath：macOS 的 /var → /private/var，子进程的 cwd 是真实路径，会话目录按它编码
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ama-bench-${name}-`)));
  roots.push(root);
  const dirs = {
    root,
    home: join(root, "home"),
    cfg: join(root, "cfg"),
    data: join(root, "data"),
    work: join(root, "work"),
  };
  for (const dir of [dirs.home, dirs.cfg, dirs.data, dirs.work])
    mkdirSync(dir, { recursive: true });
  const env = {
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    AMA_CONFIG_DIR: dirs.cfg,
    AMA_DATA_DIR: dirs.data,
    AMA_NO_INIT: "1",
    AMA_NO_AGENT_PROBE: "1",
    AMA_LANG: "en",
    TERM: "xterm-256color",
  };
  for (const key of ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...dirs, env };
}

// ---------------------------------------------------------------------------
// fake 脚本
// ---------------------------------------------------------------------------

function toolStep(name, args, i) {
  return {
    steps: [{ text: `Calling ${name} #${i}. ` }, { toolCall: { name, arguments: args } }],
    usage: { input: 1000 + i, output: 100 },
  };
}

/** `steps` 次工具调用（读文本为主，均匀穿插 `images` 次读图）+ 收尾文本。 */
function toolScript(steps, images) {
  const responses = [];
  const every = images > 0 ? Math.max(1, Math.floor(steps / images)) : Infinity;
  let imageReads = 0;
  for (let i = 0; i < steps; i++) {
    if (i % every === every - 1 && imageReads < images) {
      responses.push(toolStep("read", { path: `img${imageReads++ % 3}.png` }, i));
    } else {
      const offset = 1 + ((i * 137) % 40000);
      responses.push(toolStep("read", { path: "big.txt", offset, limit: 2000 }, i));
    }
  }
  responses.push({ text: "Done.", usage: { input: 2000, output: 50 } });
  return { version: 1, responses, whenExhausted: "echo" };
}

function writeScript(ctx, script) {
  const path = join(ctx.root, "script.json");
  writeFileSync(path, JSON.stringify(script));
  return path;
}

// ---------------------------------------------------------------------------
// 运行与采样
// ---------------------------------------------------------------------------

function spawnAma(ctx, entry, args, extraEnv = {}) {
  const log = join(ctx.root, `mem-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  const child = spawn(process.execPath, ["--expose-gc", "--require", PROBE, entry, ...args], {
    cwd: ctx.work,
    env: { ...ctx.env, AMA_MEM_LOG: log, AMA_MEM_INTERVAL: "100", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  const exited = new Promise((res) => child.on("close", (code) => res(code)));
  return { child, log, exited, stderr: () => stderr };
}

function readSamples(log) {
  try {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function peaks(samples) {
  const max = (field) => Math.max(0, ...samples.map((s) => s[field] ?? 0));
  const exit = samples.find((s) => s.ev === "exit");
  return {
    rss: Math.max(max("rss"), exit?.maxRss ?? 0),
    heapUsed: max("heapUsed"),
    external: max("external"),
  };
}

/** 跑一次到退出；stdout 只计字节（`collect` 为 true 时收集文本）。 */
async function runOnce(ctx, entry, args, { env, collect = false } = {}) {
  const started = Date.now();
  const run = spawnAma(ctx, entry, args, env);
  run.child.stdin.end();
  let stdoutBytes = 0;
  let stdout = "";
  run.child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (collect) stdout += chunk;
  });
  const code = await run.exited;
  const ms = Date.now() - started;
  if (code !== 0) throw new Error(`exit ${code}: ${args.join(" ")}\n${run.stderr()}`);
  return { ...peaks(readSamples(run.log)), ms, stdoutBytes, stdout };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const fmtMb = (bytes) => (bytes / MB).toFixed(1);

function lastSample(log, pid, ev) {
  const all = readSamples(log).filter((s) => s.pid === pid && (ev === undefined || s.ev === ev));
  return all.at(-1);
}

/** 请求 GC 并等探针记一行（Windows 没有 SIGUSR1，退回最近一次采样）。 */
async function gcSample(run) {
  if (process.platform === "win32") {
    await sleep(500);
    return lastSample(run.log, run.child.pid);
  }
  run.child.kill("SIGUSR1");
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    const sample = lastSample(run.log, run.child.pid, "gc");
    if (sample !== undefined) return sample;
  }
  return lastSample(run.log, run.child.pid);
}

// ---------------------------------------------------------------------------
// 会话文件（经构建产物里的真实 SessionManager 写，格式与运行时一致）
// ---------------------------------------------------------------------------

async function writeSession(ctx, bytes, label) {
  const managerUrl = pathToFileURL(join(ROOT, "dist", "session", "manager.js")).href;
  const { SessionManager } = await import(managerUrl);
  const manager = SessionManager.createForCwd(join(ctx.data, "sessions"), ctx.work);
  const chunk = `${label} ${"tool output line 0123456789 abcdefghij\n".repeat(1600)}`;
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  let written = 0;
  manager.append({
    type: "message",
    message: { role: "user", content: `${label}: start`, timestamp: Date.now() },
  });
  for (let i = 0; written < bytes; i++) {
    const timestamp = Date.now();
    manager.append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: `call_${i}`, name: "read", arguments: { path: "x" } }],
        api: "openai-responses",
        provider: "fake",
        model: "echo",
        usage: zero,
        stopReason: "toolUse",
        timestamp,
      },
    });
    manager.append({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call_${i}`,
        toolName: "read",
        content: [{ type: "text", text: chunk }],
        isError: false,
        timestamp,
      },
    });
    written += chunk.length + 400;
  }
  manager.flush();
  const id = manager.header().id;
  manager.close();
  return id;
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

const FAKE = ["--model", "fake/echo", "--permission-mode", "full-auto", "--trust"];

const scenarios = {
  async version(opts) {
    const ctx = isolatedEnv("version");
    const r = await runOnce(ctx, opts.entry, ["--version"]);
    return { ...r, note: "" };
  },

  async print(opts) {
    const ctx = isolatedEnv("print");
    const script = writeScript(ctx, { version: 1, responses: [{ text: "ok" }] });
    const r = await runOnce(ctx, opts.entry, [...FAKE, "-p", "go"], {
      env: { AMA_FAKE_SCRIPT: script },
    });
    return { ...r, note: "fake, one turn" };
  },

  async "read-huge"(opts) {
    const ctx = isolatedEnv("read-huge");
    const mb = opts["huge-mb"] ?? 256;
    writeTextFile(join(ctx.work, "huge.txt"), mb * MB);
    const script = writeScript(ctx, {
      version: 1,
      responses: [
        toolStep("read", { path: "huge.txt", offset: 1, limit: 100 }, 0),
        { text: "Done." },
      ],
    });
    const r = await runOnce(ctx, opts.entry, [...FAKE, "-p", "go"], {
      env: { AMA_FAKE_SCRIPT: script },
    });
    return { ...r, note: `read first 100 lines of ${mb} MB` };
  },

  async resume(opts) {
    const ctx = isolatedEnv("resume");
    const mb = opts["session-mb"] ?? 55;
    const id = await writeSession(ctx, mb * MB, "resume");
    const script = writeScript(ctx, { version: 1, responses: [{ text: "ok" }] });
    const r = await runOnce(ctx, opts.entry, [...FAKE, "-p", "--resume", id, "go"], {
      env: { AMA_FAKE_SCRIPT: script },
    });
    return { ...r, note: `-p --resume, ${mb} MB session` };
  },

  async list(opts) {
    const ctx = isolatedEnv("list");
    const mb = opts["session-mb"] ?? 55;
    for (let i = 0; i < 4; i++) await writeSession(ctx, mb * MB, `list-${i}`);
    const r = await runOnce(ctx, opts.entry, ["sessions", "list"], { collect: true });
    const rows = r.stdout
      .trim()
      .split("\n")
      .filter((l) => l.includes("list-")).length;
    return { ...r, note: `sessions list, 4 × ${mb} MB (${rows} rows)` };
  },

  async "acp-pool"(opts) {
    const ctx = isolatedEnv("acp-pool");
    makeWorkspace(ctx.work);
    const sessions = opts.sessions ?? 8;
    const rounds = opts.rounds ?? 4;
    const perRound = 10;
    const script = toolScript(sessions * rounds * perRound, sessions * rounds);
    // 每轮 perRound 次工具 + 收尾：把收尾文本插进每轮末尾
    const responses = [];
    script.responses.slice(0, -1).forEach((r, i) => {
      responses.push(r);
      if (i % perRound === perRound - 1) responses.push({ text: "Round done." });
    });
    const path = writeScript(ctx, { version: 1, responses, whenExhausted: "echo" });
    const started = Date.now();
    const run = spawnAma(ctx, opts.entry, ["--mode", "acp", ...FAKE], { AMA_FAKE_SCRIPT: path });
    const pending = new Map();
    let nextId = 0;
    createInterface({ input: run.child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "session/request_permission") {
        const result = { outcome: { outcome: "selected", optionId: "allow_once" } };
        run.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const call = (method, params) =>
      new Promise((res) => {
        const id = ++nextId;
        pending.set(id, res);
        run.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const ids = [];
    for (let i = 0; i < sessions; i++) {
      const r = await call("session/new", { cwd: ctx.work, mcpServers: [] });
      if (r.error) throw new Error(`session/new: ${JSON.stringify(r.error)}`);
      ids.push(r.result.sessionId);
    }
    let errors = 0;
    for (let round = 0; round < rounds; round++) {
      const results = await Promise.all(
        ids.map((sessionId, i) =>
          call("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: `session ${i} round ${round}: go` }],
          }),
        ),
      );
      errors += results.filter((r) => r.error).length;
    }
    const open = await gcSample(run);
    for (const sessionId of ids) await call("session/close", { sessionId });
    await sleep(500);
    const closed = await gcSample(run);
    run.child.stdin.end();
    await run.exited;
    const r = { ...peaks(readSamples(run.log)), ms: Date.now() - started, stdoutBytes: 0 };
    const at = (s) => (s ? `heap ${fmtMb(s.heapUsed)} / ext ${fmtMb(s.external)}` : "n/a");
    return {
      ...r,
      note: `${sessions}×${rounds} fake; open+gc ${at(open)}; closed+gc ${at(closed)}; prompt errors ${errors}`,
    };
  },

  async "rpc-bytes"(opts) {
    const ctx = isolatedEnv("rpc-bytes");
    makeWorkspace(ctx.work);
    const steps = opts.steps ?? 100;
    const path = writeScript(ctx, toolScript(steps, Math.floor(steps / 20)));
    const started = Date.now();
    const run = spawnAma(ctx, opts.entry, ["--mode", "rpc", ...FAKE], { AMA_FAKE_SCRIPT: path });
    const byType = new Map();
    let total = 0;
    let settle;
    const settled = new Promise((res) => (settle = res));
    let badLines = 0;
    createInterface({ input: run.child.stdout }).on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        badLines++;
        return;
      }
      const bytes = Buffer.byteLength(line) + 1;
      total += bytes;
      byType.set(event.type, (byType.get(event.type) ?? 0) + bytes);
      if (event.type === "agent_settled") settle();
    });
    const send = (command) => run.child.stdin.write(`${JSON.stringify(command)}\n`);
    if (opts.compact) {
      send({ id: "caps", type: "set_client_capabilities", capabilities: ["compact_events"] });
    }
    send({ id: "1", type: "prompt", message: "go" });
    await settled;
    run.child.stdin.end();
    await run.exited;
    const top = [...byType]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, bytes]) => `${type} ${fmtMb(bytes)}`)
      .join(", ");
    return {
      ...peaks(readSamples(run.log)),
      ms: Date.now() - started,
      stdoutBytes: total,
      note: `${steps} steps${opts.compact ? ", compact_events" : ""}; stdout ${fmtMb(total)} MB${badLines > 0 ? `, ${badLines} bad line(s)` : ""} (${top})`,
    };
  },

  async "mock-http"(opts) {
    const ctx = isolatedEnv("mock-http");
    makeWorkspace(ctx.work);
    const steps = opts.steps ?? 300;
    const images = opts.images ?? 15;
    const { responses } = toolScript(steps, images);
    const mock = await startMockResponses(responses);
    writeFileSync(
      join(ctx.cfg, "config.json"),
      JSON.stringify({
        version: 1,
        providers: {
          mock: {
            api: "openai-responses",
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            apiKey: "$MOCK_KEY",
            models: [
              { id: "m1", contextWindow: 1_000_000, maxTokens: 8192, input: ["text", "image"] },
            ],
          },
        },
      }),
    );
    try {
      const args = ["--model", "mock/m1", "--permission-mode", "full-auto", "--trust", "-p", "go"];
      const r = await runOnce(ctx, opts.entry, args, { env: { MOCK_KEY: "dummy-local" } });
      const sent = mock.bodies.reduce((a, b) => a + b, 0);
      const largest = Math.max(0, ...mock.bodies);
      return {
        ...r,
        note: `${steps} steps, ${images} image reads; ${mock.bodies.length} requests, body max ${fmtMb(largest)} MB, total ${fmtMb(sent)} MB`,
      };
    } finally {
      mock.close();
    }
  },
};

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    const text = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    process.stdout.write(
      `${text
        .slice(1, 15)
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n")}\n`,
    );
    return;
  }
  const rows = [];
  try {
    for (const name of opts.scenarios) {
      const results = [];
      for (let i = 0; i < Math.max(1, opts.runs); i++) {
        process.stderr.write(`[bench-memory] ${name} run ${i + 1}/${opts.runs}\n`);
        results.push(await scenarios[name](opts));
      }
      rows.push({
        name,
        rss: median(results.map((r) => r.rss)),
        heapUsed: median(results.map((r) => r.heapUsed)),
        external: median(results.map((r) => r.external)),
        ms: median(results.map((r) => r.ms)),
        note: results.at(-1).note,
      });
    }
  } finally {
    if (opts.keep) process.stderr.write(`[bench-memory] kept: ${roots.join(" ")}\n`);
    else for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  const out = [
    `Node ${process.version} · ${process.platform}-${process.arch} · runs ${opts.runs} (median)`,
    "",
    "| Scenario | Peak RSS (MB) | Peak heapUsed (MB) | Peak external (MB) | Time (s) | Notes |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${fmtMb(r.rss)} | ${fmtMb(r.heapUsed)} | ${fmtMb(r.external)} | ${(r.ms / 1000).toFixed(2)} | ${r.note} |`,
    ),
  ];
  process.stdout.write(`${out.join("\n")}\n`);
}

await main();
