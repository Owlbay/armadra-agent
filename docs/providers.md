# 供应商与模型

B1 草稿（B9 统稿）。设计依据见 [design.md](design.md) §3。

## 内置供应商

| id           | 协议                                            | baseUrl                                             | API Key 环境变量（顺序）                                     |
| ------------ | ----------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `anthropic`  | anthropic-messages                              | `https://api.anthropic.com`                         | `ANTHROPIC_API_KEY`、`AMA_API_KEY_ANTHROPIC`                 |
| `openai`     | openai-completions（推理模型 openai-responses） | `https://api.openai.com/v1`                         | `OPENAI_API_KEY`、`AMA_API_KEY_OPENAI`                       |
| `google`     | google-generative-ai                            | `https://generativelanguage.googleapis.com/v1beta`  | `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`AMA_API_KEY_GOOGLE`     |
| `deepseek`   | openai-completions                              | `https://api.deepseek.com`                          | `DEEPSEEK_API_KEY`、`AMA_API_KEY_DEEPSEEK`                   |
| `moonshot`   | openai-completions                              | `https://api.moonshot.cn/v1`                        | `MOONSHOT_API_KEY`、`KIMI_API_KEY`、`AMA_API_KEY_MOONSHOT`   |
| `zhipu`      | openai-completions                              | `https://open.bigmodel.cn/api/paas/v4`              | `ZHIPU_API_KEY`、`ZAI_API_KEY`、`AMA_API_KEY_ZHIPU`          |
| `dashscope`  | openai-completions                              | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY`、`QWEN_API_KEY`、`AMA_API_KEY_DASHSCOPE` |
| `openrouter` | openai-completions                              | `https://openrouter.ai/api/v1`                      | `OPENROUTER_API_KEY`、`AMA_API_KEY_OPENROUTER`               |
| `groq`       | openai-completions                              | `https://api.groq.com/openai/v1`                    | `GROQ_API_KEY`、`AMA_API_KEY_GROQ`                           |
| `xai`        | openai-completions（目录模型 openai-responses） | `https://api.x.ai/v1`                               | `XAI_API_KEY`、`AMA_API_KEY_XAI`                             |
| `mistral`    | openai-completions                              | `https://api.mistral.ai/v1`                         | `MISTRAL_API_KEY`、`AMA_API_KEY_MISTRAL`                     |
| `ollama`     | openai-completions                              | `http://127.0.0.1:11434/v1`                         | 可无（`OLLAMA_API_KEY`）                                     |
| `lmstudio`   | openai-completions                              | `http://127.0.0.1:1234/v1`                          | 可无                                                         |

另有测试用供应商 `fake`（模型 `fake/echo`、`fake/reasoning`），见下文。

协议列是供应商级缺省；目录条目可以用 `api` 覆盖（openai 的推理模型与 xai 的目录模型走
`openai-responses`，非推理的 `gpt-4.1`、`gpt-4o*` 仍走 Completions）。

## 模型引用

`provider/model-id`，例如 `deepseek/deepseek-v4-pro`、`openrouter/anthropic/claude-sonnet-5.5`。
不带供应商前缀时在全部目录里唯一匹配；多家同名时只看已配置 key 的供应商，仍不唯一则报错并列出
候选。模型表为空的供应商（ollama、lmstudio、没写 `models` 的自定义供应商）接受任意 model id。

## API Key 发现顺序

1. `--api-key`（只对 `--model` 指定的供应商）
2. `--auth-file` / profile 的 `authFile`
3. `~/.config/ama/auth.json`（权限不是 0600 时警告但照用）
4. `config.json` 的 `providers.<id>.apiKey`：支持 `$ENV`、`${ENV}`、`!command`，`$$` 表示字面 `$`
5. 环境变量（上表顺序；profile `authEnv: false` 时跳过）
6. 本地服务（`requiresApiKey: false`）无 key 也能用

`auth.json` 的 `apiKey` 以 `!` 开头表示执行命令取值（10 秒超时；空输出或非零退出视为未配置）。

## 自定义供应商

```json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "https://proxy.example/v1",
      "apiKey": "$MY_PROXY_KEY",
      "models": [{ "id": "gpt-x", "contextWindow": 128000, "maxTokens": 16384, "reasoning": true }],
      "compat": { "maxTokensField": "max_tokens" }
    },
    "deepseek": { "modelOverrides": [{ "id": "deepseek-flash", "contextWindow": 131072 }] }
  }
}
```

- `api` 缺省 `openai-completions`；自定义模型缺省 `maxTokens: 8192`、`reasoning: false`、
  `input: ["text"]`；不猜 `contextWindow`（缺省关自动压缩）。
- `models[]` 同 id 整条替换、新 id 追加；`modelOverrides[]` 只改已有模型的元数据。

## OpenAI 兼容线的 compat

推断顺序：保守缺省 ← 推断表（provider id，其次 baseUrl 子串）← `provider.compat` ← `model.compat`。

| 开关                                          | 作用                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `maxTokensField`                              | `max_tokens` 或 `max_completion_tokens`                                                                                  |
| `supportsDeveloperRole`                       | 推理模型的系统提示用 `developer` 角色                                                                                    |
| `supportsUsageInStreaming`                    | 发 `stream_options.include_usage`                                                                                        |
| `supportsFinishReason`                        | false 时忽略 finish_reason，按内容推断停止原因                                                                           |
| `supportsReasoningEffort`                     | 发 `reasoning_effort`                                                                                                    |
| `thinkingFormat`                              | `openai` / `openrouter`（`reasoning.effort`）/ `deepseek`、`zai`（`thinking.type`）/ `qwen`（`enable_thinking`）/ `none` |
| `thinkingTokenBudgetField`                    | 预算字段名（DashScope：`thinking_budget`）                                                                               |
| `requiresReasoningContentOnAssistantMessages` | 推理模型的历史助手消息带 `reasoning_content`（DeepSeek）                                                                 |
| `requiresToolResultName`                      | 工具结果消息带 `name`（Mistral）                                                                                         |
| `requiresAssistantAfterToolResult`            | 工具结果后紧跟用户消息时插入一条助手消息                                                                                 |
| `supportsMidConvoSystemMessages`              | 后续系统提示补丁按位置作为 system 消息插回                                                                               |
| `cacheControlFormat`                          | `anthropic`：在 system、最后一个工具、最后一条 user/tool 消息上打 `cache_control`                                        |
| `supportsStrictTools`                         | 对严格兼容的工具 schema 发 `strict: true`                                                                                |
| `supportsStore`                               | 发 `store: false`                                                                                                        |

compat 只记录**已验证**的差异；新增条目请附文档链接或真实样本。

## Responses 与 Gemini 的 compat

| 协议                   | 开关                            | 作用                                                                                                      | 缺省                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `openai-responses`     | `supportsReasoningSummary`      | `reasoning.summary: "auto"`（思考块有文字）                                                               | OpenAI 官方开；xAI 与其它关                  |
| `openai-responses`     | `supportsStore`                 | 发 `store: false`；推理模型同时要 `include: ["reasoning.encrypted_content"]`，多轮回放加密 reasoning item | OpenAI 官方、xAI 开；其它关                  |
| `google-generative-ai` | `supportsThoughtSignature`      | 同模型回放 `thoughtSignature`（思考、文本、functionCall part）                                            | 开                                           |
| `google-generative-ai` | `supportsFunctionResponseParts` | 工具结果图片放进 `functionResponse.parts`；关时另起一个 user 回合                                         | Gemini 3 起开；Gemini 2.x 与非 Gemini 命名关 |

- Responses：系统提示放 `instructions`；`prompt_cache_key = sessionId` 只发给 OpenAI 官方端点，
  `cacheRetention: "none"`（摘要请求）不发；思考 off 只在映射表给了 off 的字串（如 `"none"`）时发
  `reasoning.effort`，否则交给服务端缺省。
- Gemini：映射值是字串（或 Gemini 3 族且未映射）→ 离散 `thinkingLevel`（`LOW` / `HIGH`…）；映射值是
  数字或其它模型 → `thinkingBudget`（`-1` 动态）；off → `thinkingBudget: 0`。隐式缓存自动生效，
  `cachedContentTokenCount` 计入 `cacheRead`。

## 测试用 fake 供应商

`--provider fake --model fake/echo`：回显最后一条用户消息。设 `AMA_FAKE_SCRIPT=<file.json>` 后
按脚本第 n 次调用产出文本、思考、工具调用、429、溢出、断流、延迟，脚本格式见
`src/ai/fake/fake-script.ts`，示例在 `test/fixtures/scripts/`。
