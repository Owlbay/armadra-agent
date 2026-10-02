# Codex app-server 录制样本

手写构造，未用真实订阅发起计费请求。方法与字段按本机 `codex app-server generate-ts` /
`generate-json-schema`（codex-cli 0.160.0，`[experimental]`）核对，形状由 `../codex-schema/shapes.json`
锁住；线上不写 `"jsonrpc"` 字段。格式同 `../claude/README.md`（`in` 子集匹配、`$名字` 绑定请求 id）。
