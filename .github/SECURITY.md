# 安全策略 / Security Policy

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue、讨论或 PR 里描述安全问题。请通过 GitHub Security Advisories 私下报告：

Please **do not** describe security problems in public issues, discussions or pull requests. Report them privately through GitHub Security Advisories:

**<https://github.com/AMA-Link/armadra-agent/security/advisories/new>**

报告里请写明 / Please include:

- 受影响的版本（`ama --version`）、平台与运行方式（交互界面、`-p`、RPC、ACP、SDK、宿主注入） / Affected version (`ama --version`), platform and how ama runs (interactive, `-p`, RPC, ACP, SDK, host injection)
- 问题类型与影响，例如绕过权限审批、沙箱逃逸、凭据泄露、未信任项目的 Hook 被执行 / Type and impact, for example bypassing permission approval, sandbox escape, credential leaks, hooks of an untrusted project being executed
- 复现步骤或概念验证 / Steps to reproduce or a proof of concept
- 你建议的修复（可选） / A suggested fix (optional)

报告里不要附真实凭据；需要演示时请使用 `fake` 供应商或测试密钥。

Do not include real credentials; use the `fake` provider or test keys when demonstrating.

## 处理流程 / Process

1. 我们会在 7 天内确认收到。 / We acknowledge the report within 7 days.
2. 确认问题后在私有 advisory 里协同修复，并告知预计的发布时间。 / Once confirmed, we work on a fix in the private advisory and share the expected release timeline.
3. 修复发布后公开 advisory；你愿意的话会在其中致谢。 / The advisory is published after the fix ships, crediting you if you wish.

## 支持的版本 / Supported versions

只有 npm 上 `@armadra/agent` 的最新发布版会收到安全修复。 / Only the latest release of `@armadra/agent` on npm receives security fixes.

## 范围 / Scope

范围内：本仓库的 `ama` 命令与 `@armadra/agent` 包，包括权限管线与信任、codemode 与 OS 沙箱、API key 与登录 token 的存放、命令式 Hook、RPC / ACP / 宿主适配器接口，以及发布产物（`ama.cjs`、`ama-sandbox.cjs`、npm 包）。

In scope: the `ama` command and the `@armadra/agent` package in this repository, including the permission pipeline and trust, codemode and the OS sandbox, storage of API keys and login tokens, command hooks, the RPC / ACP / host adapter interfaces, and the release artifacts (`ama.cjs`, `ama-sandbox.cjs`, the npm package).

范围外：模型供应商、中转站与 ama 驱动的外部 Agent CLI 自身的问题，请向对应方报告；Armadra 应用本身的问题请报告到 [AMA-Link/Armadra](https://github.com/AMA-Link/Armadra/security/advisories/new)。

Out of scope: problems in model providers, relays or the external Agent CLIs that ama drives; please report those to the respective parties. Problems in the Armadra app itself belong to [AMA-Link/Armadra](https://github.com/AMA-Link/Armadra/security/advisories/new).
