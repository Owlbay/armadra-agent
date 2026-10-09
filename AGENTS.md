# ama 开发约定

## 代码边界

- **零运行时依赖**：`package.json` 的 `dependencies` 等字段必须为空；`src/` 非测试源码只 import `node:*` 与相对路径，不 import 任何宿主包（`pnpm check:deps` 守住）。HTTP 用全局 `fetch`，SSE、YAML frontmatter、JSON Schema 子集都自写。
- 单文件源码 ≤ 600 行、测试文件 `*.test.ts` ≤ 1000 行，超出即拆；禁止默认导出（`--host` 模块除外）。
- **提示前缀字节稳定**：系统提示节顺序固定、不含时间与随机数，工具按名排序，schema 键序固定；会话开始后的变化只追加在末尾。`src/cli/prompt-budget.test.ts` 的三档预算（`default` / `minimal` / `codemode-only`）不得突破，确需放宽要改上限并在 PR 写明理由。
- **i18n 严格**：界面文案只放 `src/i18n/messages/<领域>.ts`，`en` 为形状源、`zh` 同步；`src/**` 代码与字符串里不得出现汉字（`pnpm check:i18n`）。发给模型的一切固定英文，两种界面语言下请求逐字节相同；模型侧模块（工具、系统提示、压缩、codemode 等）不得 import `src/i18n`。
- **权限**：管线顺序固定（拒绝 → 危险命令 → 模式 → 允许），无人值守时 `ask → deny`；项目级配置只能收紧，项目级 Hook 与 Skill 需要信任。权限请求与外部 Agent 的提问一律交给人，不代答。
- **凭据**：API key 只存在于 `resolveApiKey()` 的返回值里，不进日志、会话、事件与 RPC / ACP 响应（RPC 只回 `hasKey` 与 `keySource`）。不读、不写、不导入用户其它 CLI 的配置与登录；会改外部 CLI 持久配置的选项不提供。
- **协议面**：`--mode rpc`、`--mode acp` 下 stdout 只放协议行，诊断走 stderr。ACP 线上形状必须过官方 schema 校验（`test/helpers/acp-schema.ts`）；`HOST_API_VERSION`、`RPC_PROTOCOL_VERSION`、`SESSION_FORMAT_VERSION` 变化要求破坏性版本升级（`pnpm release:check`）。
- 扩展只做 Skill，不做 MCP。测试不依赖真 key：用脚本化的 `fake` 供应商与录制的 SSE 样本。
- 不出现任何第三方参考项目的名字。

## 按需阅读与验证

- 设计与硬约束见 [docs/design.md](docs/design.md)（§1 依赖方向、§2 工程约定、§9.1 缓存保证）；用户与集成文档的索引在 [README](README.md#documentation)。
- 双语：`README.md` / `README.zh-CN.md`、`CHANGELOG.md` / `CHANGELOG.zh-CN.md` 成对维护，新条目两份都加到未发布段；`docs/en/` 七篇是中文版的英文译本，改中文版时同步。文案约定见 [docs/i18n.md](docs/i18n.md)。
- 协议形状改动同步 [docs/rpc.md](docs/rpc.md)、[docs/host-api.md](docs/host-api.md)、[docs/acp.md](docs/acp.md) 或 [docs/session-format.md](docs/session-format.md)。
- 验证：`pnpm run ci`（类型检查、prettier、依赖与 i18n 检查、发版检查、测试、构建与 bundle 冒烟）；bundle 级端到端 `AMA_E2E=1 pnpm test:e2e`。pnpm 10 起 `pnpm ci` 是内置命令，必须写 `pnpm run ci`。
- CI 在 macOS / Linux / Windows × Node 22 / 24 上跑；路径、换行与 shell 差异要考虑 Windows。
- 发布由维护者推 `v<版本>` tag 触发：CI 创建 GitHub Release 并经 npm 可信发布（OIDC）推送 `@armadra/agent`；本地不手动 `npm publish`。

## Review guidelines

- 审查意见用简体中文，先给结论，每条写明文件与行号、会出什么错、怎么修。
- 只报会造成错误行为、数据损坏、安全问题或违反下列约定的问题；不报纯风格与命名偏好。
- API key、登录 token 进入日志、会话文件、事件或 RPC / ACP 响应，视为 P0。
- 绕过权限管线（包括经 codemode、子 Agent、外部 Agent）、替人回答权限请求、项目级配置放宽权限或未信任时执行项目级 Hook，视为 P0。
- 新增运行时依赖，或 `src/` 出现 `node:*` 与相对路径以外的 import，视为 P1。
- 系统提示或工具表跨回合不再逐字节稳定、`prompt-budget` 预算被突破而 PR 没写理由，视为 P1。
- 读写用户其它 CLI 的配置或登录，视为 P1。
- 协议形状改了而对应文档没同步、协议常量变了而版本不是破坏性升级、ACP 线上形状过不了 schema 校验、协议模式下往 stdout 写非协议内容，视为 P1。
- 界面文案没有进 `src/i18n/messages/`、中英不同步、发给模型的文本随界面语言变化，视为 P2。
- 源码单文件超过 600 行或测试文件超过 1000 行、用户可见变化没有写进两份 CHANGELOG，视为 P2。
- 新增行为没有对应测试时指出缺口；测试只改断言或重录黄金去迁就实现时要说明理由是否成立。
