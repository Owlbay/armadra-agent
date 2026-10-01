# ama

可独立使用、也可嵌入 [Armadra](https://github.com/yovinchen/Armadra) 画布的编码 / 协调 Agent。

- 独立使用：在任意目录运行 `ama`，行式 REPL、`ama -p` 一次性运行、`ama --mode rpc` 与 SDK。
- 嵌入 Armadra：作为画布上的协调者，驱动 Claude Code、Codex、OpenCode、Pi、Oh My Pi、GitHub Copilot 等 CLI Agent 分工、汇报与汇总。
- 第一版只支持 API Key；只做 Skill 与内置工具，不接 MCP。

状态：设计阶段，尚未实施。设计见 [docs/design.md](docs/design.md)。

许可证：[MIT](LICENSE)。

## 开发

需要 Node ≥ 22 与 pnpm（版本见 `package.json` 的 `packageManager`，`corepack enable` 即可）。

```sh
pnpm install
pnpm run ci        # typecheck、fmt:check、check:deps、test、build，再跑 dist/bundle/ama.cjs --version
```

注意 pnpm 10 起 `pnpm ci` 是内置的「清理后安装」，跑检查要写 `pnpm run ci`。常用单项：`pnpm test`、`pnpm typecheck`、`pnpm fmt`、`pnpm build`（产出 `dist/` 与单文件 `dist/bundle/ama.cjs`）。

目录：`src/` 按层分目录（`ai` 模型接入、`agent` 循环、`session` 会话树、`tools` 工具、`permissions`、`hooks`、`host` 宿主契约、`tui` 组件库、`modes` 各入口模式、`cli` 启动），各目录的 `types.ts` 是批次之间的契约；`scripts/` 是构建与守卫脚本，`test/` 放端到端、fixture 与测试辅助，`docs/design.md` 是设计与文件所有权。运行时依赖必须为零，只允许 `node:` 内置模块。
