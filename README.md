# ama

可独立使用、也可嵌入 [Armadra](https://github.com/yovinchen/Armadra) 画布的编码 / 协调 Agent。

- 独立使用：在任意目录运行 `ama`，行式 REPL、`ama -p` 一次性运行、`ama --mode rpc` 与 SDK。
- 嵌入 Armadra：作为画布上的协调者，驱动 Claude Code、Codex、OpenCode、Pi、Oh My Pi、GitHub Copilot 等 CLI Agent 分工、汇报与汇总。
- 第一版只支持 API Key；只做 Skill 与内置工具，不接 MCP。

状态：设计阶段，尚未实施。设计见 [docs/design.md](docs/design.md)。

许可证：[MIT](LICENSE)。
