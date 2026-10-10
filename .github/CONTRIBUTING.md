# 贡献指南 / Contributing

硬约束、检查命令与评审规则见 [AGENTS.md](../AGENTS.md)，设计依据见 [docs/design/design.md](../docs/design/design.md)。

For the hard constraints, check commands and review rules, see [AGENTS.md](../AGENTS.md); the design rationale is in [docs/design/design.md](../docs/design/design.md).

## 需求流程 / Workflow

每个需求都按同一条路径推进，结论留在 Issue 里，而不只在聊天或提交信息里。

Every requirement follows the same path, and its conclusions live in the Issue rather than only in chat or commit messages.

1. **建 Issue / Open an Issue**：简单梳理后用对应表单建 Issue，写清背景、目标与范围，标签 `needs-triage`。 / Sort the requirement out briefly and open an Issue with the matching form: background, goals and scope, labelled `needs-triage`.
2. **完善 Issue 与设计 / Refine the Issue and design**：调研结论与设计方案回填到同一个 Issue（方案、批次、验收标准）；方案较大时写成仓库里的设计文档，Issue 里放链接。方案未定时标 `needs-design`，定下后改为 `ready`。 / Put research findings and the design (approach, batches, acceptance criteria) back into the same Issue; larger designs become a design document in the repository, linked from the Issue. Label `needs-design` while the approach is open and `ready` once it is settled.
3. **开 PR 实现 / Implement in PRs**：按批次开 PR，正文按模板填写并关联 Issue——中间批次写 `Refs #N`，最后一个写 `Closes #N`；Issue 里的批次清单随 PR 勾选。 / Open one PR per batch, fill in the template and link the Issue — `Refs #N` for intermediate batches, `Closes #N` for the last one; tick the Issue's batch checklist as PRs land.
4. **合并与收尾 / Merge and close**：CI 全部通过后用 merge commit 合并；全部批次合入后关闭 Issue，并在 Issue 里写一段结果（做了什么、实测数据、遗留项，遗留项另开 Issue）。 / Merge with a merge commit once CI is green; when every batch has landed, close the Issue with a short result (what was done, measurements, leftovers — leftovers get their own Issues).

小修小补（拼写、单行修复）可以直接开 PR，但仍在 PR 里说明来源。 / Trivial fixes (typos, one-line fixes) may go straight to a PR, still stating where they came from.

## 提交 issue / Opening issues

- 先搜索已有 issue，一个 issue 只写一个问题。 / Search existing issues first; one problem per issue.
- 使用对应的表单：缺陷报告、功能建议、供应商 / 模型兼容问题、文档问题。 / Use the matching form: bug report, feature request, provider / model compatibility, or documentation.
- 写清 `ama --version`、平台、运行方式（交互界面、`-p`、`--mode rpc`、`--mode acp`、SDK、宿主注入）与模型（`provider/model-id`）。 / Include `ama --version`, the platform, how you run it (interactive, `-p`, `--mode rpc`, `--mode acp`, SDK, host injection) and the model (`provider/model-id`).
- **不要贴 API key、登录 token 与会话文件全文**，日志只摘相关行并打码。 / **Never paste API keys, login tokens or whole session files**; quote only relevant log lines, redacted.
- 安全问题按 [SECURITY.md](SECURITY.md) 私下报告。 / Report security problems privately as described in [SECURITY.md](SECURITY.md).

## 提交信息 / Commit messages

格式为 `类型(范围): 描述`，描述用中文，说清行为变化而不只是改了哪个文件：

The format is `type(scope): description`. Descriptions are written in Chinese and state the behavior change, not just which file was touched:

```text
feat(acp): 开会话、回放与换模型之后立即发 usage_update
fix(compaction): 摘要续写出错时回落独立请求
docs(providers): 渠道节补中转实测
```

- 类型 / Types：`feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`build`、`chore`、`ci`、`release`、`revert`。
- 范围 / Scopes：模块或目录名，例如 `ai`、`agent`、`tools`、`codemode`、`permissions`、`config`、`tui`、`interactive`、`acp`、`rpc`、`host`、`agents`、`session`、`i18n`、`providers`；跨两处用逗号，例如 `test(acp,rpc)`。 / A module or directory name; join two with a comma.
- 一个模块连同它的测试一个提交；不要在提交信息里加生成说明或自动署名。 / One commit per module together with its tests; no generated notes or automatic trailers.

## 提交 PR / Opening pull requests

- 从 `main` 拉出按用途命名的分支，例如 `fix/acp-usage`、`docs/github-community-files`。 / Branch from `main` with a purpose-based name.
- PR 标题沿用提交信息格式；正文按模板填写，不适用的小节写「无 / None」。 / The PR title follows the commit format; fill in the template and write "无 / None" for sections that do not apply.
- 用 `Closes #N` 关联 issue。 / Link issues with `Closes #N`.
- 合并前 `pnpm run ci` 与 CI（macOS / Linux / Windows × Node 22 / 24）全部通过；合并使用 merge commit，保留逐个提交。 / `pnpm run ci` and CI (macOS / Linux / Windows × Node 22 / 24) must pass before merging; merges use a merge commit and keep individual commits.
- 不新增运行时依赖；`devDependencies` 新增要在 PR 里说明理由。 / No new runtime dependencies; explain any new `devDependencies` in the PR.
- 用户可见的变化写进 [CHANGELOG.md](../CHANGELOG.md) 与 [CHANGELOG.zh-CN.md](../CHANGELOG.zh-CN.md) 的未发布段，两份都加。 / User-visible changes go into the Unreleased section of both changelogs.
- 改了协议形状要同步 `docs/reference/rpc.md`、`docs/reference/host-api.md`、`docs/reference/acp.md` 或 `docs/reference/session-format.md` 及 `docs/en/` 的英文版。 / Protocol shape changes must update the matching docs and their English versions in `docs/en/`.
- 发布由维护者执行：改版本号、定稿两份更新记录、推送 `v<版本>` tag，CI 创建 Release 并通过 npm 可信发布（OIDC）推送；不要在本地 `npm publish`。 / Releases are done by maintainers: bump the version, finalize both changelogs and push a `v<version>` tag; CI creates the Release and publishes to npm through trusted publishing (OIDC). Never run `npm publish` locally.
