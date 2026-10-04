# ama 设计 v2：可独立使用、可嵌入 Armadra 的调用型编码 / 协调 Agent

> 状态：目标设计 v2（2026-10-02），未开始实施；替代 v1 全文。仓库 `github.com/Owlbay/armadra-agent`（MIT），npm 包名 `@armadra/agent`（0.2.1 起发布到 npm，打 `v*` tag 时由 CI 发布；Release 附件照常提供），可执行名 `ama`。
> 两种用法都是一等公民：① 任意目录下的独立 CLI；② 嵌入 Armadra 画布作为协调者（Armadra 仓库 `docs/design/coordinator-agent.md`，下称「文档 B」；其 `HostApi`、`profile.json`、事件词汇、内置 id `ama` 的契约以本文 §6.2 / §10.3 / §13 为准）。
> 参考版本 Pi 1.0（2026-10-01）。设计只借鉴 Pi 的分层、流事件契约、会话树、压缩与 TUI 组件模型；运行时不依赖它，也不出现其它任何第三方项目名。本文面向一个多代理并行实施团队：§1 给到文件级的目录树与所有权，§16 给批次与验收。

## §0 结论

| #   | 决定                                                                                                                                                                                                                | 理由                                                                                                                                                                  | v1→v2 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| D1  | **单包** `@armadra/agent`，子路径导出 `.`（SDK）、`./host`（宿主适配器类型）、`./rpc`（RPC 类型）、`./tui`（组件库，供宿主写对话框）、`./bundle`（单文件入口）                                                      | 一人维护多包只增加版本对齐成本；子路径导出已足够隔离契约面                                                                                                            | 加 `./tui` |
| D2  | 技术栈：Node ≥ 22、TypeScript 5.9 strict、pnpm、vitest 4、prettier 3、esbuild；源码 ESM，bundle 输出 **CJS 单文件**；**运行时依赖为零**                                                                             | Armadra 三条 bundle 都是 CJS 单文件 `target: node22`，用 `ELECTRON_RUN_AS_NODE=1` 启动；零依赖让单文件无原生模块、无许可证拖累、启动快                                 | 零依赖收紧 |
| D3  | **协议实现与供应商数据分离**：`ai/apis/*` 只实现协议（第一期 `anthropic-messages`、`openai-completions`；第二波 `google-generative-ai`、`openai-responses`），供应商 = `{id, baseUrl, api, envKeys, models[], compat}` 数据 | Pi 以 10 个协议接纳 40+ 供应商证明了这个拆法；国内常用供应商几乎全是 OpenAI 兼容线，两条协议即覆盖 §3.3 清单的 80%                                                     | 新 |
| D4  | 内置供应商目录 13 家（§3.3），模型目录随包携带（`ai/providers/catalog/*.json`），用户用 `config.json` 增删改；**只支持 API Key**，不做 OAuth，不联网刷目录                                                              | 需求已定；OAuth 的刷新与存储是另一期                                                                                                                                  | 新 |
| D5  | ama 的核心是**调用**：调用模型、调用工具、调用 Skill、调用子 Agent（`task`）、嵌入时调用画布上其它 CLI Agent（宿主注册的 `canvas_*` 工具）。**不做 MCP**，只做 Skill                                                | 五类调用在循环里是同一条路径（tool_call → 权限 → 执行）；MCP 的进程管理与权限模型是独立一期                                                                            | 明确 |
| D6  | **两层 Hook**：① 用户配置的命令式 Hook（`hooks.json`，事件 SessionStart…Notification，stdin/stdout JSON，退出码语义）；② 进程内宿主适配器 `HostApi`（`--host`）。顺序：命令式 Hook → 权限管线 → 宿主 broker → 执行 | Pi 没有命令式 Hook，这是 ama 自有设计；两层职责不同：命令式 Hook 给用户与项目做策略，HostApi 给宿主做集成                                                             | 新 |
| D7  | 核心零宿主概念；适配器**放宿主仓库**，本仓库只发布类型与 `HOST_API_VERSION = 1`；`create()` 返回 `undefined` 表示不激活                                                                                               | 适配器讲的是 Armadra 的 HTTP 面与令牌，随宿主发布节奏变                                                                                                               | 保留 |
| D8  | 事件词汇沿用 Pi 扩展事件名（`session_start … agent_settled`，加 `tool_approval_requested/resolved`）                                                                                                                | Armadra `hook/normalize/pi.ts` 零翻译                                                                                                                                 | 保留 |
| D9  | 会话是 **JSONL 条目树**；`message` 字段名与 Pi v3 一致；只追加                                                                                                                                                      | 分叉与分支摘要需要树；Armadra 历史解析几乎可复用                                                                                                                      | 保留 |
| D10 | 两档压缩：档一裁剪（`context_edit`，无模型调用）、档二摘要（`compaction`）；**上下文估算含 output**；溢出 / `length` → 压缩后以新 run **重试一次**；会话层重试 3 次（2 s 起 ×2，上限 60 s），失败尝试用 `context_edit` 剔除 | 吸收 Pi 的教训：少算 output 会晚触发；失败尝试留在历史但不回放最干净                                                                                                  | 修订 |
| D11 | 权限管线固定顺序：拒绝（规则 ∪ Hook deny）→ 危险命令 → 模式 → 允许（规则 ∪ Hook allow）；无人值守 `ask → deny`；**项目级配置只能收紧**，放宽只认用户级 / 命令行 / profile；项目级 Hook 与 Skill 需要**信任**           | 克隆来的仓库不能靠 `.ama/` 放开 `bash`；信任是 Pi 的做法，收紧是 ama 的加固                                                                                           | 修订 |
| D12 | 交互界面是**差分渲染的终端 UI**（主屏模式、非备用屏），组件模型「给定宽度返回行」；范围是 Pi 的子集（砍掉清单 §12.9）；`--no-tui` 行式降级保留；`TERM=dumb` / 非 TTY 自动降级                                           | Armadra 终端节点在 tmux 里跑，需要终端自己的回滚、括号粘贴 + `\r` 提交；备用屏与鼠标在那里是负担                                                                      | 修订 |
| D13 | 入口：`ama`（TUI）、`ama --no-tui`、`-p`（text / json / stream-json）、`--mode rpc`（stdio JSONL，Pi 形状）、SDK                                                                                                       | RPC 与 SDK 服务嵌入与测试；`-p` 服务脚本                                                                                                                              | 保留 |
| D14 | 独立模式的协调能力 = 同进程 `task` 子 Agent（深度 ≤ 1，并发 ≤ 4）；多 CLI 编排只在宿主下由宿主工具提供（第五波修订：独立模式也可经 `task(agent=…)` 驱动外部 CLI Agent，嵌入时由宿主注入 runner，见 [wave5-plan.md](wave5-plan.md) D13、D17）                                                                                                               | 终端、连线、worktree 是宿主领域                                                                                                                                       | 保留 |
| D15 | 分发：仓库 `pnpm build` 产出 npm 包形状（ESM + d.ts）与 `dist/bundle/ama.cjs`；GitHub Release 附 `ama.cjs` + `ama-sandbox.cjs` + `package.tgz` + `SHA256SUMS`；0.2.1 起 `v*` tag 由 CI `npm publish --provenance` 发布 `@armadra/agent`（0.3.0 之后优先 OIDC 可信发布，`NPM_TOKEN` 作回退）；Armadra 从 npm、Git 依赖或 Release 产物拉取 | 0.2.0 先只发 Release；包形状一直保持可发布，0.2.1 起在 release job 末尾加一步 npm 发布，provenance 把包与仓库 / 提交绑定 | 修订（0.2.1） |
| D16 | 测试不依赖真 key：脚本化 `fake` 供应商 + 录制的 SSE 样本黄金文件；TUI 用 `MemoryTerminal` 断言帧内容                                                                                                                 | CI 三平台可跑；供应商差异收敛在样本里                                                                                                                                 | 新 |
| D17 | 单文件 ≤ 600 行（源码），超出即拆；每个批次有明确文件所有权，跨批次只改自己拥有的文件，契约文件由 B0 所有                                                                                                             | 并行代理不互相覆盖；评审粒度可控                                                                                                                                      | 新 |
| D18 | 加入 **codemode**（§5.5）：一个 `codemode` 工具让模型写一段 JS 脚本编排多次工具调用，只有脚本输出回到模型；脚本跑在 `node --permission` 子进程的 `vm` 上下文里，零依赖；`codemode.mode: off \| on \| only`，缺省 `off`（由工具预设 `codemode` 打开，§5.6；2026-10 改为跟随预设：`default` 预设在 Node ≥ 25 时 `on`，预设 `codemode` 更名 `codemode-only`，见 §5.5） | 长流程任务的主要成本是「每次工具结果都带着整段历史回到模型」；把多步调用合进一次往返，实测可把累计 token 降到四分之一 | 新 |
| D19 | **工具预设**（§5.6）：默认 `default` 预设只给模型 6 个工具（read / edit / write / bash / grep / glob），`ls`、`todo`、`task`、`codemode` 默认关；删除 `skill` 工具（`read` 即可读 SKILL.md）；预设 `minimal` / `codemode` / `coordinator` 按场景切换 | 成本主要来自往返次数而非工具定义大小（10 个工具约 1650 token、在缓存前缀里）；ama 默认要审批 bash，保留只读的 grep / glob 才能让搜索免审批、跨平台 | 新 |
| D20 | **精简配置**：零配置可用——检测到任一供应商的标准环境变量即选其缺省模型直接运行；用户只需一个 `config.json`，常用键不超过 5 个（`defaultModel`、`tools.preset`、`permission.mode`、`providers`、`thinkingLevel`）；其余全部有缺省 | 配置越少，出错与文档成本越低；与 Pi「开箱即用」的思路一致 | 新 |
| D21 | **缓存保证**（§9.1）：系统提示与工具表构成字节稳定的前缀，跨回合不变；预设在会话开始时固定；工具表变化只以补丁追加；测试断言前缀逐字节稳定；状态栏显示缓存命中率 | 长任务的主要用量是缓存读取，前缀一旦抖动，缓存全部失效，成本成倍上升 | 新 |

### 第五波增补（0.5.0）

本文是 v2 的基线设计，第五波（0.5.0）的改动不逐节回写，按主题见下列文档（设计依据与决定表在 [wave5-plan.md](wave5-plan.md)）：

| 主题                                  | 现状文档                                                                                  | 涉及本文                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------ |
| 子 Agent（类型、后台、续聊、worktree） | [agents.md](agents.md)「子 Agent」                                                        | §5 `task`、D14                 |
| 外部 Agent 与 ACP                     | [agents.md](agents.md)「外部 Agent」、[acp.md](acp.md)                                    | D13、D14、§13                  |
| Plan 模式与计划审批                   | [plan.md](plan.md)、[permissions.md](permissions.md)「plan 模式与只读命令」               | §7                             |
| 回滚与检查点                          | [rewind-plan.md](rewind-plan.md)、[sessions.md](sessions.md)                              | §8                             |
| 操作系统沙箱（codemode、bash）        | [sandbox.md](sandbox.md)、[codemode.md](codemode.md)                                      | §5.5、§7                       |
| 压缩修订与 harness（截断、预算、提醒） | 本文 §9（已回写）、[wave5-plan.md](wave5-plan.md) §8                                      | §4、§9                         |
| 模型元数据快照、内置渠道、17 家供应商 | [providers.md](providers.md)「模型元数据」「内置供应商」                                  | §3.3、D4（目录改为快照 ⊕ 覆盖） |
| 图像、剪贴板、状态行、界面集成        | [providers.md](providers.md)「图像输入」、[tui.md](tui.md)、[tui-design.md](tui-design.md) | §12                            |
| 退出码 8 / 9                          | 下文 §11.3                                                                                | §11.3                          |

### 第六波增补（0.6.0）

第六波（0.6.0）同样不逐节回写；决定表、契约与批次在 [wave6-plan.md](wave6-plan.md)，调研依据在 [research/wave6/](research/wave6/README.md)，现状按主题见下表：

| 主题                                             | 现状文档                                                                                                                 | 涉及本文                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Agent 栏与全屏子 Agent 视图                      | [tui.md](tui.md)「Agent 栏」「子 Agent 视图」                                                                            | §12（主屏约束下的覆盖层，高 `行数 − 1`；`Ctrl+B` 只在输入为空时生效）                    |
| 轨迹（`ama.trace`、`/trace`、HTML、`get_trace`） | [tui.md](tui.md)「轨迹」、[sessions.md](sessions.md)「轨迹」、[rpc.md](rpc.md)「轨迹」、[session-format.md](session-format.md) | §8（`custom` 条目不进上下文、不改请求）、§13.2（RPC 43 条命令）                          |
| Memory（缺省关闭）                               | [memory.md](memory.md)                                                                                                   | §9.1（节顺序加 `memory`，位于 `skills` 之后；关闭时字节不变）、§7（权限类 `memory`）、§10.2 |
| ChatGPT 登录（SIWC 缺省、codex 备用）            | [providers.md](providers.md)「ChatGPT 登录」                                                                             | §3.3（内置供应商 18 家）、§3.5（`KeySource` 加 `oauth`）、§10.1（`auth.json` 的 oauth 条目与 `auth.json.lock`） |
| 中英双语                                         | [i18n.md](i18n.md)、[en/](en/tui.md) 七篇英文版                                                                          | §2（零依赖消息目录；发给模型的文本固定英文，两种语言下请求逐字节相同）                   |
| `/config` 面板与 `ama config get \| set`          | [tui.md](tui.md)「`/config` 设置面板与 `ama config`」                                                                    | §10.2（项目级只能收紧由同一函数判定）、§11.3（拒绝时退出码 3，无新退出码）               |
| `ui.replyLanguage`                               | [tui.md](tui.md)「配置与排错」                                                                                           | §9.1（`rules` 节末尾追加一句英文规则；不设时零字节变化）                                 |

## §1 架构与目录树

### §1.1 依赖方向

```text
cli → modes → { agent, tui, hooks, host } → { ai, session, compaction, tools, permissions, skills, config }
tui 不 import agent；ai 不 import session；host 不 import modes；hooks 不 import tools（只认 ToolDefinition 类型）
src/** 不 import 任何宿主包与任何 npm 运行时依赖（一条源码扫描测试守住：只允许 node: 内置模块与相对路径）
```

### §1.2 目录树（文件级；行数为源码预估，不含测试；`[Bn]` 为所有权批次，见 §16）

```text
package.json tsconfig.json tsconfig.build.json vitest.config.ts .prettierrc .npmrc .gitignore   [B0]
.github/workflows/ci.yml                                                                       [B0]
scripts/
  build-bundle.mjs          esbuild：src/bundle.ts → dist/bundle/ama.cjs，platform node，format cjs，target node22   80  [B0]
  check-no-deps.mjs         扫描 src/** 的 import：只允许 node:* 与相对路径；扫描 package.json dependencies 为空     60  [B0]
  record-sse.mjs            开发者本地用真 key 录 SSE 样本到 test/fixtures/sse/（CI 不跑）                         120 [B1]
src/
  index.ts                  SDK 公开面再导出                                                                       60  [B0]
  host.ts                   `./host` 子路径：类型 + HOST_API_VERSION                                                 20  [B0]
  rpc.ts                    `./rpc` 子路径：RPC 命令 / 事件类型                                                      20  [B0]
  tui.ts                    `./tui` 子路径：组件库再导出                                                             20  [B0]
  bundle.ts                 单文件入口：require 兜底 + 调 cli/main                                                   30  [B0]
  cli/
    main.ts                 bin 入口：进程标记、未捕获异常 → 退出码、调 bootstrap                                    120 [B5]
    args.ts                 手写参数解析（无依赖）：ParsedArgs、--help 文本、校验互斥                                 350 [B5]
    exit-codes.ts           退出码常量与说明（§11.4）                                                                 50  [B0]
    bootstrap.ts            §11 启动序列编排：返回 Runtime 或抛 StartupError{code}                                    400 [B5]
    runtime.ts              Runtime 类型（config、providers、session、hooks、host、permission、tools）                80  [B0]
    subcommands/
      auth.ts               `ama auth set|list|remove <provider>`（stdin 读 key）                                     160 [B5]
      sessions.ts           `ama sessions list|prune|show`                                                           180 [B5]
      models.ts             `ama models list [--provider]`、`ama models check <id>`（一次最小调用）                   120 [B5]
      doctor.ts             `ama doctor`：配置层级、信任状态、key 来源、hook 列表、终端能力                           160 [B5]
  modes/
    interactive/
      interactive-mode.ts   装配 TUI 根布局；会话事件 → 组件更新                                                    450 [B7]
      key-dispatch.ts       应用级键位分派（Ctrl+C / Esc 中断回填 / Alt+↑ 取回 / Shift+Tab / Ctrl+O / Ctrl+L / Ctrl+T）  130 [B7]
      message-view.ts       消息区：助手 Markdown、用户、steer、工具调用折叠、压缩摘要卡                              400 [B7]
      tool-view.ts          单个工具调用组件：标题行、折叠 / 展开、流式尾部、diff 高亮（edit）                        300 [B7]
      status-bar.ts         模型 / 思考级别 / token / 成本 / 上下文 % / 队列 / 权限模式 / 宿主状态                    200 [B7]
      approval-dialog.ts    审批对话框（y / n / a / 查看完整输入）                                                    180 [B7]
      commands.ts           斜杠命令表与处理器（/new /resume /compact /model /tree /fork /skill: /hooks …）           400 [B7]
      completion.ts         补全提供者：`/` 命令、`/skill:`、`@` 文件（glob 走 tools/glob）                           200 [B7]
      pickers.ts            模型选择、会话选择、树选择（都用 SelectList）                                             250 [B7]
      line/
        line-mode.ts        `--no-tui`：readline + 括号粘贴状态机 + 同一套 commands                                   300 [B6]
        paste-state.ts      ESC[200~ … ESC[201~ 字节状态机（与 tui/stdin-buffer 共用算法，独立实现便于单测）          120 [B6]
    print/
      print-mode.ts         -p：text / json / stream-json；无人值守策略                                                200 [B6]
      json-event.ts         线上事件形状（stream-json 与 RPC 共用）：message_update 纯增量 + usage                     180 [B6]
    rpc/
      rpc-mode.ts           stdio 读写、hello、关 stdin 有序退出、stdout 接管                                          250 [B6]
      commands.ts           命令分派表（§13.2）                                                                       450 [B6]
      jsonl.ts              按 LF 切分（容忍 CR，不切 U+2028）、分块写                                                 80  [B6]
  tui/
    component.ts            Component / Focusable / Theme 接口                                                        60  [B0]
    tui.ts                  TUI 主类：组件树、焦点、requestRender 合并、差分、同步输出、resize                        450 [B4]
    terminal.ts             Terminal 接口；ProcessTerminal（raw 模式、括号粘贴开关、尺寸）；MemoryTerminal（测试）     250 [B4]
    stdin-buffer.ts         攒完整转义序列；括号粘贴累积为一次 paste 事件；孤立 ESC 超时                                200 [B4]
    keys.ts                 键解析：CSI / SS3 / 修饰键 / Alt 前缀 / Shift+Enter 变体；KeyId 匹配                        350 [B4]
    ansi.ts                 visibleWidth / truncateToWidth / sliceByColumn / wrapTextWithAnsi（宽字符、emoji、组合）   300 [B4]
    theme.ts                语义色表、dark / light、能力降级（truecolor / 256 / 16 / NO_COLOR）                        200 [B4]
    keybindings.ts          动作 id → 键列表（固定表 + config 覆盖）                                                  120 [B4]
    components/
      container.ts          纵向容器                                                                                  100 [B4]
      text.ts               Text / TruncatedText（自动换行、缓存）                                                    150 [B4]
      markdown.ts           Markdown → 行：标题、列表、代码块、引用、行内强调 / 代码 / 链接；表格降级为等宽文本        500 [B4]
      editor-buffer.ts      文本缓冲：行 / 光标 / 选区 / 撤销栈 / 单词导航                                            350 [B4]
      editor.ts             多行编辑器组件：渲染、键处理、历史、补全列表、大粘贴折叠标记                               550 [B4]
      editor-paste.ts       粘贴折叠：阈值、标记 token、提交时展开                                                     150 [B4]
      select-list.ts        选择列表（过滤、分页、描述行）                                                             220 [B4]
      box.ts                边框 / 内边距                                                                              100 [B4]
      spacer.ts loader.ts   占位 / 旋转指示器                                                                          80  [B4]
      overlay.ts            覆盖层合成：只支持 center 与 bottom 两种锚点                                               150 [B4]
  agent/
    types.ts                AgentMessage、ContentBlock、Usage、SessionEvent、StopReason                               250 [B0]
    loop.ts                 runLoop 状态机：外层 followUp、内层 工具 / steer；钩子点                                   400 [B2]
    agent.ts                有状态 Agent：队列、activeRun、abort、waitForIdle                                         300 [B2]
    queue.ts                PendingMessageQueue：one-at-a-time / all                                                 80  [B2]
    tool-runner.ts          准备串行（校验 → Hook → 权限）/ 执行并行；sequential 传染；结果按原序入转录               350 [B2]
    retry.ts                可重试 / 不可重试判定、退避、abort 可打断                                                   150 [B2]
    transform.ts            回放修复：tool id 归一化、跨模型思考块降级、跳过 error/aborted、孤儿 tool_call 补结果      250 [B2]
    system-prompt.ts        命名节装配（preamble → tools → rules → project_context → skills → cwd → host）与 diff     220 [B2]
    session.ts              AgentSession：提示展开（模板 / skill）、重试调度、压缩调度、hook 调度、事件广播           550 [B2]
    session-state.ts        SessionState 快照与统计（tokens、成本、上下文 %）                                          120 [B2]
    schema.ts               JSON Schema 子集校验（object / string / number / boolean / array / enum / required）      200 [B0]
  ai/
    types.ts                Api、Provider、Model、Compat、Message、AssistantEvent、StreamOptions                      350 [B0]
    event-stream.ts         AsyncIterable + result()                                                                  100 [B1]
    sse.ts                  SSE 解析器（event / data / 多行 data / 注释 / CRLF）                                        120 [B1]
    http.ts                 fetch 包装：超时、头合并（null 删除）、错误体读取、代理 env 透传说明                        120 [B1]
    json-partial.ts         容错 JSON 片段解析（流式 tool_call 参数）                                                   150 [B1]
    overflow.ts             上下文溢出错误识别（各家文案正则）                                                          100 [B1]
    cost.ts                 阶梯价、1h 缓存写 2×、Usage.input 不含缓存                                                 80  [B1]
    thinking.ts             ThinkingLevel 钳位、thinkingLevelMap、预算型缺省                                            120 [B1]
    context.ts              normalizeContext：system 折叠、工具表差异、模态过滤                                         150 [B1]
    apis/
      api.ts                ApiImplementation 接口 + 注册表（按 id 懒加载）                                             80  [B1]
      anthropic-messages.ts 请求体、cache_control 断点、thinking、SSE → 事件、usage                                     550 [B1]
      openai-completions.ts 请求体、tool_calls 增量拼接、usage 差异、reasoning 字段                                      550 [B1]
      openai-compat.ts      detectCompat：provider id + baseUrl 推断 → model.compat 覆盖                                200 [B1]
      google-generative-ai.ts streamGenerateContent?alt=sse、functionCall / functionResponse、thoughtSignature          450 [B8]
      openai-responses.ts   response.* 事件、function_call item、reasoning summary                                       450 [B8]
    providers/
      registry.ts           ProviderRegistry：内置 + config 合并、模型查找、`provider/model` 字符串解析                 220 [B1]
      builtin.ts            13 家内置供应商数据（§3.3）                                                                200 [B1]
      catalog.ts            加载 catalog/*.json、校验、覆盖合并                                                        120 [B1]
      catalog/*.json        每家一份模型目录（数据，不计行）                                                            —   [B1]
      auth.ts               key 发现顺序、各家标准环境变量、`$ENV` 插值、`!command` 取值                                220 [B1]
    fake/
      fake-provider.ts      脚本化供应商：按第 n 次调用返回文本 / 工具调用 / 429 / 溢出 / 断流                           250 [B1]
      fake-script.ts        脚本 JSON 类型与加载                                                                        80  [B1]
  session/
    types.ts                SessionHeader、SessionEntry 联合                                                            150 [B0]
    manager.ts              SessionManager：open / create / inMemory、append、leaf、fork、clone、name                   500 [B2]
    projection.ts           buildContextEntries / buildProjection / buildContext                                        250 [B2]
    tree.ts                 树结构、公共祖先、路径                                                                       200 [B2]
    store.ts                目录编码、文件名、原子追加、锁、trash                                                       220 [B2]
    migrate.ts              v1 文件读取兜底（预留）                                                                     60  [B2]
  compaction/
    estimate.ts             contextTokens 估算（含 output；编辑在 usage 之后则按投影重估）                              120 [B2]
    prune-tier.ts           档一：旧 toolResult 裁剪为 context_edit                                                     200 [B2]
    cut-point.ts            档二切点：keepRecentTokens、合法切点、split turn                                            180 [B2]
    serialize.ts            被摘要段的文本序列化（工具结果截 2000 字符）                                                120 [B2]
    summarize-tier.ts       摘要调用、模板、文件列表累计、关闭缓存写                                                    300 [B2]
    branch-summary.ts       /tree 离开分支时的摘要                                                                      200 [B2]
    breaker.ts              熔断状态机                                                                                  80  [B2]
  tools/
    types.ts                ToolDefinition、ToolContext、ToolResult（也从 ./host 导出）                                 120 [B0]
    registry.ts             ToolRegistry：内置 + 宿主注册、disable、活动集、按名排序                                    140 [B3]
    truncate.ts             头 / 尾截断（行数 + 字节双阈值）、落盘全文                                                   130 [B3]
    paths.ts                展开 ~、相对 cwd 解析、禁止 NUL、符号链接策略                                               100 [B3]
    file-mutex.ts           按路径串行化读 - 改 - 写                                                                    60  [B3]
    read.ts                 文本 / 二进制检测 / 图片附件 / offset-limit                                                 220 [B3]
    write.ts                整文件写、建父目录、先读后写检查                                                            130 [B3]
    edit.ts                 多处替换、唯一性、不重叠、BOM / CRLF 保留、diff 到 details                                  350 [B3]
    edit-fuzzy.ts           模糊匹配回退（NFKC、行尾空白、引号归一）                                                    200 [B3]
    bash.ts                 命令执行、超时、流式尾部、环境注入、结构化结果                                               350 [B3]
    shell.ts                shell 选择（POSIX / Windows）、参数拼装                                                     180 [B3]
    process-tree.ts         进程组 / 杀树（SIGTERM → SIGKILL；taskkill /T /F）、退出码 128+signo                        140 [B3]
    output-accumulator.ts   滚动尾部 + 超限落文件                                                                       150 [B3]
    grep.ts                 内置正则搜索：并发读文件、二进制跳过、上下文行、limit                                        350 [B3]
    glob.ts                 内置 glob（`**`、`{a,b}`、`[...]`、否定）                                                    300 [B3]
    ignore.ts               .gitignore / .ignore 解析与匹配（含嵌套、否定、目录规则）                                    280 [B3]
    ls.ts                   目录列表（类型、大小、limit）                                                                120 [B3]
    todo.ts                 会话内任务清单（`custom` 条目持久化，不进上下文；渲染给 TUI）                                160 [B3]
    skill.ts                （已删除，§5.6：Skill 正文用 read 读取）                                  120 [B3]
    task.ts                 子 Agent：独立 AgentSession、工具子集、深度 / 并发限制、结果摘要、独立 JSONL                 320 [B3]
  skills/
    discover.ts             目录扫描、SKILL.md 定位、重名策略、信任过滤                                                  200 [B3]
    frontmatter.ts          YAML 头**子集**解析（`key: value`、单行字串、简单数组）                                      120 [B3]
    index-prompt.ts         `<available_skills>` 索引生成                                                               80  [B3]
    expand.ts               `/skill:<name> args` 展开格式                                                               100 [B3]
    templates.ts            提示模板 `prompts/*.md`：`$1 $@ ${1:-x} ${@:N}`                                             200 [B3]
  hooks/
    types.ts                HookEvent、HookConfig、HookInput、HookOutput、HookDecision                                  150 [B0]
    config.ts               发现与合并（用户级 / 项目级 / profile）、信任过滤、校验                                      220 [B5]
    matcher.ts              matcher 语法：工具名 glob、`bash(git push*)`、正则 `/…/`                                     110 [B5]
    runner.ts               子进程执行：stdin JSON、超时、并行、退出码解释、stderr 收集                                   350 [B5]
    protocol.ts             输入 / 输出 JSON 的构造与校验、决策合并规则                                                   180 [B5]
    dispatcher.ts           HookDispatcher：按事件挂到 AgentSession 的钩子点；Notification 投递                          250 [B5]
  permissions/
    types.ts                Rule、Mode、Decision、ApprovalRequest                                                        80  [B0]
    rules.ts                规则解析（`bash(git *)`、`write(src/**)`）、来源标记、收紧校验                                220 [B3]
    dangerous.ts            危险命令表（正反例测试）                                                                      250 [B3]
    pipeline.ts             四步管线 + Hook 决策合入 + 无人值守；auto 三层与 allowlist（§7.4）                             400 [B3]
    modes.ts                六种模式的显示名、说明、界面顺序与 Shift+Tab 循环                                             60
    protected.ts            auto 的受保护路径：机密文件、.git / .ama 写入、项目外写入                                       120
    auto-safe.ts            auto 的 bash 判定：安全名单、网络 / 删除类命令、重定向与路径参数                                350
    classifier.ts           auto 的模型分类器：提示（数据块防注入）、严格 JSON 解析、超时、会话内缓存                        220
    broker.ts               ApprovalBroker 链：宿主 → UI → 无人值守；超时 deny；allow_session 记忆                       160 [B3]
  host/
    types.ts                HostModule、HostAdapter、HostApi、AgentEvents                                                260 [B0]
    api-impl.ts             HostApi 实现：工具注册、事件总线、指令追加、broker、sendUser、ui.notify                       300 [B5]
    loader.ts               `--host` 加载（CJS / ESM）、版本校验、create 超时、dispose                                   150 [B5]
  config/
    paths.ts                XDG / APPDATA、AMA_CONFIG_DIR、AMA_DATA_DIR、sessionDir 规则                                 120 [B5]
    schema.ts               config.json / auth.json / profile.json / hooks.json / trust.json 类型与校验                   320 [B5]
    load.ts                 读文件 + 校验 + 诊断（行号、字段路径）                                                       220 [B5]
    merge.ts                层级合并：缺省 ← 用户级 ← profile ← 项目级（受限字段）← 命令行                                180 [B5]
    trust.ts                trust.json、祖先匹配、询问策略、`--trust/--no-trust`                                         200 [B5]
    profile.ts              profile.json 解析为等价参数                                                                   120 [B5]
    auth-file.ts            auth.json 读写（0600）、`ama auth` 后端                                                      150 [B5]
    context-files.ts        AGENTS.md 向上查找（`AGENTS.override.md > AGENTS.md > AGENTS.MD`，外层在前，worktree 去重） 160 [B5]
  sdk.ts                    createAgentSession、createRuntime、公开类型                                                  280 [B6]
docs/                       design.md（本文）、rpc.md、session-format.md、host-api.md、hooks.md、providers.md、tui.md
test/
  fixtures/sse/<api>/<case>.txt            录制 SSE 样本（两条第一期协议各 ≥ 8 个用例）
  fixtures/scripts/*.json                  脚本化供应商脚本
  fixtures/sessions/*.jsonl                会话样本
  fixtures/rpc/*.jsonl                     RPC 黄金记录
  fixtures/tui/*.txt                       TUI 帧黄金文件
  helpers/                                  tmp-home、MemoryTerminal 驱动、fake 供应商启动器
```

合计源码约 2.1–2.4 万行（含 TUI 与两条后置协议），MVP 范围约 1.4 万行。

## §2 技术栈与工程约定

| 项         | 约定                                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时     | Node ≥ 22（`engines.node: ">=22"`），只用 `node:` 内置模块；HTTP 用全局 `fetch`，SSE 自写；YAML 只支持 frontmatter 子集自写；JSON Schema 校验自写子集                                                                  |
| 语言       | TypeScript 5.9，`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`verbatimModuleSyntax`、`module: NodeNext`；源码 ESM，import 带 `.js` 后缀                                                        |
| 包管理     | pnpm 9；`packageManager` 字段固定；`dependencies` **必须为空**（`scripts/check-no-deps.mjs` 在 CI 守住）                                                                                                              |
| 测试       | vitest 4，`pool: "forks"`；单测与模块同目录 `*.test.ts`；端到端在 `test/e2e/`；覆盖率不设门槛但 CI 报告                                                                                                              |
| 格式       | prettier 3（`printWidth 100`、双引号、尾逗号 all）；`pnpm fmt:check` 在 CI                                                                                                                                              |
| 构建       | `tsc -p tsconfig.build.json` → `dist/`（ESM + d.ts）；`node scripts/build-bundle.mjs` → `dist/bundle/ama.cjs`；bundle 内把 `import.meta.url` 替换为 `__filename` 等价                                                 |
| 单文件     | ≤ 600 行；函数 ≤ 80 行建议；禁止默认导出（`--host` 模块除外）                                                                                                                                                         |
| 日志       | `stderr` 唯一诊断通道；`AMA_LOG=debug|info|warn|error`；`AMA_LOG_FILE` 可落盘；协议模式下 stdout 只放协议                                                                                                             |
| 错误       | `class AmaError extends Error { code: string; exitCode?: number; detail?: unknown }`；启动期错误是 `StartupError`                                                                                                       |

### §2.1 仓库根文件

`package.json`（节选）：

```json
{
  "name": "@armadra/agent", "version": "0.1.0", "type": "module", "license": "MIT",
  "bin": { "ama": "dist/cli/main.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./host": { "types": "./dist/host.d.ts", "import": "./dist/host.js" },
    "./rpc": { "types": "./dist/rpc.d.ts", "import": "./dist/rpc.js" },
    "./tui": { "types": "./dist/tui.d.ts", "import": "./dist/tui.js" },
    "./bundle": "./dist/bundle/ama.cjs"
  },
  "files": ["dist", "docs/rpc.md", "docs/host-api.md", "docs/hooks.md"],
  "engines": { "node": ">=22" },
  "private": false,
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "pnpm build:lib && pnpm build:bundle",
    "build:lib": "tsc -p tsconfig.build.json",
    "build:bundle": "node scripts/build-bundle.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "AMA_E2E=1 vitest run test/e2e",
    "fmt": "prettier --write .",
    "fmt:check": "prettier --check .",
    "check:deps": "node scripts/check-no-deps.mjs",
    "ci": "pnpm typecheck && pnpm fmt:check && pnpm check:deps && pnpm test && pnpm build && node dist/bundle/ama.cjs --version"
  },
  "dependencies": {},
  "devDependencies": { "typescript": "5.9.x", "vitest": "4.x", "prettier": "3.x", "esbuild": "0.2x", "@types/node": "22.x" }
}
```

`vitest.config.ts`：`test.pool = "forks"`、`testTimeout = 20000`、`include = ["src/**/*.test.ts", "test/**/*.test.ts"]`、`exclude e2e unless AMA_E2E`、`setupFiles = ["test/helpers/setup.ts"]`（设 `AMA_CONFIG_DIR` / `AMA_DATA_DIR` 到临时目录、清空各家 `*_API_KEY`）。

`.github/workflows/ci.yml`：矩阵 `os: [ubuntu-latest, macos-latest, windows-latest]`、`node: [22, 24]`；步骤 checkout → pnpm setup → `pnpm install --frozen-lockfile` → `pnpm ci`；Windows 行额外 `node dist/bundle/ama.cjs -p "hi" --provider fake --model fake/echo`；`v*` 标签触发 release job：构建、`sha256sum dist/bundle/ama.cjs > SHA256SUMS`、上传 Release 附件，随后 `npm publish --provenance --access public`（优先 OIDC 可信发布、回退 `NPM_TOKEN`；该版本已发布时跳过，见 §14）。

## §3 模型接入

### §3.1 协议层（`ai/apis/`）

```ts
export type KnownApi = "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
export type Api = KnownApi | (string & {});

export interface ApiImplementation<C = unknown> {
  readonly id: Api;
  stream(model: Model, context: TranscriptContext, options: StreamOptions): AssistantEventStream;
  detectCompat?(model: Model, provider: ProviderData): C;      // 推断缺省 compat
}
export interface StreamOptions {
  signal: AbortSignal; apiKey?: string; headers?: Record<string, string | null>;
  timeoutMs?: number; maxTokens?: number; temperature?: number;
  thinkingLevel?: ModelThinkingLevel; cacheRetention?: "none" | "short" | "long"; sessionId?: string;
  onPayload?(payload: unknown): unknown | void;                // 观测 / 替换请求体（宿主与测试用）
  onResponse?(status: number, headers: Headers): void;
}
export type AssistantEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_end"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_start" | "thinking_end"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; id: string; name: string; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallBlock; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; message: AssistantMessage };
export interface AssistantEventStream extends AsyncIterable<AssistantEvent> { result(): Promise<AssistantMessage> }
```

流契约（与 Pi 相同，测试逐条断言）：请求成功后先 `start`；块事件配对；**恰好一个**终止事件；取消 → `error{reason:"aborted"}`；`toolcall_end` 时参数已是合法对象；**流函数不抛错**，失败编码进 `error` 事件（缺 key 例外：同步抛 `AmaError{code:"no_api_key"}`，启动期就能发现）。

| 协议                   | 批次 | 理由                                                                                                                                                    |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic-messages`   | B1   | 第一供应商；缓存断点与 thinking 签名要原生支持                                                                                                          |
| `openai-completions`   | B1   | 一条线覆盖 DeepSeek、Moonshot、GLM、Qwen、OpenRouter、Groq、xAI、Mistral、Ollama、LM Studio、自定义——国内与本地的全部；差异靠 compat                    |
| `google-generative-ai` | B8   | Gemini 的 OpenAI 兼容端点缺 thought signature 与多模态细节，原生协议才能完整；但第一期用户可先走 OpenRouter 调 Gemini                                    |
| `openai-responses`     | B8   | 只有 OpenAI 自家最新推理模型必需；Completions 仍可用于绝大多数 OpenAI 模型；放第二波避免第一波三条协议并行拉长                                             |
| 不做                   | —    | Azure、Bedrock、Vertex（云身份不是 API Key）、Mistral 专有 conversations（其 OpenAI 兼容端点够用）、图像 / 分类 / 代理网关专有线                        |

### §3.2 供应商与模型数据

```ts
export interface ProviderData {
  id: string; name: string; api: Api; baseUrl: string;
  envKeys: string[];                      // API Key 环境变量候选，顺序即优先级；首项是「各家标准名」
  authHeader?: "authorization-bearer" | "x-api-key" | "x-goog-api-key" | { header: string; prefix?: string };
  headers?: Record<string, string>;
  compat?: Partial<OpenAICompletionsCompat | AnthropicMessagesCompat | GoogleCompat | OpenAIResponsesCompat>;
  models: Model[];
  requiresApiKey: boolean;                // 本地服务 false：无 key 也能用
  builtin: boolean;
}
export interface Model {
  id: string; name: string; provider: string; api: Api; baseUrl?: string;
  input: ("text" | "image")[]; reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | number | null>>;   // null = 该级别不支持
  contextWindow?: number; maxTokens: number;                                       // 缺 contextWindow → 关自动压缩并警告
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[] };
  promptCache?: { short?: number; long?: number };
  headers?: Record<string, string>; samplingParams?: Record<string, unknown>;
  compat?: ProviderData["compat"];
}
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
```

### §3.3 内置供应商目录（`ai/providers/builtin.ts`）

| id            | api                    | baseUrl                                                 | envKeys（顺序）                                  | 备注 / compat 推断                                                                        |
| ------------- | ---------------------- | ------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `anthropic`   | anthropic-messages     | `https://api.anthropic.com`                             | `ANTHROPIC_API_KEY`, `AMA_API_KEY_ANTHROPIC`     | 三断点缓存；`x-api-key`                                                                   |
| `openai`      | openai-completions（B8 后新推理模型可切 responses） | `https://api.openai.com/v1`     | `OPENAI_API_KEY`, `AMA_API_KEY_OPENAI`           | `maxTokensField: max_completion_tokens`、`developer` role、`reasoning_effort`             |
| `google`      | google-generative-ai（B8 前以 openrouter 过渡）  | `https://generativelanguage.googleapis.com/v1beta`  | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AMA_API_KEY_GOOGLE` | `x-goog-api-key`                                                         |
| `deepseek`    | openai-completions     | `https://api.deepseek.com`                              | `DEEPSEEK_API_KEY`, `AMA_API_KEY_DEEPSEEK`       | `maxTokensField: max_tokens`、`requiresReasoningContentOnAssistantMessages`、`thinkingFormat: deepseek`、缓存命中 `prompt_cache_hit_tokens` |
| `moonshot`    | openai-completions     | `https://api.moonshot.cn/v1`（`moonshot-intl` 用 `.ai`） | `MOONSHOT_API_KEY`, `KIMI_API_KEY`               | `max_tokens`；顶层 `cached_tokens`                                                        |
| `zhipu`       | openai-completions     | `https://open.bigmodel.cn/api/paas/v4`                  | `ZHIPU_API_KEY`, `ZAI_API_KEY`                   | `thinkingFormat: zai`（`thinking.type`）；`max_tokens`                                     |
| `dashscope`   | openai-completions     | `https://dashscope.aliyuncs.com/compatible-mode/v1`     | `DASHSCOPE_API_KEY`, `QWEN_API_KEY`              | `thinkingFormat: qwen`（`enable_thinking`）；`thinkingTokenBudgetField: thinking_budget` |
| `openrouter`  | openai-completions     | `https://openrouter.ai/api/v1`                          | `OPENROUTER_API_KEY`                             | `thinkingFormat: openrouter`（`reasoning.effort`）；`anthropic/*` 模型 `cacheControlFormat: anthropic`；`HTTP-Referer` / `X-Title` 头 |
| `groq`        | openai-completions     | `https://api.groq.com/openai/v1`                        | `GROQ_API_KEY`                                   | `supportsUsageInStreaming: true`（`x_groq.usage` 兼容读取）                               |
| `xai`         | openai-completions     | `https://api.x.ai/v1`                                   | `XAI_API_KEY`                                    | `reasoning_effort`                                                                        |
| `mistral`     | openai-completions     | `https://api.mistral.ai/v1`                             | `MISTRAL_API_KEY`                                | `supportsDeveloperRole: false`、`requiresToolResultName: true`                            |
| `ollama`      | openai-completions     | `http://127.0.0.1:11434/v1`                             | `OLLAMA_API_KEY`（可无）                         | `requiresApiKey: false`；模型表空，用 `ama models list --provider ollama` 从 `/api/tags` 拉（唯一联网枚举，本地） |
| `lmstudio`    | openai-completions     | `http://127.0.0.1:1234/v1`                              | （无）                                           | `requiresApiKey: false`；`/v1/models` 枚举                                                 |

自定义供应商（`config.json.providers.<id>`）字段同 `ProviderData` 去掉 `builtin`；`api` 缺省 `openai-completions`。自定义模型缺省 `maxTokens: 8192`、`reasoning: false`、`input: ["text"]`，**不猜 `contextWindow`**（缺省关自动压缩并在状态栏显示 `ctx: ?`）。

`OpenAICompletionsCompat`（第一期全部实现）：`maxTokensField`、`supportsDeveloperRole`、`supportsUsageInStreaming`、`supportsFinishReason`、`supportsReasoningEffort`、`thinkingFormat: "openai" | "openrouter" | "deepseek" | "zai" | "qwen" | "none"`、`thinkingTokenBudgetField`、`requiresReasoningContentOnAssistantMessages`、`requiresToolResultName`、`requiresAssistantAfterToolResult`、`supportsMidConvoSystemMessages`、`cacheControlFormat`、`supportsStrictTools`、`supportsStore`。`detectCompat` 顺序：`provider.compat` ← baseUrl 子串推断表（`deepseek.com`、`moonshot.`、`bigmodel.cn`、`dashscope.`、`openrouter.ai`、`groq.com`、`x.ai`、`mistral.ai`、`:11434`、`:1234`）← `model.compat` 字段级覆盖。文档告诫：compat 只记录**已验证**差异。

第五波（[wave5-plan.md](wave5-plan.md) §3）：内置供应商支持内置渠道与缺省渠道表（Messages / Responses 优先、Chat 回落），新增 minimax / stepfun / volcengine / tencent；Anthropic 协议按主机推断 compat。

`AnthropicMessagesCompat`：`supportsCacheControlOnTools`、`supportsTemperatureWithThinking`、`adaptiveThinking`（新模型 `effort` 参数，老模型 `budget_tokens`）、`maxCacheBreakpoints`。

### §3.4 模型目录（`ai/providers/catalog/*.json`）

格式 `{ "version": 1, "provider": "<id>", "models": [Model 去掉 provider/api] }`；每家 5–15 条当前主流模型，字段必填 `id, name, contextWindow, maxTokens, reasoning, cost`。维护方式：人工校对，PR 更新；`ama models list` 显示来源（内置 / 用户覆盖）。用户 `config.json.models[]` 同 `provider/id` 覆盖，`modelOverrides[]` 只改元数据。模型引用字符串 `provider/model-id`（`--model deepseek/deepseek-chat`）；无斜杠时在已配置 key 的供应商里唯一匹配，否则报错列出候选。

第五波起目录只写覆盖项与 ama 特有字段，数值事实从入库的 models.dev 快照继承，运行时不联网，`ama models refresh` 显式刷新（[wave5-plan.md](wave5-plan.md) §2）。

### §3.5 API Key 发现顺序（`ai/providers/auth.ts`）

```text
① --api-key <key>（只配合显式 --model；不进 shell 历史的替代是 ②）
② --auth-file / profile.authFile 指向的 auth.json
③ ~/.config/ama/auth.json（0600；不是 0600 → warning 并照用，doctor 提示）
④ config.json 的 providers.<id>.apiKey（支持 "$ENV_NAME"、"${ENV_NAME}"、"!command"；"$$" 转义）
⑤ 环境变量：provider.envKeys 顺序（各家标准名在前，AMA_API_KEY_<ID> 兜底）
⑥ requiresApiKey=false 的供应商：无 key 也放行
```

`auth.json`：`{ "version": 1, "providers": { "<id>": { "apiKey": "...", "env"?: {...}, "baseUrl"?: "..." } } }`；`apiKey` 以 `!` 开头 = 执行命令取值（进程内缓存，超时 10 s，空输出 / 非零视为未配置）。密钥只在 `resolveApiKey()` 的返回值里存在，不进日志、不进会话、不进事件；RPC `get_available_models` 只回 `hasKey: boolean` 与 `keySource`。

### §3.6 思考映射、重试、溢出、成本

| 项   | 决定                                                                                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 思考 | 用户面 `off/minimal/low/medium/high/xhigh`；`getSupportedLevels(model)` 按 `reasoning` 与 `thinkingLevelMap` 过滤；`clamp` 后映射：Anthropic 预算 1024/2048/8192/16384 或 `effort`；Completions 按 `thinkingFormat`；不支持的模型记 warning 不报错 |
| 重试 | 会话层：`maxRetries 3`、`baseDelayMs 2000`、×2、上限 60 000、abort 可打断；先匹配**不可重试**（`insufficient_quota`、`billing`、`invalid_api_key`、401/403）快速失败；再匹配可重试（429、5xx、`overloaded`、网络错误、断流）；失败那条 assistant 落盘 + `context_edit{replacement:null}` 剔除；事件 `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage}` / `auto_retry_end{success,attempt,finalError?}`；协议层自身不重试 |
| 溢出 | `ai/overflow.ts` 正则表（各家文案）+ `stopReason: "length"` 且无工具调用 → 不重试，走 §9 的压缩后重试一次                                                                                                                                    |
| 成本 | `calculateCost(model, usage)`：按 `input+cacheRead+cacheWrite` 选阶梯；`Usage.input` 不含缓存部分；1h 缓存写 2×；写回 `usage.cost{input,output,cacheRead,cacheWrite,total}`；无 `cost` 的模型显示 `$?`                                     |
| 缓存 | Anthropic 断点：system 末、最后一个工具定义、**最后一条 user 消息**（不再用「倒数第二条」）；Completions / Responses：`prompt_cache_key = sessionId`；摘要请求 `cacheRetention: "none"`                                                      |

## §4 循环（`agent/`）

### §4.1 状态与钩子点

```text
idle ──prompt──▶ running ──(流结束, 有 tool_call)──▶ executing-tools ──┐
  ▲                 ▲                                                  │ steer 队列 → 下一次模型调用前
  │                 └──────────────────────────────────────────────────┘
  │◀── agent_settled ◀── followUp 队列（有则新 run）◀── agent_end（无 tool_call 且 steer 空）
```

```ts
export interface LoopHooks {
  transformContext?(messages: AgentMessage[], signal: AbortSignal): Promise<AgentMessage[]>;  // 档一裁剪、Hook 的 additionalContext 注入
  convertToLlm(messages: AgentMessage[]): Message[];                                          // 不得抛错
  prepareRequest?(req: { context; model; thinkingLevel }): Promise<typeof req>;              // Hook before_provider_request 不开放给命令式 Hook
  prepareNextTurn?(prev: TurnResult): Promise<void>;                                          // 阈值压缩在此
  beforeToolCall(call: ToolCall, ctx): Promise<{ block?: boolean; reason?: string; input?: unknown }>; // 命令式 Hook PreToolUse → 权限管线 → broker
  afterToolCall?(call: ToolCall, result: ToolResult): Promise<ToolResult>;                    // PostToolUse 可追加上下文
  finishTurn?(turn: TurnResult): Promise<"continue" | "end">;
  getSteeringMessages(): AgentMessage[]; getFollowUpMessages(): AgentMessage[];
}
```

- run / turn 定义、`agent_end` vs `agent_settled`、`agent_end.willRetry` 与 v1 一致；新增 `agent_before_settle` 为最后可行动边界（宿主只观察）。
- `stopReason: "length"` 且有 tool_call：整批判失败不执行，结果写明「参数可能被截断」。

### §4.2 中断（abort）

与 v1 §3.2 完全一致：会话级 `AbortController` 同时给供应商流、每个工具、重试计时器；`bash` SIGTERM → 2 s → SIGKILL（Windows `taskkill /T /F`）；**落盘补 tool_result**（`isError: true, "aborted by user"`）+ `custom_message{customType:"ama.aborted"}`；回放时 `transform.ts` 再兜底修复旧文件；abort 不清队列；`abort()` 在 idle 后 resolve。

### §4.3 steer / followUp

与 v1 §3.3 一致；补充：`prompt()` 运行中无 `streamingBehavior` → reject `AmaError{code:"busy"}`；斜杠命令立即执行不入队；steer 消息 `origin: "steer"`，宿主 `sendUser(text, origin)` 注入的消息 `origin: "host"`。

### §4.4 工具执行（`agent/tool-runner.ts`）

准备阶段**串行**（找工具 → schema 校验 → `beforeToolCall`：PreToolUse Hook → 权限管线 → broker），执行阶段**并行**（任一工具 `executionMode: "sequential"` 则整批串行；`bash`、`write`、`edit`、`task` 是 sequential，`read/grep/glob/ls/skill/todo` 是 parallel）；`tool_execution_end` 按完成顺序发，toolResult 按原序入转录；`terminate` 要整批都为真才提前结束。输出超 `maxToolResultChars`（缺省 30 000）截断并写 `<sessionDir>/outputs/<toolCallId>.txt`。

## §5 调用面：工具、Skill、子 Agent、宿主工具

### §5.1 工具契约（`tools/types.ts`，从 `./host` 再导出）

```ts
export interface ToolDefinition<I = unknown> {
  readonly name: string;                   // ^[a-z][a-z0-9_]{1,63}$；宿主工具建议前缀（canvas_*）
  readonly label?: string;                 // TUI 标题
  readonly description: string;
  readonly parameters: JsonSchema;         // 子集：object/string/number/integer/boolean/array/enum/required/description
  readonly permission: "read" | "write" | "execute";
  readonly executionMode?: "sequential" | "parallel";   // 缺省 parallel（read 类）；write/execute 缺省 sequential
  readonly annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  readonly promptSnippet?: string;         // 系统提示 tools 节一行
  readonly promptGuidelines?: string[];    // rules 节
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
  renderCall?(input: I, width: number): string[];       // TUI 可选自定义渲染
  renderResult?(result: ToolResult, width: number, expanded: boolean): string[];
}
export interface ToolContext {
  readonly toolCallId: string; readonly cwd: string; readonly sessionId: string; readonly sessionFile?: string;
  readonly signal: AbortSignal; readonly depth: number;      // task 深度
  onUpdate(partial: string): void;
  readFiles: ReadonlySet<string>;                             // 本会话已 read 的绝对路径（write 先读后写检查）
  activeTools?: ReadonlySet<string>;                          // [S-A] 会话活动集快照（read 目录提示用）
  tools: { executeTool(name: string, input: unknown): Promise<ToolResult> };   // task 用，受同一管线
  log(level: "debug" | "info" | "warn", message: string): void;
}
export interface ToolResult {
  content: string | ContentBlock[]; isError?: boolean; details?: unknown;   // details 落盘，不进上下文
  structured?: unknown; terminate?: boolean;
}
```

### §5.2 内置工具完整规格

| 工具    | 参数                                                                          | 权限 / 模式          | 行为规格                                                                                                                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `path, offset?(1 起), limit?`                                                 | read / parallel      | 相对 cwd 解析，`~` 展开；文本返回 `行号→内容`（`cat -n` 形状）；**头截断** 2000 行或 50 KB 先到者，末尾提示 `offset` 续读；二进制（NUL 嗅探）拒绝；图片 `png/jpg/gif/webp` 作为 ImageBlock 返回（模型不支持 image 则给路径与尺寸）；成功后加入 `ctx.readFiles`                                                                           |
| `write` | `path, content`                                                               | write / sequential   | 整文件覆盖，自动建父目录；文件存在且不在 `readFiles` → 错误「先 read」；保留原文件的 BOM 与换行风格（若存在）；`details: { bytes, created }`                                                                                                                                                                                             |
| `edit`  | `path, edits: [{oldText, newText}], replaceAll?`                              | write / sequential   | 每处在**原文**上匹配、必须唯一且互不重叠（`replaceAll` 例外）；先精确再模糊（NFKC、行尾空白、引号 / 破折号归 ASCII）；不唯一 → 错误含出现次数与首两处行号；保留 BOM / CRLF；`details.diff` 统一 diff 给 TUI；要求先 read                                                                                                                 |
| `bash`  | `command, timeoutMs?(缺省 120000，上限 600000), cwd?, description?`           | execute / sequential | shell：`AMA_SHELL` → POSIX `/bin/bash` → `sh`；Windows `AMA_SHELL` → Git Bash 已知路径 → `powershell -NoProfile -Command`；`spawn(shell, ["-c", command], { detached: !win, stdio: [ignore, pipe, pipe] })`；滚动尾部流式 `onUpdate`；超限（2000 行 / 50 KB）**尾截断**并给 `full_output_path`；结果 `{output, exit_code, truncated, wall_time_seconds}`；信号退出 `128+signo`；注入 `AMA_SESSION_ID / AMA_SESSION_FILE / AMA_PROVIDER / AMA_MODEL / AMA_THINKING / AMA_DEPTH`；退出时清理所有活子进程 |
| `grep`  | `pattern, path?, glob?, ignoreCase?, literal?, context?(0–5), limit?(100), filesOnly?` | read / parallel      | 内置：按 `.gitignore` / `.ignore` 过滤，跳过二进制与 > 2 MB 文件，并发 16 文件；匹配行截 500 字符；输出格式 `path:line: text`；超 limit 提示；`filesOnly` 只列命中文件（去重、按路径排序，limit 按文件数计，`context` 不生效）                                                                                                                                                                                             |
| `glob`  | `pattern, path?, limit?(1000)`                                                | read / parallel      | 内置 glob：`**`、`{a,b}`、`[...]`、`!`；按 mtime 倒序；尊重 ignore                                                                                                                                                                                                                                                                      |
| `ls`    | `path?, limit?(500)`                                                          | read / parallel      | 目录项 `name/`、大小、符号链接标注                                                                                                                                                                                                                                                                                                      |
| `todo`  | `action: "set" \| "get", items?: [{id, text, status: pending\|in_progress\|done}]` | read / parallel  | 写 `custom{customType:"ama.todo"}` 条目（不进上下文，TUI 渲染清单）；`get` 返回当前列表                                                                                                                                                                                                                                                 |
| `skill` | —（已删除，§5.6） | — | Skill 正文改用 `read` 读取；`/skill:` 命令仍可把正文展开为本轮提示 |
| `task`  | `prompt, description?, tools?: string[], model?, thinkingLevel?, maxTurns?(30)` | execute / sequential | 同进程新 `AgentSession`：独立 JSONL（`parentSession` 指回父文件、`custom{ama.task}` 记父 toolCallId）；深度 ≤ 1（子 Agent 无 `task`）、并发 ≤ 4；工具子集缺省为父的活动集去掉 `task`；继承父的权限模式与 broker（审批串行化到父）；父 abort 级联；结果 = 子的最后助手文本 + `details{sessionFile, usage}`；宿主可 `disable("task")` |

`task` 在第五波扩展为统一入口：`agent` 参数选择子 Agent 类型或外部 CLI Agent（定义文件 `.ama/agents/*.md`、内置 general / explore / plan），同轮并行、后台运行、`taskId` 续聊、worktree 隔离，配套 `task_ctl`；见 [wave5-plan.md](wave5-plan.md) §5、§7。

通用安全：所有路径工具拒绝含 NUL 的路径；`paths.ts` 不做沙箱（与 Pi 相同声明：信任边界是容器 / VM），但 `permission.deny` 规则 `write(**/.git/**)`、`read(**/.ssh/**)` 等由内置缺省 deny 表给出，用户可移除。Windows：路径统一 `path`；`bash` 在 PowerShell 回退时把 `exit_code` 从 `$LASTEXITCODE` 取；`process-tree.ts` 用 `taskkill`；`grep/glob` 大小写不敏感文件系统提示。

### §5.3 Skill（渐进披露）

- 发现顺序：`--skill-dir`（可重复）→ profile `skillDirs` → `~/.config/ama/skills/` → `<cwd>/.ama/skills/`（**需信任**）→ 祖先目录 `.agents/skills/`（需信任）；每个子目录一份 `SKILL.md`，递归；重名保留先发现者并 warning。
- frontmatter 子集：`name`（≤ 64，`^[a-z0-9-]+$`）、`description`（≤ 1024，必填）、`disable-model-invocation`、`allowed-tools`（只做提示，不强制）。
- 三级披露：索引（`<available_skills>` XML，每条一行 `<skill name location>description</skill>`，前面一行说明）→ `skill` 工具或 `read` 读正文 → 正文引用同目录文件。
- 内置 Skill `ama-docs`（`src/skills/builtin.ts`）：ama 自身的配置速查（文件位置、供应商与 key、模型、权限、预设、会话与回滚、Skill 与 Hook），代替把自身文档放进系统提示；正文内联在代码里（单文件 bundle 没有 docs 目录），发现时写到 `<数据目录>/builtin/ama-docs.md`（内容不变不重写），排在所有来源之后，同名时用户 / 项目的优先；索引里只占一行短描述，启动头的「已加载」不计入。只在命令行组装根加载，SDK 不加。
- `/skill:<name> [args]` 展开为 `<skill name="…" location="…">\nReferences are relative to <dir>.\n\n<正文>\n</skill>\n\n<args>`。
- 提示模板 `prompts/<cmd>.md`（用户级与项目级，项目级需信任）：`$1 $@ ${1:-默认} ${@:N}`，文件名即 `/cmd`。
- 不做技能包管理、不联网下载。

### §5.4 调用画布上的其它 CLI Agent（嵌入时）

ama 不知道画布；Armadra 适配器经 `HostApi.tools.register` 注册 `canvas_team / canvas_send / canvas_inbox / canvas_sticky / context_*` 等工具（文档 B §3），它们与内置工具走**同一条**调用路径与权限管线（按 `permission` 分类）。适配器 `disable("task")` 后，系统提示 `tools` 节不再列 `task`，模型只能走画布工具。独立模式下这些工具不存在，README 明确边界。

### §5.5 codemode：用一段脚本编排多次调用

**动机**：长流程任务里，模型每调用一次工具，结果返回后就要带着整段历史再请求一次模型；即使大部分命中缓存，缓存读取仍计用量与费用。把「读几个文件 → 过滤 → 再查 → 汇总」这类多步调用合进一段脚本、一次往返完成，只把脚本输出交给模型，是降低往返次数最直接的办法。公开实测里，同一长任务改用这种方式后累计 token 减少约 75%、估算费用降低约 64%；短任务因为多写一段脚本，收益不明显。因此 codemode 是**可选的调用方式**，不替代逐个工具调用。

**工具**：`codemode`，参数 `{ script: string }`（原始 JavaScript，不是 JSON、不是 Markdown 代码块）。脚本作为 async 函数体执行，可用顶层 `await` 与 `return`。首行可选 `// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}`。

| 全局                              | 作用                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools.<name>(args)`              | 调用会话里的任一工具（含宿主注册的 `canvas_*`），**走与模型直接调用完全相同的路径**：schema 校验 → PreToolUse Hook → 权限管线 → 审批 → 执行 → PostToolUse |
| `text(v)` / `console.log(...)`    | 追加输出；字符串原样，其它值按 JSON                                                                                                                    |
| `return v`                        | 同 `text(v)`                                                                                                                                           |
| `store(key, v)` / `load(key)`     | 跨次保留小块 JSON（单值 ≤ 256 KiB，合计 ≤ 1 MiB）；脚本成功才提交，写成 `custom{customType:"ama.codemode-store"}` 条目，随会话分支走                     |
| `ALL_TOOLS` / `describeTool(name)`| 可调用工具清单与单个工具的 TypeScript 声明                                                                                                             |

- 返回值：`bash` 解析为 `{ output, truncated, fullOutputPath?, exitCode, wallTimeMs }`（输出上限 1 MiB，不受给模型看的 50 KB 限制）；其它工具解析为文本或 `structured`。工具失败、被拒、参数非法 → 以 `Error` reject，脚本可用 `Promise.allSettled`。
- 结果：`Script completed` / `Script failed` + 用时 + 输出；输出超过 `max_output_tokens`（缺省 10 000）保留首尾，全文写 `outputs/<toolCallId>.txt`。失败时保留已产生的输出，已完成的工具调用不回滚；脚本结束时仍在跑的调用被取消。
- 脚本内不能再调用 `codemode`；同一脚本内并发工具调用上限 8。

**沙箱（零依赖）**：

1. 每次执行起一个子进程：`<node> --permission --allow-fs-read=<沙箱入口文件> <沙箱入口>`；嵌入 Electron 时以 `ELECTRON_RUN_AS_NODE=1` 运行同一可执行文件。子进程**不授予**文件写、子进程、worker、addon、inspector 权限。
2. 子进程里用 `node:vm` 建一个只含 ECMAScript 内建对象的上下文，注入上表的全局函数，`codeGeneration: { strings: false, wasm: false }`；超时由父进程强杀子进程树。
3. `tools.*` 经 stdin / stdout 的 JSON 行协议回调父进程，由父进程的 `tool-runner` 执行；子进程本身拿不到任何密钥、会话文件或环境变量（以空环境启动）。
4. 网络：Node ≥ 25 的权限模型同时拒绝网络（本机 Node 26 实测：`--permission` 下 `fetch` 返回 `ERR_ACCESS_DENIED`）；**Node 22 / 24 的权限模型不管网络**，脚本若逃出 `vm` 就能联网。所以：运行时 Node ≥ 25 → `strict`；Node 22 / 24 → `codemode` 仍可用但状态栏与工具描述标注「网络未隔离」，`config.codemode.requireStrict: true` 时直接禁用该工具。（S2 起：子进程另经操作系统沙箱启动，Node 22 / 24 有 `sandbox-exec` / bwrap / unshare 时同样 `strict`，见 [sandbox.md](sandbox.md)。）
5. 声明：沙箱防的是脚本**绕过权限管线**，不是对抗性的代码执行环境；脚本能造成的副作用都来自它调用的工具，而工具调用照常受 Hook、权限与审批约束。

**模式**（`config.codemode.mode`，命令行 `--codemode off|on|only`）：

| 模式   | 模型看到的工具                                                                       | 适用                                     |
| ------ | ------------------------------------------------------------------------------------ | ---------------------------------------- |
| `off`  | 不注册 `codemode`                                                                    | 短任务、需要最大透明度                   |
| `on`   | 预设的工具 + `codemode`；其它工具描述不变，`codemode` 描述一行列出可在脚本里调用的直接工具（参数相同）与仅脚本可调的工具名 | `default` 预设在 strict 运行时的缺省 |
| `only` | 只有 `codemode`；其它工具只能在脚本里调用，声明列在 `codemode` 描述里 | 长流程、工具密集任务；嵌入 Armadra 的协调者可选 |

**缺省开放（2026-10，审计 `docs/gap-audit-2026-10.md`）**：缺省值随预设（§5.6）——`default` 预设为 `on`，**但只在沙箱 strict（Node ≥ 25）时**；Node 22 / 24（含嵌入的 Electron 主版本为 22 / 24 时）为 `off`，CLI 启动时提示一次（每个配置目录一次，记在数据目录 `notices.json`），用户显式写 `on` 才开（此时 `codemode` 仍是 `execute` 类，状态栏 `net!`）。`codemode-only` 预设为 `only`，`minimal` / `coordinator` 为 `off`。显式 `codemode.mode` / `--codemode` 覆盖；缺省配置（`DEFAULT_CONFIG` 与 `ama init` 生成的文件）都不写这个键，映射调整对老用户同样生效。`coordinator` 预设即使显式 `on`，脚本里可调用的工具也限于它的活动集（read 与宿主工具）：父进程只把活动集交给沙箱，脚本拼出别的名字也被拒，协调者「不写文件、不跑 bash」的约定不能经 codemode 绕过。

`only` 模式下，`codemode` 描述里的工具声明由 JSON Schema 生成 TypeScript 声明，总预算 `config.codemode.inlineBudget`（缺省 3 000 估算 token），超出部分只列名字，脚本用 `describeTool()` 取。`on` 模式不内联声明：已直接暴露的工具 schema 已在工具表里，再内联一遍是重复（去重前系统提示 + 工具表比 `off` 多约 1 356 token，去重后约 390 token，测试锁定 ≤ 500）；仅脚本可调用的工具（ls、todo、task 等）只列名字，`describeTool()` 取签名。

**Hook 与事件**：`codemode` 本身作为一次工具调用经过 PreToolUse / 权限（权限类 `execute`）；脚本里的每次 `tools.*` 再各自经过完整流程，Hook 输入带 `viaCodemode: true` 与父 `toolCallId`。事件：`tool_execution_update` 透传脚本输出；内层调用发 `tool_execution_start/end`，带 `parentToolCallId`，TUI 把它们折叠在 codemode 调用下面。

**嵌入 Armadra**：画布工具同样可在脚本里调用，协调者可以一段脚本里并行起多个成员、读取各自摘要后汇总，减少协调轮次。profile 可设 `codemode.mode`。

### §5.6 工具预设：直接暴露的工具要少，脚本里可以全给

**判断依据**：工具定义本身的成本很小（实测 10 个内置工具约 1 650 token，处在缓存前缀里）；真正的成本是**往返次数**——每多一次工具调用，整段历史就多读一次。所以取舍看四点：会不会诱导模型拆成很多小调用、单独成工具能否让权限细分（只读免审批、写入按路径）、跨平台可用性、使用场景。

**与 Pi 的差异**：Pi 默认只开 read / bash / edit / write，因为它默认不审批；ama 的 `default` 权限模式对 `bash` 每次都问，若去掉 grep / glob，最常见的「搜代码」会每次弹审批（`-p` 下直接被拒）。用「识别只读 bash 命令」来绕开不可靠（`find -exec`、`rg --pre`、管道与命令替换都可能有副作用），所以保留只读的 grep / glob，用约 380 token 的缓存前缀换免审批且跨平台的搜索。

| 预设          | 模型直接看到                                         | 脚本内可调用（codemode）              | 用途                                         |
| ------------- | ---------------------------------------------------- | ------------------------------------- | -------------------------------------------- |
| `default`     | read、edit、write、bash、grep、glob（第五波 D20 曾加 todo，0.5.0 复测未过门撤回）；网络隔离时另加 codemode | 全部内置工具（含 ls、todo、task）      | 独立编码，缺省                               |
| `minimal`     | read、edit、write、bash                              | —（显式 `on` 时全部内置工具）          | 与 Pi 一致；适合 `full-auto`；没有 grep / glob，检索走 bash（见下） |
| `codemode-only` | codemode                                           | 全部内置工具（含 ls、todo、task）      | 长流程、工具密集任务                         |
| `coordinator` | read、宿主注册的 canvas_* / context_*（codemode 可选） | 只有活动集：read 与 canvas_* 等       | 嵌入 Armadra 的协调者：不写文件、不跑 bash   |

- 预设名：`codemode-only` 是 2026-10 起的规范名，0.3.0 的 `codemode` 作别名保留（配置、命令行、RPC 的 argv、SDK、schema 都接受；配置合并与命令行解析后只见规范名，`ama config show` 显示规范名并提示）。项目级「只能更严」按规范名比较。

- 逐个工具：`ls` 默认关（glob 已覆盖，且诱导逐层翻目录）；`todo` 默认关（每次更新多一次往返；长任务在脚本里用；第五波曾进 `default` 预设，0.5.0 用多步长任务复测未过门撤回，计划交接改用 `[DONE:n]` 文本标记，见 [wave5-plan.md](wave5-plan.md) D20 与 docs/benchmarks/presets-todo-2026-10-03.md）；`task` 默认关（`+task` 打开；嵌入 Armadra 时禁用）；**删除 `skill` 工具**（Skill 正文用 `read` 读，`/skill:` 命令保留）；Windows 上若没有 bash，`default` 预设自动退化为 PowerShell 版 bash，grep / glob 照常可用。
- 检索取舍（[docs/search-plan.md](search-plan.md) §1.3、§4.2）：`minimal` / `coordinator` 不带 grep / glob，模型找代码只能用 `bash grep` / `rg` / `find`——`default` 权限模式下每次审批，`-p` 下直接被拒，实测模型随后连猜文件名、回合用尽也没有答案。需要检索又想要小工具表时用 `tools.default: ["+grep","+glob"]`；`-p` 下这类 bash 被拒时 stderr 会补一行同样的提示。grep 与 glob 都直接可用时 `rules` 节多一句「先 grep / glob 定位再 read，不要猜路径」；`read` 收到目录时按活动集指向 `ls` / `glob` / 目录里的文件（`ToolContext.activeTools`）。
- 配置：`tools.preset`（缺省 `default`）+ `tools.default` 的 `+name` / `-name` 微调；命令行 `--tools-preset <名>`、`--tools a,b,c`（整组替换）。
- 预设在会话开始时确定并写进首条 system 消息；会话中途改预设按工具表补丁处理（§9.1）。
- 描述精简：每个工具的描述 + 参数控制在 150 token 内（已落实：内置工具合计 1548 → 1186 token，`src/tools/descriptions.test.ts` 守住）。
- 最终缺省值以实测为准：B9 的基准任务比较 `default` / `minimal` / `codemode` 三种预设的往返次数、累计输入 + 缓存读取、费用与成功率，结果写进本节。
- 基准结论（`docs/benchmarks/presets-2026-10-02.md`，真实中转，Kimi / MiniMax / DeepSeek × fix-bug / search-summarize / multi-file-refactor，22 组全部成功）：
  - 三个预设都能完成这三类小任务，差别只在成本；平均每组估价 default $0.0076、minimal $0.0076、codemode $0.0087。
  - codemode 在小任务上不划算：平均输入 token 比 default 多约 45%（工具声明每轮都在前缀里），顶层轮数没有减少（5.3 对 5.0）；只在检索类、一次脚本能并行多次调用的场景省一轮（DeepSeek search-summarize）。
  - 结论：缺省保持 `default`；工具调用密集的长流程任务再用 `codemode`；`minimal` 适合工具描述占比大的小模型 / 小上下文。
  - 2026-10 修订：基准里 codemode 多出的输入主要是 `on` / `only` 描述内联的工具声明。`on` 模式去重后前缀只多约 390 token，`default` 预设在 strict 运行时缺省带上 codemode（模型照常直接调用工具，批量场景再写脚本）；`codemode-only` 仍是显式选择。

## §6 两层 Hook

### §6.1 第一层：命令式 Hook（`hooks/`）

**配置位置与合并**：`~/.config/ama/hooks.json`（用户级）、profile `hooksFile`（宿主级，视同用户级）、`<cwd>/.ama/hooks.json`（项目级，**需信任**，未信任时跳过并在 `doctor` / 状态栏提示）。合并 = 三份的事件数组**拼接**（用户级先、宿主级次、项目级后），不覆盖。

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [ { "type": "command", "command": "./scripts/guard.sh", "timeoutMs": 10000 } ] },
      { "matcher": "write|edit", "hooks": [ { "type": "command", "command": "ama-fmt-check" } ] }
    ],
    "PostToolUse": [ { "matcher": "edit", "hooks": [ { "type": "command", "command": "prettier --check $AMA_FILE" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "./scripts/inject-context.sh" } ] } ],
    "Stop": [], "SessionStart": [], "SessionEnd": [], "PreCompact": [], "SubagentStop": [], "Notification": []
  }
}
```

| 事件               | 时机                                             | 可改变什么（stdout JSON）                                                   | 退出码 2 的含义                          |
| ------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| `SessionStart`     | 会话创建 / 恢复后、首次提示前（`source: startup\|resume\|new\|fork`） | `additionalContext`（追加到系统提示 `hooks` 节）                 | 启动失败，退出码 6                        |
| `UserPromptSubmit` | 用户提示展开后、入转录前                          | `decision: "block"` + `reason`；`updatedPrompt`；`additionalContext`（作为 custom_message 进上下文） | 阻止本次提示，reason 显示给用户           |
| `PreToolUse`       | schema 校验后、权限管线前                         | `decision: "allow" \| "deny" \| "ask"`、`reason`、`updatedInput`             | deny，stderr 作为 reason 进 tool_result   |
| `PostToolUse`      | 工具执行后、结果入转录前                          | `additionalContext`（追加到 tool_result 末尾）；`decision: "block"` 把结果改为错误 | 结果标 isError，stderr 进 tool_result     |
| `Stop`             | `agent_before_settle`（无 followUp 时）           | `decision: "block"` + `reason` → 以 reason 作为新 user 消息**再跑一轮**（上限 3 次防死循环） | 同左                                     |
| `SubagentStop`     | `task` 子会话结束                                 | 同 Stop（作用于子会话）                                                     | 同左                                     |
| `PreCompact`       | 档二摘要前                                        | `customInstructions` 追加到摘要提示；`decision: "block"` 取消本次压缩        | 取消压缩                                 |
| `Notification`     | 需要用户注意：审批等待、run 结束、错误             | 无（纯通知）                                                                | 忽略                                     |
| `SessionEnd`       | 进程退出前（`reason: exit\|new\|switch`）         | 无                                                                          | 忽略                                     |

**stdin 输入**（所有事件共有 + 事件特有）：

```ts
export interface HookInput {
  hookEventName: HookEvent; sessionId: string; sessionFile?: string; cwd: string; transcriptPath?: string;
  model: { provider: string; id: string }; permissionMode: PermissionMode; depth: number; host?: string;
  // PreToolUse / PostToolUse
  toolCallId?: string; toolName?: string; toolInput?: unknown; toolResult?: { content: string; isError: boolean }; permissionDecision?: "allow" | "ask" | "deny";
  // UserPromptSubmit
  prompt?: string;
  // Stop / SubagentStop
  lastAssistantText?: string; stopHookActive?: boolean;      // 已由 Stop Hook 续跑过 → 处理器应避免再 block
  // PreCompact
  tokensBefore?: number; trigger?: "auto" | "manual";
  // Notification
  notification?: { kind: "approval" | "settled" | "error" | "retry"; message: string };
}
```

环境变量同时给出便于 shell 脚本：`AMA_HOOK_EVENT`、`AMA_SESSION_ID`、`AMA_CWD`、`AMA_TOOL_NAME`、`AMA_FILE`（write/edit/read 的 path）。

**stdout 输出**：空 / 非 JSON → 无决策（只按退出码）；JSON 形状：

```ts
export interface HookOutput {
  decision?: "allow" | "deny" | "ask" | "block"; reason?: string;
  updatedInput?: unknown; updatedPrompt?: string; additionalContext?: string; customInstructions?: string;
  continue?: false;              // 任何事件：请求 ama 结束当前 run（Stop 风格的硬停），reason 显示
  suppressOutput?: true;         // TUI 不显示该 Hook 的输出
}
```

**退出码语义**：`0` 放行并解析 stdout；`2` 阻止（stderr 文本作为 reason 回给模型 / 用户）；其它非零 = Hook 自身错误，**非阻塞**，记 warning，按「无决策」继续；超时（缺省 60 s，`timeoutMs` 可配，上限 600 s）等同非阻塞错误，**但 PreToolUse 超时按 deny**（fail-safe）。

**并行与顺序**：同一事件下所有匹配的 Hook **并行**启动，全部结束后合并：决策按最严 `deny > block > ask > allow`；`updatedInput` 只接受来自**唯一**一个返回它的 Hook（多个则全部忽略并 warning）；`additionalContext` 按配置顺序拼接。单条 Hook 命令用 `sh -c`（Windows：Git Bash → `cmd /d /s /c`）运行，cwd 为会话 cwd，stdin 关闭于写完 JSON。

**matcher**：缺省匹配全部；`bash` 精确；`write|edit` 多选；`canvas_*` glob；`bash(git push*)` 对 bash 命令文本再做 glob；`/regex/` 正则。只在 Pre/PostToolUse 生效。

**信任边界**：项目级 Hook 在**信任**前不加载；信任的粒度是目录（含子目录），存 `trust.json`；非交互模式缺省不信任（可 `--trust`）；Hook 以进程权限运行，文档说明「信任 = 允许该仓库执行命令」。宿主 profile 里的 Hook 视同用户级。

### §6.2 第二层：宿主适配器（`host/`，`@armadra/agent/host`）

```ts
export const HOST_API_VERSION = 1 as const;
export interface HostModule { readonly hostApi: typeof HOST_API_VERSION; create(api: HostApi): HostAdapter | undefined | Promise<HostAdapter | undefined> }
export interface HostAdapter { readonly id: string; dispose?(): void | Promise<void> }

export interface HostApi {
  readonly version: typeof HOST_API_VERSION;
  readonly agent: { readonly name: "ama"; readonly version: string };
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly mode: "interactive" | "line" | "print" | "rpc";
  readonly session: { id(): string; file(): string | undefined; cwd(): string; model(): { provider: string; id: string } | undefined };
  readonly tools: { register(tool: ToolDefinition): void; disable(name: string): void; list(): readonly string[] };
  readonly instructions: { add(source: InstructionSource): void };                 // 追加到 `host` 节（最后）
  readonly events: { on<E extends keyof AgentEvents>(name: E, h: (e: AgentEvents[E]) => void | Promise<void>): () => void };
  readonly approvals: { setBroker(broker: ApprovalBroker): void };
  readonly messages: { sendUser(text: string, origin?: string): Promise<"started" | "queued"> };
  readonly ui: { notify(message: string, level?: "info" | "warn" | "error"): void; setStatus(key: string, text?: string): void };  // print/rpc 下 notify → stderr / 事件
  readonly log: (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => void;
}
export interface ApprovalBroker { ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision | undefined> }
export interface ApprovalRequest { requestId: string; toolName: string; input: unknown; reason: "mode" | "dangerous" | "hook"; hookReason?: string }
export type ApprovalDecision = "allow" | "deny" | "allow_session";

export interface AgentEvents {
  session_start: { sessionId: string; sessionFile?: string; cwd: string; reason: "startup" | "resume" | "new" | "fork" };
  before_agent_start: { prompt: string };
  agent_start: {}; turn_start: {}; turn_end: {};
  tool_call: { toolCallId: string; toolName: string; input: unknown };
  tool_result: { toolCallId: string; toolName: string; isError: boolean };
  agent_end: { stopReason: string; willRetry: boolean };
  agent_before_settle: {}; agent_settled: { warning?: string };
  session_compact: { tokensBefore: number }; model_select: { model: { id: string; provider: string } };
  tool_approval_requested: { requestId: string; toolName: string };
  tool_approval_resolved: { requestId: string; decision: ApprovalDecision };
  hook_executed: { event: HookEvent; command: string; exitCode: number | null; durationMs: number };
  session_shutdown: {};
}
```

规矩与 v1 一致：事件处理器只观察（抛错记日志）；`session_shutdown` 被 await；适配器注册的工具受同一权限管线；版本不等拒绝启动（退出码 78）。

### §6.3 两层的关系与一次工具调用的完整顺序

```text
tool_call（模型产出）
  1. schema 校验（失败 → 错误结果，不再往下）
  2. 命令式 Hook PreToolUse（并行，合并决策 D_hook ∈ {allow, ask, deny, ∅}；updatedInput 替换 input）
  3. 权限管线（§7）：① deny 规则 ∪ D_hook=deny → deny
                      ② 危险命令识别（bash）→ ask（无人值守 deny）
                      ③ 模式决定 ask/allow（auto：受保护路径 / 网络 / 删除类先 ask，再静态判定，见 §7.4）
                      ④ allow 规则 ∪ D_hook=allow：把 ③ 的 ask 变 allow（不能越过 ①②）；D_hook=ask 把 allow 变 ask
                      ⑤ [auto] 仍未决定 → 独立的模型分类器：allow / ask（不能推翻 ①–④ 的 deny / ask）
                      [allowlist] 剩下的 ask 一律 deny（从不询问）
  4. 若结果 ask → 事件 tool_approval_requested → broker 链：宿主 broker → UI 对话框 → 无人值守 deny；超时（缺省 10 min）deny
  5. 事件 tool_call（宿主观察）→ 执行 → 事件 tool_result
  6. 命令式 Hook PostToolUse（可追加上下文 / 改为错误）→ 结果入转录
```

命令式 Hook 在前是因为它是**用户策略**（可改输入、可一票否决）；宿主 broker 在后是因为它只是「谁来回答 ask」。两层都不能把 ①② 的结论放宽。

## §7 权限与信任

### §7.1 管线

同 v1 §7.1，补三点：Hook 决策的合入位置见 §6.3；`allow_session` 记在内存（`toolName + 归一化输入前缀`），不落盘；`reason: "hook"` 的 ask 在对话框里显示 Hook 的 reason。

### §7.2 规则与来源约束

| 来源                               | 可做                                      | 不可做                                         |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| 用户级 `config.json`、命令行、profile | 设 mode、allow、deny                     | —                                              |
| 项目级 `.ama/config.json`（无需信任） | **只能收紧**：追加 deny；mode 只能更严（`full-auto → auto → auto-edit → default → allowlist → plan`），且不能设 `auto` / `full-auto` | allow 规则、`autoSafeCommands`、`autoModel` 与放宽 mode 被忽略并 warning |
| 项目级（已信任）                     | 同上 + 加载 hooks / skills / prompts       | 仍不能加 allow（信任解锁的是「执行项目的 Hook」，不是「放开工具」） |

规则语法：`bash(git push*)`、`write(src/**)`、`read(**)`、`canvas_*`；`--allow` / `--deny` 可重复。危险命令表（`dangerous.ts`）与 v1 一致并加 `git branch -D`、`npm publish`、`docker system prune -a`、`shutdown/reboot`；每条正反例测试。

### §7.3 信任（`config/trust.ts`）

- 需要信任：`.ama/hooks.json`、`.ama/skills/`、`.ama/prompts/`、祖先 `.agents/skills/`。不需要：`AGENTS.md`、`.ama/config.json`（因为它只能收紧）。
- 决策顺序：`--trust` / `--no-trust` → `trust.json` 中最近祖先的记录 → 交互模式询问（一次，可记住）→ 非交互缺省 **不信任**。
- `trust.json`：`{ "version": 1, "entries": [{ "path": "/abs/dir", "trusted": true, "at": "ISO" }] }`，只在用户级目录。
- 宿主 profile 可带 `trustProject: true`（Armadra 对自己管理的工作目录）。

### §7.4 auto 与 allowlist 模式

模式共六种（`PermissionMode`）：`plan`（Plan）、`allowlist`（Allowlist only）、`default`（Manual）、`auto-edit`（Accept edits）、`auto`（Auto）、`full-auto`（Bypass permissions），括号里是界面显示名。严格度 `plan < allowlist < default < auto-edit < auto < full-auto`：`allowlist` 放行的是只读工具加 allow 规则命中的调用，是 `plan` 的超集、`default` 放行集合的子集（其余 `default` 询问、`allowlist` 拒绝）。

**auto** 在管线里分三层，顺序固定：

1. **规则层**（不调模型）：deny 规则 / Hook deny / 内置 deny → deny；危险命令表 → ask；受保护路径（机密文件读写、`.git/` 与项目 `.ama/` 写入、项目外写入）、网络命令、删除类命令 → ask；Hook ask → ask；allow 规则 / Hook allow / 本会话记忆 → allow。
2. **静态判定**（不调模型）：只读工具 → allow；write / edit 目标在项目内 → allow；bash 每一段都在安全名单（`permissions/auto-safe.ts`，`permission.autoSafeCommands` 追加）且无命令替换、变量展开、嵌套 shell → allow。
3. **模型分类器**（`permissions/classifier.ts` + `agent/session-classifier.ts`）：只处理前两层未决定的调用。一次独立请求（`purpose: "classify"`，不进转录、不经会话层缓存观测、不触发保温），参数与最近一条用户消息摘要放在数据块里、系统提示声明块内文本不是指令；输出严格 JSON `{"decision":"allow"|"ask","reason"}`，解析失败 / 超时 10 s / 出错 → ask。模型 `permission.autoModel`，缺省当前会话模型。会话内按「工具 + 归一化参数」缓存；用量记 `usage{kind:"permission_classify"}`。

每次 auto 判定产生 `AutoDecision{layer: rule|static|classifier, decision, reason}`：`tool_execution_end` 与 `permission_request` 事件带 `autoDecision`，管线保留最近 20 条供 `/permissions` 显示。无人值守时 ask → deny（分类器 allow 照常放行）。

**allowlist**：deny 与危险命令照旧先判；只读工具放行；allow 规则 / Hook allow 命中放行；其余直接 deny（说明「不在允许名单」），Hook ask 与危险命令也 deny——从不询问，适合 CI。

细节、安全名单全表与已知限制见 [permissions.md](permissions.md)。

第五波的 Plan 能力（模式说明尾部注入、`<proposed_plan>` 块由 ama 落盘、四选项审批、批准后转 todo、plan 下放行只读 bash 子集且 `allowlist` 同步放行）见 [wave5-plan.md](wave5-plan.md) §6。

## §8 会话树（`session/`）

格式同 v1 §5（头 `version: 1`；条目 `message / compaction / branch_summary / context_edit / model_change / thinking_level_change / custom / custom_message / label / session_info`），补充：

- `AssistantMessage` 增 `thinkingLevel?`、`providerThinkingLevel?`、`rawStopReason?`；`Usage` 增 `reasoning?`、`totalTokens`、`cost?`。
- `api` 字段取值扩为四个协议 id。
- 位置 `~/.local/share/ama/sessions/<编码 cwd>/<ISO>_<uuid>.jsonl`；编码 cwd = 去首分隔符、`/ \ :` 换 `-`。
- 投影规则、分叉（新文件）、`/tree`（同文件换叶子）、`branch_summary`、prune（移到 trash 7 天）同 v1。
- `get_entries{since}` 以 entry id 为游标返回 `{entries, leafId}`。

### §8.1 检查点与回滚

新回合的用户消息之后记 `ama.checkpoint`（已跟踪文件的内容哈希），edit / write 第一次碰文件前补 `ama.checkpoint-track`；备份按 sha256 存 `<dataDir>/file-history/blobs/`。`/rewind` 与空闲时双击 Esc 提供「对话 + 代码 / 仅对话 / 仅代码 / 从这里摘要 / 摘要到这里」；对话回滚复用 `/tree` 换叶子，代码回滚带冲突检测与符号链接、硬链接、父目录移动的安全检查，git 只提示不操作。完整设计、契约（`src/checkpoints/types.ts`）与批次见 [rewind-plan.md](rewind-plan.md)。

## §9 压缩（`compaction/`）

| 项       | 决定（第五波 W5-H1 修订，[wave5-plan.md](wave5-plan.md) §8）                                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 估算     | `contextTokens` = 最后一条非 error/aborted assistant 的 `totalTokens`（缺则 `input+output+cacheRead+cacheWrite`，**含 output**）+ 其后条目估算；该 usage 之后若有 `context_edit` / 压缩，则按投影全量重估。文本按脚本：CJK 表意文字 / 假名 / 谚文 / 全角符号每字 1 token，其余字符 / 4；图片 1 600                         |
| 档一     | 按**工具结果新旧**计边界：最近 `keepResults`（5）个与最近 `min(40k, 0.2×预算)` token 的工具输出、保护集之外、> 512 token 的旧结果是候选。触发 = 估算 > 0.7×预算，或缓存已冷（reported 端点上次请求超过 TTL）；候选合计可省 < `clearAtLeast`（auto = max(20k, 0.1×预算)，≤ 0.2×预算）不动；动就从最旧的起一次清到 0.5×预算（冷时全部候选） → `context_edit{replacement:"[已裁剪 …全文 path]"}`；无模型调用 |
| 保护集   | `todo` / `skill` 工具结果、`read` 读入的 Skill 文件（系统提示 skills 索引里的路径）与 `AGENTS.md` / `CLAUDE.md`、`annotations.keepInContext` 的工具、`compaction.pruneExclude`                                                                                                                                             |
| 档二     | 裁剪后仍 `> contextWindow − reserveTokens`，或溢出错误 / `length`：切点规则（keepRecentTokens 20 000；合法切点 user / assistant / custom_message / branch_summary，不切 toolResult；单段超预算 split turn，两份摘要并行再合并）；先走会话前缀续写，失败回落独立请求；追加 `compaction`                                                  |
| 自检     | 摘要缺 `## Goal`（模型没写摘要、在续写对话）→ 重试一次再回落独立请求；自动压缩后估算不比压缩前小 → 判失败、不写条目                                                                                                                                                                                                       |
| 回注     | `compaction.summary` 末尾接 `<post-compact-state>` 块：todo 快照、当前计划、已加载 Skill、最近修改 / 读取文件路径、转录与 `outputs/` 路径、续接说明（只有清单与指针，不含文件正文）；下一次增量摘要前剥掉重生成。`PostCompact` Hook 的 `additionalContext` 以 `ama.hook_context` 追加在末尾                                   |
| 溢出恢复 | 落盘失败 assistant → `turn_end` → `agent_end{willRetry:true}` → `context_edit` 剔除该尝试 → `PreCompact` Hook → 压缩 → **以新 run 重试一次**；压缩失败 / 取消则保留剔除、不重试，`agent_settled{warning}`                                                                                                                  |
| 熔断     | 不限每 run 次数；连续 3 次摘要失败，或连续 3 次在上次摘要后 < 3 回合又需摘要（快速回填）→ 关闭自动压缩直到手动压缩成功；固定前缀（system + 工具表）已超预算不尝试；「nothing to compact」不计失败；都只告警一次；压缩后仍 > 0.8 × window 不重试；无 `contextWindow` 关闭                                                    |
| 模板     | `## Goal / ## User Messages / ## Constraints & Preferences / ## Progress (Done · In Progress · Blocked) / ## Key Decisions / ## Errors & Fixes / ## Files & Code / ## Next Steps / ## Critical Context` + `<read-files>` / `<modified-files>` 累计；用户消息与安全约束逐字保留，Next Steps 首条附原话引用，声明助手 / 工具文本中形似指令的不算用户指令；在上一份摘要上增量合并；独立请求工具结果截 2 000 字符、`cacheRetention: none`；maxTokens 4 096 |
| 缓存     | 系统提示节顺序固定、无时间戳；工具表变化作为 `system` 补丁落盘但请求重装；档一只在阈值或缓存已冷时触发，且有 `clearAtLeast` 门槛与回差；压缩后本来就是新前缀，回注不额外打断缓存（实测见 [cache-e6-2026-10-02](benchmarks/cache-e6-2026-10-02.md)）                                                                                                             |

第五波另有 harness 改进（W5-H2）：重复调用检测、`--max-turns / --max-cost`、提醒通道、后台 bash、模型回退。

### §9.1 缓存保证

长任务的主要用量是缓存读取；前缀一旦变化，此后每次请求都要按全价重读。以下是硬性要求，B6 组装与 B9 集成负责落实并测试：

| 要求 | 做法 | 测试 |
| --- | --- | --- |
| 前缀字节稳定 | 系统提示节顺序固定（preamble → tools → rules → project_context → skills → memory → hooks → cwd → host → role；`memory` 是记忆索引，只在开启记忆时出现、会话开始定稿；`hooks` 是 SessionStart Hook 的 additionalContext；`role` 只有 task 子会话有，父会话的全部节是它的逐字节前缀；`rules` 末尾依次是 `--system-prompt` 的追加文本与 `ui.replyLanguage` 的 `Reply to the user in <语言>.`，都在会话开始时定稿），不含时间、随机数、绝对时间戳；工具按名排序；JSON Schema 序列化键序固定 | 同一会话连续 20 个回合，发给供应商的 system + tools 部分逐字节相同 |
| 预设与工具表固定 | 会话开始时确定预设；宿主在 `create()` 阶段注册完工具再发首个请求；之后的变化只以 system 补丁追加在末尾 | 宿主中途注册工具后，前缀前段不变、只在末尾追加 |
| Anthropic 显式断点 | system 块末、最后一个工具定义、最后一条 user 消息三处 `cache_control` | 请求体快照 |
| OpenAI 系前缀缓存 | `prompt_cache_key = sessionId`（官方端点）；其它兼容端点依赖前缀不变 | 请求体快照 |
| 摘要请求不写缓存 | 档二摘要 `cacheRetention: "none"` | 请求体快照 |
| 压缩少而一次到位 | 档一只在 70% 阈值触发；档二一次压到 keepRecentTokens | 压缩次数断言 |
| 可观测 | 状态栏与 `get_session_stats` 显示缓存命中率 = cacheRead /（input + cacheRead + cacheWrite） | 统计单测 |
| 前缀预算 | 按真实请求体估算「系统提示 + 工具定义」（字符 / 4，临时路径换成典型长度）：`default` ≤ 2 000、`minimal` ≤ 800、`codemode-only` ≤ 1 775 token（Node ≥ 25 的 strict 沙箱，`default` 含 codemode）；超出时打印每节与每个工具描述 / schema 的字符数。加长描述或规则前先权衡，确需放宽改上限并在 PR 写明 | `src/cli/prompt-budget.test.ts` |
| 指纹 | 每次真实请求记前缀指纹（system、工具表各取 sha256 前 16 位 hex + `provider/model`），只在内存；未命中时据此说出「变了什么」，`/cache fingerprint` 可查 | `src/ai/cache/fingerprint.test.ts` |
| 未命中 | `missed = min(上次前缀, 本次前缀) − cacheRead`，噪声下限 `max(1024, minTokens, 端点推断的缓存读粒度)`（粒度 = 非零 cacheRead 的最大公约数，≥ 2 样本且在 128–8192 才采信），规模自适应比例或 ≥ 20k 才计；原因按 `prefix_changed → model_changed → idle → subtask → evicted` 归因；压缩 / 分支摘要 / 档一裁剪后的首个请求是重置点；界面只提示 ≥ 20k token 或 ≥ $0.10 的那次 | `src/ai/cache/miss.test.ts` |
| 三态 | 按 `(provider, baseUrl 主机, model)` 维护 `unknown / reported / silent`（连续 3 个可比请求读写都为 0 判 silent，`compat.cacheReporting` 可强制）；只有 `reported` 计命中率、检测未命中与保温，其余显示 `—` / `未报告` 而不是 0% | `src/ai/cache/reporting.test.ts` |
| 保温 | `cache.warming`：`off` / `streaming`（缺省，工具运行期间）/ `idle`；TTL 到期前重放上一次请求（`maxTokens: 1`），从请求发出时刻计时；`p·missCost − warmCost ≥ minSavingsUsd` 才发；streaming 60 min、idle 30 min 上限，连续 2 次零命中即停；成功记 `usage{kind:"cache_warm"}` 条目；宿主 `cache.onWarmingDecision` 可否决 | `src/ai/cache/warmer.test.ts`、`economics.test.ts` |
| 摘要续写 | 档二摘要在与上一次真实请求逐字节相同的前缀（含 tools）后追加摘要指令（`cacheRetention: "short"`；不发 `toolChoice`，改动它会断开缓存前缀，禁止调用工具只写在指令里），按读价计；空回复 / 截断 / 含工具调用 / 出错回落独立请求 | `src/compaction/continuation.test.ts` |

## §10 配置、密钥、profile

### §10.1 文件与位置

| 文件            | 用户级 `~/.config/ama/`（`%APPDATA%\ama\`；`AMA_CONFIG_DIR`） | 项目级 `<cwd>/.ama/`    | 宿主 profile 可指           |
| --------------- | ------------------------------------------------------------- | ----------------------- | --------------------------- |
| `config.json`   | 是                                                            | 是（受限字段）          | `config`                    |
| `auth.json`     | 是（0600）                                                    | 否                      | `authFile`                  |
| `hooks.json`    | 是                                                            | 是（需信任）            | `hooksFile`                 |
| `trust.json`    | 是                                                            | 否                      | —                           |
| `keybindings.json` | 是                                                         | 否                      | —                           |
| `skills/`、`prompts/` | 是                                                      | 是（需信任）            | `skillDirs`、`promptDirs`   |
| `AGENTS.md`     | 是（全局约定）                                                | 向上查找各祖先          | `instructions[]`            |
| 会话            | `~/.local/share/ama/sessions/`（`AMA_DATA_DIR`、`--session-dir`） | —                   | `sessionDir`                |

### §10.0 精简配置

- **零配置可用**：没有任何配置文件时，按 §3.3 顺序找第一个设置了标准环境变量（如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`）的供应商，用它的缺省模型直接运行；本地 Ollama / LM Studio 可达时也算。找不到则交互模式弹出供应商选择并提示 `ama auth set <provider>`。
- **一个文件、五个常用键**：`defaultModel`、`tools.preset`、`permission.mode`、`thinkingLevel`、`providers`（只在自定义供应商或覆盖时需要）；其余全部有缺省，`ama config show` 打印生效值与来源。
- **一个模型引用格式**：`provider/model-id`，到处一致（配置、命令行、`/model`、SDK）。

### §10.2 `config.json`

```json
{
  "version": 1,
  "defaultModel": "anthropic/<model-id>",
  "thinkingLevel": "medium",
  "providers": {
    "my-proxy": { "api": "openai-completions", "baseUrl": "https://proxy.example/v1", "apiKey": "$MY_PROXY_KEY",
                  "models": [{ "id": "gpt-x", "contextWindow": 128000, "maxTokens": 16384, "reasoning": true }],
                  "compat": { "maxTokensField": "max_tokens" } },
    "deepseek": { "modelOverrides": [{ "id": "deepseek-chat", "contextWindow": 131072 }] }
  },
  "permission": { "mode": "default", "allow": ["bash(git status*)"], "deny": ["write(**/.env*)"] },
  "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
  "retry": { "maxRetries": 3, "baseDelayMs": 2000, "maxDelayMs": 60000 },
  "tools": { "maxToolResultChars": 30000, "bashTimeoutMs": 120000, "disabled": [] },
  "hooks": { "timeoutMs": 60000 },
  "ui": { "theme": "dark", "markdown": true, "showThinking": "collapsed", "compact": false, "animation": true },
  "skills": { "dirs": [] },
  "cache": { "warming": "streaming", "retention": "short", "minSavingsUsd": 0.05, "missNotices": true, "warmSubagents": false }
}
```

`cache` 段（第三波）：`warming` 为 `off | streaming | idle`（`AMA_CACHE_WARMING` 覆盖），`retention` 为 `none | short | long`（`AMA_CACHE_RETENTION` 覆盖），`minSavingsUsd` 是保温的最低期望节省，`missNotices` 控制消息区的未命中与上下文余量提示，`warmSubagents` 让 task 子会话也保温。整段只认用户级 / profile，项目级忽略并 warning。供应商级开关在 `providers.<id>.compat`（`sendPromptCacheKey`、`sendSessionAffinityHeaders`、`supportsLongCacheRetention`、`supportsExplicitPromptCacheMode`、`cacheReporting`），TTL 在模型的 `promptCache{short,long,minTokens}`；见 `docs/providers.md`「缓存」。

`ui` 段：`theme` 为 `dark | light | auto`（auto 按 `COLORFGBG` / `TERM_PROGRAM` 猜，猜不出用 dark），`ascii` 用 ASCII 字形（缺省按区域设置与 `TERM` 自动检测，`AMA_ASCII=1` 等价），`compact` 让消息区块间不空行、启动头无框，`animation: false` 让运行中 spinner 静止；见 `docs/tui.md`「配置」。

合并顺序：内置缺省 ← 用户级 ← profile.config ← 项目级（只接受 `permission.deny`、`permission.mode` 收紧、`compaction`、`tools.disabled`、`ui`）← 命令行。

### §10.3 `profile.json`（宿主用；与文档 B §2.4 一致）

```json
{ "version": 1, "host": "<abs>/ama-armadra.cjs", "instructions": ["<abs>/instructions.md"], "skillDirs": ["<abs>/skills"],
  "hooksFile": "<abs>/hooks.json", "authFile": "<abs>/auth.json", "sessionDir": "<abs>/sessions", "config": "<abs>/config.json",
  "trustProject": true }
```

`--profile` 的字段等价于对应命令行参数，命令行显式参数优先于 profile；profile 不含密钥。

## §11 启动序列

### §11.1 `ama` → 第一次模型调用

| 步 | 动作                                                                                                                                                                                                                                                                       | 失败处理 → 退出码                                                                                             |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1  | `cli/main.ts`：设 `AMA=1`、`AI_AGENT=ama` 环境标记；装 `uncaughtException` / `unhandledRejection` → stderr 一行 + 退出 1；`SIGINT` / `SIGTERM` 交给当前模式                                                                                                             | —                                                                                                             |
| 2  | `args.parse(argv)`：`--version` / `--help` 短路（0）；子命令 `auth / sessions / models / doctor` 分派后退出；互斥校验（`-p` 与 `--mode rpc`；`--continue` 与 `--resume`；`--api-key` 需 `--model`）                                                                     | 参数错误 → stderr 用法 → **2**                                                                                |
| 3  | `profile.load(--profile)` 展开为参数（命令行优先）                                                                                                                                                                                                                         | 文件不存在 / 版本不符 / 路径不是绝对 → **3**                                                                  |
| 4  | 决定模式：`--mode rpc` → rpc；`-p` → print；否则 stdin / stdout 任一非 TTY 或 `TERM=dumb` 或 `--no-tui` → line；否则 interactive。非交互模式**接管 stdout**（`console.log` 重定向到 stderr）                                                                           | —                                                                                                             |
| 5  | `paths.resolve()`：configDir / dataDir / sessionDir（`--session-dir` > profile > `AMA_DATA_DIR` > 缺省）；建目录（0700）                                                                                                                                                  | 不可写 → **3**                                                                                                |
| 6  | 读**用户级** `config.json` + profile.config（深合并 + 校验）                                                                                                                                                                                                              | JSON 语法 / 字段错误 → 诊断含路径与字段 → **3**                                                              |
| 7  | 会话：`--continue`（本 cwd 最近一条）/ `--resume [id]`（无 id 交互时弹选择器，非交互报错）/ `--session-id <id>`（不存在则建）/ `--fork <id>` / 缺省新建（内存中，首次提示时才落盘）。会话 cwd 不存在：交互询问新 cwd，其它模式报错                                        | 找不到 / 损坏 → **5**                                                                                         |
| 8  | 以**会话的 cwd** 为准：信任决策（`--trust/--no-trust` → trust.json → 交互询问 → 非交互不信任）                                                                                                                                                                             | —                                                                                                             |
| 9  | 读项目级 `.ama/config.json`，按 §7.2 收紧规则合并；被忽略的放宽项记 warning                                                                                                                                                                                                | 语法错误 → **3**                                                                                              |
| 10 | 资源发现：`context-files`（AGENTS.md 向上，外层在前）→ skills（§5.3 顺序，信任过滤）→ prompts 模板 → hooks.json（用户 / profile / 项目，信任过滤）→ `--instructions` 文件                                                                                                 | 文件读错 → warning 继续；hooks.json 语法错 → **3**；`--instructions` 不存在 → **3**                           |
| 11 | 供应商与模型：`ProviderRegistry.build(builtin, config.providers)` → 解析模型（`--model` > 续会话最后 `model_change` > `config.defaultModel` > 第一个有 key 的供应商的目录首条）→ `auth.resolveApiKey(provider)`（§3.5）                                                   | 模型不存在 → **4** 并列出候选；`--provider` 不带 `--model` → **2**（不回退到别家缺省模型，同 Pi 1.0）；无 key 且 `requiresApiKey` → **4** 并提示 `ama auth set <provider>` 与环境变量名；交互模式改为弹模型选择器而非退出 |
| 12 | 工具注册表：内置 → `config.tools.disabled` → `--tools` / `--exclude-tools`                                                                                                                                                                                                 | 未知工具名 → **2**                                                                                            |
| 13 | 宿主适配器：`--host` / profile.host → `loader.load()`（版本校验）→ `create(api)`（超时 10 s）→ `undefined` 则不激活；激活后它注册工具、追加指令、设 broker                                                                                                                | 模块加载失败 → **6**；`hostApi` 版本不等 → **78**；`create` 抛错 / 超时 → **6**                               |
| 14 | 组装 `AgentSession`（系统提示装配、权限管线、HookDispatcher、broker 链）；发 `session_start`；跑 `SessionStart` Hook（可追加上下文）                                                                                                                                       | Hook 退出码 2 → **6**；其它 Hook 错误 → warning                                                               |
| 15 | 模式分派：interactive → 初始化终端（raw、括号粘贴开、能力探测）→ 渲染首帧；line → readline；print → 读 stdin 管道 + 参数拼首条提示；rpc → 发 `hello`                                                                                                                      | 终端初始化失败 → 自动降级 line + warning                                                                      |
| 16 | 首条提示：`UserPromptSubmit` Hook → 模板 / `/skill:` 展开 → `before_agent_start` → 首次请求前把系统提示 + 工具表作为首条 `system` 消息落盘（此时才创建会话文件）→ `Agent.prompt` → `api.stream`                                                                           | 供应商错误走重试 / 溢出 → 压缩；最终失败 print 模式退出 **1**，交互模式显示错误留在 REPL                       |

### §11.2 嵌入 Armadra 时的差异

- 启动行 `ama --profile <path> [--permission-mode …] [--model …] [prompt]`；profile 提供 host / instructions / skillDirs / hooksFile / authFile / sessionDir / config / `trustProject`。
- 第 4 步：在 tmux PTY 里 stdin/stdout 都是 TTY → interactive；Armadra 可在 profile.config 里设 `ui.theme`；`TERM` 由 tmux 给（`tmux-256color` / `screen-256color`）。
- 第 11 步：key 只来自 `authFile`（core 每次启动前写 0600 文件）；不读环境变量（profile 可设 `authEnv: false`）。
- 第 13 步：适配器在 `ARMADRA_NODE_ID` 缺失时返回 `undefined`，画布外同一 profile 退化为普通 ama。
- 第 16 步后：`send` 进来的正文以 `ESC[200~ … ESC[201~` + `\r` 到达 → TUI 编辑器把它当一次粘贴（折叠显示）再由 `\r` 提交。

### §11.3 退出码

| 码  | 含义                           | 码  | 含义                                                         |
| --- | ------------------------------ | --- | ------------------------------------------------------------ |
| 0   | 正常                           | 6   | 宿主 / Hook 加载或启动失败                                   |
| 1   | 运行期错误（模型最终失败等）   | 7   | `-p` 有工具调用被拒（无人审批、deny 规则、plan 等）          |
| 2   | 参数用法错误                   | 8   | `-p` 到达预算上限（`--max-turns` / `--max-cost` / `limits`） |
| 3   | 配置 / profile / 路径错误      | 9   | `-p` 产出的计划已落盘、待审批（`plan.unattended: stop`）     |
| 4   | 无可用模型或密钥               | 78  | `HOST_API_VERSION` 不匹配                                    |
| 5   | 会话不存在 / 损坏 / cwd 不匹配 | 130 | SIGINT 退出（两次 Ctrl+C）；143 = SIGTERM                    |

7 在 0.4.0 加入；8、9 在 0.5.0 加入（第五波：`--max-turns` 到限原来退出 1，现为 8；设计稿里的 7 已被「工具被拒」占用）。
码表的唯一来源是 `src/cli/exit-codes.ts`（`describeExitCode`），README 与 `--help` 与它一致。

## §12 交互界面（`tui/` 组件库 + `modes/interactive/`）

### §12.1 组件模型

```ts
export interface Component {
  render(width: number): string[];          // 每行可见宽 ≤ width；末尾重置样式
  handleInput?(data: string): void;         // 焦点组件收原始键数据
  invalidate(): void;                       // 主题 / 状态变化清缓存
}
export interface Focusable { focused: boolean }        // 获焦组件在光标处输出 CURSOR_MARKER（APC "\x1b_ama:c\x07"），TUI 据此摆硬件光标
export interface Theme { fg(name: SemanticColor, s: string): string; bg(...): string; bold/dim/italic/underline(s): string; readonly caps: { colors: 0 | 16 | 256 | 16_777_216 }; readonly glyphs: Glyphs }
```

无布局引擎；`Container` 纵向拼接。内置组件：`Container, Text, TruncatedText, Markdown, Editor, SelectList, Box, Card, Spacer, Loader, KeyValue, Meter, Overlay(center|bottom)`。视觉规格（配色、字形、逐屏样稿）见 [tui-design.md](tui-design.md)。

### §12.2 差分渲染（`tui/tui.ts`，主屏模式）

1. `requestRender()` 合并：`process.nextTick` 调度，最小间隔 16 ms；键盘输入触发的渲染绕过节流。
2. 渲染组件树得行数组 → 合成覆盖层 → 提取光标标记。
3. 首帧全量；**宽度变化全量重绘**；高度变化全量。
4. 否则找首尾变化行，只重写该区间；首变化行已滚出视口（在上次视口之上）→ 全量重绘。
5. 所有写入包在同步输出 `\x1b[?2026h … \x1b[?2026l`；按 64 KiB 分块写。
6. 记录内容末行与硬件光标行；最后把硬件光标移到编辑器光标处。
7. 退出时：关括号粘贴、恢复 cooked 模式、光标移到内容末尾下一行、不清屏（回滚保留对话）。

### §12.3 输入

- `StdinBuffer`：攒完整转义序列；括号粘贴 `ESC[200~ … ESC[201~` 跨 data 块累积为一次 `paste` 事件；孤立 ESC 判定超时 `AMA_TUI_ESC_TIMEOUT`（SSH / tmux 100 ms，本地 10 ms）。
- `keys.ts`：解析 CSI / SS3、修饰键参数、Alt 前缀、`\r` / `\n`、Shift+Enter 的常见变体（`\x1b[13;2u`、`\x1b[27;2;13~`）、Ctrl 组合；**不查询 Kitty 协议**（tmux 下回包会污染输入）。
- 键位（固定表 + `keybindings.json` 覆盖）：`Enter` 提交；`Shift+Enter` / `Ctrl+J` 换行；`Esc` 中断（clear_queue → abort，队列文本回填）；`Ctrl+C` 清输入，再按退出；`Ctrl+D` 空输入退出；`Alt+Enter` 以 followUp 提交；`Alt+Up` 取回队列末条；`Shift+Tab` 循环权限模式；`Ctrl+O` 展开 / 折叠工具输出与思考块；`Ctrl+L` 模型选择；`Ctrl+T` 思考级别；`Up/Down` 历史（单行时）/ 行移动；`Tab` 接受补全；`Ctrl+U/K/W` 行编辑。

### §12.4 编辑器（`components/editor*.ts`）

多行、单词导航、撤销栈（50 步）、历史（会话内 + `~/.local/share/ama/history`，500 条）；大粘贴 **> 10 行或 > 1 000 字符**折叠为 `[粘贴 #N · M 行]` 不可分割段，提交时展开；补全：`/` 命令与模板与 `/skill:`，`@` 文件（`glob` 实现，相对 cwd，最多 50 项）；`disableSubmit` 用于审批对话框期间。括号粘贴期间不触发补全；粘贴结束后紧随的 `\r` 正常提交（Armadra 路径）。

### §12.5 消息区（`message-view.ts`、`tool-view.ts`）

三级层级用缩进表达（颜色只做第二通道）：第 0 列用户 `›`、工具 `⏺`、提示符号；第 2 列结果连接符 `⎿` 与续行；第 4 列工具输出正文。相邻工具调用之间不空行，回合之间空一行；`ui.compact` 全部不空行。

- 助手文本：Markdown 渲染（h1/h2 accent 粗体、列表符号 muted、全宽代码块加边框与语言标签且正文为正文色、`▎` 引用、链接 link 色加 ` (url)`、表格列间两空格加表头规则线）；流式时只重渲染末块，按 (width, text) 缓存。
- 思考块：缺省折叠一行 `✻ 思考 · N token`（流式中 `✻ 思考中…`），`Ctrl+O` 展开为缩进正文（最多 60 行）；`ui.showThinking: full|collapsed|hidden`。
- 工具调用：标题 `⏺ bash git status`（运行中 accent、成功 success、失败 error）+ `⎿` 一行结果摘要（读取 N 行、N 处修改 · +a −b、退出码 · 耗时 · 行数、匹配数 · 文件数……）；正文折叠显示前 3 行；`Ctrl+O` 展开全部；`edit` 显示 diff（+/− 着色，≥ 60 列带行号）；`bash` 运行中摘要行带与 Loader 同帧的 spinner，流式显示尾部 8 行；错误红色。
- 用户消息（续行缩进 2 列）、插话（`↳ 插话`）、之后（`↳ 之后`）、宿主注入（`↳ 宿主`）、压缩摘要左竖条卡片、重试提示、Hook 阻止提示；退出前追加会话摘要与 `ama --resume <id>`。
- 滚动由终端回滚承担；TUI 只维护「视口内的尾部」：超出屏幕高度的历史行已经由终端滚出，不再重绘（这是主屏模式能差分的前提）。

### §12.6 状态栏、审批、选择列表

- 状态栏一行、永远是最后一行，两区：左区权限模式 + `shift+tab 切换`，右区 `模型 · 思考 · ↑12.3k ↓1.2k · cache 80% · $0.12 · ctx 34% · queue 1 · codemode on · preset x · [host 状态]`（顺序与 ` · ` 分隔固定）；`ctx ?` 表示无窗口；窄屏按优先级丢项，模式永不丢。运行中 Loader 显示动词（等待确认 / 运行 bash / 重试 / 压缩上下文 / 回复中 · ↓≈N / 思考中）与已用时。
  第五波改为两行（速率行 + 状态行，`ui.statusLine`，嵌入缺省 `compact` 保持单行）并补 git 分支 / 提交 / 增删行与会话时长，见 [wave5-plan.md](wave5-plan.md) §1。
- 审批对话框（覆盖层 bottom）：标题为原因（需要确认 / 危险命令 / Hook 要求确认），边框随预览严重度着色；工具名、输入（bash 显示命令全文，文件工具显示路径与 diff 摘要）、执行前预览；编号选项 `1. 允许 y / 2. 本会话允许同类 a / 3. 拒绝 n Esc`，数字、↑↓ Enter 与字母键都可用，危险命令缺省选中拒绝；`v` 展开完整输入；10 分钟超时 deny。
- 选择列表：模型（按供应商分组，标 key 状态，当前模型 ✓）、会话（时间、名字、首条提示）、树（缩进显示分支，选中 user 消息回填编辑器）、权限模式（标题「权限模式」）；底部一行按键提示。`/session`、`/cache`、`/permissions` 是消息区的左竖条面板。

### §12.7 主题与能力

`dark` / `light` 两套语义色，14 个（`text, muted, dim, accent, success, warning, error, user, assistant, tool, border, code, link, selection`），取值都落在 xterm 256 色立方 / 灰阶上（256 色回退无损），16 色按内置索引表；`selection` 只在 ≥ 256 色时作选中行底色，更少时退化为 accent 粗体；`NO_COLOR` 或 `caps.colors = 0` 全部降为无色；`ui.theme: "auto"` 只看 `COLORFGBG`，不探测终端背景。

字形挂在 `Theme.glyphs`（`tui/glyphs.ts`）：`› ⏺ ⎿ ✓ ✗ ✻ ↳ ↻ ▎ ▸ ▾ ♨ • ◦ ▪ ▮ ▯`、圆角框线、10 帧盲文 spinner，全部 1 列宽；ASCII 回退表（`> * L v x ~ -> @ | # .`、`+ - |`、4 帧 spinner）在 `ui.ascii` / `AMA_ASCII=1`、区域设置不含 UTF-8、`TERM=linux`、旧 conhost 时启用。

### §12.8 在 Armadra 终端节点（tmux）里的可用性保证

| 问题                     | 对策                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 括号粘贴透传             | 启动时发 `\x1b[?2004h`；tmux 会把外层粘贴转成内层序列；状态机只认 `ESC[200~ / ESC[201~`；e2e 里实测            |
| `\r` 提交                | 粘贴结束后 `\r` 走普通键路径 = 提交；粘贴内部的 `\n` 是数据                                                     |
| 回滚                     | 主屏模式，不用备用屏；对话历史滚进 tmux 回滚，Armadra 的 `context_terminal` 读得到                              |
| 同步输出                 | tmux ≥ 3.4 透传 `?2026`；旧版忽略无害                                                                            |
| 宽度变化                 | SIGWINCH → 全量重绘；编辑器按新宽重排                                                                            |
| 无 Kitty / 无鼠标        | 不查询、不启用；避免回包                                                                                        |
| 自动降级                 | `TERM=dumb`、非 TTY、`--no-tui` → line 模式（同一套命令与审批 `y/n/a` 问答）                                     |

### §12.9 相对 Pi 的砍掉清单

备用屏 / 全屏模式与自管滚动、鼠标事件与选区、Kitty 键盘协议与键释放事件、图片渲染、九种覆盖层锚点（只留两种）、kill ring、HStack / ScrollView / SettingsList、`system` 主题的终端颜色探测、Markdown 表格与语法高亮、可替换页眉页脚、扩展自定义组件 API（宿主只能 `notify` / `setStatus`）、会话 HTML 导出、`!` 用户 bash 行、每日提示与 logo 动画。

### §12.10 显示模式与启动画面（对照 Pi 1.0）

Pi 1.0 把 TUI 默认改为全屏（备用屏），并以 `tuiMode: "regular"` 保留终端原生回滚；ama 的取舍如下。

| 项         | ama 决定                                                                                                                                                                                  | 理由                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 显示模式   | 第一期**只有主屏模式**（相当于 Pi 的 `regular`）；配置键 `ui.tuiMode` 与参数 `--tui-mode` 预留，取值 `regular`，`fullscreen` 记为后置（§12.9 砍掉清单）                                  | 嵌入 Armadra 时 core 要用 tmux 读屏、对话要进回滚供 `context_terminal` 读取、Eco 休眠后 resume 要能看到历史；备用屏会让三者都变差 |
| 启动画面   | `ui.quietStartup`：`normal`（AMA 字符画 + 信息列：模型 / 目录与信任 / 模式 / 已加载资源 / 警告；启动时点亮一次；窄屏、`ui.logo: off` 或 `ui.compact` 不画字符画）、`header`（一行 `✻ ama 版本 · 模型 · 模式 · /help`）、`silent`（不输出）；参数 `--quiet-startup <档>` | 与 Pi 1.0 的 `quietStartup` 同义                                                                                                |
| 嵌入缺省   | profile.config 缺省 `ui.quietStartup: "header"`                                                                                                                                           | 画布节点窄，资源清单由画布自己展示                                                                                              |

## §13 SDK 与 RPC

### §13.1 SDK（`@armadra/agent`）

```ts
export function createAgentSession(options?: CreateSessionOptions): Promise<AgentSession>;
export function createRuntime(options?: RuntimeOptions): Promise<Runtime>;      // 复用 bootstrap 的 6–14 步，不进入模式
export interface CreateSessionOptions {
  cwd?: string; model?: string | { provider: string; id: string }; thinkingLevel?: ModelThinkingLevel;
  auth?: { kind: "file"; path: string } | { kind: "env" } | { kind: "inline"; keys: Record<string, string> } | { kind: "none" };
  providers?: ProviderData[];                                     // 追加 / 覆盖供应商（含 fake）
  sessionManager?: SessionManager;                                // SessionManager.inMemory() | open(file) | create(dir, cwd)
  tools?: "default" | "none" | ToolDefinition[]; extraTools?: ToolDefinition[]; disableTools?: string[];
  instructions?: InstructionSource[]; skillDirs?: string[]; contextFiles?: boolean;
  permission?: { mode?: PermissionMode; allow?: string[]; deny?: string[]; ask?(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> };
  hooks?: HookConfig | false;                                     // 命令式 Hook（缺省不加载文件系统配置）
  host?: HostModule; trustProject?: boolean; config?: Partial<AmaConfig>;
}
export interface AgentSession {
  prompt(text: string, o?: { images?: ImageBlock[]; streamingBehavior?: "steer" | "followUp" }): Promise<PromptDisposition>;
  steer(text: string): Promise<"queued" | "handled">; followUp(text: string): Promise<"queued" | "handled">;
  abort(): Promise<void>; waitForIdle(): Promise<void>; clearQueue(): { steering: string[]; followUp: string[] };
  subscribe(listener: (event: SessionEvent) => void): () => void;
  compact(instructions?: string): Promise<CompactionResult>; fork(entryId: string): Promise<AgentSession>;
  setModel(ref: string): Promise<void>; setThinkingLevel(level: ModelThinkingLevel): void; setPermissionMode(mode: PermissionMode): void;
  setActiveTools(names: string[]): void; getTools(): readonly ToolDefinition[];
  readonly state: SessionState; readonly messages: readonly AgentMessage[]; readonly entries: readonly SessionEntry[];
  getLastAssistantText(): string | null; getStats(): SessionStats;
  dispose(): Promise<void>;
}
export { SessionManager, ProviderRegistry, FakeProvider, defineTool, loadConfig, HOST_API_VERSION };
export type { ToolDefinition, ToolContext, ToolResult, Model, ProviderData, SessionEvent, HookInput, HookOutput, ... };
```

### §13.2 RPC（stdio JSONL，`--mode rpc`）

框架同 v1 §8.4（`hello{protocolVersion:1, capabilities:["approvals","images","hooks"]}`）。命令组：提示（`prompt / steer / follow_up / abort / clear_queue`）、状态（`get_state / get_messages / get_last_assistant_text / get_session_stats`）、模型（`set_model / get_available_models / set_thinking_level / get_available_thinking_levels`）、队列、压缩（`compact / set_auto_compaction`）、重试（`set_auto_retry / abort_retry`）、会话（`new_session / switch_session / fork / get_entries{since} / get_tree / set_session_name / get_fork_messages`）、审批（`set_client_capabilities / permission_response{requestId, decision}`）、工具（`get_tools / set_active_tools`）、权限（`set_permission_mode`）、发现（`get_commands`：模板、技能、斜杠命令）、技能（`get_skills`）。

事件：v1 列表改名 `auto_retry_start / auto_retry_end`，加 `entry_appended{entry}`、`hook_executed`、`permission_mode_changed`、`agent_before_settle`；`message_update` 线上为纯增量 + 最新 `usage`；`agent_end{stopReason, willRetry}`。`permission_request` 带 `timeoutMs`，服务端超时自动 deny 并发 `permission_resolved`。

第五波增量：命令 `plan_response / get_plan / get_todos / get_tasks / get_agents`、能力 `plans`、事件 `plan_* / subagent_* / todo_updated / limit_reached / model_fallback / telemetry_tick`；另有 `--mode acp`（ACP 服务端）与 `@armadra/agent/acp`，见 [wave5-plan.md](wave5-plan.md) §5.6、§6.5、§9。

## §14 分发

| 产物                        | 构建                                                              | 用途                                                                       |
| --------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `dist/`（ESM + d.ts）        | `tsc -p tsconfig.build.json`                                      | SDK；宿主拿类型（Armadra 以 Git 依赖 `github:Owlbay/armadra-agent#v0.x` 或 Release tarball 安装） |
| `dist/bundle/ama.cjs`       | esbuild，全部内联，无原生模块，`target node22`                    | 宿主随包携带；`node ama.cjs` 或 `ELECTRON_RUN_AS_NODE=1 <Electron> ama.cjs` |
| GitHub Release              | `v*` 标签 → CI 全绿 → 附 `ama.cjs` + `ama-sandbox.cjs` + `SHA256SUMS` + `package.tgz`（`pnpm pack`） | 不走 npm 的用户直接跑 `ama.cjs`（与 `ama-sandbox.cjs` 同目录），或 `npm i -g ./package.tgz` |
| npm publish                 | 0.2.1 起：`v*` 标签 → release job 在 GitHub Release 之后 `npm publish --provenance --access public`（npm ≥ 11.5.1 先用 OIDC 可信发布——npmjs.com 上为 `Owlbay/armadra-agent` 的 `ci.yml` 配 Trusted Publisher；换不到令牌时回退 `NODE_AUTH_TOKEN` = 仓库 secret `NPM_TOKEN`；两者都没有则 job 失败；版本已在 npm 上则跳过） | `npm i -g @armadra/agent`；SDK `import … from "@armadra/agent"`；包内只有 `dist/`（无源映射、无测试辅助）、README、LICENSE、CHANGELOG 与用户文档 |

版本语义：`HOST_API_VERSION` 或 RPC `protocolVersion` 变 → 主版本；其余 semver。Windows：CI 跑单测 + `-p` 冒烟 + line 模式括号粘贴测试；TUI 在 Windows Terminal 手测。

## §15 测试策略

| 层         | 方法                                                                                                                                                                            | 批次 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 协议解析   | `test/fixtures/sse/<api>/*.txt` → 事件序列黄金 JSON；每协议 ≥ 8 用例：纯文本、思考、单 / 多工具调用、length、429、溢出、断流、usage 差异                                          | B1   |
| compat     | `detectCompat` 真值表（13 家 + 自定义 baseUrl）；请求体快照（`onPayload`）                                                                                                       | B1   |
| 循环       | fake 供应商脚本驱动：abort 补 result、steer 投递点、followUp 时机、重试 + context_edit、length 整批失败、并行 / 串行传染                                                          | B2   |
| 会话 / 压缩 | JSONL ↔ 投影；fork / tree / prune；档一只改旧结果；切点合法；split turn；熔断各触发一次；溢出 → 压缩 → 重试一次                                                                   | B2   |
| 工具       | 每工具正反例；bash 超时 / 杀树 / 退出码 / 截断落盘（三平台）；edit 唯一性与模糊；grep / glob / ignore 对照 fixture 树                                                             | B3   |
| 权限       | 危险表正反例；4 模式 × 3 类 × Hook 决策真值表；项目级放宽被忽略；无人值守 deny                                                                                                     | B3   |
| Hook       | 用 `node -e` 脚本做 Hook：退出码 0/2/其它、超时、并行合并、updatedInput 唯一性、信任过滤                                                                                           | B5   |
| 配置 / 启动 | 临时 HOME 下的层级合并、profile 展开、每个退出码一个用例、AGENTS.md 向上查找、trust 决策                                                                                            | B5   |
| TUI        | `MemoryTerminal`：帧黄金文件（宽 80 / 40）、差分只写变化区间、同步输出包裹、resize 全量、括号粘贴折叠与 `\r` 提交、键解析表                                                       | B4/B7 |
| RPC        | 黄金记录字节比对；U+2028 不切；审批超时                                                                                                                                           | B6   |
| 宿主 API   | 测试适配器收齐全部事件、注册工具受管线、版本不匹配 78、`create` 返回 undefined                                                                                                   | B5   |
| 端到端     | `AMA_E2E_PROVIDER=…` 真模型（CI 不跑）；Armadra 场景 11 在宿主仓库                                                                                                                | B9   |

## §16 实施批次（面向并行代理团队）

### §16.1 波次

```text
B0 契约与骨架（1 人，先行 1–2 天）
  ├─ 第一波（并行 5 人）：B1 协议与供应商 │ B2 循环·会话·压缩 │ B3 工具·权限·Skill │ B4 TUI 组件库 │ B5 配置·Hook·宿主·启动
  ├─ 第二波（并行 4 人）：B6 模式（line/print/rpc）与 SDK │ B7 交互模式 │ B8 Google 与 Responses 协议 │ B10 codemode
  └─ 第三波（1–2 人）：B9 集成、Windows、bundle、Release、文档与 Armadra 场景 11
```

### §16.2 批次定义

| 批次 | 交付物                                                                                                                                                                                                                | 文件所有权（§1.2 标注）                                                        | 依赖      | 验收                                                                                                                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0   | 仓库根文件、CI、`scripts/build-bundle.mjs`、`check-no-deps.mjs`；全部 `types.ts` / `component.ts` / `exit-codes.ts` / `runtime.ts` / `schema.ts`（JSON Schema 校验）；子路径入口文件；`docs/` 骨架                 | 所有 `[B0]` 文件；之后对契约文件的改动走 B0 所有者评审                          | —         | `pnpm ci` 在空实现上绿；`node dist/bundle/ama.cjs --version` 输出版本；`check-no-deps` 通过                                                                                                                                                              |
| B1   | 两条第一期协议、SSE、容错 JSON、compat、13 家供应商数据与目录、key 发现、思考映射、成本、溢出识别、fake 供应商、`record-sse.mjs`                                                                                       | `src/ai/**`（除 B8 两文件）、`test/fixtures/sse/**`、`fixtures/scripts/**`     | B0        | 协议黄金测试全绿；`detectCompat` 真值表全绿；对 anthropic 与一家 OpenAI 兼容端点（开发者本地真 key）各录 ≥ 8 样本入库；fake 供应商能按脚本产出工具调用 / 429 / 溢出                                                                                          |
| B2   | 循环、队列、重试、transform、tool-runner、系统提示装配、AgentSession、SessionManager / 投影 / 树 / store、两档压缩与熔断、分支摘要                                                                                       | `src/agent/**`（除 types/schema）、`src/session/**`、`src/compaction/**`       | B0；用 B1 的 fake（接口在 B0 types，可先用本地桩） | 循环与压缩测试全绿；用 fake 脚本：长会话（> 窗口 2 倍）自动压缩且不循环；abort 后文件每个 tool_call 恰有一个 result；溢出 → 压缩 → 重试一次                                                                 |
| B3   | 全部内置工具（含 task、skill、todo）、截断、进程树、ignore、grep / glob、权限规则 / 危险表 / 管线 / broker、Skill 发现与模板                                                                                           | `src/tools/**`（除 types）、`src/permissions/**`（除 types）、`src/skills/**`  | B0        | 工具测试三平台绿；bash 杀树在 macOS / Linux / Windows 各通过；权限真值表全绿；`skills/` fixture 索引输出与黄金一致                                                                                                                                         |
| B4   | TUI 组件库：tui / terminal / stdin-buffer / keys / ansi / theme / keybindings / 全部 components                                                                                                                       | `src/tui/**`（除 component.ts）、`test/fixtures/tui/**`                        | B0        | 帧黄金测试全绿；差分测试断言「只重写变化区间」与同步输出包裹；括号粘贴（跨 data 块）折叠为标记并在 `\r` 时提交展开；`node demo` 脚本在真终端与 tmux 内手测编辑器 / 选择列表 / Markdown                                                                      |
| B5   | 参数解析、bootstrap、子命令、config 层级 / 信任 / profile / auth 文件 / AGENTS.md 查找、命令式 Hook 全部、HostApi 实现与加载器                                                                                          | `src/cli/**`（除 exit-codes/runtime）、`src/config/**`、`src/hooks/**`（除 types）、`src/host/**`（除 types） | B0        | 启动序列每个退出码一个测试；Hook 退出码 / 超时 / 并行合并测试全绿；测试适配器收齐事件；`ama doctor` 在临时 HOME 下输出层级与信任状态；`ama auth set` 从 stdin 写 0600                                                                                        |
| B6   | line 模式、print 三格式、RPC 全命令、json-event 线上形状、`sdk.ts`                                                                                                                                                     | `src/modes/{print,rpc}/**`、`src/modes/interactive/line/**`、`src/sdk.ts`      | B1–B3、B5 | RPC 黄金记录全绿；`ama -p "hi" --model fake/echo` 三格式输出正确；line 模式括号粘贴测试；外部脚本仅凭 `docs/rpc.md` 跑通 prompt → agent_settled；SDK 示例在 README 可运行                                                                                     |
| B7   | 交互模式：装配、消息区、工具视图、状态栏、审批对话框、斜杠命令、补全、选择器                                                                                                                                           | `src/modes/interactive/**`（除 line/）                                        | B2–B5     | 用 MemoryTerminal + fake 供应商的集成帧测试：一次完整 run 的帧序列黄金；审批对话框 y/n/a；Esc 回填队列；真终端与 tmux 手测：读改一个文件、Esc 中断后继续、`/model` 切换、`/tree` 分叉                                                                            |
| B8   | `google-generative-ai`、`openai-responses` 协议与各自 compat、目录条目切换、SSE 样本                                                                                                                                 | `src/ai/apis/{google-generative-ai,openai-responses}.ts`、对应 fixtures、catalog 中 `api` 字段 | B1        | 两协议各 ≥ 8 样本黄金；fake 之外对真实端点手测一次工具调用往返                                                                                                                                                                                            |
| B10  | codemode（§5.5）：`codemode` 工具、沙箱子进程与 JSON 行协议、`vm` 上下文与全局函数、JSON Schema → TS 声明、store 条目、三种模式、`viaCodemode` 的 Hook 输入与嵌套事件 | `src/codemode/**`（`tool.ts`、`host-side.ts`、`sandbox-entry.ts`、`protocol.ts`、`declarations.ts`、`store.ts`、`modes.ts`）；bundle 增加第二个入口 `dist/bundle/ama-sandbox.cjs` | B2、B3、B5 | 脚本并行调用三个工具、只回输出；`--permission` 子进程读文件 / 起进程被拒（Node ≥ 25 联网被拒）；内层调用被拒绝规则拦下时脚本收到 Error；超时杀子进程；store 只在成功时提交；`only` 模式下模型只见 `codemode` |
| B9   | 集成：bundle 冒烟三平台、Windows 收尾（PowerShell 回退、taskkill、路径）、Release 流水线、§5.6 预设基准、§9.1 缓存稳定性测试、`docs/{rpc,session-format,host-api,hooks,providers,tui}.md`、README、Armadra 文档 B 场景 11 配合                                | 跨批次修复走原所有者；B9 拥有 `docs/**`、`README.md`、CI release job          | 全部      | `pnpm ci` 三平台绿；`node ama.cjs` 在 `ELECTRON_RUN_AS_NODE=1` 下启动；Armadra 场景 11 1–4 步通过；Release 附件 SHA 校验                                                                                                                                      |

### §16.3 并行约束

- 第一波五个批次互不 import 对方的实现文件，只 import B0 的 `types.ts`；需要对方能力时写本地桩（例如 B2 在 B1 完成前用一个最小 `stubStream`）。
- 契约变更流程：提 PR 改 `types.ts` + 说明影响批次，B0 所有者合并后各批次 rebase；禁止在实现文件里「顺手」改契约。
- 每批次附带自己的测试与 `docs/` 对应章节草稿（B9 统稿）。

## §17 风险与待定项

| #   | 风险 / 待定                                                                                             | 处置                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | OpenAI 兼容各家对流式 `tool_calls` 增量、`usage`、思考字段的差异                                        | B1 先录真实样本；差异全部收敛在 `openai-compat.ts` 的真值表，每家一条样本                                                            |
| R2  | 主屏差分渲染在终端高度小于内容时的边界（首变化行已滚出）                                                 | 该情况全量重绘；B4 的黄金测试覆盖高度 10 行的小终端                                                                                  |
| R3  | tmux 版本差异：`?2026` 同步输出、括号粘贴透传、`TERM` 值                                                 | 不依赖 `?2026`（忽略无害）；括号粘贴在 Armadra e2e 实测；`TERM` 只用来判 dumb                                                       |
| R4  | 命令式 Hook 以用户权限执行任意命令；项目级 Hook 是供应链入口                                             | 项目级需信任；非交互缺省不信任；`doctor` 列出将执行的 Hook 命令；文档说明边界                                                        |
| R5  | `Stop` Hook 的 block 可能让 run 无限续跑                                                                 | 上限 3 次，`stopHookActive: true` 传给 Hook                                                                                          |
| R6  | 内置模型目录过时（新模型、价格变动）                                                                    | 目录是数据文件，PR 更新；用户 `modelOverrides` 立即可用；`ama models check` 验证可用性                                                 |
| R7  | 零依赖意味着 glob / ignore / Markdown / 键解析全部自写，边角多                                           | 每个模块用对照 fixture 树与黄金文件；范围刻意缩小（§12.9）                                                                           |
| R8  | 两层 Hook 与权限管线的组合语义用户难以理解                                                              | `doctor` 与 `/permissions` 命令显示「这条工具调用会经过哪些步骤」的解释；文档 §6.3 的顺序图进 `docs/hooks.md`                       |
| R9  | 不发布 npm 时 Armadra 的依赖方式（Git 依赖需在 install 时构建）                                          | Release 附 `pnpm pack` 的 tgz，Armadra 用 tgz URL 作 devDependency；`tools/release/compatibility.json` 锁 SHA                        |
| R10 | `task` 子 Agent 与父共享 broker 时的审批排队体验                                                        | 子的 ask 串到父对话框并标 `[task]`；文档 B 下适配器禁用 task，不受影响                                                               |
| R11 | 保温重放在中转上可能按全价而不是读价计费（中转改写请求或缓存按连接亲和） | 只在 `reported` 端点保温；连续 2 次保温零命中即停；`/session` 显示保温次数与花费；`cache.warming: "off"` 一键关闭 |
| R12 | 压缩摘要的前缀续写在 Anthropic 上能否命中到上一轮断点 | 请求体快照保证前缀逐字节一致；回落为独立请求并记 warning；命中占比以真实中转实验为准 |
| R13 | 24h / 30m 长保留、亲和头、中转上的 `prompt_cache_key` 未见收益或被 400 拒收 | 只对官方端点缺省开；400 自动剥离并提示开关；`ama models cache-probe` 让用户自测 |
| R14 | `usage` 条目与 `leaf` 行是会话格式的追加，旧版本读取会遇到未知行 | 都是 v1 可选行，投影跳过未知类型；格式版本不升 |
| R15 | `ama models discover --probe` 对每个模型发请求，中转按次计费或限流 | 缺省 `--limit 30`，执行前打印预估，401 / 403 / 429 即停 |
| R16 | `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 指向中转后 compat 推断按主机名，缓存字段可能不被接受 | 非官方主机按保守缺省；400 剥离兜底；`ama config show` / `doctor` 标出 baseUrl 来源 |
| R17 | 审批前预览递归统计大目录（如 `rm -rf` 的目标）耗时 | 每个目标最多 2000 项、整次 200 ms 预算，超出只提示且不降低严重度；预览失败不影响审批 |
`xhigh` 级别是否在 UI 暴露；`todo` 是否进系统提示；Windows PowerShell 回退时的 Hook 命令解释器 | B1 / B7 / B3 / B5 开工前各自决定并写进对应 docs 章节                                                                                   |
