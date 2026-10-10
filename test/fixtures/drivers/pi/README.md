# pi `--mode rpc` 录制样本

- `turn-basic.jsonl`、`approval-write.jsonl`：pi 1.1.0 + `openai-codex/gpt-6-luna` 实录（2026-10-10，#198），
  去掉了 system 消息、`agent_end` 的全量回放、`textSignature` / `responseId` 与会话文件路径；
  审批经 ama 以 `-e` 加载的审批闸扩展（`src/drivers/native/pi-gate.ts`）走 `extension_ui_request{confirm}`。
- `interrupt.jsonl`、`foreign-dialog.jsonl`：手写，按 pi 自带的 `docs/rpc-commands.md`、`docs/rpc-extension-ui.md`
  与实录的事件形状构造。

格式同 `../claude/README.md`：`in` 是驱动应写给 pi 的命令（子集匹配，`"$名字"` 绑定为驱动实际的请求 id），
`out` 是 pi 的输出；`//` 开头的行是注释。
