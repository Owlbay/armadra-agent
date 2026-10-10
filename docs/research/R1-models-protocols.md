# R1 调研：模型元数据入库、协议优先级、图像输入（ama）

调研日期 2026-10-02；对象仓库 `/Users/yovinchen/Projects/Rust/Tauri/armadra-agent`（HEAD `fb36ecd`）。只读，未改代码。
文中 `src/...` 路径均相对该仓库。

---

## 0. 结论

1. **models.dev 可以入库**：数据源仓库现为 `anomalyco/models.dev`（原 `sst/models.dev` 重定向），**MIT 许可**（`Copyright (c) 2025 models.dev`）。只要随附 MIT 版权声明，就可以裁剪后放进 ama（同为 MIT）。建议用 `THIRD_PARTY_NOTICES` 或快照文件头写明来源与许可，不需要额外授权。
2. **快照体积很小**：按建议的 20 家供应商、只留需要的字段（去掉 deprecated、非文本输出、无 tool_call、context=0 的条目），紧凑 JSON 约 **108 KB**，其中 OpenRouter 子集占 48 KB；不含 OpenRouter 约 60 KB。原始 `api.json` 有 5.29 MB、225 家供应商。快照**必须像 `catalog-data.ts` 那样生成 TS 内联**，因为 bundle 是单文件 `dist/bundle/ama.cjs`，运行时不读 JSON 文件。
3. **Action**：每周 cron，加 `workflow_dispatch`。Node 零依赖脚本执行「拉 api.json → 裁剪 → 规范化排序 → 写 `src/ai/providers/models-dev/*.json` 与生成的 `models-dev-data.ts`」，然后跑 `pnpm typecheck && pnpm test`。只有 diff 非空时才用 `peter-evans/create-pull-request`（或 `gh pr create`）对固定分支开 PR。上游一天能有 20–40 个 commit（10-01 有 24 个，10-02 有 36 个），每天跑 PR 会太吵，所以用每周。
4. **协议优先级**：多数国内厂商现在都有 **Anthropic Messages 兼容端点**，包括 DeepSeek、智谱、Kimi、MiniMax、通义/百炼、阶跃、腾讯 TokenHub/混元，以及只在 Coding Plan 提供的火山方舟。Kimi、通义、MiniMax、阶跃（部分模型）、火山方舟（豆包）、xAI、OpenRouter、Groq 有 **Responses**。但「Messages 兼容」不等于缓存可控：只有**通义（显式 `cache_control`，5m）、MiniMax M2.x（显式）、腾讯 TokenHub（显式，含 1h）**会真正执行 `cache_control`。DeepSeek 明确写了 `cache_control` 被忽略，智谱、Kimi、阶跃是自动前缀缓存。建议默认值见 §2.3：
   - Anthropic → messages；OpenAI → **全部** responses；xAI → responses；Kimi、通义、MiniMax → messages。
   - DeepSeek、智谱 → messages。两家都靠隐式缓存，选 messages 是为了把 usage 统一到 `cache_read_input_tokens`，并减少 compat 分支；如果实测有问题，这两家可以保留 chat。
   - Google 走原生 gemini；Mistral、Groq、Ollama、LM Studio 只有 chat 或保持 chat。
5. **ama 现状的缺口**：
   - `builtin.ts` 的 `api` 是单值。除 OpenAI、xAI 靠目录条目覆盖外，其余都锁在 `openai-completions`。没有内置渠道（channels 只能来自用户配置），也没有 MiniMax、阶跃、火山方舟、腾讯这几家内置供应商。
   - Anthropic 协议的 compat 没有按主机推断（`detectAnthropicCompat` 只合并 provider/model compat，`src/ai/apis/anthropic-request.ts:69-74`）。第三方 Messages 端点的 thinking、beta 头、1h TTL 都要靠缺省撞运气。
   - `OFFICIAL_HOSTS` 只有 `api.openai.com`、`api.anthropic.com`（`src/ai/apis/cache-params.ts:26`），所以 xAI 官方推荐的 `prompt_cache_key` 缺省不发。
6. **图像**：四条协议的 base64 图片块序列化完整，工具结果里的图也有映射，换到不支持图像的模型时会替换为占位文本（`src/ai/context.ts:32-91`）。主要缺口：
   - 没有剪贴板图片粘贴（Ctrl+V 位图），只认「粘贴的文件路径」。
   - 不做缩放（零依赖、不解码像素）。5 MB 上限按原始字节计算，base64 后约 6.7 MB，超过 Bedrock/Vertex 系中转的 5 MB（base64）上限。
   - 历史里的图片每轮都会重发，没有按请求总字节控制（Anthropic 32 MB、Gemini inline 20 MB）。
   - 不支持 URL 或 file_id 来源（多数场景可以不做）。

---

## 1. 本地内置模型目录（models.dev 入库）

### 1.1 现状（读代码）

| 层         | 文件                                                                                                  | 现状                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 人工目录   | `src/ai/providers/catalog/*.json`（13 份）→ 生成的 `src/ai/providers/catalog-data.ts`                 | 每家 2–15 条，人工校对，字段有 `contextWindow / maxTokens / reasoning / input / cost / thinkingLevelMap / promptCache / compat / api`。生成方式：`UPDATE_CATALOG=1 pnpm vitest run src/ai/providers/catalog.test.ts`（`catalog.test.ts:28-56`） |
| models.dev | `src/ai/providers/models-dev.ts`（裁剪、索引、匹配、映射，纯计算）+ `models-dev-cache.ts`（下载缓存） | 运行时缓存在 `<dataDir>/models-dev.json`，约 2.3 MB。只在 `ama providers add/refresh`、`models discover`、`models refresh-catalog` 时联网，24h TTL + ETag（`models-dev-cache.ts:1-10`）                                                         |
| 补全       | `src/ai/providers/enrich.ts`                                                                          | 只给**自定义模型**补字段，优先级是 config > 目录 > models.dev > 缺省（`enrich.ts:1-7`）。内置目录模型不走 models.dev                                                                                                                            |
| 匹配       | `ModelsDevIndex.match()`（`models-dev.ts:244-321`）                                                   | 依次尝试：显式 → `vendor/model` → canonical → 原厂 → 多数 → 唯一；`FIRST_PARTY_PROVIDERS` 见 `models-dev.ts:38-61`                                                                                                                              |

所以「改为入库」的实际含义是：**把 `models-dev-cache.ts` 的运行时缓存换成仓库内快照**。`ModelsDevIndex` 和匹配逻辑可以原样复用，只换数据来源。是否保留 `refresh-catalog` 的联网刷新，可以作为可选项（见 §4 待定项）。

### 1.2 数据源与字段（实测 2026-10-02 的 `https://models.dev/api.json`）

- 结构：`{ [providerId]: { id, name, env[], npm, api?, doc, models: { [modelId]: Model } } }`。225 家供应商，5,294,262 字节。
  - 供应商级 `api` 是 OpenAI 兼容或 Anthropic 兼容的 baseUrl。例如 `minimax-cn` 的 `api` 是 `https://api.minimax.cn/anthropic/v1`，npm 是 `@ai-sdk/anthropic`，可以顺带作为协议线索。
  - 模型级 `provider: {npm, api, shape: "responses"|"completions"}` 覆盖少量条目。
- 模型字段全集（实测）：`id, name, description, family, attachment, reasoning, reasoning_options, tool_call, structured_output, temperature, release_date, last_updated, knowledge, modalities{input,output}, open_weights, limit{context,input,output}, cost{...}, canonical_model_id, status, interleaved, experimental, provider`。
  - `cost` 子键：`input, output, cache_read, cache_write, reasoning, input_audio, output_audio, context_over_200k{input,output,cache_read}, tiers[{input,output,cache_read,tier:{type:"context",size}}]`，单位是 $/1M token。
  - `limit.input`：少数模型的输入上限小于 context，例如 deepinfra 的 `tencent/Hy3`：context 262144、input 192000。
  - `status`：`deprecated` 或 `beta`。`reasoning_options[].type` 取值为 `effort` / `toggle` / `budget_tokens`。`interleaved`：`true` 或 `{field:"reasoning_content"|"reasoning_details"}`。
  - `modalities.input` 可能包含 `image / pdf / audio / video`。
- 仓库结构（`gh api repos/anomalyco/models.dev/contents`）：
  - 源数据是 TOML：`providers/<id>/provider.toml` 加 `providers/<id>/models/<model>.toml`。
  - 原厂通用元数据在 `models/<lab>/<model>.toml`；转售条目用 `base_model = "anthropic/claude-opus-5-5"` 继承，再覆盖 `cost` 等字段。生成后的 `api.json` 给出 `canonical_model_id`。
  - 还有 `models.json`（只含模型事实）和 `catalog.json`（两者合一），`?type=all` 能拿到专用模型。
  - 结论：**消费 `api.json` 即可，不要解析 TOML**。TOML 需要处理 `base_model` 继承，而且 benchmarks 等字段体积很大。
- 许可：`LICENSE` 为 MIT（[repo](https://github.com/anomalyco/models.dev)，[README](https://github.com/anomalyco/models.dev/blob/dev/README.md)）。MIT 要求「copies or substantial portions」保留版权与许可声明。建议做到：
  - 快照目录放一份 `LICENSE-models.dev`，或在 `THIRD_PARTY_NOTICES.md` 里写明；
  - 生成文件头注释写上来源 URL、抓取时间和 MIT 声明；
  - `docs/guides/providers.md` 标注出处。
  - 不要分发 logo SVG（logo 的权属不明确）。

### 1.3 覆盖厂商建议清单（models.dev provider id → 实测条目，按「过滤后条数 / 紧凑字节」）

| 厂商                   | models.dev id                                        | 过滤后条数                  | 紧凑大小 | 理由                                                                                                                     |
| ---------------------- | ---------------------------------------------------- | --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| Anthropic Claude       | `anthropic`                                          | 16                          | 3.1 KB   | 必选                                                                                                                     |
| OpenAI GPT / o / codex | `openai`                                             | 34                          | 6.9 KB   | 必选（含 gpt-6.x、5.x、o3/o4-mini、codex 系）                                                                            |
| Google Gemini          | `google`                                             | 21                          | 4.7 KB   | 必选                                                                                                                     |
| xAI Grok               | `xai`                                                | 7                           | 1.5 KB   | 必选                                                                                                                     |
| DeepSeek               | `deepseek`                                           | 2                           | 0.4 KB   | 必选                                                                                                                     |
| 月之暗面 Kimi          | `moonshotai`、`moonshotai-cn`                        | 4+4                         | 1.5 KB   | 必选（国内与国际价格不同，两份都留）                                                                                     |
| 智谱 GLM               | `zhipuai`、`zai`（国际）、`zhipuai-coding-plan` 可选 | 17+18                       | 5.6 KB   | 必选                                                                                                                     |
| 阿里通义 Qwen          | `alibaba-cn`、`alibaba`（国际）                      | 86+54                       | 22.7 KB  | 必选；条目最多，可再按 `family` 只留 qwen3.x、qwen-coder，以及百炼转售的 deepseek、kimi、glm                             |
| MiniMax                | `minimax-cn`、`minimax`                              | 7+7                         | 2.2 KB   | 必选（M2.x/M3）                                                                                                          |
| 阶跃星辰 StepFun       | `stepfun`（国内）、`stepfun-ai`（国际）              | 6+6                         | 2.2 KB   | 用户点名                                                                                                                 |
| 字节豆包（火山方舟）   | `volcengine`                                         | 16                          | 3.3 KB   | 国内常用；model id 带日期后缀，例如 `doubao-seed-2-1-pro-260628`                                                         |
| 腾讯混元               | `tencent-tokenhub`                                   | 3                           | 0.5 KB   | 国内常用（hy3、hy4-preview）                                                                                             |
| Mistral                | `mistral`                                            | 23                          | 3.7 KB   | 已内置                                                                                                                   |
| Meta                   | `meta`（Muse Spark）、`llama`（Llama API）           | 5+7                         | 1.0 KB+  | `llama` 条目老且 cost 为 0，可只留 `meta`                                                                                |
| 小米 MiMo              | `xiaomi`                                             | 6                           | 1.0 KB   | 国内新秀，可选                                                                                                           |
| Groq                   | `groq`                                               | 7                           | —        | 已内置                                                                                                                   |
| OpenRouter（子集）     | `openrouter`                                         | 236（按上表各家前缀过滤后） | 47.9 KB  | 已内置；聚合价不同于原厂，需要单独保留                                                                                   |
| **不收录**             | 百川、零一万物、百度千帆                             | —                           | —        | models.dev 里**没有**这几家（实测 `baichuan / 01-ai / qianfan / baidu` 都缺）。另外零一和百川的 API 已边缘化，不建议内置 |

合计约 108 KB 紧凑 JSON；如果改成 pretty 并多保留字段，约 370 KB。对 bundle 是可以接受的。

### 1.4 建议的仓库内格式

```
src/ai/providers/models-dev/
  _meta.json            # { source, license, fetchedAt, upstreamCommit?, sha256 }
  anthropic.json        # 一家一份，键按 id 排序，便于 diff
  openai.json
  ...
src/ai/providers/models-dev-data.ts   # 生成：MODELS_DEV_SOURCES: Record<id, string>（同 catalog-data.ts 手法）
```

单家文件的形状要和现有 `ModelsDevProvider` 兼容，这样 `ModelsDevIndex` 可以直接复用（`models-dev.ts:15-32`）。在现有裁剪字段的基础上补齐用户点名的字段：

```jsonc
{
  "id": "anthropic",
  "name": "Anthropic",
  "api": null,
  "npm": "@ai-sdk/anthropic",
  "models": {
    "claude-opus-5-5": {
      "name": "Claude Opus 5.5",
      "family": "claude-opus",
      "reasoning": true,
      "tool_call": true,
      "modalities": { "input": ["text", "image", "pdf"] },
      "limit": { "context": 1000000, "output": 128000 }, // 有 input 时保留
      "cost": { "input": 4, "output": 20, "cache_read": 0.2, "cache_write": 5 }, // 保留 context_over_200k / tiers
      "knowledge": "2026-06",
      "release_date": "2026-09-22",
      "last_updated": "2026-09-22",
      "reasoning_options": [
        { "type": "effort", "values": ["low", "medium", "high", "xhigh", "max"] },
      ],
      "interleaved": true,
      "status": "beta", // 有才写
      "canonical_model_id": "anthropic/claude-opus-5-5",
    },
  },
}
```

- 需要扩展 `trimModel()`（`models-dev.ts:109-141`）：新增 `family, knowledge, release_date, last_updated, limit.input, cost.context_over_200k / tiers, reasoning_options, interleaved, status`。`ModelCost.tiers` 已有类型（设计 §3.2），可以映射到 `tiers[{inputTokensAbove, ...}]`。
- 过滤规则：
  - 丢掉 `status: "deprecated"`；
  - 丢掉 `modalities.output` 不含 `text` 的（图像生成、TTS 等）；
  - 丢掉 `limit.context` 为 0 的；
  - `tool_call` 为 false 的条目也丢掉，编码 Agent 用不了。
- **与人工目录的关系**：保留 `catalog/*.json`，它负责 ama 特有字段（`thinkingLevelMap`、`promptCache`、`compat`、`api`）。快照负责数值事实。可以加一个测试：目录条目在快照里的 context、output、cost 若与快照不一致就报 warning，用来提示人工目录过期。是否改成「目录只写 ama 特有字段、数值从快照继承」见 §4 待定项。

### 1.5 生成脚本思路（`scripts/update-models-dev.mjs`，零依赖）

1. `fetch(AMA_MODELS_DEV_URL ?? "https://models.dev/api.json")`，Node 22 自带 fetch，超时 60s。失败时退出码 1，不写任何文件。
2. 校验：顶层是对象、供应商数 > 100，且清单里每个供应商都存在、条目数 ≥ 1。任一不满足就失败，防止上游改版后清空数据。
3. 按清单 `PROVIDERS`（与 §1.3 一致，放进脚本常量或 `models-dev/_providers.json`）裁剪和过滤。OpenRouter 按前缀白名单过滤。
4. 规范化：键排序（`Object.keys().sort()` 递归）、数字原样、2 空格缩进、末尾换行，确保无变化时字节完全相同。
5. 写每家的 JSON 和 `_meta.json`。`fetchedAt` **不要**放进会触发 diff 的位置，否则每次都有改动。建议 `_meta.json` 只存 `sha256(规范化内容)`；`fetchedAt` 只在内容 hash 变化时更新。
6. 生成 `models-dev-data.ts`。可以复用 `catalog.test.ts:29-44` 的 `generate()` 思路，抽到 `scripts/` 供两处共用。
7. 输出摘要：新增、删除的模型，以及 context、output、cost 发生变化的模型，写到 stdout 供 PR body 使用。

不要依赖 `If-None-Match`。Action 每次都全量拉，5 MB，可以接受。

### 1.6 GitHub Action 设计（`.github/workflows/models-dev.yml`）

```yaml
on:
  schedule: [{ cron: "17 3 * * 1" }] # 每周一 03:17 UTC
  workflow_dispatch: {}
permissions: { contents: write, pull-requests: write }
concurrency: { group: models-dev, cancel-in-progress: true }
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: node scripts/update-models-dev.mjs > /tmp/summary.md
      - run: pnpm prettier --write src/ai/providers/models-dev src/ai/providers/models-dev-data.ts
      - run: pnpm typecheck && pnpm vitest run src/ai/providers
      - id: diff
        run: git diff --quiet || echo "changed=1" >> "$GITHUB_OUTPUT"
      - if: steps.diff.outputs.changed == '1'
        uses: peter-evans/create-pull-request@v7
        with:
          branch: chore/models-dev-refresh # 固定分支：未合并时覆盖更新同一个 PR
          commit-message: "chore(providers): 刷新 models.dev 快照"
          title: "chore(providers): 刷新 models.dev 快照"
          body-path: /tmp/summary.md
          labels: models-dev
```

要点：

- 固定分支 + `create-pull-request` 会自动复用已开的 PR，避免每周堆积新 PR。
- 用 `GITHUB_TOKEN` 创建的 PR **不会触发** `on: pull_request` 的 CI。必须改用 PAT 或 GitHub App token，或者在本 workflow 里先把 `pnpm run ci` 跑完。项目约定 CI 绿了才合并（见用户的 fine-commits 偏好），所以建议用 App token 让 `ci.yml` 正常跑。
- 校验阈值：单次「删除模型」超过 30% 时，在 PR 上加 `needs-review` 标签而不是失败，因为上游也可能是批量清理。
- 该 workflow 不发布、不推 main，只开 PR，符合「merge 手动」的约定。

---

## 2. 协议优先级（Anthropic Messages / OpenAI Responses 优先，Chat 回落）

### 2.1 厂商 × 协议 × 缓存 × base URL 表

缓存列说明：「显式」= 端点执行 `cache_control` 或 `prompt_cache_options`；「自动」= 前缀自动缓存，ama 无需打点；「路由键」= `prompt_cache_key` 或 header 只用于粘性路由。

| 厂商                 | Anthropic Messages                                                                                                                                                             | Responses                                                                                                           | Chat                                                                                            | 缓存机制                                                                                                                                                         | 缓存字段（usage）                                                                                             | 证据                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anthropic            | `https://api.anthropic.com`（原生）                                                                                                                                            | —                                                                                                                   | （OpenAI SDK 兼容层，不建议用）                                                                 | 显式 `cache_control`，5m / 1h                                                                                                                                    | `cache_read_input_tokens` / `cache_creation_input_tokens`                                                     | 官方                                                                                                                                                                                                                                                                                 |
| OpenAI               | —                                                                                                                                                                              | `https://api.openai.com/v1/responses`                                                                               | 同 base `/chat/completions`                                                                     | 自动 + `prompt_cache_key` 路由；`prompt_cache_retention:"24h"`                                                                                                   | Responses: `input_tokens_details.cached_tokens`                                                               | [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)                                                                                                                                                                                                       |
| Google Gemini        | 无                                                                                                                                                                             | 无                                                                                                                  | `.../v1beta/openai/`（兼容层缺 thoughtSignature）                                               | 隐式自动（另有显式 `cachedContents` API）                                                                                                                        | `cachedContentTokenCount`                                                                                     | 原生协议已在 ama 实现                                                                                                                                                                                                                                                                |
| xAI Grok             | `/v1/messages` 仍可用但官方标注 **deprecated**                                                                                                                                 | `https://api.x.ai/v1/responses`                                                                                     | 同 base                                                                                         | 自动；Responses 建议 `prompt_cache_key`，Chat 用 `x-grok-conv-id` 头；无公开 TTL                                                                                 | `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens`                                  | [xAI prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching)、[best practices](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices)                                                                                                |
| DeepSeek             | `https://api.deepseek.com/anthropic`。支持 image（base64/url/file）、tools、thinking（`budget_tokens` 被忽略）；**`cache_control` 被忽略**；不支持 document、redacted_thinking | 官方未提供（中转的 Responses 对缓存字段报 400，见 providers.md 中转实测）                                           | `https://api.deepseek.com`                                                                      | 自动前缀缓存（默认开，TTL 数小时至数天）                                                                                                                         | Chat：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；Messages 经中转实测有 `cache_read_input_tokens` | [anthropic_api](https://api-docs.deepseek.com/guides/anthropic_api)、[kv_cache](https://api-docs.deepseek.com/guides/kv_cache)                                                                                                                                                       |
| 智谱 GLM             | `https://open.bigmodel.cn/api/anthropic`                                                                                                                                       | `https://open.bigmodel.cn/api/v1`（Coding Plan 文档面向编码工具；按量是否可用待实测）                               | `https://open.bigmodel.cn/api/paas/v4`；Coding Plan 是 `/api/coding/paas/v4`；国际站 `api.z.ai` | **仅隐式**，不支持显式；命中约 50% 价；建议 > 500 token                                                                                                          | `prompt_tokens_details.cached_tokens`                                                                         | [Claude API 兼容](https://docs.bigmodel.cn/cn/guide/develop/claude/introduction)、[上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache)                                                                                                                                 |
| Kimi                 | `https://api.moonshot.cn/anthropic`（国际 `.ai`）                                                                                                                              | `https://api.moonshot.cn/v1/responses`                                                                              | `https://api.moonshot.cn/v1`                                                                    | 自动（256 token 块），`prompt_cache_key` 为路由提示；`prompt_cache_options.ttl` 可选 `5m` / `1h`                                                                 | 顶层 `cached_tokens`，以及 `prompt_tokens_details.cached_tokens` / `cache_write_tokens`                       | [API 概述](https://platform.kimi.com/docs/api/overview)、[Chat API](https://platform.kimi.com/docs/api/chat)                                                                                                                                                                         |
| 通义 Qwen（百炼）    | `https://dashscope.aliyuncs.com/apps/anthropic`（国际 `dashscope-intl`；Coding Plan 用 `coding.dashscope...`）                                                                 | `https://dashscope.aliyuncs.com/compatible-mode/v1/responses`（部分模型不支持）                                     | `.../compatible-mode/v1`                                                                        | **隐式 + 显式**：`cache_control:{type:"ephemeral"}` 在 Chat、Anthropic 上都生效，5m，命中时重置；≥ 1024 token；显式写入 125%、命中 10%，隐式命中 20%             | Chat：`cached_tokens`、`cache_creation_input_tokens`                                                          | [context cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)、[Anthropic 兼容](https://www.alibabacloud.com/help/zh/model-studio/anthropic-api-messages)、[Responses](https://www.alibabacloud.com/help/en/model-studio/compatibility-with-openai-responses-api) |
| MiniMax              | `https://api.minimaxi.com/anthropic`（国际 `api.minimax.io`）。**官方推荐**用此端点                                                                                            | `https://api.minimaxi.com/v1/responses`（M3）                                                                       | `https://api.minimaxi.com/v1`                                                                   | M2.x：显式 `cache_control`，5m，读 0.1×、写 1.25×。M3：被动自动缓存（≥ 512 token）；第三方报告 M3 在 Messages 端点忽略 `cache_control`，两方说法冲突，**待实测** | Anthropic 形状                                                                                                | [Anthropic 主动缓存](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache)、[Prompt 缓存](https://platform.minimaxi.com/docs/api-reference/text-prompt-caching)、[Responses](https://platform.minimaxi.com/docs/api-reference/responses-create)             |
| 阶跃 StepFun         | `https://api.stepfun.com`（`/v1/messages`；Step Plan 用 `/step_plan`）                                                                                                         | `https://api.stepfun.com/v1/responses`（按模型开放：step-5-preview 可用，step-3.5-flash 不可用）                    | `https://api.stepfun.com/v1`                                                                    | 自动（256 token 最小，LRU）                                                                                                                                      | 待实测                                                                                                        | [Messages API](https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create)、[prompt cache](https://platform.stepfun.ai/docs/en/guides/developer/prompt-cache)                                                                                                           |
| 字节豆包（火山方舟） | **仅 Coding Plan**：`https://ark.cn-beijing.volces.com/api/coding`（额度只限编程工具）                                                                                         | `https://ark.cn-beijing.volces.com/api/v3/responses`（推荐）                                                        | `.../api/v3`                                                                                    | 隐式（≥ 1024，Chat 与 Responses 都有）；显式需在 Responses 发 `caching:{type:"enabled"}`（≥ 256，存储收费）                                                      | `prompt_tokens_details.cached_tokens`（Responses 为 `input_tokens_details`）                                  | [Responses API](https://docs.volcengine.com/docs/ark/responses-api)、[缓存选型](https://www.volcengine.com/docs/82379/1398933)                                                                                                                                                       |
| 腾讯混元（TokenHub） | `https://tokenhub.tencentmaas.com`（`/v1/messages`，`x-api-key`）；旧版 `api.hunyuan.cloud.tencent.com/anthropic`                                                              | 未见                                                                                                                | `https://tokenhub.tencentmaas.com/v1`                                                           | Anthropic：`cache_control`，含 `ttl:"1h"`。OpenAI：自动 + `prompt_cache_key`                                                                                     | 两种形状都有                                                                                                  | [TokenHub Anthropic](https://cloud.tencent.com/document/product/1823/135874)、[混元 Anthropic](https://cloud.tencent.com/document/product/1729/127293)                                                                                                                               |
| OpenRouter           | `https://openrouter.ai/api/v1/messages`                                                                                                                                        | `https://openrouter.ai/api/v1/responses`（已 GA）                                                                   | `.../chat/completions`                                                                          | 按上游；`anthropic/*` 需 `cache_control`；流式时缓存 usage 只出现在 `message_delta`                                                                              | 视协议                                                                                                        | [Responses](https://openrouter.ai/docs/api/reference/responses/basic-usage)、[Messages](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message)、[changelog](https://openrouter.ai/docs/changelog)                                                         |
| Groq                 | 无                                                                                                                                                                             | `https://api.groq.com/openai/v1/responses`（不支持 `prompt_cache_key`、`store`、`include`、`previous_response_id`） | 同 base                                                                                         | 自动，命中 5 折                                                                                                                                                  | `input_tokens_details.cached_tokens`                                                                          | [Responses](https://console.groq.com/docs/responses-api)、[caching](https://console.groq.com/docs/prompt-caching)                                                                                                                                                                    |
| Mistral              | 无                                                                                                                                                                             | 无（自有 `/v1/conversations`，形状不同）                                                                            | `https://api.mistral.ai/v1`                                                                     | `prompt_cache_key`（64 token 块，命中 10% 价）                                                                                                                   | `prompt_tokens_details.cached_tokens`                                                                         | [prompt caching](https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching)                                                                                                                                                                                           |

> 第三方来源（论坛、博客、GitHub issue）已在表中注明「第三方」或「待实测」。上表中的官方 URL 均为本次检索所得。

### 2.2 怎么选（原则）

1. **能执行显式缓存的 Messages 端点** → 选 messages。ama 已经有三断点、TTL 校验和 400 剥离。适用：Anthropic、通义、MiniMax M2.x、腾讯 TokenHub。
2. **只有自动缓存的厂商**：协议对缓存命中影响不大，主要看哪条协议的 reasoning 回放和工具调用更完整。
   - Kimi、DeepSeek、智谱、阶跃都把编码工具经 Messages 端点接入当作一等场景，Messages 端点的 thinking 签名回放和工具流更成熟。
   - Chat 线要靠 `reasoning_content` 等私有字段（`requiresReasoningContentOnAssistantMessages`、`thinkingFormat`），compat 分支多。
   - 所以建议 messages 优先，chat 作为渠道回落。
3. **Responses**：OpenAI（全部模型）、xAI（官方已把 Anthropic 兼容标为 deprecated）走 responses；豆包首选 responses（显式缓存只在 Responses 上有）；OpenRouter 可选。
4. **Chat 只做回落**：Mistral、Groq（Responses 缺 store/include，回放 encrypted reasoning 不可用）、Ollama、LM Studio、自定义中转。

### 2.3 ama 内置供应商推荐默认值（对照 `src/ai/providers/builtin.ts`）

| id（行号）                     | 现状 api / baseUrl                                 | 建议默认渠道                                                                        | 回落渠道                        | 改动说明                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`（L19）             | messages                                           | 不变                                                                                | —                               | —                                                                                                                                                              |
| `openai`（L29）                | `openai-completions`；目录推理模型覆盖为 responses | **供应商级改为 `openai-responses`**                                                 | `chat`                          | `gpt-4.1` / `gpt-4o*` 也支持 Responses。去掉目录里的逐条 `api` 覆盖（openai.json 有 12 处）                                                                    |
| `google`（L38）                | gemini                                             | 不变                                                                                | （可选 chat：`/v1beta/openai`） | —                                                                                                                                                              |
| `deepseek`（L47）              | chat，`https://api.deepseek.com`                   | `anthropic-messages`，`https://api.deepseek.com/anthropic`                          | `chat`                          | Messages 上 `cache_control` 被忽略，无害，但应该关掉打点，或依赖 400 剥离（实际不报错）；`budget_tokens` 被忽略 → thinking 映射要确认                          |
| `moonshot`（L55）              | chat，`api.moonshot.cn/v1`                         | `anthropic-messages`，`https://api.moonshot.cn/anthropic`                           | `responses`、`chat`             | 已知 K3 在 Messages 端点有复用 `tool_use.id` 的 bug（第三方论坛，2026-08），**需要实测后再定默认值**；国际站 `.ai` 做成渠道                                    |
| `zhipu`（L63）                 | chat，`/api/paas/v4`                               | `anthropic-messages`，`https://open.bigmodel.cn/api/anthropic`                      | `chat`                          | 只有隐式缓存；国际 `api.z.ai/api/anthropic` 做成渠道                                                                                                           |
| `dashscope`（L71）             | chat                                               | `anthropic-messages`，`https://dashscope.aliyuncs.com/apps/anthropic`               | `responses`、`chat`             | 显式缓存 5m（不支持 1h，`supportsLongCacheRetention` 保持关）；也可以在 chat 上打 `cacheControlFormat:"anthropic"`                                             |
| `openrouter`（L79）            | chat                                               | 保持 chat；`anthropic/*` 模型级选 `messages`（`/api/v1/messages`）                  | —                               | 流式 usage 在 `message_delta` 读取。ama Anthropic 解析是否合并 `message_delta.usage` 中的 input/cache 字段需要核对                                             |
| `groq`（L91）                  | chat                                               | 不变                                                                                | —                               | Responses 缺 store/include                                                                                                                                     |
| `xai`（L99）                   | chat；目录覆盖为 responses                         | **供应商级改为 `openai-responses`**                                                 | `chat`                          | 官方 Responses 推荐 `prompt_cache_key` → 把 `api.x.ai` 加入 `sendPromptCacheKey` 的缺省开名单（`cache-params.ts:26,51-53`）；Chat 回落时加 `x-grok-conv-id` 头 |
| `mistral`（L107）              | chat                                               | 不变；`sendPromptCacheKey` 对 `api.mistral.ai` 缺省开                               | —                               | Mistral 官方支持 `prompt_cache_key`                                                                                                                            |
| **新增** `minimax`             | —                                                  | `anthropic-messages`，`https://api.minimaxi.com/anthropic`（国际 `api.minimax.io`） | `responses`、`chat`             | M3 的缓存行为需要实测                                                                                                                                          |
| **新增** `stepfun`             | —                                                  | `anthropic-messages`，`https://api.stepfun.com`                                     | `chat`（responses 按模型）      | —                                                                                                                                                              |
| **新增** `volcengine`（ark）   | —                                                  | `openai-responses`，`https://ark.cn-beijing.volces.com/api/v3`                      | `chat`                          | 显式缓存需要新的 compat，用来发送 `caching:{type:"enabled"}`                                                                                                   |
| **新增** `tencent`（tokenhub） | —                                                  | `anthropic-messages`，`https://tokenhub.tencentmaas.com`                            | `chat`                          | 支持 1h TTL（官方文档），可开 `supportsLongCacheRetention`                                                                                                     |

**代码层面需要改的地方：**

1. `BuiltinProvider` 需要支持**内置渠道**（现在 `channels` 只来自用户 config，`src/ai/providers/channels.ts:26-50`）。建议给 `BUILTIN_PROVIDERS` 增加 `channels?: ProviderChannel[]` 和 `defaultChannel`，`registry.ts` 物化时与用户 config 合并（用户的覆盖内置）。
2. `isRelayedBaseUrl()`（`builtin.ts:142-146`）只比较供应商级 baseUrl 的主机名。DeepSeek 的 `/anthropic` 与 chat 同主机，不受影响；智谱 `/api/anthropic` 也同主机，同样不受影响。
3. **Anthropic compat 推断表**：仿照 `openai-compat.ts:72-96` 的 baseUrl 子串表，给 `detectAnthropicCompat` 加规则（`anthropic-request.ts:69-74`）。
   - 规则内容：非 `api.anthropic.com` 时关闭 `adaptiveThinking`，或按厂商设置；DeepSeek 不发 interleaved-thinking beta；控制 `maxCacheBreakpoints`；控制 1h TTL。
   - 依据：ama 在有工具时会加 `INTERLEAVED_THINKING_BETA`（`anthropic-request.ts:278`），第三方端点可能拒收未知 beta 头。providers.md 的中转实测显示被接受，但官方直连未测。
4. `OFFICIAL_HOSTS`（`cache-params.ts:26`）改成按主机配置能力：

   ```ts
   { "api.x.ai": { sendPromptCacheKey: true },
     "api.mistral.ai": { sendPromptCacheKey: true },
     "api.moonshot.cn": { sendPromptCacheKey: true },
     "tokenhub.tencentmaas.com": { supportsLongCacheRetention: true }, ... }
   ```

   Kimi 的 `prompt_cache_options.ttl:"1h"` 可以对应 `supportsExplicitPromptCacheMode`，但 Kimi 的形状是 Chat 的 `prompt_cache_options.ttl`，要先核对 ama 在 Chat 线上是否支持这个字段。

5. 目录：新增 `catalog/minimax.json`、`stepfun.json`、`volcengine.json`、`tencent.json`。`catalog.test.ts:58-64` 断言目录集合等于 `BUILTIN_PROVIDERS`，需要同步。
6. 文档：`docs/guides/providers.md`「内置供应商」表（L76 起）与 `docs/design/design.md` §3.3 表要同步。

---

## 3. 图像输入

### 3.1 协议层序列化（读代码）

| 协议                 | 用户消息                                                       | 工具结果中的图                                                                                   | 不收图模型                                                                              | 位置                                           |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| anthropic-messages   | `{type:"image", source:{type:"base64", media_type, data}}`     | `tool_result.content` 为块数组（含 image）                                                       | 由 `normalizeContext` 统一替换                                                          | `anthropic-request.ts:127-141, 181-193`        |
| openai-completions   | `{type:"image_url", image_url:{url:"data:<mime>;base64,..."}}` | tool 消息只放文本；图片另起一条 user 消息「Images from the tool results:」（必要时插入助手桥接） | 同上，另有 `model.input` 判断                                                           | `openai-request.ts:68-80, 128-190`             |
| openai-responses     | `{type:"input_image", detail:"auto", image_url:"data:..."}`    | `function_call_output.output` 为数组（`input_text` + `input_image`）                             | 同上                                                                                    | `openai-responses-request.ts:143-160, 204-226` |
| google-generative-ai | `{inlineData:{mimeType,data}}`                                 | `functionResponse.parts`（Gemini 3+），否则另起 user 回合                                        | 同上                                                                                    | `google-request.ts:100-120, 165-190`           |
| 统一过滤             | —                                                              | —                                                                                                | 模型 `input` 不含 image → 换成 `[image omitted: the model does not accept image input]` | `src/ai/context.ts:32, 60-91`                  |

结论：**base64 路径完整**，有测试覆盖（`src/ai/apis/image-input.test.ts`）。不支持的来源：URL 和 file_id。`ImageBlock` 只有 `{data, mimeType}`（`src/ai/types.ts:92-97`）。

### 3.2 各厂商兼容端点的图像差异

| 端点                        | 来源格式                                                                                   | 大小与尺寸                                                                                                                                                                                 | 备注                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Anthropic 官方              | base64 / url / file_id                                                                     | 单图 **10 MB（base64 后）**；Bedrock / Vertex 为 5 MB（base64 后）；请求总量 32 MB；单图最大 8000×8000；单请求超过 20 图时每边 ≤ 2000 px；长边 1568（标准）/ 2576（4.7+ 高分辨率）会被缩放 | [vision](https://platform.claude.com/docs/en/build-with-claude/vision)           |
| OpenAI                      | data URL / http URL / file_id；`detail` 可选 low/high/original/auto                        | 单请求 512 MB、1500 图；PNG/JPEG/WEBP/非动画 GIF                                                                                                                                           | [images-vision](https://developers.openai.com/api/docs/guides/images-vision)     |
| Gemini 原生                 | inlineData / File API / URL                                                                | 文档写 inline 请求总量 20 MB；2026-01 的公告提到 100 MB（两处说法不一致，按 20 MB 保守处理）；3600 图                                                                                      | [image-understanding](https://ai.google.dev/gemini-api/docs/image-understanding) |
| DeepSeek Messages           | base64（jpeg/png/gif/webp）/ url / file                                                    | 未写上限                                                                                                                                                                                   | 只有 `deepseek-flash` 收图（目录与 models.dev 一致）                             |
| Kimi                        | **只能 base64 data URL 或 `ms://<file-id>`，不支持公网 URL**；`image_url` 可以直接传字符串 | 建议 ≤ 4K 分辨率；请求体有总量限制但未写数值                                                                                                                                               | [视觉模型](https://platform.kimi.com/docs/guide/use-kimi-vision-model)           |
| 智谱                        | `image_url`：URL（推荐）或 base64 data URL                                                 | GLM-5V 未写；旧 4V 为 5 MB / 6000 px（第三方）                                                                                                                                             | [GLM-5.3-Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)      |
| 通义                        | data URL / URL                                                                             | —                                                                                                                                                                                          | [vision](https://www.alibabacloud.com/help/en/model-studio/vision)               |
| 中转（Bedrock / Vertex 系） | 只有 base64                                                                                | **5 MB（base64 后）**                                                                                                                                                                      | 很多中转背后是 Bedrock，风险最高                                                 |

### 3.3 ama 入口现状

| 入口               | 现状                                                                                                                                               | 位置                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `read` 工具        | png/jpg/gif/webp 返回 ImageBlock（MIME 按文件头识别）；模型不收图或文件超过 5 MB 时只返回路径与尺寸                                                | `src/tools/read.ts:48-92`          |
| `ama -p --image`   | 显式附件；模型不收图时退出 2                                                                                                                       | `src/modes/image-input.ts:67-90`   |
| `@图片路径`        | 显式附件，支持引号和 `~`                                                                                                                           | `image-input.ts:27-51`             |
| 粘贴或拖入路径     | 以图片扩展名结尾且文件存在的词视为隐式附件；模型不收图时静默忽略                                                                                   | 同上                               |
| RPC                | `prompt` 支持 `images`                                                                                                                             | `src/modes/rpc/commands.ts:173`    |
| 长输出截断         | 保留图片块                                                                                                                                         | `src/agent/tool-runner.ts:210-217` |
| 压缩估算           | 每张图按 1600 token 计                                                                                                                             | `src/compaction/estimate.ts:13`    |
| **剪贴板位图粘贴** | **没有**。终端只开了 bracketed paste（`src/tui/terminal.ts:25`），没有读取系统剪贴板图片的路径（全仓库搜不到 pbpaste、osascript、wl-paste、xclip） | —                                  |

### 3.4 要实现的清单（按优先级）

1. **P1 大小按 base64 后计算，并给中转一个更小的上限**：`MAX_IMAGE_BYTES = 5 MB` 现在比较的是原始字节（`image-file.ts:14,116`；`read.ts:64`），base64 后约 6.7 MB。
   - 修法：改成 `ceil(bytes/3)*4 ≤ limit`。
   - 上限按端点区分：官方 Anthropic 10 MB；`isRelayedBaseUrl` 为真或主机未知时取 5 MB（base64 后，即原始约 3.75 MB）。
2. **P1 单次请求的图片总量预算**：base64 图在历史里每轮重发，几张截图就可能超过 Anthropic 32 MB 或 Gemini 20 MB 的请求上限，返回 413。
   - 修法：在 `normalizeContext` 里按协议预算从最旧的图开始降级为占位文本（复用 `IMAGE_OMITTED_TEXT` 的机制，换一条文案，例如「earlier image omitted to fit request size」）。
   - 注意：降级会改变前缀，导致缓存失效，所以只在超预算时触发，而且要一次多降一些，减少反复失效。
3. **P1 尺寸检查**：已有 `imageSize()`。超过 8000 px 的图直接拒绝（Anthropic 会 400）。单请求超过 20 图时检查每边 ≤ 2000 px，否则同样按第 2 条降级旧图。
4. **P2 剪贴板图片粘贴**：零依赖的做法是调用系统命令。
   - macOS：`osascript -e 'the clipboard as «class PNGf»'` 或 `pngpaste`；
   - Wayland：`wl-paste -t image/png`；X11：`xclip -selection clipboard -t image/png -o`；
   - Windows：PowerShell `Get-Clipboard -Format Image`。
   - 绑定 Ctrl+V 或 `/paste-image`，把结果写进临时文件，再走 `loadImageFile`。没有对应工具时给出提示。
   - Armadra 嵌入（tmux 节点）场景下拿不到剪贴板，需要宿主通过 RPC `images` 注入。
5. **P2 缩放**：零依赖无法解码 JPEG/PNG。可选方案：
   - (a) 调用系统工具（macOS `sips -Z 2000`、`magick`、`ffmpeg`），找不到就跳过；
   - (b) 不缩放，只在文件超过上限时报错。
   - 建议先做 (a) 的 macOS `sips` 和 Linux `magick`，作为可选能力。
6. **P3 Kimi、智谱等的格式差异**：ama 一律发送 data URL，Kimi 必须用 data URL 而且已满足；智谱接受 data URL。**不需要按厂商改格式**。只需在 Anthropic 兼容端点确认 DeepSeek 的 `media_type` 白名单（jpeg/png/gif/webp，与 ama 的嗅探一致）。
7. **P3 `detail` 与高分辨率**：Responses 固定 `detail:"auto"`（`openai-responses-request.ts:146`）。截图类任务可以考虑 `high`；暂不需要做。
8. **P3 图像能力的来源**：目录与快照的 `modalities.input` 已映射到 `input`（`models-dev.ts:334-335`）。入库快照后，自定义模型能离线拿到 image 能力，`@图片` 的拒绝判断会更准确。

---

## 4. 风险与待定项

1. **Messages 兼容端点的细节差异需要逐家实测**，至少覆盖：thinking 回放（签名）、`tool_use.id` 唯一性（Kimi K3 有第三方 bug 报告）、`anthropic-beta` 头是否被拒、`max_tokens` 上限、流式 usage 出现在哪个事件（OpenRouter 只在 `message_delta`）。建议在把默认值切到 messages 前，用 `ama models check` 和 `cache-probe` 对每家官方直连跑一轮，结果记入 providers.md「中转实测」同款表格。
2. **DeepSeek、智谱改成 messages 的收益不确定**。两家都只有隐式缓存，切换主要是为了统一 usage 和 thinking 回放。如果实测 Messages 端点的 reasoning 质量或稳定性不如 chat，就保留 chat。
3. **MiniMax M3 的缓存在 Messages 端点是否生效**：官方被动缓存文档与第三方提交（「M3 在 /anthropic 忽略 cache_control，应走 chat」）说法冲突，需要实测 `cache_read_input_tokens`。
4. **Coding Plan 端点的合规问题**：火山方舟、阿里、智谱的 Coding Plan 额度只能在编程工具里用，非交互或脚本调用可能导致封号。ama 是编程工具，但 `-p` 和 RPC 嵌入属于自动化调用。内置渠道只提供按量端点；Coding Plan 端点写进文档，由用户自己配置渠道。
5. **models.dev 数据质量**：
   - 存在 `limit.output == context` 的情况（例如 grok-4.7 为 500000/500000）；ama 已用 65536 封顶（`models-dev.ts:63, 332`）。
   - 转售价与原厂价不同，例如 alibaba-cn 的 kimi-k3 与 moonshotai-cn 的价格不同；匹配逻辑已经优先选原厂。
   - 上游提交频繁，偶尔会出现错误值。PR 要人工审 diff 摘要。
6. **快照与 `refresh-catalog` 联网是否并存**（待定）。用户要求运行时不联网。建议默认只用快照，`ama models refresh-catalog --online` 作为显式选项保留，用户主动执行时才写入用户数据目录覆盖快照；或者直接删除联网路径，简化代码。
7. **人工目录是否改为从快照继承数值**（待定）。继承可以减少人工维护，但 ama 目录里有「人工校对、与 models.dev 不同」的值，例如 `maxTokens` 有意调小，需要逐条决定以哪个为准。
8. **版权与署名**：MIT 只要求保留版权与许可声明。logo 和 benchmarks 不要搬运。
9. **bundle 体积**：快照约 108 KB，加生成的 TS 转义后约 130 KB，可以接受。如果 OpenRouter 不做前缀过滤（322 条，紧凑约 60 KB 以上），可以考虑只保留原厂。
10. **xAI Anthropic 兼容**已被官方标为 deprecated，不要作为渠道。
11. **Gemini inline 上限**：官方页面写 20 MB，2026-01 的公告写 100 MB，按 20 MB 保守实现。
12. 本次没有实测任何厂商端点，也没有读取或使用 `~/.config/ama-test/packy.env`。表中「待实测」项需要后续拿真实 key 验证。
