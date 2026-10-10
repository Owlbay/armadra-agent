# 外部 Agent 驱动实测（2026-10-10，#198）

本机 macOS / Node 26，各 CLI 均为当日最新：claude 2.1.295、claude-agent-acp 0.89.0、codex 0.162.1、codex-acp 2.2.2、
copilot 1.0.95、opencode 1.18.35、pi 1.1.0；cursor-agent 未安装。脚本：`src/drivers/agents-audit.e2e.test.ts`
（`AMA_E2E_AUDIT=<agent>/<驱动种类>@<模型>`，强制只走一条驱动路径）。

每条路径两个会话：

- **A**（非 git 临时目录，`default` 模式；一次性打印模式用 `plan`）：「只回 OK」→ 续一轮「只回 OK」→ 写 `note.txt`（测试代替人点「允许」）；
- **B**（`git init` 的临时目录）：让它不调工具输出 1..400，收到首个文本增量后中断，紧接着一轮「只回 OK」。

## 结果

用量列是 ama 记到的本回合 `input / output / cacheRead`（input 不含缓存命中）；上下文是外部 Agent 报告的占用 / 窗口。

| 路径（模型）                                    | A：两轮 | A：写文件                      | B：中断 → 续聊 | 第二轮用量              | 上下文             |
| ----------------------------------------------- | ------- | ------------------------------ | -------------- | ----------------------- | ------------------ |
| `claude/claude-stream`（haiku）                 | OK / OK | 问人 1 次，写入                | 1.9 s → OK     | 2 / 4 / 15342           | 未报（已补，见下） |
| `claude/acp-adapter`（haiku）                   | OK / OK | 问人 1 次，写入                | 2.3 s → OK     | 2 / 4 / 12977           | 17.5k / 1M         |
| `codex/codex-app-server`（gpt-6-luna）          | OK / OK | 命令提权问人 1 次，写入        | 2.5 s → OK     | 22380\* / 5 / 21248     | 22.4k / 258k       |
| `codex/acp-adapter`（gpt-6-luna）               | OK / OK | 未问人：只读沙箱拒写，模型放弃 | 2.6 s → OK     | 199 / 5 / 26368         | 26.6k / 258k       |
| `codex/oneshot`（gpt-6-luna）                   | OK / OK | —（只读）                      | 结束进程       | 39808\* / 10 / 19200    | —                  |
| `copilot/acp`（gpt-5-mini）                     | OK / OK | 问人 1 次，写入                | 4.6 s → OK     | 50710\*\* / 143 / 25216 | 26.7k / 128k       |
| `opencode/acp`（opencode/mimo-v2.6-flash-free） | OK / OK | 未问人：OpenCode 自身配置放行  | 6.2 s → OK     | 58 / 3 / 29632          | 29.7k / 200k       |
| `pi/pi-rpc`（openai-codex/gpt-6-luna）          | OK / OK | 经审批闸问人 1 次，写入        | 2.7 s → OK     | 314 / 5 / 1536          | 1.9k / 272k        |

\* 实测时 Codex 的 input 还含缓存命中部分（总量把缓存算了两次），已修：input 改为扣掉 `cachedInputTokens`。
\*\* Copilot 的 `session/prompt` usage 是会话累计且 input 含缓存（`totalTokens = input + output`），已修：按差值、扣缓存。
同一会话的原始答复（两轮）：`inputTokens 25301 → 50645`、`cachedReadTokens 7680 → 32896`、`totalTokens 25386 → 50817`。

## 发现与处理

- **codex 一次性模式在非 git 目录直接失败**（`Not inside a trusted directory and --skip-git-repo-check was not specified`）：
  `codex exec` / `exec resume` 一律带 `--skip-git-repo-check`（ama 只在自己已信任的目录里起外部 Agent）。app-server 与 codex-acp 在非 git 目录正常。
- **ACP 模式没映射时留在 Agent 自己的当前模式**：claude-agent-acp 的当前模式是用户缺省的 `bypassPermissions`，`auto-edit` / `full-auto`
  原本找不到同名模式就照它跑；codex-acp 的模式是 `read-only` / `workspace-write` / `agent` / `agent-full-access`，`plan` 直接拒绝启动、
  `default` 留在 `agent`（自动审阅）；Copilot 的模式 id 是 URL。三家都在驱动表写了显式映射，且从不落到放开全部权限的模式。
- **task 的 `model` 没交给 ACP Agent**：改经 category `model` 的会话配置项设置（三家与 OpenCode 都给了该配置项）。
- **用量口径**：Codex（app-server、exec）与 Copilot 的 input 含缓存；Copilot 的 usage 是会话累计。见上表注。
- **Claude stream-json 没有上下文占用**：改为取主线最后一条 assistant 消息的用量，窗口取 `result.modelUsage[模型].contextWindow`。
- **pi**：新增原生 `pi --mode rpc` 驱动；社区 `pi-acp` 不发权限请求，不收录。审批经 `-e` 加载的审批闸扩展走 RPC 扩展对话框。
- **OpenCode**：`opencode/exo-free` 已下线（`Model exo-free has been deprecated`），换 `opencode/mimo-v2.6-flash-free`。
  本机 OpenCode 的模式来自用户自己的 agent 配置（`Sisyphus - ultraworker` 等，没有 `plan`），所以 `plan` 下拒绝启动、`default` 按其缺省运行。
- **`chatgpt/gpt-6-astra`**：ama 没有内置 ChatGPT 模型表，列表来自 `ama models discover chatgpt` 的发现缓存。本机缓存是 10-03 拉的，
  含 `gpt-6-astra`；10-10 发一次请求得到 400 `The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.`，
  重新发现（`client_version` 0.160.0 与 0.162.1 结果相同）只剩 `gpt-6-luna`、`gpt-5.6-terra`、`gpt-5.6-luna`。
  处理：这类 400 报 `model_unavailable` 并提示刷新发现缓存。
- **Cursor CLI**：未安装，按官方 ACP 文档收录 `cursor-agent acp`（模式 `agent` / `plan` / `ask`），标未验证。

## 真实运行次数

| 对象                 | 次数 | 说明                                                           |
| -------------------- | ---- | -------------------------------------------------------------- |
| Claude（订阅）       | 4    | 两条路径 × A / B；`~/.claude` 下 settings 指纹前后一致         |
| Codex                | 6    | 三条路径 × A / B                                               |
| Copilot              | 3    | A / B + 一次原始 ACP 往返（看 usage 形状）                     |
| OpenCode（免费模型） | 5    | exo-free 已下线的 A / B、一次原始往返、mimo 的 A / B           |
| pi                   | 3    | 一次原始 RPC 录制（回放样本来源）+ A / B                       |
| ChatGPT（ama 自身）  | 1    | `chatgpt/gpt-6-astra` 一次请求；另有两次模型列表 GET（不计费） |
