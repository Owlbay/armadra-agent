# 调研报告

- 第五波（2026-10-02）：本目录下 R1–R5，设计见 `docs/wave5-plan.md`。
- 第六波（2026-10-03）：[wave6/](wave6/README.md) 下 R6–R10，设计见 `docs/wave6-plan.md`。
- ACP 补全（2026-10-04）：[acp-gap-2026-10.md](acp-gap-2026-10.md)，对照 ACP v1 schema 1.24.1 的差距审计与实测；设计见 `docs/acp-plan.md`。

## 第五波

`docs/wave5-plan.md` 的设计依据，只用于追溯；现状以代码与 `docs/` 其余文档为准。报告里的代码行号对应写作时的 `main`，`/tmp/...` 路径是调研时的本地材料，不在仓库中。引用第三方产品只记录行为，原文引用每段不超过 15 词。作为设计参照的同类工具不具名，以「工具 A」「工具 B」…代号指代（各报告代号一致）；ama 实际驱动或兼容的外部 Agent、供应商与协议照常写名字。

| 报告                                                 | 主题                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| [R1-models-protocols.md](R1-models-protocols.md)     | 模型元数据入库、各厂商协议与缓存、图像输入 |
| [R2-agent-control.md](R2-agent-control.md)           | 原生操控其他 CLI Agent、ACP                |
| [R3-plan.md](R3-plan.md)                             | Plan 模式                                  |
| [R4-subagent.md](R4-subagent.md)                     | 子 Agent                                   |
| [R5-harness-compaction.md](R5-harness-compaction.md) | Agent 循环与自动压缩选型                   |
