# 更新记录

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
