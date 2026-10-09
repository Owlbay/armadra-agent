# 内存占用优化设计（read 流式、ACP 释放、请求体序列化、图片驻留、会话流式读取）

> 状态：**实施设计**（Issue #136，label 改 `ready` 后进入批次）。基线 `main` = `599fc11`（0.7.3 + #133 + #134 ME-C0）。依据：内存测量报告（C0 整理为 [research/memory-2026-10.md](research/memory-2026-10.md)，去掉外部项目名与 `/tmp` 路径）、[design.md](design.md) §9.1（前缀字节稳定）、[session-format.md](session-format.md)、[model-efficiency-plan.md](model-efficiency-plan.md)（#135，**并行实施中**，交集见 §3.0）。批次写法沿用 [acp-plan.md](acp-plan.md)。
> 硬约束不变：零运行时依赖；源码 ≤ 600 行 / 测试 ≤ 1000 行（**`src/agent/session.ts`、`src/agent/subagent-registry.ts`、`src/ai/providers/registry.ts`、`src/cli/compose-session.ts` 不得加行**；`src/modes/acp/acp-server.ts` 已 587 行，本计划只允许它 +≤ 8 行，新逻辑放 `acp-sessions.ts`）；i18n en / zh；**首个请求与相邻回合的请求体逐字节不变**（本计划不改任何请求体内容，只改序列化方式，并以字节比对守住）；`prompt-budget` 三档不变（不碰工具描述与系统提示）；会话文件格式向后兼容，rewind / resume / fork 语义不变；RPC / ACP 新增字段与能力一律可选；测试只用 fake 供应商；真实测量只用 astr 上便宜的 GPT 模型（`astr/gpt-6-luna`），每批 ≤ 15 次请求；代码与文档不出现参考项目名。
> 范围：报告 P0-1 / P0-2 / P0-3 全部；P1-1…P1-6 全部；P2 中 P2-2（惰性 `Intl.Segmenter`）、P2-3（codemode 子进程堆上限）、P2-7（fake 供应商不留上下文）纳入；P2-1、P2-4、P2-5、P2-6 本波不做，理由见 §7。附带：Issue #139（ACP 后台子 Agent 通知回合进行中时 `session/prompt` 报 busy）并入 M-A，理由见 D4。

## §0 决策表

| #   | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **`read` 的文本路径改为"按字节窗口"读取，不再整文件进内存**（P0-1）。新文件 `src/tools/read-lines.ts`：用 `fs.openSync` + 64 KiB 块 `readSync`，以 `Buffer.indexOf(0x0a)` 定行，只解码 `[offset, offset+limit)` 范围且累计不超过 `DEFAULT_MAX_BYTES`（50 KB）+ 1 行的字节；`totalLines` 继续扫完全文只计换行、不建字符串；BOM 只看前 3 字节、二进制嗅探只看前 `SNIFF_BYTES`（8000）；CRLF 按行去 `\r`（与现有 `normalizeToLF` 口径一致：`\r\n` → `\n`，孤立 `\r` 也视为换行——见 R1）；UTF-8 跨块边界靠按行解码天然避开（行尾是 `\n`，不会切在多字节内）。**小文件（≤ 1 MiB）保留现有路径**（`readFile` → split），两条路径对同一输入的 `content` / `details` **逐字节相同**，用黄金 fixture 守住。阈值 1 MiB 而不是报告建议的 8 MB：小于 1 MiB 的文件两条路径峰值差异可忽略，大于它就应避开 3× 复制。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D2  | **ACP 关闭会话必须能被 GC**（P0-2，L1 / L2 / L3）。① `acp-server.ts prompt()` 的 abort 监听改为有引用、`await result` 之后 `removeEventListener`（放在 `try/finally`）；② `reporting.ts` 的 `EndpointState.last` 从整条 `RequestRecord` 改为只存比较需要的 `{ at, promptTokens, fingerprint }`（新类型 `LastRequest`），不再持有 `options.onQuota` / `contextRef`；③ L3 **按报告的推测核对而不是改代码**：`session/close` → `disposeSessionAlongside` → `session.dispose()` → `extensions.dispose()` → `createSubagentExtension.dispose()` → `registry.dispose()` → `unregisterTaskControl` 这条链已成立（`compose-agents.ts:122`、`subagent-registry.ts:598`），快照里残留的那一个 `SubagentRegistry` 极可能是**待命会话**（`standby`，close 唯一会话时新建）而非泄漏；用测试断言 `taskControl(closedId) === undefined` 与 `_AgentSessionImpl` 可回收，若断言失败再修。`jsonrpc.ts` 不改（合成信号在监听移除后自然可回收）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D3  | **请求体序列化分两步，第一步不碰转换器**（P0-3）。对报告「按消息 WeakMap 缓存片段」的异议：四个协议的 `convertMessages` 每次请求都新建 item 对象（`anthropic-request.ts` / `openai-request.ts` / `openai-responses-request.ts` / `google-request.ts`），`transform.ts downgradeBlocks` 也对每条 assistant 返回新对象——消息身份在请求层不稳定，WeakMap 命中率为 0；要缓存必须改四个转换器（全部是 #135 ME-C 的文件），且缓存的 Buffer 会让图片**常驻**再多一份。**步骤一（本波 M-B）**：新文件 `src/ai/json-body.ts` 的 `serializeJsonBody(body): Buffer`——分块序列化器：先一次廉价遍历找有没有 ≥ 64 KiB 的字符串（图片 base64），没有就 `Buffer.from(JSON.stringify(body))` 照旧；有则按对象 / 数组结构逐键拼片段，小子树交给原生 `JSON.stringify`，**大字符串**经 `/["\\\u0000-\u001f\ud800-\udfff]/` 检查无需转义时直接 `Buffer.from(str, "utf8")` 夹双引号写出（否则回落原生），最后 `Buffer.concat`。`postJson` 的 `body: JSON.stringify(options.body)` 改为 `body: serializeJsonBody(options.body)`（fetch 接 `Uint8Array`，undici 自动算 `Content-Length`，不走 chunked）。结果与 `JSON.stringify(body)` 的 UTF-8 编码**逐字节相同**（含 `toJSON`、`undefined` 跳过、数组内 `undefined` → `null`、`NaN` → `null`、孤立代理项的 `\udXXX` 转义——全部交给原生处理，自写部分只有"结构 + 已验证无转义字符的大字符串"）。瞬时内存从约 3×（UTF-16 字符串 + fetch 的 UTF-8 编码 + 拷贝）降到约 1.1×。**步骤二（可选，§7）**：ME-C 合入并实测后若 CPU / 分配仍以序列化为主，再做按消息片段缓存，那时需要 `downgradeBlocks` 保持身份。 |
| D4  | **#139 并入 M-A**：根因是 ACP 的 `PromptQueue` 只串行化 ACP 自己的 prompt，`TaskNotifier` 以 `followUp` 在父会话空闲时开的通知回合不在队列里，`runPrompt` 调 `session.prompt(text)` 不带 `streamingBehavior` → `busy`（`session.ts:346`）。修法放 `acp-sessions.ts`：`promptWhenIdle(session, text, images, job)`——`while (session.state.isStreaming) await session.waitForIdle()`，再 `prompt`；捕获 `AmaError("busy")`（与通知器竞速输了）就再等一轮，`job.cancelRequested` 时退出回 `cancelled`。**不用 `streamingBehavior: "followUp"` 入队**：`abort()` 不清队列，客户端在等待期间 `session/cancel` 会让这条提示在下一个周期冒出来。文档 `docs/acp.md` 的「排队」语义因此对后台通知也成立；`Closes #139`。它与 P0-2 同文件、同测试驱动，分开做反而要两次改 `prompt()`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D5  | **图片 base64 按内容哈希驻留**（P1-1）。对报告「`WeakRef` 表 sha256 → 字符串」的修正：`WeakRef` 的目标不能是字符串原始值。新文件 `src/ai/image-intern.ts`：`internImage(block: ImageBlock, hash?: string): ImageBlock`——表为 `Map<sha256hex, WeakRef<ImageBlock>>` + `FinalizationRegistry` 清键；命中时返回**已驻留的那个 block 对象**（调用方把它放进内容数组，字符串随之共享），未命中登记并返回入参。哈希：`read` / `loadImageFile` 用 `fit.buf`（缩放后的原始字节）算 sha256（native，快）；会话加载时只能对 base64 字符串算 sha256（55 MB 约 100 ms，可接受）。三个入口：`read.ts readImage`（1 行）、`image-file.ts loadImageFile`（1 行）、`SessionManager.open` 之后对 `message` 条目的 `content` 数组做一次 `internSessionImages(entries)`（manager.ts +3 行；条目对象就地替换 block 引用，JSONL 不变）。驻留对象只在仍被某条消息引用时存活，不增加常驻。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D6  | **会话文件改为字节级分块读取**（P1-2 / P1-3）。新文件 `src/session/line-reader.ts`：`forEachLineSync(file, visit(lineBuf: Buffer, index, last, byteOffset): boolean \| void)` 用 fd + 64 KiB 块、`indexOf(0x0a)`、跨块残片 `Buffer.concat`，回调返回 `false` 立即 `closeSync` 返回；提供 `lineTypeOf(buf)`（只解码前 96 字节后复用 `scan.ts lineType`）。`store.ts readSessionLines` 改为逐行 `JSON.parse(buf.toString("utf8"))`，不再生成全文字符串与 `split` 数组；修复半行用回调给的 `byteOffset` 直接 `truncateSync(file, offset)`（比现在的 `Buffer.byteLength(join)` 更便宜且相同）。`scan.ts forEachLine` 改为包装 `forEachLineSync`，签名不变（`line: string`），提前返回真的停止读盘。`SessionManager.list` 的实现搬到新文件 `src/session/list.ts`（`listSessionItems(dir)`，manager.ts 只留一行委托）：头 + 首条条目解析，其余行只看 `lineTypeOf`：`message` 且 role ≠ system → `messageCount++`；首个 `user` 行与每个 `session_info` 行才 `JSON.parse`；口径与现状一致（`migrateSessionLines` 对 v1 只做校验与 leaf 剥离，`leaf` 行不算条目；损坏文件照旧跳过——中间坏行只影响该文件）。                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D7  | **全局 `ama` 命令指向 bundle**（P1-4）：`package.json` `bin.ama` → `dist/bundle/ama.cjs`（已带 shebang、`chmod 755`、`__AMA_VERSION__` 内联，`version.ts` 不再读 package.json；`import.meta.url` 由构建替换；`ama-sandbox.cjs` 按同目录查找）。库导出（`.`、`./host`、`./rpc`、`./tui`、`./acp`）仍是 ESM `dist/*.js`。`scripts/release-check.mjs` 加一条：`bin.ama` 指向的文件存在、首行是 shebang、`exports["./bundle"]` 与之相同。`AMA_E2E=1 pnpm test:e2e` 已全程跑 bundle，再补一条「`node_modules/.bin/ama --version`（`pnpm pack` 后在临时目录安装）」的端到端。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D8  | **子 Agent 句柄 LRU 16 → 4，并可配置**（P1-5）：`subagent-registry.ts` 只改常量值（不加行）；新配置键 `subagents.retainSessions`（整数 ≥ 0，缺省 4）经 `compose-agents.ts` 写进 `env.retain`（已有字段，现只在测试里用）。不做「闲置 N 分钟释放」——需要在 600 行的 registry 里加计时逻辑；被释放的子会话续聊时按现有逻辑从 JSONL 重开，语义不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D9  | **RPC 精简事件是客户端能力位**（P1-6）：`RpcCapability` 加 `"compact_events"`；客户端 `set_client_capabilities` 声明后，`json-event.ts toWireEvent(event, { compact })` 对三类事件去重：`turn_end.toolResults[]` 每项只留 `{ toolCallId, toolName, isError, timestamp, contentOmitted: true }`；`message_start` 的 `message` 若是 `toolResult` / 带图片的 `user`，`content` 换成 `""` 并加 `contentOmitted: true`；`entry_appended.entry` 为 `message` 类型且 role 是 `toolResult` / `user` 时同样处理。**`message_end` 与 `tool_execution_end` 保持全量**（前者是客户端替换整条消息的依据，后者带 `details`）。未声明时线路形状逐字节不变；`hello.capabilities` 列表多一项（黄金 `prompt.out.jsonl` 等重录，PR 说明只多这一项）。`RPC_PROTOCOL_VERSION` 不变。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D10 | **codemode 子进程加堆上限**（P2-3）：`sandboxArgs` 首位插入 `--max-old-space-size=<n>`（V8 选项必须在 `--permission` 之前且在脚本之前；它不是权限相关标志，`--permission` 模式允许）；`n` 来自新配置键 `codemode.maxHeapMb`（整数 ≥ 0，缺省 256，0 = 不加）。子进程 OOM 时 Node 以非零码退出且 stderr 含 `heap out of memory`，宿主侧把它映射为脚本错误文案 `Script exceeded the codemode memory limit (<n> MB)`（固定英文，模型侧）。Electron 作为 node 运行时（`ELECTRON_RUN_AS_NODE`）同样接受 V8 选项；Node 22 / 24 在 CI 矩阵里都跑一次真实 OOM 用例。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D11 | **`Intl.Segmenter` 惰性初始化**（P2-2）：`tui/ansi.ts:12` 改为模块内 `let` + `segmenter()` 取用函数，两处调用点改调函数；`-p` / RPC / ACP / `--version` 不再付这约 3 MB。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D12 | **fake 供应商的 CLI 缺省实例不留上下文**（P2-7）：`FakeProviderOptions.keepCalls?: boolean`（缺省 true，测试不变）；`defaultFakeProvider`（CLI 的 `AMA_FAKE_SCRIPT` 路径）传 `keepCalls: false`，`calls.push` 只留 `{ index }` 之外的轻量字段（`model`、`options`），`context` 不留；`AMA_FAKE_RECORD` 录制文件不受影响（它是跨进程的真实依据）。之后任何基于 fake 的内存测量不再有 30 MB 偏差。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D13 | **内存回归测试进 CI，用确定性断言**：① 泄漏：`WeakRef` + 显式 GC（vitest `poolOptions.forks.execArgv: ["--expose-gc"]`；helper 在 `globalThis.gc` 缺失时回落 `v8.setFlagsFromString("--expose-gc")` + `vm.runInNewContext("gc")`），`gcUntil(() => ref.deref() === undefined, rounds = 10)` 每轮 `gc()` + `setImmediate`；② 增长上限：`measureGrowth(fn)` 在前后各做两轮 GC 后比较 `heapUsed + external + arrayBuffers`，断言上界留 ≥ 3× 噪声余量（经验噪声 < 1 MB），且被测操作先热身一次再测；③ 对象计数：`FinalizationRegistry` 计数 `AgentSessionImpl` 实例；④ 字节不变：序列化、`read` 输出、会话列表字段都与旧实现 / 黄金逐字节比对。**不以 RSS 作硬断言**；RSS 与真实模型数字只进 benchmarks 文档。所有 CI 用例生成的临时文件 ≤ 32 MB、单测 < 5 s。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D14 | **测量口径**：验收数字以 `/usr/bin/time -l`（macOS）/ `--require` 探针的 `process.memoryUsage()` 峰值为准，场景脚本进仓库 `scripts/bench-memory.mjs` + `scripts/lib/mem-probe.cjs`（dev 工具，不进 `files`），结果写 `docs/benchmarks/memory-2026-10.md`（Z 汇总，中英各一份不需要——benchmarks 只有中文）。真实模型：astr/gpt-6-luna，M-A 8 次、M-B 10 次、M-D 4 次、Z 复测 10 次，合计 ≤ 32 次，每批 ≤ 15。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D15 | **有意不做**（§7）：P2-1 每请求 O(N) 转录复制（瞬时、GC 可回收，CPU 问题而非常驻；且 `projection.ts` / `transform.ts` 是 ME-B 的地盘）；P2-4 降级后释放 base64（牵涉 rewind / fork 的条目完整性，等 D5 实测后再评估）；P2-5 bundle minify（RSS 收益在噪声内，牺牲堆栈可读性）；P2-6 V8 新生代参数（报告结论不确定）；RPC 写队列背压改造（64 KiB 分片已有，宿主读得慢时堆积是 D9 之外的另一问题，先看 D9 效果）；MessageView 滚动历史裁剪（3 MB，TUI 已有上限策略）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## §1 共享契约（`[M-C0]` 先落地，之后批次只消费）

C0 原则：只加可选字段 / 新空文件 / 无行为搬迁；`pnpm run ci` 绿；所有黄金、`prompt-budget`、rpc / acp 线路字节不变。

### §1.1 `src/rpc.ts`（+2 行）

```ts
export type RpcCapability = "approvals" | "images" | "hooks" | "plans" | "compact_events";
// hello.capabilities 由 M-G 加入 "compact_events"（C0 不改 RPC_CAPABILITIES，黄金不变）
```

### §1.2 `src/ai/cache/types.ts`（+6 行）与 `reporting.ts`（类型替换，行为不变）

```ts
/** [M-A] 端点上一条可比请求的摘要；只存比较需要的字段，不持有转录与回调。 */
export interface LastRequest {
  at: number;
  promptTokens: number;
  fingerprint: PrefixFingerprint;
}
```

C0 把 `EndpointState.last: RequestRecord | undefined` 改成 `LastRequest | undefined`，`observe()` 写入 `{ at, promptTokens, fingerprint }`（这本身就是 L2 的修复，但零风险：`observe` 只读这三个字段）。`reporting.test.ts` 加一条「`last` 不含 `options` / `contextRef`」的类型级断言（`satisfies`）。

### §1.3 `src/config/types.ts`、`schema.ts`、`json-schema.ts`、`settings-registry.ts`、`key-docs.ts`、`src/i18n/messages/config-keys.ts`

| 键                         | 类型 / 缺省              | 消费者 |
| -------------------------- | ------------------------ | ------ |
| `subagents.retainSessions` | 整数 ≥ 0，缺省 4         | M-F    |
| `codemode.maxHeapMb`       | 整数 ≥ 0，缺省 256，0 关 | M-F    |

i18n：`config-keys` 两条说明 en / zh。ME-C0（#134）已改过这组文件并合入，没有在飞的冲突。

### §1.4 新空文件（签名就位，实现归各批）

```ts
// src/ai/json-body.ts [M-B]
export const LARGE_STRING_BYTES = 64 * 1024;
/** 与 Buffer.from(JSON.stringify(body), "utf8") 逐字节相同；大字符串不经中间字符串。 */
export function serializeJsonBody(body: unknown): Buffer; // C0：return Buffer.from(JSON.stringify(body))

// src/ai/image-intern.ts [M-D]
export function sha256Hex(data: Buffer | string): string;
export function internImage(block: ImageBlock, hash?: string): ImageBlock; // C0：原样返回
export function internSessionImages(entries: readonly SessionEntry[]): number; // C0：返回 0

// src/session/line-reader.ts [M-C]
export interface LineVisit {
  (line: Buffer, index: number, last: boolean, byteOffset: number): boolean | void;
}
export function forEachLineSync(file: string, visit: LineVisit, chunkBytes?: number): void; // C0：实现（纯新增、无调用方）
export function lineTypeOf(line: Buffer): { type: string; role?: string } | undefined;

// src/session/list.ts [M-C]
export function listSessionItems(dir: string): SessionListItem[]; // C0：把 SessionManager.list 的函数体原样搬来；manager.ts 改为一行委托

// src/tools/read-lines.ts [M-E]
export const STREAM_READ_THRESHOLD = 1024 * 1024;
export interface LineWindow {
  lines: string[];
  totalLines: number;
  truncatedBy?: "bytes";
  bom: boolean;
}
export function readLineWindow(
  abs: string,
  offset: number,
  limit: number | undefined,
  maxBytes: number,
): LineWindow; // C0：签名 + throw not implemented（无调用方）

// src/modes/acp/acp-sessions.ts [M-A]
export async function promptWhenIdle(session: AgentSessionImpl, job: PromptJob): Promise<void>; // C0：直接 session.prompt（行为不变）
```

### §1.5 测试基建（C0）

- `vitest.config.ts`：`poolOptions: { forks: { execArgv: ["--expose-gc"] } }`。
- `test/helpers/memory.ts`：`forceGc()`、`gcUntil(pred, rounds = 10)`、`measureGrowth(fn, { warmup: true })` → `{ heapUsed, external, arrayBuffers, total }`、`trackInstances(ctor)`（`FinalizationRegistry` 计数器）、`makeTextFile(path, bytes, { crlf?, bom?, cjk?, trailingNewline? })`、`makeSessionFile(path, { messages, imageBytes? })`（用真实 `SessionManager` 写出，保证格式一致）。
- `test/memory/`（新目录，vitest 的 `test/**/*.test.ts` 已包含）：各批把回归用例放这里，C0 先放 `helpers.test.ts` 验证 `gc` 可用、噪声 < 1 MB。
- `scripts/lib/mem-probe.cjs`（`--require` 探针：`AMA_MEM_LOG` / `AMA_MEM_INTERVAL` / `AMA_MEM_SNAP_EXIT`，收 `SIGUSR1` 做 GC 并记一行）与 `scripts/bench-memory.mjs`（场景：`version`、`print`、`read-huge`、`resume`、`list`、`acp-pool`、`rpc-bytes`、`mock-http`——mock Responses SSE 服务内置其中；输出 Markdown 表）。零依赖、只 `node:*`。

### §1.6 文档与记录（C0）

- `docs/memory-plan.md`（本文）；`docs/research/memory-2026-10.md`（报告整理稿：去掉 §7 外部项目名与所有 `/tmp` 路径，复现脚本改指向 `scripts/bench-memory.mjs`）。
- `docs/rpc.md` / `docs/en/rpc.md`：`set_client_capabilities` 能力表加 `compact_events`（标「M-G 起生效」）。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 未发布段建子标题「Memory footprint」/「内存占用」。
- Issue #136 回填：方案链接、label `ready`。

## §2 行为细节

### §2.1 `read` 字节窗口（M-E；D1）

`executeRead` 文本分支：

```ts
if (info.size <= STREAM_READ_THRESHOLD) { …现有路径不变… }
else {
  const head = readHead(abs, SNIFF_BYTES);               // 一次 readSync
  if (isBinary(head)) return error(...);                 // 文案不变
  const win = readLineWindow(abs, offset, input.limit, DEFAULT_MAX_BYTES);
  // win.lines 已去 BOM（仅首行）、已按 LF 切、已去行尾 \r；totalLines 口径 = 现有 split 规则
  …之后 numberLines / truncateHead / 尾注与现有代码完全同一段…
}
```

`readLineWindow`：单次顺序扫描；第 `offset` 行之前只计数；窗口内每行 `toString("utf8")` 并累计字节，达到 `maxBytes` 后停止收集（多收一行以便 `truncateHead` 判断 `truncated`，与现状行为一致），之后继续只计数到 EOF 得 `totalLines`。空文件 / 末尾无换行 / 只有换行的文件与现有 `normalized.replace(/\n$/, "").split("\n")` 口径对齐（`"a\n"` → 1 行，`"a"` → 1 行，`"\n"` → 1 行空串，`""` → 0 行）。**`offset > totalLines` 的错误文案需要 `totalLines`**：此时要扫到 EOF，仍是 O(1) 内存。孤立 `\r`：现有 `normalizeToLF` 把 `\r` 也当换行；字节窗口用 `indexOf(0x0a)` 定行后对行内孤立 `\r` 再 split 一次，保证口径相同（R1）。`ctx.markRead(abs)` 位置不变。

验收数字：读 255 MB 文件前 100 行，峰值 RSS 757 MB → **≤ 110 MB**（`grep` 同文件 98 MB）。

### §2.2 ACP 释放与排队（M-A；D2、D4）

```ts
// acp-server.ts prompt()
const onAbort = () => {
  if (this.peer.isOpen) this.cancelJob(job);
};
signal?.addEventListener("abort", onAbort, { once: true });
try {
  answer = await result;
} finally {
  signal?.removeEventListener("abort", onAbort);
}
```

```ts
// acp-sessions.ts
export async function promptWhenIdle(session, job): Promise<void> {
  for (;;) {
    if (job.cancelRequested) return;
    while (session.state.isStreaming) await session.waitForIdle(); // 后台通知回合在跑：等
    try {
      await session.prompt(job.text, job.images.length > 0 ? { images: job.images } : {});
      return;
    } catch (error) {
      if (!(error instanceof AmaError && error.code === "busy")) throw error; // 与通知器竞速输了：再等
    }
  }
}
```

`runPrompt` 以 `promptWhenIdle(session, job)` 替换直接调用；`cancelJob` 对「在等空闲」的 job 置 `cancelRequested` 并 `session.abort()`（中断正在跑的通知回合是可接受的——客户端明确取消了这个会话）。`session/close` 同理。

### §2.3 请求体（M-B；D3）

`serializeJsonBody` 的结构遍历只处理普通对象与数组；遇到有 `toJSON` 的对象、非对象值、或不含大字符串的子树一律 `Buffer.from(JSON.stringify(v))`。键用 `JSON.stringify(key)`；对象里值为 `undefined` / function / symbol 的属性跳过（与原生一致）；数组里这些值写 `null`。大字符串判定：`typeof v === "string" && v.length >= LARGE_STRING_BYTES && !NEEDS_ESCAPE.test(v)`。`postJson` 改一行；`PostOptions.body` 类型不变（`unknown`）。`postWithCacheFallback` 的 `stripWithCount` 仍对对象工作，不受影响；`onPayload` 替换的也是对象。

验收数字：mock HTTP 300 步 + 15 次读图，峰值 1.19 GB → **≤ 650 MB**；`postJson` 分配 13 GB → **≤ 1.3 × 请求体总字节**（4.5 GB → ≤ 6 GB，用 `inspector` 采样复测）；真实 astr 8 提示 2 图 392 MB → **≤ 300 MB**（与 D5 叠加）。

### §2.4 会话文件（M-C；D6）

`readSessionLines(file, { repair })` 新实现：

```ts
forEachLineSync(file, (buf, index, last, offset) => {
  if (buf.length === 0 || isBlank(buf)) return;
  try {
    lines.push(JSON.parse(buf.toString("utf8")));
  } catch (error) {
    if (last) {
      repairedTail = true;
      if (repair) truncateSync(file, offset);
      return false;
    }
    throw new AmaError("session_corrupt", `${file}:${index + 1}: invalid JSON line`, {
      cause: error,
    });
  }
});
// 末行完整但缺 LF 且 repair：appendRaw("\n")（现状保留；last 为 true 且能解析时）
```

`listSessionItems(dir)`：每个文件 `forEachLineSync`，index 0 解析为头（非 `type: "session"` → 跳过该文件），index 1 解析为首条（给 `isSubagentSession`），其余行 `lineTypeOf(buf)`；`type === "message"` 且 `role !== "system"` → `messageCount++`，且首个 `role === "user"` 解析取 `firstPrompt`；`type === "session_info"` 解析取 `name`；`lineTypeOf` 为 undefined（其它程序写的行）→ 退回 `JSON.parse` 判类型（与 `scan.ts` 注释一致）。不再调用 `migrateSessionLines`——它对 v1 的校验（头版本、条目有 id）在列表里的作用只是"坏文件跳过"，等价改为：头 `version !== 1` 跳过。对 fixture 目录下全部会话文件断言新旧实现返回的 `SessionListItem[]` 深度相等。

验收数字：`sessions list` 4 × 55 MB 峰值 486 MB → **≤ 110 MB**；`-p --resume` 55 MB 会话 333 MB → **≤ 200 MB**；TUI 恢复 358 → ≤ 220 MB。

### §2.5 图片驻留（M-D；D5）

`read.ts readImage`：`{ type: "image", data: fit.buf.toString("base64"), mimeType }` → `internImage({...}, sha256Hex(fit.buf))`；`image-file.ts loadImageFile` 同。`manager.ts open()` 在 `migrateSessionLines` 之后 `internSessionImages(entries)`（遍历 `message` 条目 `content` 为数组的块，对 `type === "image"` 做 `internImage(block)`——哈希对 `data` 字符串算；条目对象是刚解析出来的，就地替换数组元素安全；`fork` 的 `structuredClone` 会复制字符串？不会——V8 的 structuredClone 对字符串按值语义但底层仍可共享只读字符串，且 fork 的新 manager 立即 `flush` 落盘；不对 fork 结果再驻留）。`session-images.ts` 的 `withinLimits` 以 `data.length` 计总量，不受驻留影响（同一张图读两次仍按两次算预算——这是预算语义，不改）。

验收数字：3 个文件读 15 次，堆中 base64 字符串 15 份（46 MB）→ **3 份**；TUI 长会话峰值 334 MB → ≤ 300 MB。

### §2.6 分发、子 Agent、codemode、TUI、fake（M-F；D7、D8、D10、D11、D12）

见决策表。`sandboxArgs(entry, capability, heapMb = DEFAULT_CODEMODE_HEAP_MB)` 第三参可选；`runSandbox` 的 `request.options.maxHeapMb` 从配置带入；`host-side.test.ts` 现有的 `sandboxArgs` 断言按新首位元素更新。

验收数字：全局 `ama --version` 105–107 MB → **≤ 82 MB**，启动 0.17 s → ≤ 0.10 s；`-p` 一轮 110–116 → ≤ 98 MB；codemode 子进程分配 400 MB 的脚本在 256 MB 上限下以脚本错误结束，宿主 RSS 不变。

### §2.7 RPC 精简事件（M-G；D9）

`rpc-mode.ts`：`subscribe` 的 `write(toWireEvent(event, { compact: ctx.capabilities.has("compact_events") }))`；`json-event.ts` 新增 `compactEvent()`，`stream-json` 输出格式不受影响（不传 compact）。`docs/rpc.md` 事件表三行加「声明 `compact_events` 时」列。

验收数字：fake 100 步、单个 1 MB 结果，stdout 事件字节 86 MB → **≤ 30 MB**（−65%）；单元测试断言 compact 下三类事件不含该结果文本且 `message_end` / `tool_execution_end` 仍含。

## §3 实施批次与文件所有权

### §3.0 与 #135（model-efficiency）的交集与先后

| 文件                                                                                 | #135 批次                       | 本计划批次       | 处理                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `src/tools/read.ts`                                                                  | ME-D（D11 截断、描述）          | M-D（1 行）、M-E | **M-E 在 ME-D 合入后做**；M-D 的 `readImage` 一行可先行（不在 ME-D 的改动区） |
| `src/ai/http.ts`                                                                     | ME-C（两段超时）                | M-B（1 行）      | M-B 在 ME-C 之后，或两者只在 `fetch(...)` 的 `body:` 一行相撞，后合者 rebase  |
| `src/ai/fake/fake-provider.ts`                                                       | ME-C（录 rawArguments）         | M-F（keepCalls） | M-F 在 ME-C 之后                                                              |
| `src/agent/subagent-registry.ts`                                                     | 不改                            | M-F（常量值）    | 无冲突；不加行                                                                |
| `src/agent/session-cache.ts`、`projection.ts`、`context.ts`、`session-compaction.ts` | ME-B                            | 不碰             | —                                                                             |
| `src/ai/cache/reporting.ts`                                                          | 不在 ME 任何批次                | M-C0 / M-A       | Issue 评论里的担心不成立；可立即做                                            |
| `src/config/*`、`i18n/messages/config-keys.ts`                                       | ME-C0（已合）                   | M-C0             | 自由                                                                          |
| `src/modes/acp/*`、`drivers/jsonrpc.ts`                                              | 不在 ME                         | M-A              | 自由                                                                          |
| `src/session/store.ts`、`scan.ts`、`manager.ts`                                      | 不在 ME（ME-C0 的 `fork` 已合） | M-C              | 自由                                                                          |
| `src/modes/rpc/*`、`src/rpc.ts`、`json-event.ts`                                     | 不在 ME                         | M-G              | 自由                                                                          |
| `CHANGELOG ×2`、`docs/rpc.md`、`docs/design.md`                                      | 各批追加 / Z 统稿               | 同规则           | 两计划各自子标题；`design.md` 都只在 Z 合入                                   |

结论：**M-C0、M-A、M-C、M-D（除 read.ts 一行）、M-G 可与 #135 的 A–D 完全并行**；**M-B、M-E、M-F 等 ME-C / ME-D 合入后开始**（M-E 的 `read-lines.ts` 与其单测可先写，只有 `read.ts` 接线等）。

### `[M-C0]` 契约与基建（§1 全部）

| 文件（唯一属主 C0）                                                                                                                                                                                                                                                | 内容       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `src/rpc.ts`、`src/ai/cache/types.ts`、`src/ai/cache/reporting.ts`、`reporting.test.ts`                                                                                                                                                                            | §1.1、§1.2 |
| `src/config/types.ts`、`schema.ts`、`json-schema.ts`、`settings-registry.ts`、`key-docs.ts`、`src/i18n/messages/config-keys.ts`、各测试                                                                                                                            | §1.3       |
| `src/ai/json-body.ts`、`src/ai/image-intern.ts`、`src/session/line-reader.ts`（含实现 + `line-reader.test.ts`）、`src/session/list.ts`、`src/session/manager.ts`（list 搬迁）、`src/tools/read-lines.ts`、`src/modes/acp/acp-sessions.ts`（`promptWhenIdle` 直通） | §1.4       |
| `vitest.config.ts`、`test/helpers/memory.ts`、`test/memory/helpers.test.ts`、`scripts/lib/mem-probe.cjs`、`scripts/bench-memory.mjs`                                                                                                                               | §1.5       |
| `docs/memory-plan.md`、`docs/research/memory-2026-10.md`、`docs/rpc.md`、`docs/en/rpc.md`、CHANGELOG ×2                                                                                                                                                            | §1.6       |

完成标准：`pnpm run ci` 绿；rpc / acp 黄金字节不变；`prompt-budget` 不变；`SessionManager.list` 搬迁前后 `manager.test.ts` 不改断言。

### `[M-A]` ACP 释放与排队（P0-2、#139；D2、D4）

| 文件所有权                                                                          | 改动                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `src/modes/acp/acp-server.ts`（+≤ 8 行）、`acp-sessions.ts`、`acp-sessions.test.ts` | §2.2                                                        |
| `src/modes/acp/acp-mode.test.ts`、新 `test/memory/acp-release.test.ts`              | 见下                                                        |
| `docs/acp.md`「多会话」节、`docs/en/acp.md` 同节                                    | close 后内存释放；后台子 Agent 通知回合进行中的 prompt 排队 |
| CHANGELOG ×2                                                                        | 两条（泄漏；#139）                                          |

测试：

1. **可回收**：fake 下开 N = 6 个会话各跑 2 轮（脚本含 1 次读图），`trackInstances(AgentSessionImpl)` 记 6 + 待命 1；逐个 `session/close`；`gcUntil` 后存活实例 == 1（待命），`taskControl(id) === undefined`，`sharedCacheReporting` 任何端点的 `last` 不含 `options`；`measureGrowth` 的 external 回到基线 ± 2 MB（图片全部释放）。
2. **#139**：会话 s1 的脚本派生后台子 Agent（`background: true`），子 Agent 结束触发通知回合（fake 延迟 1.5 s）；通知回合运行中发 `session/prompt` → 不报 -32603，等通知回合结束后开始，两回合 `session/update` 顺序正确；等待期间 `session/cancel` → 该 prompt 回 `cancelled` 且不在之后冒出。
3. `$/cancel_request` 撤回仍回 -32800（监听移除不影响取消语义）；连接关闭时在跑的运行照常结束。
4. 全部线上行过 `assertAcpWire`；黄金 `mode-prompt.jsonl` 不变。

真实测量（≤ 8 次）：astr 4 会话 × 2 轮纯文本后全部 close + GC：heap ≤ 20 MB、external ≤ 10 MB（报告基线 16 / 7，确认无回归），写 benchmarks「A」表。

### `[M-B]` 请求体序列化（P0-3；D3）——ME-C 之后

| 文件所有权                                       | 改动                           |
| ------------------------------------------------ | ------------------------------ |
| `src/ai/json-body.ts`、`json-body.test.ts`（新） | §2.3                           |
| `src/ai/http.ts`（1 行）、`http.test.ts`         | `body: serializeJsonBody(...)` |
| `test/memory/json-body.test.ts`                  | 见下                           |
| `docs/design.md` §3.1 一行（经 Z）               | 文档                           |
| CHANGELOG ×2                                     | 一条                           |

测试：

1. **字节不变**：对 ① 四份 rpc / acp 黄金里录到的 fake `context` 经 `buildAnthropicRequest` / `buildOpenAIRequest` / `buildResponsesRequest` / `buildGoogleRequest` 生成的 body（含 `cache_control`、图片块）；② 500 个随机 JSON（含 `toJSON`、`undefined`、`NaN`、`-0`、嵌套空对象、U+2028、孤立代理项、≥ 64 KiB 的 base64 与含引号 / 反斜杠 / 控制字符的大字符串）——`serializeJsonBody(b).equals(Buffer.from(JSON.stringify(b), "utf8"))`。
2. **增长上限**：含 6 张 3 MB base64 的 body（≈ 20 MB）序列化：`heapUsed` 增长 **< 3 MB**，`external + arrayBuffers` 增长在 **[0.95, 1.15] × 结果长度**（结果 Buffer 自身），热身后测。
3. `http.test.ts`：fake `fetch` 收到的 `body` 是 `Uint8Array` 且解码后等于 `JSON.stringify(options.body)`；`postWithCacheFallback` 剥离重发路径不变。
4. `cache-stability.test.ts` 既有用例不改断言（请求体内容未变）。

真实测量（≤ 10 次）：astr TUI 5 个提示、2 张图（复现报告场景的一半）：峰值 RSS 与 `heapUsed` 峰值写 benchmarks「B」表，目标 ≤ 300 MB（叠加 M-D）。

### `[M-C]` 会话文件流式读取（P1-2、P1-3；D6）

| 文件所有权                                                    | 改动             |
| ------------------------------------------------------------- | ---------------- |
| `src/session/store.ts`（`readSessionLines`）、`store.test.ts` | §2.4             |
| `src/session/scan.ts`（`forEachLine` 包装）、`scan.test.ts`   | 提前返回真的停读 |
| `src/session/list.ts`、`list.test.ts`（新）                   | 流式列表         |
| `test/memory/session-files.test.ts`                           | 见下             |
| `docs/sessions.md` 一句、`docs/en/sessions.md`                | 列表不再整读文件 |
| CHANGELOG ×2                                                  | 一条             |

测试：

1. **口径一致**：`test/fixtures` 下全部 `.jsonl`（含 trace fixtures、含 `leaf` 行、含 `session_info` 多次改名、CRLF、末尾半行、非 ama 写入的行）新旧 `list` 结果深度相等；`readSessionLines` 新旧 `lines` 深度相等、`repairedTail` 相同、修复后文件字节相同。
2. **增长上限**：`makeSessionFile` 生成 24 MB（含中文文本与 2 张 1 MB 图）：`listSessionItems` 的 `heapUsed + external` 增长 **< 2 MB**；`readSessionLines` 增长 **< 1.0 × 文件字节 + 2 MB**（旧实现因 UTF-16 全文 + `split` 数组 ≥ 2.5×）。
3. `forEachLine` 回调在第 3 行返回 `false`：读取的字节数（fd 读计数经 `chunkBytes` 注入断言）≤ 2 块。
4. 中间坏行 → `session_corrupt` 行号一致；`session_not_found` 一致。

真实测量：0 次。

### `[M-D]` 图片驻留（P1-1；D5）——`read.ts` 一行等 ME-D

| 文件所有权                                                                                                         | 改动 |
| ------------------------------------------------------------------------------------------------------------------ | ---- |
| `src/ai/image-intern.ts`、`image-intern.test.ts`                                                                   | §2.5 |
| `src/tools/image-file.ts`（1 行）、`src/tools/read.ts`（1 行，ME-D 后）、`src/session/manager.ts`（+3 行）、各测试 | 接线 |
| `test/memory/image-intern.test.ts`                                                                                 | 见下 |
| CHANGELOG ×2                                                                                                       | 一条 |

测试：

1. 同一 PNG 经 `executeRead` 读 5 次，5 个 `ImageBlock.data` **`===` 同一字符串**；`measureGrowth` 第 2–5 次合计增长 < 200 KB。
2. `loadImageFile` 与 `executeRead` 读同一文件 → 同一字符串（自动附图 + 工具读图去重）。
3. 会话文件里同一图片出现 4 次，`SessionManager.open` 后 4 个 block 的 `data` 同一引用；`fork`、`rewind`、`getEntries`、落盘字节不受影响（黄金）。
4. 驻留表的 `WeakRef` 在所有引用释放 + `gcUntil` 后 `deref() === undefined` 且 `FinalizationRegistry` 清掉键（表大小回 0）。
5. `session-images.test.ts` 既有预算用例不变。

真实测量（≤ 4 次）：astr 1 个提示附图 + 模型 `read` 同一图（2 次请求）：`heapUsed` 峰值比报告同场景低 ≥ 1 份图片大小。

### `[M-E]` `read` 字节窗口（P0-1；D1）——ME-D 之后

| 文件所有权                                              | 改动 |
| ------------------------------------------------------- | ---- |
| `src/tools/read-lines.ts`、`read-lines.test.ts`（新）   | §2.1 |
| `src/tools/read.ts`（文本分支 ≈ 12 行）、`read.test.ts` | 接线 |
| `test/memory/read-huge.test.ts`                         | 见下 |
| `docs/design.md` §5.2 read 行（经 Z）                   | 文档 |
| CHANGELOG ×2                                            | 一条 |

测试：

1. **逐字节相同**：对 fixture 集合（空、无尾换行、只有 `\n`、CRLF、孤立 `\r`、BOM、CJK 与 emoji、单行 100 KB、2500 行、跨 64 KiB 块边界的多字节字符、`offset` 在末行 / 超界、`limit` 覆盖 / 不覆盖）把 `STREAM_READ_THRESHOLD` 注入为 0 与 `Infinity`，两条路径 `content` 与 `details` 深度相等。
2. **增长上限**：生成 32 MB 文本（每行 80 字节、含中文），`executeRead({ offset: 1, limit: 100 })` 的 `heapUsed + external + arrayBuffers` 增长 **< 2 MB**（旧实现 ≥ 3 × 32 MB）；`offset: 400000`（接近尾部）同样 < 2 MB；`offset` 超界的错误文案给出正确 `totalLines`。
3. 二进制文件（> 1 MiB，NUL 在前 8000 字节内）仍拒绝；NUL 在 8000 字节之后的大文件与现状一样当文本（口径不变）。
4. `prompt-budget` 三档不变（描述未改）。

真实测量：0 次（`bench-memory.mjs read-huge` 本地复测 255 MB 用例，写 benchmarks「E」表）。

### `[M-F]` 分发、子 Agent 保留、codemode 堆、TUI、fake（P1-4、P1-5、P2-2、P2-3、P2-7；D7、D8、D10–D12）——ME-C 之后（fake 一行）

| 文件所有权                                                                                                                                             | 改动 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `package.json`（`bin`）、`scripts/release-check.mjs`、`test/release-check.test.ts`、`test/e2e/print.e2e.test.ts`（装包用例）                           | D7   |
| `src/agent/subagent-registry.ts`（常量值）、`src/cli/compose-agents.ts`（+2 行）、`subagent-registry.test.ts`、`compose-agents.test.ts`                | D8   |
| `src/codemode/host-side.ts`、`host-side.test.ts`、`os-sandbox.test.ts`、`src/codemode/types.ts`（`maxHeapMb`）、`src/cli/compose-*`（配置带入处 1 行） | D10  |
| `src/tui/ansi.ts`、`ansi.test.ts`                                                                                                                      | D11  |
| `src/ai/fake/fake-provider.ts`、`fake-provider.test.ts`                                                                                                | D12  |
| `docs/agents.md`（保留数 + 配置键）、`docs/codemode.md`（堆上限）、`docs/en/*` 无对应（这两篇无英文版）、README 两份「安装」不变                       | 文档 |
| CHANGELOG ×2                                                                                                                                           | 四条 |

测试：`sandboxArgs(entry, cap)[0] === "--max-old-space-size=256"`、`maxHeapMb: 0` 时不含；真实子进程跑 `new Array(5e7).fill("x".repeat(16))` 的脚本 → `ok: false` 且错误含 `memory limit`、宿主进程 `heapUsed` 增长 < 5 MB；注册表 6 个任务后前 2 个 `handle` 被 dispose（`retain` 缺省 4）；`ansi.ts` 首次 `stringWidth` 之前 `Intl.Segmenter` 未构造（用 `vi.spyOn(Intl, "Segmenter")`）；`defaultFakeProvider.calls[i].context === undefined` 而 `new FakeProvider()` 仍有；`release:check` 对 `bin` 的三条断言。

真实测量：0 次。

### `[M-G]` RPC 精简事件（P1-6；D9）

| 文件所有权                                                                                  | 改动                             |
| ------------------------------------------------------------------------------------------- | -------------------------------- |
| `src/modes/print/json-event.ts`、`json-event.test.ts`（新或现有）                           | `compactEvent`                   |
| `src/modes/rpc/rpc-mode.ts`、`commands.ts`（`RPC_CAPABILITIES` 加一项）、`rpc-mode.test.ts` | 能力位接线；黄金重录（只多一项） |
| `test/memory/rpc-bytes.test.ts`                                                             | 见下                             |
| `docs/rpc.md`、`docs/en/rpc.md`                                                             | 事件表三行、能力说明             |
| CHANGELOG ×2                                                                                | 一条                             |

测试：fake 脚本一次 `read` 返回 1 MB 文本：未声明时 stdout 含该文本的事件恰 5 条（现状基线，守住不变）；声明 `compact_events` 后恰 2 条（`message_end`、`tool_execution_end`），`turn_end.toolResults[0].contentOmitted === true`，`entry_appended` 的 `message.content === ""`；总字节比 < 0.45；`stream-json` 输出不变。

### `[M-Z]` 收尾（A–G 合入后）

- `docs/design.md`：§3.1（请求体序列化一行）、§5.2（read 行）、§5.5（codemode 堆上限）、§13.2（`compact_events`）、§14（`bin` → bundle）、新增 §9.2「内存预算」表（场景 → 上限 → 守护测试）。
- `docs/benchmarks/memory-2026-10.md`：A / B / D 的真实测量 + `bench-memory.mjs` 全场景本地复测（与报告 §2 同表对照，前后两列）；Z 复测 ≤ 10 次真实请求。
- `docs/en/` 七篇与中文版通读对齐；CHANGELOG 两份归并到发版号；Issue #136 / #139 关闭。
- 全量 `pnpm run ci`、`AMA_E2E=1 pnpm test:e2e`。

### 共享文件规则

| 文件                                                                                                             | 规则                                                      |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/i18n/messages/config-keys.ts`                                                                               | C0 加键；之后不改                                         |
| `docs/rpc.md` / `docs/en/rpc.md`                                                                                 | C0 加能力行；G 填事件表；Z 统稿                           |
| `docs/acp.md` / `docs/en/acp.md`                                                                                 | 只有 A 改                                                 |
| `docs/design.md`                                                                                                 | 各批把要改的行写在 PR 描述里，Z 一次合入                  |
| `CHANGELOG ×2`                                                                                                   | C0 建子标题，各批只追加自己的条目（与 #135 的子标题并列） |
| `src/tools/read.ts`                                                                                              | D 一行、E 文本分支；都在 ME-D 之后，D 先 E 后             |
| `src/session/manager.ts`                                                                                         | C0 搬 list；D 加 3 行；其它批不碰                         |
| `src/agent/session.ts`、`subagent-registry.ts`（除常量值）、`ai/providers/registry.ts`、`cli/compose-session.ts` | 本计划不改                                                |

## §4 验收

每批：`pnpm run ci` 绿；本批 `test/memory/*` 用例在三平台 × Node 22 / 24 稳定通过（上界按 D13 留余量）；rpc / acp 黄金除 G 的 `hello` 一项外字节不变；`prompt-budget` 三档不变；`cache-stability.test.ts` 不改断言；受影响文件 ≤ 600 行。

整体（Z，用 `scripts/bench-memory.mjs` 复测，前 → 后）：

| 场景                            | 报告基线        | 目标                | CI 守护                             |
| ------------------------------- | --------------- | ------------------- | ----------------------------------- |
| 全局 `ama --version`            | 105–107 MB      | ≤ 82 MB             | release:check `bin` 断言 + e2e 装包 |
| `-p` 一轮（fake）               | 92–98 MB        | ≤ 92 MB             | —（Segmenter 惰性由单测守）         |
| `read` 255 MB 前 100 行         | 757 MB          | ≤ 110 MB            | 32 MB 文件增长 < 2 MB               |
| `sessions list` 4 × 55 MB       | 486 MB          | ≤ 110 MB            | 24 MB 文件增长 < 2 MB               |
| `-p --resume` 55 MB             | 333 MB          | ≤ 200 MB            | 增长 < 1.0 × 文件 + 2 MB            |
| mock HTTP 300 步 + 15 次读图    | 1 189 MB        | ≤ 650 MB            | 序列化 heap 增长 < 3 MB、字节不变   |
| mock HTTP 300 步无图            | 366–487 MB      | ≤ 360 MB            | 同上                                |
| ACP 8 会话 × 4 轮 close + GC 后 | 409 MB / ext 90 | ≤ 120 MB / ext ≤ 10 | 实例可回收、external 回基线         |
| RPC 100 步事件字节              | 86 MB           | ≤ 30 MB（声明能力） | 字节比 < 0.45                       |
| 真实 astr 8 提示 2 图（TUI）    | 392 MB          | ≤ 300 MB            | —（benchmarks 记录）                |

## §5 文档与 CHANGELOG

- 中文：`docs/acp.md`（A）、`docs/rpc.md`（C0、G）、`docs/sessions.md`（C）、`docs/agents.md`、`docs/codemode.md`（F）、`docs/design.md`（Z）、`docs/benchmarks/memory-2026-10.md`（Z）、`docs/research/memory-2026-10.md`（C0）。
- 英文同步：`docs/en/acp.md`、`docs/en/rpc.md`、`docs/en/sessions.md`（agents / codemode 无英文版）。
- CHANGELOG（两份，子标题「Memory footprint」/「内存占用」）条目：ACP 关闭会话后内存释放；ACP 后台子 Agent 通知回合进行中的提示排队（#139）；请求体不再经整串字符串序列化（峰值内存约降一半，请求字节不变）；`read` 大文件按需读取；图片按内容去重；会话列表与恢复不再整读文件；全局 `ama` 走单文件 bundle（更快、更省）；子 Agent 会话保留数 16 → 4（`subagents.retainSessions`）；codemode 子进程堆上限 256 MB（`codemode.maxHeapMb`）；RPC `compact_events` 能力。
- 用户可见但不写 CHANGELOG：Segmenter 惰性、fake 不留上下文（测试基建）。

## §6 风险与未决问题

| #   | 风险 / 问题                                                                                                                                                                                                     | 处置                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| R1  | D1 口径细节：现路径 `normalizeToLF` 把孤立 `\r` 也当换行、`splitBom` 只去 UTF-8 BOM；字节窗口必须逐项对齐，否则 `totalLines` / 行号变化会改变工具输出（影响缓存前缀之外的 toolResult 内容，但不影响系统提示）。 | fixture 两路径逐字节比对（含孤立 `\r`、BOM + CRLF 组合）；阈值可注入让所有既有 `read.test.ts` 用例在流式路径再跑一遍。         |
| R2  | D3 `Buffer.concat` 瞬时仍有「片段 + 结果」约 2× 的短暂峰值；想到 1× 需以 `ReadableStream` 流式发送（chunked 传输），部分中转可能拒收。                                                                          | 本波用 Buffer；流式发送列为 §7 后续项，先在 `bench-memory mock-http` 上验证收益再议。                                          |
| R3  | D3 自写序列化若与原生在某个边角（如 `toJSON` 返回 `undefined`、`Symbol.toPrimitive`）不一致会破坏字节稳定。                                                                                                     | 结构遍历只在"普通对象 / 数组且含大字符串"时介入，其余一律原生；随机测试 + 黄金；`cache-stability` 守相邻回合。                 |
| R4  | D4 等待后台通知回合会让 ACP `session/prompt` 的响应变慢（通知回合通常几秒）；等待期间客户端看到的是另一回合的 `session/update`。                                                                                | 文档写明；Zed 侧本来就按 sessionId 显示；`session/cancel` 可随时打断。                                                         |
| R5  | D5 以 base64 字符串为键算 sha256（恢复大会话时约 2 MB/ms 量级，55 MB ≈ 30–100 ms）。                                                                                                                            | 只对 `content` 为数组且含 `image` 块的条目算；可接受；benchmarks 记录 resume 耗时前后。                                        |
| R6  | D6 `list` 不再经 `migrateSessionLines`：将来格式 v2 需要同时改 `list.ts`。                                                                                                                                      | `list.ts` 头部注释写明，并在 `migrate.ts` 的版本常量处留交叉引用；测试「`version !== 1` 的文件被跳过」。                       |
| R7  | D7 `bin` 指向 bundle：开发者 `pnpm link` 后要先 `pnpm build:bundle`；`--host` 加载用户 ESM 模块从 CJS 经 `import()` 已在 e2e 覆盖，但 Windows 下 `node_modules/.bin` 的 cmd shim 需实测一次。                   | CI Windows 作业已跑 `node dist/bundle/ama.cjs`；e2e 装包用例在三平台跑 `.bin/ama --version`；docs/design.md §14 写明开发流程。 |
| R8  | D8 保留 4 个子会话：频繁续聊 5 个以上任务时多一次磁盘重开（55 MB 子会话 ≈ 0.5 s）。                                                                                                                             | 可配 `subagents.retainSessions`；文档写明。                                                                                    |
| R9  | D9 需要宿主（Armadra）适配后才有收益；`hello.capabilities` 变化重录黄金。                                                                                                                                       | 可选能力，未声明时线路不变；PR 说明。                                                                                          |
| R10 | D10 256 MB 对处理大数据的 codemode 脚本可能不够；OOM 报错文案要能被模型理解并改用分片。                                                                                                                         | 可配 `codemode.maxHeapMb`（0 关闭）；错误文案含上限与建议「process in smaller pieces」。                                       |
| R11 | D13 GC 测试在 CI 慢机器上的时序：`gcUntil` 10 轮仍未回收会误报。                                                                                                                                                | 轮数可调（缺省 10，CI 环境变量可放宽到 30）；失败时打印仍存活的持有链提示（`v8.getHeapSnapshot` 只在本地调试开启）。           |
| R12 | L3 若不是待命会话而是真泄漏（例如 `registries` Map 在 `dispose` 之前被替换）。                                                                                                                                  | M-A 测试 1 直接断言 `taskControl(closedId) === undefined` 与实例可回收；失败再查 `registries` / `controls` 的替换逻辑。        |
| Q1  | M-B 步骤二（按消息片段缓存）是否做：取决于 M-B 后 mock 300 步的 CPU / 分配数据。推荐：Z 测完再决定，另开 Issue。                                                                                                |                                                                                                                                |
| Q2  | `compact_events` 是否也精简 `message_end` 里 toolResult 的 `content`（只留 `tool_execution_end`）：再省一份，但客户端重建消息列表要多一步。推荐：本波不精简，听 Armadra 反馈。                                  |                                                                                                                                |
| Q3  | `subagents.retainSessions` 缺省 4 还是 8。推荐 4：真实子会话转录常达数十 MB；续聊重开成本低。                                                                                                                   |                                                                                                                                |

## §7 有意不做（写进文档）

| 项                                                                                        | 理由                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| P2-1 每请求 O(N) 转录复制（`convertToLlm` / `pathToRoot` / `buildProjection` 按条目缓存） | 分配是瞬时的、GC 可回收，不抬常驻；收益主要是 CPU；`projection.ts` / `transform.ts` 在 #135 ME-B 改动中，等它稳定后另立计划。 |
| P2-4 图片被降级 / 压缩后释放 base64（条目改惰性引用）                                     | 牵涉 rewind / fork / `get_entries` 都要能回读原文；D5 去重后真实会话里剩余的旧图通常 < 50 MB；等 D5 实测后再评估。            |
| P2-5 bundle minify / charset ascii                                                        | RSS 变化在噪声内（源码字符串 −2 MB、heap −1.4 MB），牺牲报错堆栈可读性。                                                      |
| P2-6 V8 新生代参数（`--max-semi-space-size`）                                             | 报告自述结论不确定（机器有负载）；`bench-memory.mjs` 加一个开关供日后重复测量，不改缺省。                                     |
| 请求体以 `ReadableStream` 流式发送                                                        | chunked 传输对中转的兼容性未知；先拿 Buffer 的收益（R2）。                                                                    |
| 子 Agent 句柄「闲置 N 分钟释放」                                                          | 需要在 600 行的 `subagent-registry.ts` 加计时逻辑；LRU 4 已覆盖主要场景。                                                     |
| RPC 写队列背压 / 丢弃策略                                                                 | 宿主读得慢是另一类问题；D9 把字节量降 65% 后再看是否仍堆积。                                                                  |
| TUI `MessageView` 滚动历史裁剪                                                            | 3.19 MB，非主要项。                                                                                                           |
| 精简 `i18n/messages` 或按语言拆 bundle                                                    | 244 KB 源码对 RSS 影响可忽略；破坏「单 bundle」分发约定。                                                                     |

## 附：对报告的异议与修正汇总

1. P0-3「按消息 WeakMap 缓存序列化片段」在当前请求层不可行（消息身份每次请求重建；需改四个 #135 正在改的转换器；缓存 Buffer 增加常驻）→ 先做分块序列化器（D3），片段缓存留作步骤二。
2. L3 更像待命会话而非泄漏 → 以测试核实而不是先改代码（D2 ③）。
3. P1-1 `WeakRef` 不能指向字符串 → 以 `ImageBlock` 为驻留单元（D5）。
4. P1-5 的「闲置释放」与 600 行限制冲突 → 只改常量并加配置（D8）。
5. P0-1 阈值 8 MB → 1 MiB（D1），两条路径字节相同所以阈值只影响性能不影响行为。
6. 报告把 `reporting.ts` 列为与 #135 交集，核对 #135 计划后不成立（§3.0）。
