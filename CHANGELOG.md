# 更新记录

## 未发布

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
  参数时等 stdin 超过 3 s 提示一次。
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
