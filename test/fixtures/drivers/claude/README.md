# Claude Code stream-json 录制样本

手写构造，未用真实订阅发起计费请求。字段依据 Claude Code 2.1.x 的 headless / Agent SDK 文档
（`--input-format stream-json --output-format stream-json --verbose --include-partial-messages`，
`control_request{can_use_tool|interrupt|initialize}`、`control_cancel_request`、`result.total_cost_usd`、
`permission_denials`）与 `docs/research/R2-agent-control.md` §1.2；标注版本 2.1.287（本机 `claude --help`）。

每行 `{"dir":"in"|"out","msg":…}`：`in` 是驱动应写给 Claude 的消息（子集匹配；顶层值为 `"$名字"`
时绑定为驱动实际的值，之后 `out` 里同名占位符替换成它），`out` 是 Claude 的输出。`//` 开头的行是注释。

真实 CLI 的两轮往返与一次审批在 `AMA_E2E_AGENTS=1` 下由用户本地跑（`src/drivers/agents.e2e.test.ts`）。
