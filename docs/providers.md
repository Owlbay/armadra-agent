# 供应商与模型

内置供应商、模型引用、API Key、自定义供应商与中转站、各协议的 compat 开关，以及缓存。设计依据见 [design.md](design.md) §3、§9.1。

## 配置目录

缺省 `~/.config/ama/`（Windows `%APPDATA%\ama\`；`AMA_CONFIG_DIR` 优先，其次 `XDG_CONFIG_HOME/ama`）。数据
（会话、models.dev 刷新覆盖）在另一个目录：`~/.local/share/ama/`（`AMA_DATA_DIR` / `XDG_DATA_HOME`）。

```
~/.config/ama/                 0700
├── config.json                用户级配置：供应商、渠道、模型、权限、工具、缓存……（直接编辑）
├── config.schema.json         config.json 的 JSON Schema（编辑器补全与校验；由 ama 生成，会被重写）
├── auth.json                  API key（0600；只在 ama auth set / ama providers add 时创建）
├── config.json.bak            ama 改写 config.json 前的备份
├── hooks.json / trust.json / keybindings.json   （按需）
└── skills/ prompts/           （按需）
~/.local/share/ama/
├── sessions/                  会话
└── models-dev.json            models.dev 刷新覆盖（只有 ama models refresh 写）
```

- `ama init`：建目录（0700）并补齐缺失的 `config.json` 与 `config.schema.json`，逐个打印「已创建」或
  「已存在，未改动」；已存在的 `config.json` 一律不覆盖（`--force` 也不），`config.schema.json` 不是用户文件，
  每次 `init` 都重写为当前版本（说明跟随当前界面语言，切换语言后再 `init` 即重写）；不创建空的 `auth.json`。
- **首次运行自动初始化**：进入对话的命令（交互、`-p`、`--mode rpc`）与 `ama providers add` 启动时若配置目录不存在，
  静默建目录并写最小 `config.json` 与 schema（`AMA_NO_INIT=1` 关闭；SDK 与测试不触发）。只读子命令（`config show` /
  `path`、`doctor`、`models list`、`providers list`、`auth list`、`sessions` 等）不创建也不改写配置目录。
- 最小 `config.json`：

  ```json
  {
    "$schema": "./config.schema.json",
    "version": 1,
    "providers": {}
  }
  ```

  不写任何缺省值（缺省值调整时老配置同样生效，`ama config show` 里来源也显示 default），也不写
  `defaultModel`（见下文「缺省模型」）。`ama init` 结束时打印下一步（`ama auth set` / `ama providers add` /
  `ama doctor`）。`config.schema.json` 里每个键都带说明与缺省值（运行时决定的键只写规则），编辑器悬停可见。

- `ama config path`：打印配置目录、数据目录与各文件路径（标出是否存在）；`ama config edit`：用
  `$VISUAL` / `$EDITOR` 打开 `config.json`（不存在先 `init`），没有编辑器时打印路径。

示例：一个三渠道中转 + 一个图像模型 + 内置供应商的覆盖。

```json
{
  "$schema": "./config.schema.json",
  "version": 1,
  "defaultModel": "packy/kimi-k2.5",
  "providers": {
    "packy": {
      "apiKey": "$PACKY_API_KEY",
      "channels": {
        "chat": { "api": "openai-completions", "baseUrl": "https://www.packyapi.com/v1" },
        "responses": { "api": "openai-responses", "baseUrl": "https://www.packyapi.com/v1" },
        "messages": { "api": "anthropic-messages", "baseUrl": "https://www.packyapi.com" }
      },
      "models": [
        { "id": "kimi-k2.5", "channels": ["chat", "messages"] },
        { "id": "grok-4.7", "channels": ["responses"] },
        {
          "id": "qwen3-vl-flash",
          "input": ["text", "image"],
          "modelsDev": "llmgateway/qwen3-vl-flash"
        }
      ]
    },
    "deepseek": { "modelOverrides": [{ "id": "deepseek-flash", "contextWindow": 131072 }] }
  }
}
```

## 内置供应商

| id           | 渠道（**粗体**为缺省）                                                                | 缺省地址                                           | API Key 环境变量（顺序）                                      |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| `anthropic`  | 单渠道 messages                                                                       | `https://api.anthropic.com`                        | `ANTHROPIC_API_KEY`、`AMA_API_KEY_ANTHROPIC`                  |
| `openai`     | **responses**、chat                                                                   | `https://api.openai.com/v1`                        | `OPENAI_API_KEY`、`AMA_API_KEY_OPENAI`                        |
| `google`     | 单渠道 gemini                                                                         | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`AMA_API_KEY_GOOGLE`      |
| `deepseek`   | **chat**、messages（`/anthropic`）                                                    | `https://api.deepseek.com`                         | `DEEPSEEK_API_KEY`、`AMA_API_KEY_DEEPSEEK`                    |
| `moonshot`   | **chat**、messages、responses、chat-intl、messages-intl（`.ai`）                      | `https://api.moonshot.cn/v1`                       | `MOONSHOT_API_KEY`、`KIMI_API_KEY`、`AMA_API_KEY_MOONSHOT`    |
| `zhipu`      | **chat**、messages（`/api/anthropic`）、chat-intl、messages-intl（`api.z.ai`）        | `https://open.bigmodel.cn/api/paas/v4`             | `ZHIPU_API_KEY`、`ZAI_API_KEY`、`AMA_API_KEY_ZHIPU`           |
| `dashscope`  | **messages**（`/apps/anthropic`）、responses、chat、messages-intl、chat-intl          | `https://dashscope.aliyuncs.com/apps/anthropic`    | `DASHSCOPE_API_KEY`、`QWEN_API_KEY`、`AMA_API_KEY_DASHSCOPE`  |
| `openrouter` | 单渠道 chat                                                                           | `https://openrouter.ai/api/v1`                     | `OPENROUTER_API_KEY`、`AMA_API_KEY_OPENROUTER`                |
| `groq`       | 单渠道 chat                                                                           | `https://api.groq.com/openai/v1`                   | `GROQ_API_KEY`、`AMA_API_KEY_GROQ`                            |
| `xai`        | **responses**、chat                                                                   | `https://api.x.ai/v1`                              | `XAI_API_KEY`、`AMA_API_KEY_XAI`                              |
| `mistral`    | 单渠道 chat                                                                           | `https://api.mistral.ai/v1`                        | `MISTRAL_API_KEY`、`AMA_API_KEY_MISTRAL`                      |
| `minimax`    | **messages**、responses（只 M3）、chat、messages-intl、chat-intl（`api.minimax.io`）  | `https://api.minimax.cn/anthropic`                 | `MINIMAX_API_KEY`、`AMA_API_KEY_MINIMAX`                      |
| `stepfun`    | **messages**、chat、responses（只 step-5-preview）、messages-intl、chat-intl（`.ai`） | `https://api.stepfun.com`                          | `STEPFUN_API_KEY`、`STEP_API_KEY`、`AMA_API_KEY_STEPFUN`      |
| `volcengine` | **responses**、chat                                                                   | `https://ark.cn-beijing.volces.com/api/v3`         | `ARK_API_KEY`、`VOLCENGINE_API_KEY`、`AMA_API_KEY_VOLCENGINE` |
| `tencent`    | **messages**、chat（`/v1`）                                                           | `https://tokenhub.tencentmaas.com`                 | `TOKENHUB_API_KEY`、`HUNYUAN_API_KEY`、`AMA_API_KEY_TENCENT`  |
| `ollama`     | 单渠道 chat                                                                           | `http://127.0.0.1:11434/v1`                        | 可无（`OLLAMA_API_KEY`）                                      |
| `lmstudio`   | 单渠道 chat                                                                           | `http://127.0.0.1:1234/v1`                         | 可无                                                          |

另有测试用供应商 `fake`（模型 `fake/echo`、`fake/reasoning`），见下文。

**缺省协议**：Messages / Responses 优先、Chat 回落。能执行显式缓存的 Messages 端点（通义、MiniMax M2.x、腾讯）与
官方推荐 Messages 的阶跃缺省 messages；OpenAI、xAI、火山方舟缺省 responses；DeepSeek、智谱、Kimi 只有隐式缓存，
**缺省保持 chat，直到官方直连过了实测门**（见「渠道实测」）再改，切换只是 `builtin.ts` 里一行 `defaultChannel`。

**内置渠道**（与用户的[渠道](#渠道channels一个供应商多种接口)同一机制）：

- `provider/model@channel` 选渠道，例如 `deepseek/deepseek-v4-pro@messages`、`dashscope/qwen3.8-max@chat-intl`；
  目录模型缺省挂全部渠道，目录可按模型限定（MiniMax M2.x、阶跃 step-3.x 没有 responses）。
- 改缺省：`"providers": { "deepseek": { "defaultChannel": "messages" } }`；或只写协议
  `"api": "anthropic-messages"`，选同协议的内置渠道。
- 改某个渠道：`channels.<内置渠道名>` 只写要改的字段（`headers` / `compat` 合并一层，其余覆盖）；新名字的渠道追加
  在后，目录模型同样可用。
- **改了供应商级 `baseUrl`**（config、auth.json 或 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`）而没写自己的
  `channels` 时，内置渠道作废，按「供应商级 `api` + 新 `baseUrl`」单渠道处理，与引入内置渠道之前一致：回落协议是
  Chat（`api` 可改）；OpenAI / xAI / 火山方舟的**目录模型**在中转上仍走 Responses，目录外的 id（本地服务、中转
  自有模型）走 Chat。落在任一内置渠道主机上（如国际站）不算中转。
- 鉴权头按渠道：Anthropic 兼容端点缺省 `x-api-key`，Kimi、MiniMax、阶跃的 Messages 渠道按其文档用
  `Authorization: Bearer`。

### Coding Plan 类订阅端点

火山方舟、阿里百炼、智谱、Kimi、MiniMax、阶跃等的 Coding Plan / Token Plan 额度只限编程工具使用，`ama -p` 与 RPC
嵌入属于自动化调用，有被判违规的风险，因此**不做内置渠道**。确认条款允许后可自行加渠道（key 写在渠道上）：

```json
{
  "providers": {
    "volcengine": {
      "channels": {
        "coding": {
          "api": "anthropic-messages",
          "baseUrl": "https://ark.cn-beijing.volces.com/api/coding",
          "apiKey": "$ARK_CODING_PLAN_KEY"
        }
      }
    },
    "zhipu": {
      "channels": {
        "coding": {
          "api": "openai-completions",
          "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
          "apiKey": "$ZHIPU_CODING_PLAN_KEY"
        }
      }
    },
    "stepfun": {
      "channels": {
        "plan": {
          "api": "anthropic-messages",
          "baseUrl": "https://api.stepfun.com/step_plan",
          "apiKey": "$STEP_PLAN_KEY",
          "authHeader": "authorization-bearer"
        }
      }
    }
  }
}
```

然后 `--model volcengine/<模型>@coding`（订阅端点的模型 id 以各家文档为准，目录外的 id 用 `models[]` 补上并写
`"channels": ["coding"]`）。

## 模型引用

`provider/model-id`，例如 `deepseek/deepseek-v4-pro`、`openrouter/anthropic/claude-sonnet-5.5`。
不带供应商前缀时在全部目录里唯一匹配；多家同名时只看已配置 key 的供应商，仍不唯一则报错并列出
候选。模型表为空的供应商（ollama、lmstudio、没写 `models` 的自定义供应商）与 baseUrl 指向非官方
主机的内置供应商（见「接入中转站」）接受任意 model id。

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

## 接入中转站

同一个中转站下，不同模型支持的协议常常不同（有的三种都行，有的只有 Chat 与 Messages，有的只有
Responses）。一个供应商就够：协议写在模型上。

```sh
export PACKY_API_KEY=sk-...
```

```json
{
  "providers": {
    "packy": {
      "baseUrl": "https://proxy.example/v1",
      "apiKey": "$PACKY_API_KEY",
      "models": [
        { "id": "deepseek-v4-flash" },
        { "id": "grok-4.7", "api": "openai-responses" },
        { "id": "MiniMax-M2.7", "api": "anthropic-messages" }
      ]
    }
  }
}
```

- 模型的 `api` 缺省沿用供应商的（这里是 `openai-completions`）；`modelOverrides[]` 也可以改 `api`。
- 三种协议共用一个 `baseUrl`：Completions / Responses 拼 `/chat/completions`、`/responses`；
  Messages 在 baseUrl 以 `/v1` 结尾时拼 `/messages`，否则 `/v1/messages`。
- 不想手写 `models`：`ama models discover packy` 列出中转站的模型（`GET {baseUrl}/models`）；
  `--probe` 对每个模型依次试供应商协议、completions、responses、messages 的最小请求，记第一个成功
  的（每模型最多 3 次，`--limit` 限制探测的模型数，缺省 30，执行前打印预估；模型之间并发，探测规则同下文
  `providers add --probe`）；
  `--write` 把结果合并进用户级 `config.json`（已有同 id 不覆盖，只写 `id` 与和供应商不同的 `api`，
  原文件备份为 `config.json.bak`）。上下文等元数据在运行时从 models.dev 快照补（见下文「模型元数据」），
  匹配不到的条目没有 `contextWindow`，自动压缩随之关闭，需要时手动补。

```sh
ama models discover packy --probe --write --limit 8
ama -p "hi" --model packy/grok-4.7
```

零配置：内置 `openai` / `anthropic` 识别 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`（OpenAI SDK 与
Claude Code 的通行约定），优先级低于 config 与 auth.json 的 `baseUrl`，profile `authEnv: false` 时
不读。baseUrl 不在官方主机时，目录外的 model id 也接受，compat 按保守缺省（不发
`prompt_cache_key`）。`ama config show` 的「供应商」节与 `ama doctor` 标出 baseUrl 来自哪个变量；
零配置挑的缺省模型来自官方目录，中转站未必有，用 `--model` 或 `defaultModel` 指定。

### 缺省模型

没有 `--model`、续会话的模型与 `defaultModel` 时，按供应商顺序（内置在前，config 里的自定义供应商在后）取第一个
有 key（或本地服务可达）的供应商，再在它的模型里挑：

- **内置供应商**：目录首条（目录按推荐顺序整理）；
- **自定义供应商**（中转站，模型表是上游 `/models` 的顺序）：在 models.dev 有价格（输入价 > 0）、支持工具调用、
  上下文 ≥ 64k 的模型里取**输入价最低**的；同价取上下文大的，再同取列表靠前的；一个都不满足才退回列表首条。

`ama providers add` 在还没有 `defaultModel` 时按同一规则挑一个写进 `defaultModel`（探测过只在探测通过的模型里
挑），摘要里写明选了谁、为什么；已有 `defaultModel` 不改。`ama config show` 与 `ama doctor` 的「模型」一行同样
说明原因。没有任何可用模型时，启动提示列出 key 的环境变量名、`ama auth set` 与 `ama providers add`。

```sh
OPENAI_BASE_URL=https://proxy.example/v1 OPENAI_API_KEY=$PACKY_API_KEY ama -p "hi" --model openai/qwen3.8-flash
```

### 渠道（channels）：一个供应商、多种接口

同一个中转常常同时开放 Chat Completions（`/v1/chat/completions`）、Responses（`/v1/responses`）与
Anthropic Messages（`/v1/messages`），且每个模型只在其中一部分接口上可用。**渠道**是「协议 + 地址（+ 可选
的 key / headers / compat）」，一个供应商可以有多个渠道，模型声明自己挂在哪些渠道上：

```json
{
  "providers": {
    "packy": {
      "name": "Packy",
      "apiKey": "$PACKY_API_KEY",
      "channels": {
        "chat": { "api": "openai-completions", "baseUrl": "https://www.packyapi.com/v1" },
        "responses": { "api": "openai-responses", "baseUrl": "https://www.packyapi.com/v1" },
        "messages": { "api": "anthropic-messages", "baseUrl": "https://www.packyapi.com" }
      },
      "defaultChannel": "chat",
      "models": [
        { "id": "kimi-k2.5", "channels": ["chat", "messages"] },
        { "id": "grok-4.7", "channels": ["responses"] },
        { "id": "deepseek-v4-flash", "channels": ["chat", "responses", "messages"] },
        { "id": "glm-5" }
      ]
    }
  }
}
```

- **渠道字段**：`api`、`baseUrl` 必填；`apiKey`（同供应商级写法，`$ENV` / `!command` / 字面量；auth.json 里
  `"<provider>@<channel>"` 条目同样生效）、`headers`、`compat`、`authHeader` 可选，缺省继承供应商级。渠道名
  `[A-Za-z0-9][A-Za-z0-9_-]*`，不含 `/` 与 `@`。
- **模型挂载**：`models[].channels` 列出可用渠道，第一个是首选；不写 → `defaultChannel`（缺省为 `channels`
  的第一个键）。引用了不存在的渠道 → 配置校验报带路径的错误。
- **模型引用**：`provider/model` 走首选渠道；`provider/model@channel` 显式指定（`--model`、`defaultModel`、
  `/model`、SDK、RPC `set_model` 一致）。指定的渠道不在该模型的 `channels` 里 → 报错并列出可用的
  `provider/model@channel`。`@` 之后不是该供应商的渠道名时整串仍按模型 id 处理（兼容 id 里本来带 `@` 的模型）。
- **向后兼容**：没有 `channels` 的供应商（自定义供应商与单协议的内置供应商；多协议内置供应商的内置渠道见「内置供应商」）按单渠道处理——供应商级 `api` + `baseUrl`
  就是隐式的 `default` 渠道；模型级 `api` / `baseUrl` 仍然有效，覆盖在所选渠道之上（等价于一个匿名渠道）。
  已有配置不用改。写了 `channels` 时供应商级 `api` / `baseUrl` 不再单独成渠道。
- **运行时**：选中的模型带上该渠道的协议、地址、key、headers 与 compat；会话记录（`model_change`）与
  `ModelRef` 带上 `channel`；缓存的端点键（三态、未命中、粒度推断）是 `供应商|主机|模型@渠道`，同一模型的
  不同渠道分开统计。价格与 models.dev 元数据按模型共享。

### 一键接入：`ama providers`

只有 baseUrl 与 key 时，一条命令建好供应商、列出模型、补齐元数据：

```sh
ama providers add packy --base-url https://www.packyapi.com/v1 --key-env PACKY_API_KEY --probe --limit 8 --yes
```

```
ama providers add <id> --base-url <url> [--channel <name>=<api>@<baseUrl> …] [--api <api>|auto]
                       [--key-env <VAR>] [--probe] [--limit N] [--probe-models a,b,…]
                       [--max-requests N] [--concurrency N] [--probe-timeout ms]
                       [--prefer chat,responses,messages] [--include-no-tools] [--yes]
ama providers list
ama providers channels <id>
ama providers remove <id>
ama providers refresh <id> [--probe …]
```

- **key**：缺省从 stdin 读（终端下不回显，不进命令行与 shell 历史），存 `auth.json`（0600）；给
  `--key-env VAR` 时不读 stdin，`config.json` 里写 `"apiKey": "$VAR"`。供应商已有 key 时不再询问。
- **候选渠道**：给了 `--channel`（可重复）就只用这些；否则从 `--base-url` 推出三个——`chat`
  （openai-completions，baseUrl 原样）、`responses`（openai-responses，同上）、`messages`
  （anthropic-messages，去掉末尾 `/v1` 的主机根）；`--api <api>` 只留对应的一个。
- **模型列表**：`GET {baseUrl}/models`（第一个 OpenAI 系渠道的地址；只有 Messages 渠道时是 `/v1/models`，先带
  `Authorization: Bearer`，401 / 403 再试 `x-api-key`——实测中转只认前者）。new-api 一类中转在条目上给
  `supported_endpoint_types`（`openai` / `openai-response` / `anthropic`），据此把模型挂到对应渠道；没有提示
  时挂到全部候选渠道里的第一个；有提示但候选渠道都不支持（如只配了 messages 渠道时的 grok）→ 不写入。
- **`--probe`**：对选中的模型（`--probe-models` 列出的，缺省按 id 字母序不分大小写取前 `--limit` 个，缺省 30）
  逐个渠道发一次最小请求（有提示时只试提示里的渠道），**探测成功的渠道全部写进模型的 `channels`**，顺序按
  `--prefer`（缺省 chat、responses、messages）；全部失败的模型不写入；未探测的按提示写入并在表格里标「未探测」。
  执行前打印请求数与耗时预估，超过 `--max-requests`（缺省 60）时截断模型数。
  - **判定**：HTTP 成功且流里出现第一个内容事件（文本 / 思考 / 工具调用）即判可用并立刻断开，不等推理模型
    想完；只收到流开头、还没有内容时再等 1 s，期间没有报错也判可用（防止中转先回 200 再在流里报错被误判）。
    HTTP 错误、流里的错误、超时（`--probe-timeout`，缺省 15000 ms）判不可用并记原因。
  - **并发**：「模型 × 渠道」同时在途最多 `--concurrency` 个（1–16，缺省 6）；结果按模型、渠道顺序打印，
    终端里单行刷新「探测 18/60」，最后打印总用时。
  - **限流**：401 / 403 立即停止；429 时并发减半、2 s 后重试该请求一次，重试仍 429 则停止。
- **渠道收敛**：写入前删掉没有任何模型挂载的候选渠道；`defaultChannel` 取剩下的第一个（按 `--prefer`）。
- **写入**：用户级 `config.json` 的 `providers.<id>`（先备份为 `config.json.bak`）。模型条目只写 `id` 与
  `channels`；上下文、输出、图像、推理、价格**不写进配置**，运行时从 models.dev 快照补（见下节），所以
  `refresh` 不会覆盖手改的字段，手写的值永远优先。models.dev 标明不支持工具调用的模型缺省不写入（Agent
  离不开工具调用），`--include-no-tools` 照写。对已存在的供应商再执行 `add`：只追加新渠道与新模型，已有
  渠道定义与模型条目一字不改。
- **确认**：写配置前打印摘要，终端里问一次 y/N；非 TTY 必须带 `--yes`（否则退出 2）。
- 打印表格：id、渠道、上下文、输出、图像、推理、工具调用、价格（models.dev 的原厂价，$/M 输入 / 输出，
  中转实际价格可能不同）、匹配方式。
- `list`：全部供应商（config.json 里的与有 key 的内置供应商）→ 渠道（协议、地址、key 来源：auth.json /
  `$VAR` / 字面量 / 无，从不显示 key）→ 模型数。`channels <id>`：每个渠道的协议、地址与挂载的模型数。
  `remove`：删 `providers.<id>`（备份）与 auth.json 里该供应商的条目。`refresh`：重拉 `/models`（models.dev
  用本地快照），只追加新模型（带 `--probe` 时同 add 的探测），已有条目不改；上游已下架的 id 只提示、不删。

实测（2026-10-02，一家同时提供三种接口的中转，22 个模型，共 29 次请求）：

- `providers add --probe --probe-models kimi-k2.5,grok-4.7,deepseek-v4-flash` 共 8 次请求（1 次列表 + 7 次探测）：
  kimi-k2.5 → chat、messages（Responses 不通）；grok-4.7 → responses；deepseek-v4-flash 在 Responses 上回
  `incomplete_details.reason: "length"`（中转转发 DeepSeek 时不写 `max_output_tokens`），已按输出截断处理，三种接口都通。
- models.dev 匹配 22 / 22：原厂条目 19 个（其中 `qwen3.8-max-0902` 去日期后缀匹配到 `alibaba/qwen3.8-max`），多数一致 2 个
  （kimi-k2.5：原厂 `moonshotai/kimi-k2.5` 不在库里，同 canonical 的 11 条取多数 262k / 图像；qwen3-coder-next），
  唯一条目 1 个（qwen3-vl-flash）。
- `-p` 经 chat 与 `@messages` 两条渠道都正常；`--image` 四色方块图在 kimi-k2.5（chat、messages）与 qwen3-vl-flash 上都答对
  红 / 绿 / 蓝 / 黄；对 glm-5（models.dev 标纯文本）直接退出 2、不发请求。
- 第二个供应商只配 messages 渠道：19 个模型挂上，3 个只支持 Responses 的 grok 不写入；同名模型不加前缀时报歧义并列出两家。

### 模型元数据：models.dev

[models.dev](https://models.dev) 汇总了两百多家供应商的模型参数（`https://models.dev/api.json`，约 5 MB，MIT 许可，
声明见仓库根的 `THIRD_PARTY_NOTICES.md`）。ama 把主流厂商的一份**裁剪快照随包携带**，用它给内置目录与自定义模型
补上下文、输出上限、输入模态、推理、价格等数值事实。**启动与运行都不联网**。

- **快照**：`src/ai/providers/models-dev/<provider>.json`，一家一份，收录清单在同目录 `_providers.json`（22 家：
  anthropic、openai、google、xai、deepseek、moonshotai / moonshotai-cn、zhipuai / zai、alibaba / alibaba-cn、
  minimax / minimax-cn、stepfun / stepfun-ai、volcengine、tencent-tokenhub、mistral、meta、xiaomi、groq，以及
  openrouter 里原厂前缀白名单内的模型）。`scripts/update-models-dev.mjs`（零依赖）拉取、过滤（丢 `deprecated`、
  输出不含文本、上下文为 0、`tool_call: false` 的条目）、裁剪字段（name、family、knowledge、release_date、
  reasoning、modalities.input、limit.context / input / output、cost 含 `context_over_200k` 与按上下文的 `tiers`、
  interleaved、beta 状态、canonical_model_id）并按键排序写出，再生成内联进 bundle 的 `models-dev-data.ts`；内容
  不变时字节不变（`_meta.json` 的 `fetchedAt` 只随 sha256 变）。为控制体积（内联数据 ≤ 200 KB，测试守住）不收
  `last_updated`、`reasoning_options`。
- **每周刷新**：`.github/workflows/models-dev.yml` 每周一 03:17 UTC（与手动 `workflow_dispatch`）跑脚本，自动删掉
  目录里与新快照相同的覆盖项，有改动才往固定分支 `chore/models-dev-refresh` 开 / 更新 PR（摘要列新增、删除、上下文 /
  输出 / 价格变化；删除超过 30% 加 `needs-review`）。PR 用仓库 secret `MODELS_DEV_PR_TOKEN`（GitHub App token 或
  fine-grained PAT，`contents` + `pull-requests` 写权限）创建以触发 CI；没有这个 secret 时 workflow 先自己跑
  `pnpm run ci`，再用缺省 token 开 PR 并在描述里写明结果。合并由人做。
- **`ama models refresh [--provider <id>[,<id>…]]`**：显式联网拉最新 `api.json`，按同一清单裁剪，写到数据目录
  `models-dev.json`（缺省 `~/.local/share/ama/`），打印新增 / 上游删除 / 变价。之后的索引 = 内置快照 ⊕ 这份覆盖：
  覆盖文件的 `fetchedAt` 晚于快照才叠加（升级 ama 带来更新的快照后旧覆盖自动失效），同一 `provider/model` 以覆盖
  为准，上游删掉的条目沿用快照。`refresh-catalog` 是旧名。`AMA_MODELS_DEV_URL` 换刷新的数据源。旧版 ama 写的全量
  缓存（version 1）不再读取。`ama providers add|refresh` 与 `ama models discover` 只用本地索引，不再拉 models.dev
  （它们对 `/models` 的请求照旧）。
- **内置目录（`catalog/*.json`）只写覆盖项**：文件级 `"modelsDev": "<快照供应商 id>"`（本地服务写 `false`）；条目
  按 `<modelsDev>/<id>` 从快照继承 name、reasoning、contextWindow、maxTokens、input、cost、family、knowledge、
  releaseDate、inputLimit、status，目录只写 ama 特有字段（`api`、`thinkingLevelMap`、`promptCache`、`compat`）与
  有意不同于快照的值（如 openai 的 272k 窗口、deepseek 的价格）；`cost` 可只写要改的键。id 与快照不同时条目写
  `"modelsDev": "provider/model"`，不继承写 `false`。快照里没有的模型（已 deprecated 等）写完整条目。
  `catalog.test.ts` 把与快照取值相同的字段当冗余报错，`UPDATE_CATALOG=1 pnpm vitest run
src/ai/providers/catalog.test.ts` 自动删除并重新生成 `catalog-data.ts`（之后跑 prettier）；确实要钉住与快照相同的
  值时在条目上写 `"_reason": "…"`（注释，运行时忽略，该条目不做冗余检查）。目录继承的映射与自定义模型略有不同：
  `maxTokens` 不封顶（取 `min(limit.output, contextWindow)`），缺的缓存价记 0。
- **优先级**：用户配置（`models[]` / `modelOverrides[]` 里写了的字段）> 内置目录（快照 ⊕ 目录覆盖）> models.dev
  索引 > 自定义缺省（`maxTokens: 8192`、`input: ["text"]`、`reasoning: false`、不猜 `contextWindow`）。
  `ama models list` 与 `ama config show` 标出每个字段来自哪里（`config` / `目录` / `models.dev` / `缺省`；内置目录
  从快照继承的字段标 `models.dev`）。
- **字段映射**（自定义模型）：`contextWindow = limit.context`；`maxTokens = min(limit.output, 65536, contextWindow)`——
  `maxTokens` 每次请求都作为 `max_tokens` 发出，models.dev 给的是原厂上限（不少模型写的是与上下文相同的
  1M），中转换了上游后常拒收超大值，Anthropic 协议的思考预算也从它推导，64k 对编码 Agent 的单轮输出足够，
  需要更大时在配置里写；`input` 由 `modalities.input` 含不含 `image` 定为 `["text","image"]` 或 `["text"]`；
  `reasoning`；`cost` 取 `input` / `output` / `cache_read` / `cache_write`（$/M），缺缓存价时按输入价算
  （不假设有折扣，保温的经济性判断因此偏保守）；`cost.tiers` 取 models.dev 的按上下文档位，只有
  `context_over_200k` 时折成 200k 一档；另补 `family`、`knowledge`、`releaseDate`、`inputLimit`（与上下文不同时）、
  `status: "beta"`。
- **匹配规则**（同一个 id 常在多家转售商下重复出现，取值不一）：
  1. 模型上写了 `"modelsDev": "provider/model"` → 直接用该条目（写 `false` 关闭补全）；
  2. id 形如 `vendor/model` 且索引里正好有这个 `provider/model` → 用它；
  3. 按 id 不分大小写找全部同名条目；有 `canonical_model_id` 的，取指向与 id 同名的那个（否则取票数最多的），
     它若能在原厂供应商下找到 → 用原厂条目；
  4. 否则在（同一 canonical 的）条目里优先原厂供应商：anthropic、openai、google、deepseek、moonshotai(-cn)、
     zhipuai、zai、alibaba(-cn)、xai、mistral、minimax(-cn)、meta、llama、cohere、xiaomi、stepfun(-ai)、volcengine、
     tencent-tokenhub 等（models.dev 里没有 `qwen` 这样的供应商 id，通义在 `alibaba`）；
  5. 仍有多条 → 按 (上下文, 输出, 图像) 取多数，取值不一时记 warning；只有一条就用它；
  6. 同名找不到时依次试归一化后的 id：去 `vendor/` 前缀、去 `:free` 一类后缀、去 `-latest`、去日期后缀
     （`-0902`、`-20250514`、`-2025-05-14`）；
  7. 都没有 → 「未匹配」，保持自定义缺省（不猜 `contextWindow`，自动压缩关闭）。快照只收主流厂商，转售商专有的
     id 可能匹配不到，可在模型上写 `modelsDev` 指向收录的条目。

### 图像输入

- 四条协议都把图片放进用户消息：Chat Completions `image_url`（data URL）、Responses `input_image`、
  Anthropic `image`（base64 source）、Gemini `inlineData`；工具结果里的图片同样映射。
- 入口：`ama -p "描述这张图" --image a.png --image b.jpg`；交互界面与行式界面里写 `@图片路径`，或粘贴 /
  拖入一个图片文件路径（整段输入里以 `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` 结尾且文件存在的词）；交互界面里
  `Ctrl+V` 或 `/paste` 把剪贴板里的图片存成文件并在光标处插入 `@<路径>`（见下文「剪贴板图片」与 [tui.md](tui.md)「剪贴板图片」）。
  `--image`、`@图片` 与粘贴的图片都按 `images.resize` 缩放。
- 与 `read` 工具共用 MIME 检测（按文件头识别 PNG / JPEG / GIF / WebP，扩展名不符时以文件头为准）与大小上限。
  上限按 **base64 后**计算（`ceil(字节/3)*4`），按当前模型的端点分档：官方 Anthropic（`api.anthropic.com`）
  10 MB、官方 Gemini 与 OpenAI 20 MB，中转（内置供应商改了 baseUrl）与其它主机 5 MB；任一边超过 8000 px 拒绝。
- 缩放（`images.resize`，缺省 `auto`）：超限时依次找 `sips`（macOS）、`magick` / `convert`（ImageMagick）缩到
  上限以内再附上；找不到工具或 `off` 时按上面的规则拒绝并提示。零依赖，不内置图像解码。
- 单次请求的图片总量预算按协议：`anthropic-messages` 32 MB，其它 20 MB（base64 后）。历史图片每轮重发，超预算时
  从最旧的图开始换成占位文本 `[earlier image omitted to fit request size]`，一次降到预算的 60% 以下；超过当前端点
  单图上限的旧图（换了模型 / 渠道之后）直接换成占位；单请求超过 20 张图且有长边 > 2000 px 的图时，继续从最旧的
  降到 20 张以内。最新一条带图的消息不降。降级写成会话里的 `context_edit{reason:"image_budget"}`，之后前缀稳定，
  缓存统计把这一次当重置点。
- 剪贴板图片（交互界面 `Ctrl+V` / `/paste`）：`pasteClipboardImage` 依次调 `osascript` / `pngpaste`（macOS）、`wl-paste`（Wayland）/ `xclip`（X11）、
  PowerShell `Get-Clipboard -Format Image`（Windows），写到 `<数据目录>/clipboard/<时间戳>.png`；
  `ama sessions prune` 清理其中超过 7 天的文件。
- 模型 `input` 不含 `image` 时直接拒绝并提示换模型（`-p` 退出 2，界面里给错误提示，不发请求）；`read`
  工具读图时只返回路径、尺寸与「当前模型不接受图片」。

接好之后：`ama models check packy/<id>` 发一次最小请求确认连通；`ama models cache-probe packy/<id>` 看这个端点报不报缓存（见下节「缓存」），中转上不报缓存的模型按建议设 `compat.cacheReporting: "silent"`，状态栏就显示「未报告」而不是 0%。

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

## Anthropic Messages 的 compat

按请求主机推断缺省（`src/ai/apis/anthropic-compat.ts`），`providers.<id>.compat`、渠道或模型级 `compat` 逐字段覆盖：

| 开关                          | 作用                                                 | 缺省                                                                                                           |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sendInterleavedThinkingBeta` | 预算型思考 + 工具时带 `interleaved-thinking` beta 头 | `api.anthropic.com` 开；DeepSeek、智谱、Kimi、通义、MiniMax、阶跃、腾讯、火山关；其它主机只对 `claude*` 模型开 |
| `sendCacheControl`            | 打 `cache_control` 断点                              | 开；DeepSeek 关（文档写明忽略）                                                                                |
| `adaptiveThinking`            | `{type:"adaptive"}` + `output_config.effort`         | 关；官方新模型在目录里逐条开                                                                                   |
| `supportsCacheControlOnTools` | 最后一个工具定义上打断点                             | 开                                                                                                             |
| `maxCacheBreakpoints`         | 断点个数上限                                         | 4                                                                                                              |

OpenRouter 的 Messages 接口只在 `message_delta` 里给缓存 usage，解析本就按非空字段合并，不需要开关。

## Responses 与 Gemini 的 compat

| 协议                   | 开关                            | 作用                                                                                                      | 缺省                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `openai-responses`     | `supportsReasoningSummary`      | `reasoning.summary: "auto"`（思考块有文字）                                                               | OpenAI 官方开；xAI 与其它关                  |
| `openai-responses`     | `supportsStore`                 | 发 `store: false`；推理模型同时要 `include: ["reasoning.encrypted_content"]`，多轮回放加密 reasoning item | OpenAI 官方、xAI 开；其它关                  |
| `google-generative-ai` | `supportsThoughtSignature`      | 同模型回放 `thoughtSignature`（思考、文本、functionCall part）                                            | 开                                           |
| `google-generative-ai` | `supportsFunctionResponseParts` | 工具结果图片放进 `functionResponse.parts`；关时另起一个 user 回合                                         | Gemini 3 起开；Gemini 2.x 与非 Gemini 命名关 |

- Responses：系统提示放 `instructions`；缓存字段见下节「缓存」；思考 off 只在映射表给了 off 的字串（如 `"none"`）时发
  `reasoning.effort`，否则交给服务端缺省。
- Gemini：映射值是字串（或 Gemini 3 族且未映射）→ 离散 `thinkingLevel`（`LOW` / `HIGH`…）；映射值是
  数字或其它模型 → `thinkingBudget`（`-1` 动态）；off → `thinkingBudget: 0`。隐式缓存自动生效，
  `cachedContentTokenCount` 计入 `cacheRead`。

## 缓存

长任务的主要用量是缓存读取：前缀一旦变化，此后每次请求都要按全价重读。ama 分三层处理缓存：**协议层**按各家写法打断点、发缓存键与保留层级，并标记响应里有没有缓存字段；**会话层**记录每次请求的前缀指纹，检测未命中、判定端点报不报缓存、在长工具运行期间保温；**展示层**是状态栏、`/session`、RPC 统计与 `ama models cache-probe`（界面怎么读见 [tui.md](tui.md)「缓存与上下文」）。

前缀稳定由组装保证：系统提示节顺序固定、不含时间戳，工具按名排序，会话中途的变化只以 system 补丁追加在末尾（[session-format.md](session-format.md)「消息」）。

### 请求字段

| 协议                                     | 字段                                                                                     | 条件                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `anthropic-messages`                     | 三断点 `cache_control`（最后一条 user、system 末、最后一个工具）                         | `cacheRetention` 不是 `none`                                                             |
| `anthropic-messages`                     | `ttl: "1h"`                                                                              | `long` 且 `supportsLongCacheRetention`；否则按 5m                                        |
| `openai-completions`                     | `prompt_cache_key = sessionId`（截 64 字符）                                             | `sendPromptCacheKey` 且不是 `none`                                                       |
| `openai-completions`                     | `prompt_cache_retention: "24h"`                                                          | `long` 且 `supportsLongCacheRetention`                                                   |
| `openai-completions`（`anthropic/*` 等） | `cache_control`（`cacheControlFormat: "anthropic"`），`long` 时带 `ttl: "1h"`            | 同 Anthropic                                                                             |
| `openai-responses`                       | `prompt_cache_key`                                                                       | 同 Completions                                                                           |
| `openai-responses`                       | `prompt_cache_options: { ttl: "30m" }`，否则 `prompt_cache_retention: "24h"`             | `long` 且 `supportsExplicitPromptCacheMode`；否则 `long` 且 `supportsLongCacheRetention` |
| OpenAI 两条                              | 亲和头 `x-session-affinity` + 每请求 `x-client-request-id`（OpenRouter：`x-session-id`） | `sendSessionAffinityHeaders` 且有 sessionId                                              |
| `google-generative-ai`                   | 无（隐式缓存）                                                                           | —                                                                                        |
| 全部                                     | `toolChoice: "none"` → 各家的「禁止调用工具」写法                                        | 请求带工具时（摘要续写**不用**，见「压缩摘要续写」）                                     |

保留层级：`StreamOptions.cacheRetention` 优先；未指定时读 `AMA_CACHE_RETENTION=none|short|long`；都没有为
`short`。Anthropic 请求体最后做 TTL 顺序校验（tools → system → messages 里 5m 之后出现 1h 则全部降为 5m）。
Anthropic 的 `baseUrl` 以 `/v1` 结尾时请求 `{baseUrl}/messages`，不会拼成 `/v1/v1/messages`。

### 兼容开关（`providers.<id>.compat` 或模型级 `compat`）

| 开关                              | 作用                                                    | 缺省                                                                            |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sendPromptCacheKey`              | 发 `prompt_cache_key`                                   | OpenAI、xAI、Mistral、Kimi（`.cn` / `.ai`）、腾讯 TokenHub 的官方主机开，其余关 |
| `sendSessionAffinityHeaders`      | 发亲和头                                                | 关（含 OpenRouter，未实测）                                                     |
| `supportsLongCacheRetention`      | `long` 可用（Anthropic 1h、OpenAI 24h）；否则降为 short | `api.openai.com` / `api.anthropic.com` / `tokenhub.tencentmaas.com` 开          |
| `supportsExplicitPromptCacheMode` | Responses 的 `prompt_cache_options`（30m）              | 关                                                                              |
| `cacheReporting`                  | `auto` / `silent` / `reported`：强制「是否报缓存」三态  | `auto`                                                                          |

推断只看最终请求的主机名（`cache-params.ts` 的 `HOST_CACHE_CAPABILITIES`，只收官方文档写明支持的主机），不看 provider id：用 `OPENAI_BASE_URL` 或自定义 `baseUrl` 把 `openai` 指到中转时
按中转处理。缺省只对官方端点开，是因为中转上实测「接受但未见收益」或「收下但不生效」（下表）。

**400 自动剥离**：端点以 400 拒收并在错误体里点名 `prompt_cache_key` / `prompt_cache_retention` /
`prompt_cache_options` / `cache_control` 时，ama 把 `provider/model` 记入进程内的剥离表，去掉这些字段重发一次
（仍只有一个终止事件），提示一次建议写哪个开关；同一进程里之后的请求直接不带。

### usage 与 `cacheReported`

原始 usage 里出现任一缓存字段（即使为 0）→ `Usage.cacheReported = true`，都没有 → `false`：Completions 认
`prompt_tokens_details.cached_tokens` / `cache_write_tokens`、`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`、
顶层 `cached_tokens`；Responses 认 `input_tokens_details.cached_tokens`；Anthropic 认
`cache_read_input_tokens` / `cache_creation_input_tokens`；Google 认 `cachedContentTokenCount`（隐式缓存未命中时
常常不给）。字段存在但一直为 0 的端点由会话层按连续 3 次判 `silent`。

### 模型目录 `promptCache`

只写有公开依据的值（秒 / token）：Anthropic 全部 `short 300 / long 3600`，`minTokens` 按模型 512–4096；OpenAI
全部 `short 300 / long 86400 / minTokens 1024`；Kimi 全部 `short 300`。DeepSeek、智谱、通义、Groq、xAI、Mistral、
OpenRouter、Google 没有承诺的 TTL，留空（不保温，归因按隐式缓存 10 分钟估）。可在 `models[]` /
`modelOverrides[]` 里自填。

### 会话层：指纹、未命中与三态

每次真实请求在内存里记一条记录：前缀指纹（system 与工具表各取 sha256 前 16 位 hex，加 `provider/model`）、`promptTokens`（input + cacheRead + cacheWrite）、用量与发出时刻。下一次请求与上一条比对：

- **未命中**：`missed = min(上次前缀, 本次前缀) − 本次 cacheRead`，低于噪声下限（`max(1024, promptCache.minTokens, 端点缓存粒度)`）不计——有的端点按块报缓存读（DeepSeek 经中转是 2048 一块），粒度取同一端点（供应商 + 主机 + 模型）观察到的非零 cacheRead 的最大公约数，至少 2 个样本且在 128–8192 之间才采信，只在内存、进程内跨会话复用；相对比例超过随规模自适应的门槛（约 `0.10 × √(100k / 前缀)`，夹在 2%–30%），或绝对值 ≥ 20 000 才记一次。重计费金额按本条实付单价与读价之差估算，模型无价格时只有 token。
- **原因**（按顺序判定）：system / 工具表指纹变了 → `prefix_changed`（`detail` 说明哪段，多半是宿主中途注册工具或 Hook 上下文变化）；模型变了 → `model_changed`；间隔超过 TTL → `idle`（目录没有 TTL 的隐式缓存按 10 分钟估）；两次请求之间 `task` 子任务占了间隔的 80% 以上 → `subtask`；其余 → `evicted`（服务端淘汰）。
- **不算未命中**：压缩、分支摘要、档一裁剪之后的首个请求（上下文合法地变了）；前缀低于最小可缓存长度。切换模型**不**豁免。
- **三态**：按 `(provider, baseUrl 主机名, model)` 在进程内维护。`unknown`：还没有足够长的可比请求；`reported`：出现过 cacheRead 或 cacheWrite > 0；`silent`：连续 3 个可比请求（前缀 ≥ minTokens、指纹未变、间隔 < TTL）读写都是 0，或 `compat.cacheReporting: "silent"`。只有 `reported` 时显示命中率、检测未命中并保温；`unknown` / `silent` 的请求不进命中率分母，界面显示 `—` / `未报告` 而不是 0%。

`task` 子会话有自己的记录链与统计，`/session` 的「子任务」行汇总；fork 出的会话沿用根会话 id 作 `prompt_cache_key`（只是路由提示）。

### 保温

工具长时间运行（长测试、`task` 子任务、codemode 脚本）时，前缀可能在下一次请求前过期。保温在 TTL 到期前重放上一次真实请求（同模型、同上下文，`maxTokens: 1`），只买一次读价，把缓存续上。

| 项     | 规则                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 模式   | `off`；`streaming`（缺省，只在运行中、也就是工具执行期间）；`idle`（运行结束后的空闲期也保温，适合贵模型）                                                                                 |
| 前提   | 端点为 `reported`；模型目录有 `promptCache.short`（TTL > 10 秒）；请求的 `cacheRetention` 不是 `none`；请求体没被 `onPayload` 替换；Anthropic 开思考且思考预算随 `max_tokens` 推导的不保温 |
| 时机   | 从上一次请求**发出**时刻起算，`max(1s, min(0.9·TTL, TTL − 10s))` 后发；计时器迟到超过截止（睡眠、事件循环阻塞）直接停                                                                      |
| 经济性 | `p · missCost − warmCost ≥ cache.minSavingsUsd`（缺省 $0.05）才发，`p` 在 streaming 为 1、idle 为 0.15；缺价格不发                                                                         |
| 上限   | streaming 60 分钟、idle 30 分钟；连续 2 次保温零命中即停                                                                                                                                   |
| 取消   | 换模型、换思考级别、压缩、`/tree`、退出时取消，下一次真实请求再开始                                                                                                                        |
| 记账   | 成功的保温追加 `usage{kind:"cache_warm"}` 条目（不进上下文），计入 `/session` 费用与 RPC 统计；事件 `cache_warm{scheduled｜sent｜stopped}`                                                 |

宿主可以经 `api.cache.onWarmingDecision` 否决或强制每一次保温（[host-api.md](host-api.md)「缓存保温」）。子会话缺省不保温（`cache.warmSubagents: true` 打开）。按目录价格估算，长工具运行期间几乎总是划算；空闲保温只对贵模型、长前缀划算。

### 压缩摘要续写

档二压缩的摘要请求不再另起一段新对话，而是在与上一次真实请求逐字节相同的前缀后面追加一条摘要指令（`cacheRetention: "short"`），所以整段历史按读价计费。续写请求**不发 `tool_choice`**：实测中转与 Kimi 在 `tool_choice: "none"` 时渲染的提示不带工具定义，前缀在工具段断开、读不到缓存；Anthropic 也写明改动 tool_choice 会让消息缓存失效。工具表照常发，「不要调用工具、只输出摘要」写在末尾指令里。响应为空、被截断、含工具调用或请求出错时，回落为独立的摘要请求（`cacheRetention: "none"`）并记 warning。

### 配置

```json
{
  "cache": {
    "warming": "streaming",
    "retention": "short",
    "minSavingsUsd": 0.05,
    "missNotices": true,
    "warmSubagents": false
  }
}
```

| 键              | 缺省        | 说明                                                                                          |
| --------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `warming`       | `streaming` | `off` / `streaming` / `idle`；环境变量 `AMA_CACHE_WARMING` 覆盖；`/cache warm …` 本会话内切换 |
| `retention`     | `short`     | `none` / `short` / `long`；环境变量 `AMA_CACHE_RETENTION` 覆盖                                |
| `minSavingsUsd` | `0.05`      | 保温的最低期望节省（美元）                                                                    |
| `missNotices`   | `true`      | 消息区的未命中与上下文余量提示（统计不受影响）                                                |
| `warmSubagents` | `false`     | `task` 子会话也保温                                                                           |

整段只认用户级与 profile 的 `config.json`，项目级忽略并 warning。供应商级开关在 `providers.<id>.compat`（上文「兼容开关」），TTL 在模型的 `promptCache`。

### `ama models cache-probe`

```sh
ama models cache-probe <provider/id> [--tokens 2048] [--gap-ms 3000] [--json] [--yes]
```

用一个确定性的固定前缀（约 `--tokens` token）+ `Reply with: ok`，`maxTokens: 16`，相隔 `--gap-ms` 发两次，判定：

- `reported`：第二次 cacheRead ≥ 前缀的 50%；目录没有 `promptCache` 时建议自填 `promptCache.short` 以启用保温；
- `silent`：两次读写都是 0；建议设 `compat.cacheReporting: "silent"`。响应里有缓存字段但恒为 0 时另提示可能是写入延迟（同一中转的 kimi-k2.5 间隔 3 秒两次都是 0、间隔 8 秒第二次读满前缀），可加大 `--gap-ms` 重试；
- `inconclusive`：读到一点或只有写入，多半是缓存粒度或 TTL 问题。

输出两次请求的 input / cacheRead / cacheWrite 与该协议读取的 usage 字段名。这是计费动作：执行前打印预估（无价格显示 `$?`），交互终端问一次 y/N，非交互环境必须带 `--yes`（否则退出 2）；`--json` 时预估写 stderr，stdout 只有结果对象。

### 中转实测（2026-10-02）

一家同时提供 Chat / Responses / Messages 三种接口的测试中转，固定前缀约 8.6k–10.9k token，同一前缀相隔 2–3 秒
发两次（共 38 次请求）。

| 接口 / 模型                                       | 发送的缓存参数                                    | 结果                    | 第二次 cacheRead / 前缀    | usage 里的缓存字段（原始形状）                                                |
| ------------------------------------------------- | ------------------------------------------------- | ----------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| Chat · kimi-k2.5                                  | 无                                                | 200                     | 8576 / 8597                | `prompt_tokens_details.cached_tokens`（首个请求为 0）                         |
| Chat · kimi-k2.5                                  | `prompt_cache_key`；再加亲和头                    | 200，接受               | 8576 / 8597（无提升）      | 同上                                                                          |
| Chat · deepseek-v4-flash                          | `prompt_cache_key` + `x-session-affinity`         | 200，接受               | 9472 / 9767                | `prompt_tokens_details.cached_tokens`                                         |
| Chat · qwen3.8-flash                              | 同上                                              | 200，接受               | 10240 / 10400              | 同上                                                                          |
| Chat · glm-5                                      | 同上                                              | 200，接受               | 8704 / 9040                | 同上                                                                          |
| Chat · MiniMax-M2.7                               | 同上                                              | 200，接受               | 9389 / 9700                | 同上                                                                          |
| Responses · qwen3.8-flash                         | `prompt_cache_key` + `prompt_cache_retention`     | 200，接受               | 10240 / 10432              | `input_tokens_details.cached_tokens`                                          |
| Responses · qwen3.8-flash                         | `prompt_cache_options: {ttl:"30m"}`               | 200，接受               | 同上                       | 同上                                                                          |
| Responses · grok-4.7                              | 同上两组                                          | 200，接受               | 1152 / 10929               | 同上                                                                          |
| Responses · deepseek-v4-flash                     | `prompt_cache_retention` / `prompt_cache_options` | **400** `unknown field` | —                          | 去掉后 200；`input_tokens_details.cached_tokens`                              |
| Messages · kimi-k2.5、qwen3.8-flash               | `cache_control` + `ttl:"1h"`                      | 200，接受               | 9464 / 9476、10385 / 10400 | `cache_creation.ephemeral_5m_input_tokens` 有值、无 1h 字段：**1h 被当作 5m** |
| Messages · MiniMax-M2.7、deepseek-v4-flash、glm-5 | 同上                                              | 200，接受               | 9403、8192、8704           | `cache_creation_input_tokens` 恒 0，读命中照常（端点自管的隐式缓存）          |

结论与缺省值：

- `prompt_cache_key`、亲和头在中转上都被接受，但未见命中提升 → `sendPromptCacheKey`、
  `sendSessionAffinityHeaders` 对非官方端点缺省关；需要时自行打开（400 剥离兜底）。
- 1h 保留在中转的 Messages 接口上被收下但按 5m 写入，Responses 的长保留字段在部分上游 400 →
  `supportsLongCacheRetention` 只对官方端点缺省开，`supportsExplicitPromptCacheMode` 缺省关。
- 实测的五家在 Chat 接口上都报缓存字段（前一版调研里 DeepSeek / GLM 报 0 的现象本次未复现），它们首个
  请求的 `cached_tokens: 0` 正是「字段存在但为 0」，`cacheReported` 为 true。
- `/v1` 去重与 `toolChoice: "none"` 经 ama 协议层实发验证：Messages 请求落在 `/v1/messages`，三种接口都接受
  `tool_choice: none` 且未产生工具调用。

## 渠道实测

`scripts/channel-probe.mjs`（先 `pnpm build:lib`）对 `provider/model@channel` 跑实测门，每个模型 ≤ 8 个请求：

| 项                | 做法                                                           | 通过                                                                     |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ① check           | 一次最小调用                                                   | 无错误且有文本                                                           |
| ② 工具往返        | 一次并行 `read` 两个临时文件、回答口令                         | 有工具调用且回答含口令                                                   |
| ③ thinking 两回合 | 接着同一对话、thinking=medium 再读一个文件（思考块随历史回放） | 第二次无错误；没有思考块或 Messages 上思考块无签名记 ⚠（签名回放未验证） |
| ④ 缓存            | 约 3k token 的固定前缀相隔 `--gap-ms` 发两次                   | 第二次 cacheRead > 0                                                     |
| tool_use.id       | ②③ 同一对话里的全部工具调用 id                                 | 互不相同                                                                 |

四项全过且 id 不重复 = 过门；DeepSeek、智谱、Kimi 的官方 Messages 渠道过门后缺省改 messages。

### 中转对比（2026-10-02，messages vs chat）

同一测试中转（Chat / Messages 两种接口），`--gap-ms 8000`，84 次请求（含一轮调试），保守估价约 $0.11：

| 模型@渠道                          | 协议 · 主机                           | ① check | ② 工具往返 | ③ thinking 两回合    | ④ 缓存（读 / 前缀） | id 唯一 | 请求 | 结论     |
| ---------------------------------- | ------------------------------------- | ------- | ---------- | -------------------- | ------------------- | ------- | ---- | -------- |
| `packy/kimi-k2.5@messages`         | anthropic-messages · www.packyapi.com | ✓       | ✓          | ⚠ 2/2 个思考块无签名 | ✓ 2734 / 2738       | ✓       | 7    | 未过     |
| `packy/kimi-k2.5@chat`             | openai-completions · www.packyapi.com | ✓       | ✓          | ✓                    | ✓ 2688 / 2740       | ✓       | 7    | **过门** |
| `packy/deepseek-v4-flash@messages` | anthropic-messages · www.packyapi.com | ✓       | ✓          | ⚠ 没有思考块         | ✓ 2048 / 2732       | ✓       | 7    | 未过     |
| `packy/deepseek-v4-flash@chat`     | openai-completions · www.packyapi.com | ✓       | ✓          | ✓                    | ✓ 2048 / 2732       | ✓       | 7    | **过门** |
| `packy/glm-5@messages`             | anthropic-messages · www.packyapi.com | ✓       | ✓          | ⚠ 2/2 个思考块无签名 | ✓ 2560 / 2733       | ✓       | 7    | 未过     |
| `packy/glm-5@chat`                 | openai-completions · www.packyapi.com | ✓       | ✓          | ✓                    | ✓ 2560 / 2733       | ✓       | 7    | **过门** |
| `packy/qwen3.8-flash@messages`     | anthropic-messages · www.packyapi.com | ✓       | ✓          | ⚠ 2/2 个思考块无签名 | ✓ 3053 / 3061       | ✓       | 7    | 未过     |
| `packy/qwen3.8-flash@chat`         | openai-completions · www.packyapi.com | ✓       | ✓          | ✓                    | ✓ 2048 / 3063       | ✓       | 7    | **过门** |
| `packy/MiniMax-M2.7@messages`      | anthropic-messages · www.packyapi.com | ✓       | ✓          | ⚠ 2/2 个思考块无签名 | ✓ 2638 / 2743       | ✓       | 7    | 未过     |
| `packy/MiniMax-M2.7@chat`          | openai-completions · www.packyapi.com | ✓       | ✓          | ✓                    | ✓ 2638 / 2744       | ✓       | 7    | **过门** |

- 五家在中转的两种接口上 ①②④ 全过，tool_use.id 在同一对话里都不重复（Kimi 的 id 形如 `functions.read:<n>`，
  按对话递增；不同对话会从 0 重来，所以只能在同一对话里比较）。
- Messages 接口上的思考块**都没有签名**（DeepSeek 没返回思考块）：中转把上游 Chat 转成 Messages 时不带签名，
  ama 按规则降级为文本回放，往返照常成功，但签名回放没被验证——**中转结果不能替代官方直连的实测门**。
- 缓存：通义在 Messages 上首个请求就写入 3053 token（执行 `cache_control`），第二次读满前缀；其余四家读命中照常、
  `cache_creation_input_tokens` 为 0（端点自管的隐式缓存），与「缓存 · 中转实测」一致。

### 官方直连（待用户用自己的 key 跑）

每家 ≤ 8 个请求，Kimi 的缓存写入有延迟、用 `--gap-ms 8000`：

```sh
pnpm build:lib
node scripts/channel-probe.mjs --model deepseek/deepseek-v4-pro@messages,deepseek/deepseek-v4-pro@chat --json /tmp/probe-deepseek.json
node scripts/channel-probe.mjs --model zhipu/glm-5.3@messages,zhipu/glm-5.3@chat --json /tmp/probe-zhipu.json
node scripts/channel-probe.mjs --model moonshot/kimi-k3@messages,moonshot/kimi-k3@chat --gap-ms 8000 --json /tmp/probe-kimi.json
node scripts/channel-probe.mjs --model dashscope/qwen3.8-max@messages --json /tmp/probe-qwen.json
node scripts/channel-probe.mjs --model minimax/MiniMax-M3@messages,minimax/MiniMax-M2.7@messages --json /tmp/probe-minimax.json
node scripts/channel-probe.mjs --model stepfun/step-5-preview@messages --json /tmp/probe-stepfun.json
node scripts/channel-probe.mjs --model tencent/hy3@messages --json /tmp/probe-tencent.json
node scripts/channel-probe.mjs --model volcengine/doubao-seed-2-1-pro-260628@responses --json /tmp/probe-volcengine.json
```

key 用各家标准环境变量（上表）；没有 key 的那家记「没有 key」、不发请求。结果用 `--render` 重画后补进本节。

## 测试用 fake 供应商

`--model fake/echo`：回显最后一条用户消息。零配置的模型选择器、`ama doctor`、`ama models list`、
`ama providers list`、`ama config show` 缺省不列 fake；`AMA_SHOW_FAKE=1` 或设了 `AMA_FAKE_SCRIPT` 时照列，
显式 `--model fake/…` 任何时候都可用。设 `AMA_FAKE_SCRIPT=<file.json>` 后
按脚本第 n 次调用产出文本、思考、工具调用、429、溢出、断流、延迟，脚本格式见
`src/ai/fake/fake-script.ts`，示例在 `test/fixtures/scripts/`。
