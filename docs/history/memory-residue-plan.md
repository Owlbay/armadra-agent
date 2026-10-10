# 内存优化遗留项设计（#165–#173）

> 状态：**已实施**（#165–#173 均已关闭）。
> 基线 `main` = `53ce1ed`（v0.7.4）。上游设计 docs/memory-plan.md（D1–D15）、实测 docs/benchmarks/memory-2026-10.md、§9.2 内存预算表 docs/design.md:859。
> 硬约束沿用 内存批次的共同规则：零运行时依赖；源码 ≤ 600 / 测试 ≤ 1000 行；`session.ts`(596)、`subagent-registry.ts`、`ai/providers/registry.ts`、`compose-session.ts` 不得加行；`acp-server.ts` 现 592 行，**整个 ACP 批只允许净 +≤ 8 行**；i18n en/zh；首请求 system+tools 逐字节稳定、`prompt-budget` 三档不变；协议新增字段只可选；测试只用 fake；内存断言用 test/helpers/memory.ts（WeakRef+GC、`measureGrowth`），不以 RSS 硬断言。
> 注意：CHANGELOG 两份目前没有未发布段（0.7.4 刚发）。第一个合入的批次新建 `## Unreleased` / `## 未发布` 与子标题 `### Memory footprint` / `### 内存占用`，其余批次 rebase 后只追加条目。

## §0 总览与分批

| 批            | Issue                  | 一句话                                                         | 拥有的文件（src/test/docs）                                                                                                                                                                                                                                    | 依赖                        | 规模               | 真实请求                                               |
| ------------- | ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------ | ------------------------------------------------------ |
| R-A ACP       | #165 #166 #167         | 启动会话可回收；usage 只算本回合；close 与通知器竞态           | `src/cli/bootstrap.ts`、`src/modes/acp/acp-server.ts`（净 ≤ +8）、`acp-sessions.ts`、`acp-sessions.test.ts`、`acp-mode.test.ts`（822→≤1000）、`test/memory/acp-release.test.ts`、`docs/acp.md`+`docs/en/acp.md`「多会话」节                                    | 无                          | 中（~250 行）      | ≤ 6（astr 4 会话×1 轮纯文本 → 全部 close 后 heap/ext） |
| R-B 请求体    | #168 #169              | 流式片段切小；图片片段免扁平化+免重扫                          | `src/ai/json-body.ts`+`.test.ts`、`test/memory/json-body.test.ts`、`src/ai/apis/{anthropic,openai,openai-responses,google}-request.ts`+各 test、必要时 `src/ai/apis/shared.ts`（`Json` 类型 1 行）                                                             | 无（ME-C 已合）             | 中（~200 行）      | ≤ 4（astr TUI 2 提示 2 图，前后各 1 次）               |
| R-C 会话卸载  | #170                   | 被 context_edit 降级的条目在内存里只留图片定位，按需从文件回读 | `src/session/manager.ts`、`store.ts`、新 `src/session/offload.ts`+`.test.ts`、`test/memory/session-offload.test.ts`（新）、`test/helpers/memory.ts`（`makeSessionFile` 加 `edits` 选项）、`docs/session-format.md`「内存表示」一段+`docs/en/session-format.md` | 无                          | 大（~400 行）      | 0                                                      |
| R-D read 异步 | #171                   | 字节窗口改异步分块，解析器共用                                 | `src/tools/read-lines.ts`+`.test.ts`、`src/tools/read.ts`（2 行）、`read.test.ts`、`test/memory/read-huge.test.ts`                                                                                                                                             | 无                          | 小（~120 行）      | 0                                                      |
| R-E 基准      | #173（E1）、#172（E2） | 脚本坏行容错 + 探针细分；#172 原生层剖析与结论                 | `scripts/bench-memory.mjs`、`scripts/lib/mem-probe.cjs`、`scripts/lib/bench-memory-fixtures.mjs`、新 `test/bench-memory-lines.test.ts`、`docs/benchmarks/memory-2026-10.md`、`docs/design.md` §9.2（统稿）                                                     | E1 无；E2 在 A–D 合入后复测 | E1 小；E2 调查为主 | 0                                                      |

并行关系：**R-A、R-B、R-C、R-D、R-E1 五个 worktree 完全并行**（文件两两不交）。串行点只有：① R-E2 必须在 A–D 合入后做最终复测与 §9.2 统稿；② R-B 内部 #168 先于 #169（同文件 json-body.ts，一个 PR 两个提交或两个 PR 同 worktree）；③ R-A 内部三项同改 acp-server.ts/acp-sessions.ts，一个 PR。
建议合并顺序：R-E1 → R-D → R-B → R-A → R-C → R-E2（见 §10）。

## §1 #165 启动会话被 Runtime 常驻

**根因**

- `src/cli/bootstrap.ts:393` `session: active`——Runtime 对象固定持有启动会话；`bootstrap.ts:353-363` `shutdown` 闭包里 `(session ?? active).dispose()` 再次捕获 `active`。
- `bootstrap.ts:392` `sessionManager,`（const）与 `assembly.sessionManager`（`bootstrap.ts:318`，`deps.ts:86`）持有启动会话的 `SessionManager` → `_entries` 里的转录与 ImageBlock 常驻；hooks `context` 闭包（`bootstrap.ts:288-293`）与 HostApi binding（`245-249`）引用 `sessionManager` const 作回退值。
- ACP 侧 `acp-server.ts:153-154` 把启动会话当 `standby` 认领，`close()`（`377-403`）走 `disposeSessionAlongside` 正常 dispose，但对象因上述引用不可达 → benchmarks「ACP ext 16.3 MB」。
- `compose-session.ts:403-406` `recordOf(runtime)` 以 `runtime.session` 为 WeakMap 键——`records` 对每个 `buildSession` 产物都 `set`（`:330`），所以键换成任一存活会话都能查到。

**方案**：让 `Runtime.session` / `Runtime.sessionManager` 跟随当前会话（getter），并切断 bootstrap 里对启动会话与其 manager 的闭包引用。

1. `bootstrap.ts`：`let manager: SessionManagerApi = sessionManager;`（同步阶段用它替代所有闭包里的 `sessionManager` 引用：hooks context、binding.session.*）；`onSessionReplaced: (next) => { session = next; manager = (next as { manager?: SessionManagerApi }).manager ?? manager; assembly.sessionManager = manager; }`；Runtime 返回对象改 `get session() { return session as AgentSession; }`、`get sessionManager() { return manager; }`；`shutdown` 改 `await session?.dispose()`；`active` 只在 `events.emit("session_start")` 同步使用。净 +≈4 行（521 行文件，可）。
2. `acp-server.ts` 不变（`close()` 已切前台到 fallback 再 dispose）。`AcpServer.initialMode` 只读了 `permissionMode`。
3. `test/memory/acp-release.test.ts`：去掉 `if (session !== runtime.session)` 的豁免，6 个会话全部登记；断言 `closed < 1 MB`（原 `< IMAGE_BASE64`）。

- 被否决：ACP 永不认领启动会话、另建兄弟会话——`--mode acp --resume <id>` 时启动会话已持有该文件锁（`manager.ts:131 acquireLock`），`session/load` 同 id 会撞锁，且多留一个空会话。
- 被否决：首个 close 时 `runtime.dispose()`——会跑 SessionEnd/宿主 dispose，语义错误。

**协议/格式影响**：无。SDK 可见变化：`Runtime.session` / `sessionManager` 从「初始会话」变为「当前会话」（实现计划 R5 的旧定义）；写 CHANGELOG 一条与 `docs/design.md` §11 一行（经 R-E2）。

**测试**：① acp-release：全部 close 后 `tracker.alive === 0`（含启动会话）、`heap+ext` 回到基线 ±1 MB；② `compose.test.ts`/`compose-session.test.ts`：`switchSession` 后 `runtime.session === currentSession(runtime)`、`runtime.sessionManager.id` 跟随；③ rpc/acp 黄金不变；④ `startup-screen` 仍读到启动时的 `permissionMode`。
**验收数字**：bench `acp-pool` 8×4 全部 close+GC：ext **≤ 10 MB**（现 16.3），heap ≤ 16；真实 astr 4 会话纯文本 close 后 ext ≤ 7（无回归）。
**风险**：有人依赖 `runtime.session` 不变（宿主 `--host` 模块经 HostApi 不直接拿 Runtime，SDK `createRuntime` 用户少）；`records.get(runtime.session)` 在会话刚 dispose、前台尚未切换的瞬间——`disposeSessionAlongside` 先切前台（`compose-session.ts:598-602`），窗口不存在。

## §2 #166 prompt usage 混入排队前的通知回合

**根因**：`acp-server.ts:445` `const before = session.getStats().tokens` 在 `promptWhenIdle`（`:448`）之前取样，而 `promptWhenIdle`（`acp-sessions.ts:223-235`）要先 `await session.waitForIdle()`——通知回合在这期间结束，其 token 被 `after - before` 计入。
**方案**：`promptWhenIdle(session, job, onStart?: () => void)`，在每次真正 `session.prompt()` 之前调 `onStart()`（busy 重试时再调，最后一次赢）；`runPrompt` 改 `let before = ...` 并传 `() => { before = session.getStats().tokens; }`。acp-server 净 +0～1 行。

- 被否决：按本回合新增的 assistant 消息累加 `usage`——重试剔除的失败尝试与缓存读写口径和 `getStats` 不一致。
  **协议影响**：无（`usage` 字段形状不变，只是数值正确）。
  **测试**（`acp-mode.test.ts` 复用 #139 用例 `:583-623`）：通知回合 fake 配 `usage: {input: 500, output: 50}`，排队的 `session/prompt` 结果 `usage.inputTokens` 等于本回合脚本声明值；`acp-sessions.test.ts`：`onStart` 在 busy 重试后被调 2 次。
  **验收**：上述断言精确相等。**风险**：无。

## §3 #167 session/close 与通知器投递的 busy 竞态

**根因**：

- `acp-server.ts:383-388` 只在「队列里在跑的 job 属于本会话」时 abort；**通知回合不经队列**（`subagent-background.ts:150-158` `TaskNotifier` 以 `followUp` 直开周期），此时 `running?.sessionId !== id` → 不 abort → `disposeSessionAlongside`（`compose-session.ts:596-597`）见 `isStreaming` 抛 `busy`，close 以 -32603 失败且会话不释放。
- 即便 abort 了，`TaskNotifier.delivery` 链上下一条通知在 `cycle.promise` 结算后的微任务里 `followUp` → 新周期；`disposeSessionAlongside` 里 `await hooks.run("SessionEnd")` 之后才 `session.dispose()`，期间可能开新周期；`dispose()`（`session.ts:560-565`）不 abort，周期带着已 dispose 的扩展继续跑。
- 通知器停止条件 `disposed()` = `registry.disposed`（`subagent-registry.ts:167`），只在 `registry.dispose()`（`:588`，由 `session.dispose()` 触发）置位；registry 不得加行，不能新增「静默」接口。

**方案**（新逻辑全放 `acp-sessions.ts`）：

```ts
/** close 前把会话安静下来：停后台任务（通知器跳过 aborted 结果）→ 反复 abort 直到一个宏任务内保持空闲。 */
export async function quiesce(
  session: AgentSessionImpl,
  control: TaskControl | undefined,
  rounds = 50,
): Promise<boolean>;
//   for (const t of control?.list() ?? []) if (t.status === "running") await control.stop(t.taskId).catch(() => undefined);
//   for (let i = 0; i < rounds; i++) { await session.abort(); await new Promise(setImmediate); if (!session.state.isStreaming) return true; }
//   return false;
/** disposeSessionAlongside 的 busy 重试版；dispose 后若又有周期在跑，再 abort 一次。 */
export async function disposeQuiet(runtime, session, fallback, retries = 3): Promise<void>;
```

`acp-server.ts close()`：`383-388` 五行换成 `running?.cancelRequested = true` 一行 + `await quiesce(entry.session, taskControl(id)); await this.queue.settled(id);`；`401` 改调 `disposeQuiet`。`AcpServer.dispose()`（stdin 关闭）同样用 `quiesce`（`:220` 的 `waitForIdle` 换掉）。净 −2 行左右。

- 被否决：给 `TaskNotifier` 加 `stop()` 并经 `TaskControl` 暴露——registry 需 +3 行，违反不加行约束。
- 被否决：先 `session.dispose()` 再 abort——dispose 顺序破坏 SessionEnd Hook 语义。
  **协议影响**：无（close 仍回 `{}`；被 abort 的通知回合会在会话文件留 `ama.aborted` custom_message，与用户 cancel 相同，文档写明）。
  **测试**（`acp-mode.test.ts`，剩余 178 行足够；超出则新建 `acp-close.test.ts`）：① 后台子 Agent 两个（fake 延迟 300/600 ms）→ 第一条通知回合在跑时 `session/close` → 回 `{}` 无错误；`taskControl(id) === undefined`；`gcUntil` 实例回收；close 之后 500 ms 内该会话再无 `session/update`；② close 期间另一会话 `session/prompt` 正常出队；③ `acp-sessions.test.ts` 用 fake session 对象覆盖 `quiesce` 的三条路径（立即空闲 / 一次 abort 后空闲 / 超过 rounds 返回 false）。
  **验收**：bench `acp-pool` 「prompt errors 0」且 close 全部成功；上述用例在 Node 22/24 稳定。
  **风险**：`quiesce` 的 abort 若击中用户刚入队的 `followUp`（不在 ACP 队列里的 SDK 调用）——ACP 模式下只有通知器用 followUp，接受。

## §4 #168 流式发送时图片多一份 UTF-8 副本

**根因**：`src/ai/json-body.ts:209-222` `pull()` 对每个片段整段 `Buffer.from(part, "utf8")`，大字符串片段就是一整张图（3–4 MB），发送期间多出一份 UTF-8 字节。
**方案**：`pull` 维护 `(partIndex, offset)` 游标；片段长度 > `STREAM_CHUNK_CHARS`（256 Ki 码元）时按游标切 `part.slice(offset, end)`（V8 sliced string，不拷贝）再编码；切点若落在代理项对之间（`part.charCodeAt(end - 1)` 在 0xD800–0xDBFF）则 `end--`（`isPlain` 允许成对代理项通过，大文本片段可能含 emoji；base64 不受影响）。`contentLength` 不变；`parts[next] = ""` 的放手逻辑在片段发完时做。约 +15 行。

- 被否决：`TextEncoder.encodeInto` 复用缓冲——enqueue 的块会被消费者持有，仍要每块新 Buffer，收益相同代码更多。
- 被否决：`highWaterMark` 调整——缺省计数 1 已是最小。
  **协议影响**：无（线路字节逐字节相同）。
  **测试**：`test/memory/json-body.test.ts` 第二条改断言 `largest ≤ 256 KiB + 4`、`growth.total < 2 MB` 不变、字节相等；新增：大文本片段含 emoji 且长度使切点恰落在代理项对上 → 拼接后与 `JSON.stringify` 相同；`http.test.ts` fake fetch 读流拼接等于原文。
  **验收**：mock-http 300 步 + 15 图峰值 RSS 720 → **≤ 700 MB**（叠加 #169 看 ≤ 650）；发送期间 `arrayBuffers` 峰值比请求体少 ≥ 1 张图。
  **风险**：块数增多（4 MB 图 → 16 块）对 undici 写路径无可测影响。

## §5 #169 请求体按消息缓存片段（设计步骤二）

**根因 / 修正认识**：真正的每请求浪费不在「消息身份」而在**字符串扁平化**：四个转换器用模板串拼 data URL（`openai-request.ts:69`、`openai-responses-request.ts:148-153`、`google-request.ts:100`；anthropic `:111` 直接放 `block.data`）→ V8 cons string；`json-body.ts isPlain`（`:28-34`）`slice` 触发扁平化 → 每张图每请求一份 3–4 MB 一字节字符串垃圾 + 一遍转义扫描；`Buffer.byteLength`、`Buffer.from` 再各扫一遍。15 图部件 × 260 请求 ≈ 17 GB 堆分配，正是 heapUsed 峰值 260 MB 的来源。D3 对 WeakMap<消息> 的异议成立，但 **ImageBlock 对象在转录里身份稳定**（D5 驻留 + `repairTranscript` 对 user/toolResult 消息按引用透传、`{...result, toolCallId}` 不复制 content 数组），足够做块级缓存，无需碰 `downgradeBlocks`。

**方案（最小可行）**：

1. `json-body.ts` 新增 `export class LargeString { constructor(readonly prefix: string, readonly key: object, readonly text: string) {} toJSON() { return this.prefix + this.text; } }` 与 `largeString(prefix, key, text)`；`collectLarge` 把 `instanceof LargeString && text.length ≥ LARGE_STRING_BYTES` 视为大字符串；`writeEntry` 写 `prefix(JSON 结构) + '"' + value.prefix` 后 `large(value.text)`；无需转义判定走 `plainCache: WeakMap<object, boolean>`（键 = ImageBlock），每块每进程只扫一次；`prefix` 必须自身无需转义（构造时 `JSON.stringify(prefix).length === prefix.length + 2` 断言）。原生回落路径经 `toJSON` 得到相同字符串。
2. 四个转换器的 `imagePart` / `inlineData` / anthropic `source.data` 改为 `largeString("data:${mime};base64,", block, block.data)`（anthropic/google 的 prefix 为 `""`）。`Json` 若是 `Record<string, unknown>` 不需改类型。
3. 核对请求体的其它遍历者把 `LargeString` 当叶子：`postWithCacheFallback` 的 `stripWithCount`、trace writer（`JSON.stringify` → toJSON 正确）、`onPayload`。

- 被否决：`WeakMap<ImageBlock, Buffer>` 常驻 UTF-8 片段——每张图常驻 +1 份（D3 反对的理由仍成立）。
- 被否决：按消息缓存（需改 `downgradeBlocks` 身份）——收益被块级方案覆盖。
- 不做：≥ 64 KiB 的文本工具结果（bash）仍走现路径——无稳定键。
  **协议影响**：无；**字节逐字节不变**由现有 500 随机 JSON + 四协议黄金比对守住（随机测试加 `LargeString` 节点）。
  **测试**：`test/memory/json-body.test.ts` 新增：6 张图以 cons string（模板拼接）构造的 body，`jsonFetchBody` 读完 `beforeGc.heapUsed < 2 MB`（现路径 ≥ 6 × 3 MB）；第二次请求同一组 block：`isPlain` 调用计数 0（`vi.spyOn` 内部 hook 或导出计数器）；`src/ai/apis/*-request.test.ts`：含图请求 `serializeJsonBody(body).equals(Buffer.from(JSON.stringify(body)))`；`cache-stability.test.ts` 不改。
  **验收数字**：mock-http 300 步 + 15 图：峰值 RSS **≤ 650 MB**（现 720），heapUsed 峰值 260 → ≤ 180 MB；真实 astr TUI 2 提示 2 图峰值 ≤ 170 MB（现 168.8，不回归）。
  **风险**：`LargeString` 实例泄到不认识它的代码（如 fake 录制 `AMA_FAKE_RECORD`）——那里录的是 context 不是 body；黄金录制走 `JSON.stringify` 正确。

## §6 #170 降级/压缩后释放旧图 base64（最小可行切分）

**根因**：`context_edit{image_budget|prune}` 只改投影（`projection.ts:110-135`），`SessionManager._entries` 里 `MessageEntry.message.content` 的 ImageBlock 照旧常驻；`getEntries`（`manager.ts:219-226`）、`fork`（`:245`，`structuredClone`）、rewind 回到编辑点之前都要原文，所以不能简单删。
**范围切分**：

- **做（本批）**：只卸载**图片 `data`**，对象是「活动分支上有生效 context_edit 的 `message` 条目」（任何 reason）。
- **不做并建议在 Issue 关闭说明里写明**：卸载被 `prune` 的 toolResult **文本**以及「resume 55 MB ≤ 200 MB」子目标——bench 的 resume 会话没有任何编辑，218 MB 里的 66 MB 是在上下文中的转录本身，不卸载上下文就不可能降；而 agent 层（rewind `session-rewind.ts:200/211/347`、compaction 规划、TUI `/tree`、SDK `session.entries`）直接读 `entry.message.content`，惰性 getter 会被 `{...message}` / 解构触发（`projection.ts:122-128`），改动面与收益不成比例。

**方案**：新文件 `src/session/offload.ts`（≤ 200 行）

- `interface LineLocator { offset: number; length: number }`；`class ImageOffload { locators: Map<entryId, LineLocator>; offloaded: Set<entryId> }`。
- `store.ts readSessionLines(file, { repair, locate: true })` 额外返回 `locators: LineLocator[]`（与 `lines` 同序；`forEachLineSync` 已给 `byteOffset`，长度 = `buf.length`+行尾）。`appendLines` 返回写入字节数。
- `manager.ts`：`open()` 建 locators（只记含 image 的 message 条目），`internSessionImages` 之后对 `collectContextEdits(branch)` 命中的条目 `offload(entry)`；`append()`：file 存储时 `fileBytes += appendLines(...)` 并为含图条目记 locator；`input.type === "context_edit"` 且目标含图 → `offload(target)`；`setLeaf()` → `sync(branch)`：新分支上无生效编辑但已卸载的条目 `hydrate`（回读后经 `internImage`），有编辑的卸载；`flush()`：按 `writeNewSessionFile` 同一序列化计算每行长度建 locators；`fork()` 复制前对已卸载条目 `hydrateCopy`；`getEntries()` 返回 hydrate 后的副本（RPC `get_entries` 必须原文）。`inMemory` 会话不卸载。
- `offload(entry)`：**不改共享的 ImageBlock**（驻留对象被其它条目/会话共享），把 `entry.message` 换成浅拷贝、`content` 换新数组、image 块换 `{ type: "image", mimeType, data: "" }`。`hydrate`：`openSync` + `readSync(fd, buf, 0, length, offset)` + `JSON.parse`，校验 `id` 相同，失败则保留 `""` 并 `log warn`。
- 原始视图：`entries()` / `branch()` / `getEntry()` 返回卸载后的对象（`data === ""`）；`getEntries()` / `fork()` 原文。`docs/session-format.md` 加「内存表示」一段说明；文件格式零变化。
- 被否决：`Object.defineProperty` 惰性 getter（被 spread/`structuredClone`/`JSON.stringify` 隐式触发大量回读）；按条目持 `WeakRef` 缓存（命中率低，复杂）。
  **协议/格式影响**：无（JSONL 不变；RPC `get_entries` 原文；`entry_appended` 事件早已发出）。SDK `session.entries` 里被降级条目的图片 `data` 为空串——写进 CHANGELOG 与 session-format.md。
  **测试**（`test/memory/session-offload.test.ts`，`makeSessionFile` 加 `edits: "image_budget"` 选项）：① 6 张 1.5 MB 图各在一条 user 消息，`append` 6 条 `context_edit` 后 `gcUntil`：6 个 block 的 `WeakRef.deref() === undefined`，`heap+ext` 下降 ≥ 5 × base64；② `getEntries()` 深度等于直接 `readSessionLines` 的条目；`fork(entryId)` 新文件含全部 base64；③ `setLeaf(编辑前的 id)` → `data.length` 恢复、`sha256` 相同，再 `setLeaf(末尾)` → 再卸载；④ 带 6 条编辑的 24 MB 会话 `SessionManager.open` 增长 < 文本字节 + 2 MB（图片不常驻）；⑤ 现有 `manager.test.ts`、`session-images.test.ts`、rpc 黄金不变；`inMemory` 会话不受影响。
  **验收数字**：上述确定性断言；bench 新增 `--edited` 选项让 `resume` 会话带 N 条 image_budget 编辑：55 MB（含 10 张 3 MB 图）resume 峰值比不卸载低 ≥ 30 MB。注：mock-http 因 D5 去重只有 3 张图，收益 ≈ 10 MB，不作目标。
  **风险**：会话文件被其它进程改写（trash/purge）后回读失败 → 图片丢失，仅影响 fork/get_entries，有 warn；`fileBytes` 与真实文件不一致（外部追加）→ 回读 `id` 校验失败走同一兜底。

## §7 #171 read 字节窗口同步读阻塞事件循环

**根因**：`src/tools/read-lines.ts:99-153` `readSync` 循环（含只计数到 EOF 的阶段）在 256 MB 上约 150 ms 不让出事件循环；`readHead`（`:38-52`）同样同步。
**方案**：把状态机抽成 `class LineScanner { constructor(first, stop, maxBytes); feed(buf, end): void; finish(): LineWindow }`（现有 `take/finish/skipLF/bom` 逻辑原样搬入），`readLineWindow`（同步，保留给单测与口径比对）与新 `readLineWindowAsync(abs, offset, limit, maxBytes, chunkBytes)` 共用；异步版用 `fs/promises.open` + `handle.read(buf, carry, size - carry, null)`，每块一次 `await`（64 KiB → 256 MB 约 4096 次让出）；`readHead` 加 `readHeadAsync`。`read.ts:141-148` 两处改 `await` 版本。峰值内存不变（仍一块缓冲）。

- 被否决：worker 线程（重）；`createReadStream`（等价但不能共用解析器、`highWaterMark` 语义额外一层）；放大块到 1 MiB（违背「不增加峰值」）。若实测用时 > 1.3×，允许把**只计数阶段**换 256 KiB 块（+192 KiB）。
  **协议影响**：无；工具输出逐字节相同（R1 口径由同一 `LineScanner` 保证）。
  **测试**：`read-lines.test.ts` 现有 fixture 集合对 sync/async 两版 `deepEqual`，再与整读路径比对（阈值注入 0/Infinity）；`test/memory/read-huge.test.ts` 新增「响应性」用例：读 32 MB 期间 `setInterval(1 ms)` 计数 ≥ 1（同步版恒为 0），`measureGrowth` 仍 < 2 MB。
  **验收数字**：bench `read-huge` 256 MB：峰值 RSS ≤ 110 MB 不变，用时 0.37 s → ≤ 0.55 s；TUI/RPC 在读期间最大停顿 < 20 ms（本地 `--mode rpc` 下 `ping` 往返观察，写 benchmarks）。
  **风险**：并行 read（`executionMode: "parallel"`）同时打开多个 fd——数量等于并发工具数，可接受。

## §8 #172 无图 mock HTTP 峰值 RSS +90 MB（原因未明）

**已知**（benchmarks「发现 1」）：二分到 #162（e8ac513，只改 read.ts/read-lines.ts）；退出时留存相同；`--max-old-space-size=64` 下 rpc-bytes 两者相同 → heapUsed 峰值差是 GC 节奏；但 128 MB 老生代下 mock-http 仍差 ~115 MB 且不在 `heapUsed`/`external` 采样里。
**工作假设**：旧路径每步 `readFile` 4 MB Buffer + 4 MB 字符串 + split 数组 ≈ 12 MB 分配压力，频繁触发 full GC；新路径近零分配，8.8 MB 请求体字符串（大对象空间）与 undici 发送缓冲在两次 major GC 之间堆积——差额落在 **V8 已提交未使用的页（heapTotal−heapUsed）或大对象空间的 committed**，而采样只看 heapUsed/external。
**排查步骤**（全部只用 node:* 与 macOS 自带工具，写进 R-E 的脚本/文档）：

1. 探针 `mem-probe.cjs` 每行加 `heapTotal`、`v8.getHeapSpaceStatistics()` 的 `old_space/large_object_space/code_space` 的 `space_size`/`space_used_size`、`rss - heapTotal - external` 作「other」列；bench 表加 `Peak heapTotal`、`Peak other`。
2. 复现对照：同一新 bundle 跑 `mock-http --text-mb 0.5`（big.txt < 1 MiB → 走旧整读路径）vs 缺省 4 MB：若 RSS 回到 ~670 → 差异完全由路径的分配节奏决定。
3. `node --trace-gc --trace-gc-verbose`（经 `NODE_OPTIONS` 传给子进程，probe 已过滤 mem-probe 字串）对比 mark-sweep 次数与间隔；`--max-old-space-size=128` 复测时同时看 heapTotal。
4. 若 other 仍有 ≥ 50 MB 差：macOS `vmmap -summary <pid>`（probe 加 `AMA_MEM_VMMAP_AT=<ms>` 在峰值附近 `execFile("vmmap")` 写文件）比较 `MALLOC_*` 与 V8 匿名区域；`heap -s <pid>`；`MallocStackLogging=1` + `malloc_history <pid> -highWaterMark`（只在本地）。
5. 分配剖析：`AMA_MEM_ALLOC` 采样剖析 diff 两个构建，确认 `readLineWindow` 的 `Buffer.alloc(64 KiB)` / `Buffer.from(subarray)` 与 `JSON.stringify` 体占比。
6. 针对性实验：read-lines 复用一块模块级 64 KiB 缓冲（串行时）、`readHead` 与窗口共用 fd；`fs.readSync` 换 `readFileSync` 前 1 MiB。任一实验让 RSS 回落则定位到分配粒度。
   **出口**：

- **定位 + 修复**：若是 read-lines 分配粒度/缓冲（步骤 5–6）→ 在 R-D 已重构的 `LineScanner` 上做缓冲复用（≤ 20 行），目标回到 ≤ 670 MB。
- **定位 + 记录为预期**：若是 GC 节奏导致的已提交页（步骤 1–3 证实 other≈heapTotal−heapUsed 且 `--max-old-space-size` 可压回）→ benchmarks「发现 1」改写为结论，§9.2 把该行目标改为「≤ 800 MB（GC 节奏，非留存）」并关闭 Issue；不在库代码里设 V8 参数。
  **验收**：两种出口都要给出 other/heapTotal 归因表（前后两构建、3 次中位数）；修复出口要求 ≤ 670 MB。**风险**：机器负载影响 ±5%；三次中位。

## §9 #173 bench-memory.mjs 遇到截断行崩溃

**根因**：`scripts/bench-memory.mjs:356` 与 `:418` 在 `readline` 的 `line` 回调里直接 `JSON.parse(line)`，坏行抛错为未捕获异常；同时 `rpc-bytes` 等 `agent_settled`、`acp-pool` 等 `pending` 应答——ama 提前退出时永久挂起。
**方案**：`scripts/lib/bench-memory-fixtures.mjs` 导出 `parseJsonLine(line): object | undefined`；两处改用，坏行 `badLines++` 并仍计字节；`run.exited.then(code => …)` 时 reject/settle 所有挂起的等待并把 `exit <code>` 与 `bad lines N` 写进 `note`；非零退出仍抛错但先汇总。
**测试**：新 `test/bench-memory-lines.test.ts`：截断 JSON → `undefined`，完整行 → 对象；（脚本本身无 vitest 覆盖，沿用 `test/release-check.test.ts` 对 scripts 的测法）。
**验收**：人为 `--max-old-space-size=32` 让 ama 中途 OOM，脚本输出表格且 note 含 `exit 134` / `bad lines`。**风险**：无。

## §10 共享文件规则与合并顺序

| 文件                                       | 规则                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md` / `CHANGELOG.zh-CN.md`      | 首个合入批建 `## Unreleased`+`### Memory footprint`（zh 同形）；其余只追加自己条目；#173 不写（dev 工具） |
| `docs/design.md`                           | 各批把 §9.2 行与其它改动写在 PR 描述；R-E2 一次合入                                                       |
| `docs/benchmarks/memory-2026-10.md`        | 只有 R-E 改；各批数字写 PR 描述                                                                           |
| `docs/acp.md` / `docs/en/acp.md`           | 只有 R-A 改（「多会话」节：close 的安静过程、usage 口径、启动会话可释放）                                 |
| `docs/session-format.md`（+en）            | 只有 R-C 改                                                                                               |
| `src/ai/json-body.ts`、四个 `*-request.ts` | 只有 R-B                                                                                                  |
| `src/tools/read.ts`、`read-lines.ts`       | 只有 R-D；R-E2 若需缓冲复用修复，在 R-D 合入后改                                                          |
| `src/modes/acp/*`、`src/cli/bootstrap.ts`  | 只有 R-A；`acp-server.ts` 净 ≤ +8 行                                                                      |
| `src/session/*`                            | 只有 R-C                                                                                                  |
| `test/helpers/memory.ts`                   | 只有 R-C（`makeSessionFile.edits`）                                                                       |
| `scripts/*`                                | 只有 R-E                                                                                                  |
| 禁改                                       | `session.ts`、`subagent-registry.ts`、`ai/providers/registry.ts`、`compose-session.ts`                    |

合并顺序：R-E1（脚本容错，先让后续复测可靠）→ R-D → R-B → R-A → R-C → R-E2（复测 + §9.2 + #172 结论）。后合者 rebase 处理 CHANGELOG 相邻行冲突。PR 正文：`Closes #<N>`（R-A 三个、R-B 两个 Closes），R-E2 `Closes #172 #173`。

## §11 验收汇总

| Issue | 确定性守护（CI）                                                      | 数字（bench / 真实）                  |
| ----- | --------------------------------------------------------------------- | ------------------------------------- |
| #165  | acp-release：含启动会话全部回收、`closed < 1 MB`                      | acp-pool close+GC ext ≤ 10 MB         |
| #166  | 排队 prompt 的 `usage` 精确等于本回合脚本 usage                       | —                                     |
| #167  | 通知回合在跑时 close 成功、无后续 update、实例回收                    | acp-pool prompt errors 0              |
| #168  | 流块 ≤ 256 KiB+4、代理项边界字节相同、读完增长 < 2 MB                 | mock-http ≤ 700 MB                    |
| #169  | cons-string 图片 body 读完 `beforeGc.heapUsed` < 2 MB；四协议字节相同 | mock-http ≤ 650 MB；heapUsed 峰 ≤ 180 |
| #170  | 编辑后 block 可回收；getEntries/fork 原文；setLeaf 回读               | resume（带编辑 10 图）降 ≥ 30 MB      |
| #171  | sync/async 深度相等；读 32 MB 期间计时器 ≥ 1 次                       | read-huge ≤ 110 MB，≤ 0.55 s          |
| #172  | 探针/表格新增 heapTotal、other 列                                     | ≤ 670 MB 或归因表 + 预期结论          |
| #173  | parseJsonLine 单测                                                    | 中途退出不崩、不挂                    |
