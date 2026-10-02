# 更新记录

## 未发布

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
