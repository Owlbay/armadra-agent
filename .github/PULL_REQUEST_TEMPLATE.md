<!--
标题沿用提交信息格式：`类型(范围): 中文描述`，例如 `fix(acp): 窗口未知时不发 usage_update`。
Title follows the commit format: `type(scope): description`, for example `fix(acp): …`.
规范见 .github/CONTRIBUTING.md。不需要的小节写「无 / None」，不要删掉。
See .github/CONTRIBUTING.md. Write "无 / None" for sections that do not apply instead of deleting them.
-->

## 变更摘要 / Summary

<!-- 做了什么、为什么。 / What changed and why. -->

## 关联 issue / Related issues

<!-- Closes #123 / Refs #456 -->

## 改动范围 / Scope

- [ ] 模型接入 / model access（`src/ai/`、`src/auth/`）
- [ ] 循环与压缩 / loop and compaction（`src/agent/`、`src/compaction/`）
- [ ] 工具、codemode 与沙箱 / tools, codemode and sandbox（`src/tools/`、`src/codemode/`、`src/sandbox/`）
- [ ] 权限、配置与 Hook / permissions, config and hooks（`src/permissions/`、`src/config/`、`src/hooks/`）
- [ ] 终端界面 / terminal UI（`src/tui/`、`src/modes/interactive/`）
- [ ] 协议面 / protocol surfaces（RPC、ACP、`src/host/`、SDK）
- [ ] 子 Agent 与外部 Agent / sub-agents and external agents（`src/agents/`、`src/drivers/`）
- [ ] 会话 / sessions（`src/session/`、`src/checkpoints/`）
- [ ] docs / CHANGELOG
- [ ] scripts / CI

## 协议变化 / Protocol changes

<!--
RPC（docs/rpc.md）、宿主适配器（docs/host-api.md）、ACP（docs/acp.md）、会话文件格式（docs/session-format.md）的线上形状是否变了；
`HOST_API_VERSION`、`RPC_PROTOCOL_VERSION`、`SESSION_FORMAT_VERSION` 变化要求破坏性版本升级（`pnpm release:check` 守住）。
Whether the wire shape of RPC, the host adapter, ACP or the session file format changed;
bumping `HOST_API_VERSION`, `RPC_PROTOCOL_VERSION` or `SESSION_FORMAT_VERSION` requires a breaking version bump (enforced by `pnpm release:check`).
-->

- 涉及的协议与文档 / Protocols and docs:
- 协议常量 / Protocol constants:

## 提示前缀 / Prompt prefix

<!--
系统提示、工具描述或 schema 是否变了；`src/cli/prompt-budget.test.ts` 三档的前后数字。放宽上限要写理由。
Whether the system prompt, tool descriptions or schemas changed; before / after numbers of the three tiers in `src/cli/prompt-budget.test.ts`. Explain any raised limit.
-->

- [ ] 不涉及 / Not applicable
- [ ] 前缀逐字节稳定，预算未突破 / Prefix is byte-stable and within budget:

## 界面文案 / UI copy

- [ ] 不涉及 / Not applicable
- [ ] 文案都在 `src/i18n/messages/`，中英同步，`pnpm check:i18n` 通过 / All copy is in `src/i18n/messages/`, Chinese and English in sync, `pnpm check:i18n` passes
- [ ] 发给模型的文本固定英文 / Text sent to the model stays in English

## 测试 / Testing

<!-- 跑了哪些命令、加了哪些用例；界面改动附帧黄金或截图。 / Commands run and tests added; attach frame goldens or screenshots for UI changes. -->

- [ ] 单元测试 / Unit tests:
- [ ] 端到端 / E2E（`AMA_E2E=1 pnpm test:e2e`）:
- [ ] 帧黄金或截图 / Frame goldens or screenshots:
- [ ] `pnpm run ci`

## 检查清单 / Checklist

<!-- 见 AGENTS.md 与 docs/design.md。 / See AGENTS.md and docs/design.md. -->

- [ ] `dependencies` 仍为空，`src/` 只 import `node:*` 与相对路径（`pnpm check:deps`） / `dependencies` stays empty and `src/` imports only `node:*` and relative paths
- [ ] 源码单文件 ≤ 600 行，测试文件 ≤ 1000 行 / Source files ≤ 600 lines, test files ≤ 1000 lines
- [ ] API key 与登录 token 不进日志、会话、事件与 RPC / ACP 响应 / API keys and login tokens stay out of logs, sessions, events and RPC / ACP responses
- [ ] 权限请求不代答；项目级配置只能收紧，项目级 Hook 与 Skill 需要信任 / Permission requests are never answered on the user's behalf; project config can only tighten, project hooks and skills require trust
- [ ] 不读写用户其它 CLI 的配置与登录 / Does not read or write other CLIs' configuration or logins
- [ ] ACP 线上形状过 schema 校验（`test/helpers/acp-schema.ts`）；协议模式下 stdout 只有协议行 / ACP wire shapes pass schema validation; in protocol modes stdout carries protocol lines only
- [ ] 测试只用 `fake` 供应商与录制样本，不需要真 key / Tests use the `fake` provider and recorded samples only, no real keys
- [ ] 用户可见的变化已写进两份 CHANGELOG 的未发布段；改了中文文档时同步 `docs/en/` / User-visible changes are in the Unreleased section of both CHANGELOGs; `docs/en/` updated with the Chinese docs

## 需要用户提供的外部条件 / External prerequisites

<!-- 真实供应商的 key、订阅登录、已登录的外部 CLI、各平台真机沙箱等 CI 无法验证的部分，以及用 fake 供应商与录制回放验证到了哪一步。 / Real provider keys, subscription logins, logged-in external CLIs, sandboxes on real machines, etc. that CI cannot verify, and how far the fake provider and recordings cover them. -->

## 已知限制 / Known limitations
