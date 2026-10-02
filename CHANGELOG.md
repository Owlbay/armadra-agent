# 更新记录

## 未发布

- **检查点核心**（docs/rewind-plan.md，回滚的会话接线与界面在后续批次）：edit / write 第一次写文件前备份，
  每个新回合重拍已跟踪文件；备份按内容 sha256 存 `<数据目录>/file-history/blobs/`。恢复做冲突检测与安全检查
  （符号链接、硬链接、非普通文件、父目录移动；非 Windows 用 `O_NOFOLLOW`），可预览行级增删。
  `ama sessions prune` 结束后清理未引用的备份，`ama doctor` 显示占用。新配置 `checkpoints.mode`
  （`AMA_CHECKPOINTS` 覆盖）、`checkpoints.maxFileBytes`、`checkpoints.keep`。
- **会话回滚（接口层）**（设计见 docs/rewind-plan.md）：`AgentSession.rewindPoints()` 列出活动路径上开启新回合的用户消息；
  `rewind({ entryId, mode: both | conversation | code, dryRun?, onConflict? })` 回到该消息之前——对话复用 `/tree` 换叶子、
  代码经检查点后端恢复，返回原消息草稿、恢复结果与 git HEAD 变化提示；全部失败报 `rewind_failed`，运行中报 `busy`。
  「已读」集合按新路径重算并去掉被恢复 / 不一致的文件；仅对话或仅代码时在下一次提示前追加 `ama.rewind-note`，前缀不变、缓存照常命中。
  `summarizeFrom` / `summarizeUpTo` 对应「从这里摘要」「摘要到这里」；`canUndoAbortedTurn` / `undoAbortedTurn` 供中断即撤回，
  新配置 `ui.restoreOnCancel`（缺省 true）。新回合用户消息落盘后建检查点，`task` 子会话的编辑记到父会话当前回合。
- **回滚界面**（docs/tui.md「回滚」）：`/rewind` 与空闲时双击 Esc 打开回滚列表（高亮行右侧显示代码改动统计，
  没有检查点的标「仅对话」），确认面板给出恢复代码和对话 / 恢复对话 / 恢复代码 / 从这里摘要 / 摘要到这里 / 取消，
  每项带预览，列出冲突与无法恢复的文件（冲突可选择覆盖），git HEAD 变化时给出两条命令（不执行）；对话类操作后
  原消息回填输入框。输入框有字时双击 Esc 清空并存进输入历史。运行中 Esc 中断且本回合还没有输出时自动撤回并回填
  （`ui.restoreOnCancel`）。line 模式 `/rewind` 列编号，`/rewind <n> [both|conversation|code] [overwrite]`、
  `/rewind <n> summarize-from|summarize-up-to [说明]`。新键位动作 `app.rewind`（缺省 Esc）。
- RPC 新增 `get_rewind_points`、`rewind`、`summarize_from`、`summarize_up_to` 与事件 `session_rewound`（命令表 37 条）；
  命令式 Hook 新增 `PostRewind`（`{ entryId, mode, files }`，不可阻止）；SDK 导出回滚类型。
- **影子 git 检查点**（`checkpoints.mode: "shadow-git"`，docs/sessions.md「影子 git 模式」）：每个新回合把工作目录快照进
  `<数据目录>/file-history/shadow/` 下的独立仓库，bash 与手动的新增、修改、删除、重命名也能回滚；尊重 `.gitignore`，
  不碰用户仓库。git 不在 PATH、文件数超过 20 000 或快照超过 3 秒时本会话降级为 `tools`；家目录与根目录不启用。
  `ama doctor` 显示影子仓库占用。
- **`default` 预设加 `todo`**（第五波 D20）：会话开始时随工具表固定，不中途开启；系统提示 tools 节与工具表多约 150 token，
  升级后续接的旧会话会有一次缓存未命中。**这是待复测的决定**：W5-H2 的 `bench-presets default,default+todo` 若费用增幅
  超过 5% 或成功率下降，就撤回到「plan 交接时用 `[DONE:n]` 文本标记」。
- 新工具 `task_ctl`（列出 / 等待 / 停止 / 读取后台子 Agent 任务）与 `task` 同进退：`+task`、`--tools …,task` 一起暴露，
  `-task`、宿主 `disable("task")` 一起去掉；本版本执行时返回「尚未实现」（第五波 W5-G 实现）。

- 第五波契约与扩展点（docs/wave5-plan.md §9–§10，全部可选、向后兼容；`RPC_PROTOCOL_VERSION` / `HOST_API_VERSION` /
  会话格式版本不变）：会话扩展点 `SessionExtension`（`cli/compose-extensions.ts` 组装表）；新事件 `subagent_*`、`plan_*`、
  `todo_updated`、`limit_reached`、`model_fallback`、`background_job`、`telemetry_tick`；RPC 命令 `plan_response / get_plan /
get_todos / get_tasks / get_agents`（命令表 42 条，实现前回 `not_implemented`）与能力 `plans`；Hook 事件 `PostCompact`；
  `HostApi.runners` 可选面；`@armadra/agent/acp` 子路径（驱动类型与 NDJSON 分帧）；第五波配置键的校验、说明与 JSON Schema
  （行为随各批次生效）。命令行新增 `--mode acp`、`--max-cost`、`--agent-dir`（实现前分别报「尚未实现」或提示不生效），
  退出码 8 = `-p` 到达预算上限（7 仍是工具被拒）。

## 0.4.0（2026-10-02）

- **终端界面重做**（视觉规格见 docs/tui-design.md）：带框启动头（模型 / 目录 / 模式 / 已加载资源，窄屏去框）；
  工具调用改 `⏺ 工具名 摘要` + `⎿ 一行结果摘要` + 缩进正文三级层级，相邻调用不空行，运行中摘要行带 spinner 与秒数，
  diff 带行号；思考块 `✻ 思考 · N token`，`Ctrl+O` 同时展开思考；运行中动词（思考中 / 回复中 · ↓≈N / 运行 bash /
  等待确认 / 重试 / 压缩上下文）；输入框 `›` 提示符与占位；状态栏两区（左模式 + `shift+tab 切换`，右用量，
  模型名按宽度缩写）；审批对话框编号选项（1–3 / ↑↓ Enter，危险命令缺省选中拒绝，边框随严重度着色）；
  `/session` `/cache` `/permissions` 改为左竖条面板；退出时留一行会话摘要与 `ama --resume <id>`。
  新配置 `ui.theme: "auto"`、`ui.ascii`（`AMA_ASCII=1`）、`ui.compact`、`ui.animation`。
- **破坏性变更（`@armadra/agent/tui` 与界面文本）**：`SemanticColor` 增加 `muted` / `link` / `selection`，`Theme`
  增加必填的 `glyphs`——自己实现 `Theme` 的宿主需补这 3 个颜色与字形表（可用 `UNICODE_GLYPHS`）；`Loader` 渲染从
  `⠋ 消息 (12s)` 改为 `⠋ 动词 · 12s · 附加项`；粘贴折叠标记从 `[paste #N +M lines]` 改为 `[粘贴 #N · M 行]`；
  状态栏不再有 `mode:` / `think:` / `preset:` 前缀（模式移到最左，`preset` 只在非 default 时出现），按 `mode:` 解析
  状态栏的脚本需改为取最左一项；排队消息标签 `↳ steer` / `↳ followUp` / `↳ host` 改为 `↳ 插话` / `↳ 之后` / `↳ 宿主`
  （会话文件里的 `origin` 不变）；`/permission` 选择器标题 `Mode` 改为「权限模式」。
- **codemode 缺省开放**：`codemode.mode` 不写时跟随预设——`default` 预设在沙箱网络隔离（Node ≥ 25）时带上
  `codemode`（六个工具 + codemode），Node 22 / 24 缺省不开并在启动时提示一次（每个配置目录一次，记在数据目录
  `notices.json`），`--codemode on` 或 config 显式开启；`minimal` / `coordinator` 不开。缺省配置不写这个键。
- **修复：coordinator 经 codemode 绕过**：`coordinator` 预设显式开了 codemode 时，脚本里只能调活动集里的工具
  （read 与宿主工具），`tools.bash` / `tools.write` 不再可达。
- **on 模式去重**：`codemode` 描述不再内联已直接暴露的工具声明，其它工具描述也不再追加提示，只列「参数同直接
  工具」与「仅脚本可调用」的名字；系统提示 + 工具表比 off 只多约 390 token（原约 1356）。`--codemode on` 的旧会话
  续接时描述字节变化，会有一次缓存未命中。
- **预设改名**：`codemode` 预设更名 `codemode-only`；旧名作别名继续可用（配置、`--tools-preset`、RPC、SDK、schema），
  `ama config show` 显示规范名并提示。
- **`ama init` 不写死缺省值**：新生成的 `config.json` 只有 `$schema`、`version` 与空 `providers`，以后缺省值调整对老
  用户同样生效；init 结束打印下一步。已存在的文件不动（之前生成的文件里的 `thinkingLevel` / `permission.mode` /
  `tools.preset` 仍会按 user 层生效，想跟随缺省可以删掉）。
- **`ama config show`**：补全 `cache`、`codemode` 等段与每项来源，codemode 写明生效模式与原因；接受
  `--tools-preset` / `--codemode`；`ama doctor` 同样显示 codemode。`config.schema.json` 的每个键都带说明与缺省值。
- **不再展示 fake**：零配置的模型选择器、`doctor`、`models list`、`providers list`、`config show` 缺省不列测试供应商
  `fake`（`AMA_SHOW_FAKE=1` 或 `AMA_FAKE_SCRIPT` 时照列，`--model fake/…` 照常可用）；没有可用模型时提示 key 环境变量、
  `ama auth set` 与 `ama providers add`。
- **缺省模型**：自定义供应商（中转站）不再取列表首条，而是在 models.dev 有价格、支持工具调用、上下文 ≥ 64k 的模型里
  取输入价最低的；`ama providers add` 在还没有 `defaultModel` 时按同一规则写入并说明原因。内置供应商仍取目录首条。

- **auto 权限模式**：`--permission-mode auto`（界面显示名 Auto）由 ama 判断每一步——规则层不调模型，危险命令、
  网络命令、删除类命令、机密文件与项目外写入一律询问；静态判定放行只读工具、项目内写入与安全名单里的命令
  （`ls`、`grep`、`git status/diff/log`、`npm test`、`tsc --noEmit`、`cargo test` 等，`permission.autoSafeCommands` 追加）；
  其余交给一次独立的模型分类器（`permission.autoModel`，不影响主会话缓存，用量记 `permission_classify`）。
  事件带 `autoDecision`，`/permissions` 显示最近判定。见 docs/permissions.md。
- **allowlist 模式**：只放行只读工具与 allow 规则命中的调用，其余直接拒绝、从不询问，适合 CI。
- **模式选择器**：`/permission` 打开 Mode 列表（显示名 + 说明、数字 1–6、当前打勾、Default / Recommended），
  `Shift+Tab` 循环 Manual → Accept edits → Plan → Auto → Bypass permissions，状态栏显示显示名。
  项目级配置不能设 `auto` / `full-auto`。
- **测试隔离**：组装测试不再把会话写进真实数据目录，测试结束检查真实 `~/.local/share/ama` / `~/.config/ama` 有无新增。

- **探测提速**：`ama providers add|refresh --probe` 与 `ama models discover --probe` 并发探测（`--concurrency`，缺省 6），
  流里出现首个内容事件即判可用并断开，单次超时缩到 15 s（`--probe-timeout`）；429 时降并发并重试一次，
  连续 429 才停止。实测 22 个模型、60 次探测从预计 20–30 分钟降到约 85 s。
  降并发之后连续 4 次没被限流就并发 +1，回到初始并发为止。

- **流空闲超时**：模型请求等响应头、以及流里两块数据之间缺省 300 s 没有任何字节即判卡住，按可重试错误重试；
  `request.idleTimeoutMs`（用户级）或 `AMA_IDLE_TIMEOUT_MS` 调整，0 关闭。服务端发一块就停住不再让 `-p` 永久挂起。
- **`-p` 与 stdin**：`git diff | ama -p "审阅"` 照旧把管道内容拼在提示后面；有提示参数时只等管道首字节 2 秒
  （`AMA_STDIN_WAIT_MS` 可调，0 = 不等），一个字节都没有就忽略 stdin 并在 stderr 提示，父进程留着不关的管道不再让
  `-p` 挂起；收到首字节后读到 EOF。末尾加 `-` 一直等到 EOF（上游要先跑很久才输出时用），`< 文件` 照常读取；没有提示
  参数时等 stdin 超过 3 s 提示一次；`--no-stdin` 完全不读。
- **`-p` 无人值守的拒绝可见**：被拒的工具调用在 stderr 汇总（工具、原因、放行办法），`json` 结果带 `deniedTools`，
  `tool_execution_end` 带 `denied: true`，退出码 7（新增）。重试期间 stderr 每次一行 `↻`。
- **新参数**：`-p --max-turns N`（到上限仍在调工具时退出 1，`json` 带 `maxTurnsReached`）、
  `--system-prompt <文本|@文件>` 与 `--system-prompt-mode append|replace`（缺省作为最后一条规则追加，缓存前缀不变）、
  `--no-session`（会话不落盘）。
- **报错准确**：`provider/model@渠道` 渠道不存在时报「渠道不存在」并列出该模型的可用渠道（中转供应商不再把 `@后缀`
  当成模型 id 发出去）；供应商写错报「供应商不存在」并给编辑距离最近的候选；模型写错列出最接近的几个。
- **代理**：设了 `HTTPS_PROXY` / `HTTP_PROXY` 时启动即启用 Node 内置的环境变量代理（`NO_PROXY` 生效），Node 22.21 以前
  提示一次并直连；`ama doctor` 新增「代理」一节。
- **行式管道模式**：模型错误只在运行结束时打印一次，有运行失败时退出码 1（以前 0）。
- **只读命令不写盘**：`config show` / `path`、`doctor`、`models list` 等不再创建配置目录，首次自动初始化只在进入对话的
  命令与 `providers add` 里触发。

- **会话统计**：`ama stats` 只读扫描会话，汇总请求（对话、保温、权限分类、压缩分开计）、回合与平均耗时、
  token、缓存命中率（只算报告缓存的端点）、费用（只加有价请求）、错误与重试、工具调用 Top N；
  `--since` / `--until` / `--by day|week|month|provider|channel|model|project` / `--json`；
  增量索引 `<数据目录>/stats-index.json`，1000 个会话冷扫描约 160 ms。
- **会话检索与导出**：`ama sessions search <关键词|/正则/>`（`--role`、`--since`、`--limit`，TTY 高亮）；
  `ama sessions export <id> --format md|json|jsonl [--branch leaf|all] [--output]`，导出前脱敏 key / token。
- **复用**：`ama sessions show` 列出用户消息编号；`--from <id>[#编号]` 用那条消息作新提示（`-p` 时连图片），
  可配合 `--model` 换模型重问。见 docs/sessions.md。
- **发布**：release job 优先用 npm 可信发布（OIDC，npm ≥ 11.5.1），`NPM_TOKEN` 只作回退；需要在 npmjs.com
  为 `@armadra/agent` 添加 Trusted Publisher（Owlbay / armadra-agent / ci.yml）。

## 0.3.0（2026-10-02）

自定义供应商与多渠道、models.dev 模型元数据、图像输入、默认配置目录。

- **一键接入**：`ama providers add <id> --base-url <url>` 只要 baseUrl 与 key——列出中转的模型、按提示或 `--probe` 逐渠道
  探测、写进配置；`list` / `channels` / `remove` / `refresh`。
- **渠道**：一个供应商可挂多个渠道（协议 + 地址 + 可选 key / headers / compat），模型声明 `channels`，
  `provider/model@channel` 指定渠道；旧配置按隐式 `default` 渠道处理，不用改。
- **models.dev 元数据**：上下文、输出上限、图像输入、推理、价格缺省从 models.dev 补（数据目录缓存，启动不联网），
  `ama models refresh-catalog` 刷新；`models list` / `config show` 标出每个字段的来源。
- **图像输入**：`-p --image`、界面里 `@图片路径`；与 read 工具共用 MIME 检测与 5 MB 上限；模型不收图片时拒绝。
- **配置目录**：首次运行自动建 `~/.config/ama/` 与最小 `config.json`、`config.schema.json`；`ama init`、
  `ama config path`、`ama config edit`。
- **修复**：Responses 的 `incomplete_details.reason: "length"` 按输出截断处理（中转转发 DeepSeek 时出现）。

## 0.2.1（2026-10-02）

npm 首发：`npm i -g @armadra/agent`。功能与 0.2.0 相同。

- **npm 发布**：包名 `@armadra/agent`；打 `v*` tag 时 CI 在生成 GitHub Release 之后执行 `npm publish --provenance`（仓库未配置 `NPM_TOKEN` 时跳过）。
- **包元数据**：仓库地址改为 `Owlbay/armadra-agent`，补 keywords、homepage、bugs、author、`sideEffects`；包里带用户文档（providers / tui / codemode / hooks / host-api / rpc / session-format）与 CHANGELOG，不再带源映射与测试辅助，解包体积约 2.9 MB。
- **README**：重写为完整介绍——定位、特性、安装、配置、中转站、工具预设、缓存、安全、各入口与 SDK、嵌入 Armadra。

## 0.2.0（2026-10-02）

首个可用版本。

- **模型接入**：协议与供应商数据分离，四条协议线（Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、Google Generative AI），13 家内置供应商与自定义供应商、模型级协议；只用 API Key；`ama models discover` 从中转站 `/v1/models` 探测协议并写入配置，`OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` 零配置接入。
- **调用**：内置工具与工具预设（`default` / `minimal` / `codemode` / `coordinator`），codemode（`node --permission` 子进程 + vm 沙箱，脚本内调用照样走权限管线），`task` 子 Agent，Skill（`/skill:`），不接 MCP。
- **安全**：权限管线（拒绝 → 危险命令 → 模式 → 允许）、危险命令识别穿透 `sh -c` / `eval` / `xargs` / `find -exec` 与 git 全局选项、项目级配置只能收紧、项目信任、审批时的执行前预览。
- **Hook**：命令式 Hook（9 个事件）与进程内宿主适配器 HostApi。
- **缓存**：前缀逐字节稳定、各协议缓存字段与兼容开关（400 自动剥离）、前缀指纹与未命中归因、不报缓存的三态与分块粒度推断、`off / streaming / idle` 保温、压缩摘要按会话前缀续写、状态栏 / `/session` / `/cache` / `ama models cache-probe`。
- **会话**：JSONL 条目树、分叉与 `/tree`、两档压缩与熔断。
- **入口**：差分渲染终端界面（主屏模式）、`--no-tui` 行式、`-p`（text / json / stream-json）、`--mode rpc`、SDK。
- **发布物**：`ama.cjs` 与 `ama-sandbox.cjs` 两个单文件 bundle、`package.tgz`、`SHA256SUMS`；暂不发布 npm。
