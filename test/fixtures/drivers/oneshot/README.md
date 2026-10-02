# 一次性打印模式录制样本

手写构造（未发起计费请求），只有对端输出（`out`）：驱动把提示写进 stdin 并关闭，测试桩读完 stdin
后依次写出这些行再退出。字段依据：Claude `-p --output-format json` 的 result 对象（2.1.x），
`codex exec --json` 的 JSONL 事件（0.160.0，`codex exec --help` 与 R2 §1.1），
`gemini -p --output-format stream-json`（官方 headless 文档；本机未安装，未实测）。
