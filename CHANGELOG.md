# 更新记录

## 未发布

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
