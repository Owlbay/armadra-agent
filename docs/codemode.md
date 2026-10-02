# codemode

B10 草稿（B9 统稿）；设计依据见 [design.md](design.md) §5.5、§5.6、§9.1。

`codemode` 工具让模型写一段 JavaScript，在脚本里经 `tools.*` 编排多次工具调用，只有脚本输出回到模型。长流程、工具密集的任务里，它把多次往返合成一次，减少往返次数与缓存读取；短任务收益不明显，因此是可选的调用方式。

## 打开

| 写法                                        | 模型看到的工具                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `--tools-preset codemode`（`only`）         | 只有 `codemode`；全部内置工具与宿主工具只能在脚本里调用，声明列在 `codemode` 描述里 |
| `--codemode on` / `codemode.mode: "on"`     | 预设的工具 + `codemode`；其它工具描述末尾加一行提示                                 |
| `--codemode off` / 缺省（非 codemode 预设） | 不注册 `codemode`                                                                   |

`codemode` 本身的权限类随沙箱能力：网络隔离（Node ≥ 25，见下文沙箱）时是 `read` 类，`default` 权限模式下免审批——脚本只能经 `tools.*` 做事，每次内层调用仍逐个经过权限管线；网络未隔离（Node 22 / 24）时是 `execute` 类，`default` 模式下每次都要审批，`-p` 等无人值守场景直接拒绝，此时常用做法是在配置里放行它：

```json
{ "version": 1, "tools": { "preset": "codemode" }, "permission": { "allow": ["codemode"] } }
```

其它配置：`codemode.inlineBudget`（描述里内联声明的预算，估算 token，缺省 3000，超出只列名字）、`codemode.requireStrict`（见下文沙箱）。项目级配置只能把 `codemode.mode` 设为 `off`。

## 脚本

输入是原始 JavaScript（不是 JSON，不要代码块），作为 async 函数体执行，可用顶层 `await` 与 `return`。首行可选：

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

- `max_output_tokens`（缺省 10 000，按字符 / 4 估算）：输出超出时保留首尾，全文写 `<会话目录>/outputs/<toolCallId>.txt`（内存会话写系统临时目录）。单条工具结果上限（`tools.maxToolResultChars`，缺省 30 000 字符）更小时以它为准。
- `timeout_ms`（缺省 300 000，上限 3 600 000）：整个脚本的硬期限，到点杀掉子进程树。

| 全局                           | 作用                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `tools.<name>(args)`           | 调用会话里任一未禁用的工具（含宿主注册的 `canvas_*`），走与模型直接调用相同的门禁 |
| `text(v)` / `console.log(...)` | 追加输出；字符串原样，其它值按 JSON（`console.info / warn / error / debug` 相同） |
| `return v`                     | 同 `text(v)`                                                                      |
| `store(key, v)` / `load(key)`  | 跨次保留小块 JSON；`store(key, undefined)` 删除                                   |
| `ALL_TOOLS`                    | 可调用工具名（执行时的清单，含描述冻结之后才注册的宿主工具）                      |
| `describeTool(name)`           | 单个工具的 TypeScript 声明                                                        |

没有 `require`、`import`、`process`、`fetch`、定时器；`eval` 与 `new Function` 被拒绝。工具只能写成 `tools.read({ path })`，不能直接 `read(...)`。

### 给模型的描述

描述首段写明规则（只有 `tools.<name>(args)`；没有 require / import / process / fetch / 定时器；不要把工具当函数直接调用），随后是一段 6 行示例脚本：`Promise.all` 并发两个 `tools.read`、过滤、`return`。实测 Kimi、MiniMax 在旧描述下会在脚本里写 `require` / `import`，或在 `only` 模式下直接调用 `read`。两类错误都给出正确写法：

- 脚本因 `require` / `import` / `process` / `fetch` / 定时器失败：`Script error` 后追加一行 `Only tools.<name>(args) is available in codemode scripts …`；脚本里直接调用工具名（`read is not defined`）：追加 `Call tools as tools.read({...}), not read(...).`
- `only` 模式下模型绕过 `codemode` 直接调用工具：错误结果是 `Tool read is only callable inside a codemode script: tools.read({...})`（真不存在的工具仍是 `Tool X not found`）。

### 返回值

- `bash` 解析为 `{ output, truncated, fullOutputPath?, exitCode, wallTimeMs }`，非零退出码同样解析；`output` 是模型可见的版本（2000 行 / 50 KB 尾截断），`fullOutputPath` 存在时可再 `tools.read` 全文。
- 其它内置工具解析为文本；宿主 / SDK 工具返回 `structured` 时解析为它，否则为文本。
- 工具失败、被 Hook / 权限 / 用户拒绝、参数非法 → 以 `Error` reject，消息是工具的错误文本；用 `Promise.allSettled` 保留其余结果。
- 同一脚本内最多 8 个调用同时进行，多出的排队；脚本里不能调用 `codemode`。

### 结果

`Script completed` / `Script failed` + 用时 + 输出；失败时保留已产生的输出，末尾附 `Script error: …`（带脚本行号）。已完成的工具调用不回滚；脚本结束时仍在跑的调用被取消，未 await 的 Promise 被丢弃。

### store

脚本成功结束且写过 store 时，追加一条 `custom{customType:"ama.codemode-store"}` 条目，内容是完整快照；读取取活动分支上最近一条，所以 `/resume` 后值仍在，切分支、fork 后只看本分支写过的值。单值 JSON ≤ 262 144 字符，合计 ≤ 1 048 576 字符；超限时 `store()` 抛 `RangeError`。失败的脚本不提交。

## Hook 与事件

- `codemode` 本身作为一次工具调用经过 PreToolUse、权限与 PostToolUse。
- 脚本里的每次 `tools.*` 再各自经过完整流程，Hook 按**真实工具名**匹配（`bash`，不是 `codemode`）；Hook 输入多两个字段：`viaCodemode: true` 与 `parentToolCallId`（外层 `codemode` 调用的 id）。
- 事件：`tool_execution_update` 透传脚本输出（最近 4000 字符）；内层调用发 `tool_execution_start / end`，带 `parentToolCallId`，不进转录、不进模型上下文。

## 沙箱

每次执行起一个子进程：

```text
<node> --permission --allow-fs-read=<ama-sandbox.cjs> --disallow-code-generation-from-strings <ama-sandbox.cjs> --ama-codemode-sandbox
```

- 空环境启动，拿不到密钥、会话文件与环境变量（Windows 上 libuv 会从父进程补入 PATH、SYSTEMROOT、USERPROFILE 等系统变量，不含密钥）；不授予文件写、子进程、worker、addon、inspector 权限；Node 22.0–22.12 用 `--experimental-permission`；嵌入 Electron 时设 `ELECTRON_RUN_AS_NODE=1`。
- 子进程里用 `node:vm` 建只含 ECMAScript 内建对象的上下文（`codeGeneration: { strings: false, wasm: false }`，沙箱对象空原型）；全局函数都在上下文内定义，只经一个宿主函数交换 JSON 字符串；子进程主 realm 也禁止字符串生成代码，经构造器链逃逸拿不到 `Function("return process")`。
- `tools.*` 经 stdin / stdout 的 JSON 行协议回调父进程执行。
- 网络：Node ≥ 25 的权限模型同时拒绝网络（strict）；Node 22 / 24 不管网络，脚本若逃出 `vm` 就能联网——此时工具描述标注 `network not isolated`，`codemode.requireStrict: true` 时直接不注册 `codemode` 并给出 warning（codemode 预设随之回退到 default）。

| 实测（`--permission` + 只读入口） | Node 22.19 | Node 24.21 | Node 26.10 |
| --------------------------------- | ---------- | ---------- | ---------- |
| 读其它文件                        | 拒绝       | 拒绝       | 拒绝       |
| 写文件                            | 拒绝       | 拒绝       | 拒绝       |
| 起子进程 / worker                 | 拒绝       | 拒绝       | 拒绝       |
| 联网（fetch / TCP）               | **允许**   | **允许**   | 拒绝       |

沙箱防的是脚本**绕过权限管线**，不是对抗性的代码执行环境；脚本能造成的副作用都来自它调用的工具，而工具调用照常受 Hook、权限与审批约束。

## 缓存

`codemode` 的描述（含工具声明）在第一次读取时确定并冻结，同一会话内字节稳定；之后宿主注册的工具不改变描述（`only` 模式下也不进活动集），但脚本里可以调用，`ALL_TOOLS` / `describeTool` 能查到。
