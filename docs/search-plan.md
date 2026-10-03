# 检索与网络搜索设计

> 状态：设计稿（2026-10-03），待用户看过「效果演示」（§8）后决定实施范围。基线：`main` = `1094ad7`（0.6.3 已发布）。
> 设计依据：`docs/design.md`（§5.2 工具规格、§5.6 预设、§7 权限、§9.1 缓存保证、§10 配置）、`docs/permissions.md`、`docs/sandbox.md`、`docs/providers.md`、`docs/gap-audit-2026-10.md`（2026-10-02 曾决定「不做内置 WebFetch / WebSearch；P2 做供应商原生 web search 透传」，本文按新的用户反馈与实测重新评估并推翻该项）。各家供应商的接口形状来自官方文档与本机对中转站的实测（§1.3、§2）；同类产品只学行为，不复制代码。
> 硬约束不变：TypeScript、Node ≥ 22、**零运行时依赖**、单文件 ≤ 600 行、单 bundle、缓存前缀逐字节稳定（§9.1）、提示预算（`src/cli/prompt-budget.test.ts` 三档不得突破）、**权限请求不代答**、项目级配置只能收紧。
> 路径相对仓库根；`[S-x]` 为本计划批次编号（§5）。

## §0 结论

用户感觉「ama 没有检索能力」，实测拆成三件事，只有第一件是真的缺：

| #   | 决定                                                                                                                                                                                                                                                                                                                                                                     | 理由 / 证据                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **网络检索确实没有**：ama 没有任何 web 工具，模型遇到「查最新版本 / 看某个文档页」只能走 `bash curl` / `npm view`，在 `default` 权限模式下每次询问、`-p` 下直接被拒，连 codemode 脚本里的 `tools.bash` 也被拒（§1.3 E4 / E5：两个模型各试了 5 次 bash 全被拒，最后没有答案）。这就是用户看到的「没有检索能力」。                                                         | 实验 E4 / E5；`docs/gap-audit-2026-10.md` 的「curl 加 Skill 已经够用」在 `default` 模式与 `-p` 下不成立                                                                                                                                                    |
| D2  | **本地检索能力是有的、模型也会主动用**：`default` 预设下 DeepSeek 与 Kimi 收到「哪些文件读了环境变量」都第一轮就调 `grep`（E1 / E2）。问题在边缘：`minimal` 预设没有 grep / glob，模型用 `bash grep` 被拒后只能靮猜文件名（E3：6 轮 20 次 `read` 猜路径全部失败）；`read` 传目录时报「use the ls tool instead」而 `ls` 不在 `default` 预设里；没有「先定位再读」的规则。 | 实验 E1–E3；`src/tools/read.ts` 的目录错误文案；`src/agent/prompt-rules.ts` 只有两条规则                                                                                                                                                                   |
| D3  | **本地检索不新增工具**，只做三处小改：`read` 的目录提示按活动集说「用 glob / ls」；`rules` 节在 grep 与 glob 都可用时加一句「先 grep / glob 定位再 read，不要猜路径」；`grep` 加 `filesOnly`（只列命中文件，大仓库先缩范围）。符号 / 语义检索不做内置（零依赖做不好，LSP 是另一期）。                                                                                    | §4.2；三处合计 ≤ 40 token 前缀增量                                                                                                                                                                                                                         |
| D4  | 新增内置 **`web_fetch`**（URL → 正文 Markdown / 文本，零依赖 HTML 转换，不做二次模型提取），权限类新增 **`network`**：default / auto-edit 询问（可「本会话允许该域名」）、plan 询问、allowlist 只放行 allow 规则命中、auto 规则层拒私网 → 分类器、full-auto 放行。私网 / 环回 / 链路本地 / 云元数据地址一律拒绝（DNS 解析后检查并钉住 IP）。                             | §4.3、§4.6；Claude Code 的 WebFetch 在 Manual 下也询问；Gemini CLI 的 web_fetch 弹确认且拒私网                                                                                                                                                             |
| D5  | 新增内置 **`web_search`**，后端三选一按序回落：**模型原生搜索 → 外部搜索 API（有 key 才算有）→ 都没有则不注册该工具**，由 `search.provider` 控制（缺省 `auto`）。外部 API 首期接 Brave、Tavily、Exa、Serper 四家与自建 SearXNG；**不接 DuckDuckGo HTML**（违反其条款、202 限流）。                                                                                       | §2、§4.4；四家都是「一个 GET/POST + JSON」，零依赖可做；DDG 实测社区报告见 §2.3                                                                                                                                                                            |
| D6  | 原生搜索按**协议层服务端工具**实现，不走 ama 的函数工具：会话开始按模型能力与配置一次确定（写进 `StreamOptions.serverTools`，进缓存指纹），会话内不变；中途 `/model` 切换按工具表补丁处理。首期只做 OpenAI Responses（含 xAI、中转透传、ChatGPT 订阅后端）与 Anthropic Messages 两条线，Gemini / Kimi / 通义 / 智谱 / OpenRouter 第二期。                                | 中转站实测：grok-4.7 走 Responses 的 `web_search` 完整透传（含 `web_search_call`、`url_citation`、`server_side_tool_usage`，§1.3 P-A）；Kimi `$web_search` 透传但结果可疑（P-B2）；通义 `enable_search` 被吞（P-C）；智谱 `web_search` 工具类型被拒（P-D） |
| D7  | 引用是一等数据：助手文本块加可选 `citations[]`（url、title、位置、摘录），服务端工具调用加 `serverTool` 内容块（原始 JSON 不透明保存，只回放给同 provider / model / api；跨模型由 `transform.ts` 降成一行文字）。TUI 以脚注 `[n]` 呈现并在消息末尾列来源；`-p` text 末尾加 `Sources:`；`-p json` / RPC 原样带 `citations` 与 `server: true` 的工具事件。                 | §4.5、§4.8；Anthropic 的 `encrypted_content` / `encrypted_index` 必须原样回放，否则 400                                                                                                                                                                    |
| D8  | 工具表与预算：`web_fetch` 进 `default` 预设（有网络就有），`web_search` 只在后端解析到时进；两者各 ≤ 150 token。实测 `default` 前缀现约 960 token（strict 运行时含 codemode 约 1 350），加两工具约 1 600，`PROMPT_BUDGETS.default = 2000` 不动。`minimal` / `coordinator` 不加（显式 `+web_fetch` 可加）。                                                               | §4.7；`node` 估算脚本对 `dist/` 的测量                                                                                                                                                                                                                     |
| D9  | 嵌入 Armadra：宿主用已有的 `tools.disable("web_fetch" / "web_search")` 或 profile 新键 `web: { fetch: false, search: false }` 关闭；缺省开。项目级 `.ama/config.json` 只能关（`web.fetch.enabled: false`、`search.provider: "off"`）或加 deny 规则。                                                                                                                     | 与 `task` 的处理一致（§5.4 / §7.2）                                                                                                                                                                                                                        |
| D10 | 外部搜索 API 的 key 走 `auth.json`，条目 id 用 `brave-search` / `tavily` / `exa` / `serper` 这样的「搜索供应商 id」（与模型供应商同一张表、同一条 `ama auth set` 命令），环境变量 `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` / `EXA_API_KEY` / `SERPER_API_KEY`；key 绝不进会话、日志、事件。                                                                             | §4.4；复用 `resolveApiKey` 的发现顺序（配置 → auth.json → 环境变量）                                                                                                                                                                                       |

## §1 现状与实验记录

### §1.1 本地检索现状

- 内置工具 `grep`（JS 正则、尊重 `.gitignore` / `.ignore`、跳二进制与 > 2 MB、16 并发、100 命中上限、50 KB 头截断）、`glob`（`**` / `{a,b}` / `!`、mtime 倒序、1000 上限）、`read`、`ls`（`src/tools/{grep,glob,read,ls}.ts`）。
- 预设（`src/tools/presets.ts`）：`default` = bash、edit、glob、grep、read、write；`minimal` = bash、edit、read、write；`codemode-only` 只见 `codemode`，脚本里 `tools.grep()` / `tools.glob()` / `tools.ls()` 全部可调；`coordinator` 只有 read。`ls` 不在任何预设里（§5.6：「glob 已覆盖，且诱导逐层翻目录」）。
- 模型看到的工具节与规则（对 `dist/` 直接装配，`default` 预设）：

```text
Available tools:
- bash: run shell commands (AMA_* env vars describe the session)
- edit: replace text in a file
- glob: find files by name pattern
- grep: search file contents
- read: read files (text or images)
- write: create or overwrite a whole file (read existing files first)
Rules:
- Ask before destructive commands (rm -rf, git reset --hard, force push, deleting branches) unless the user requested them.
- Batch independent read-only tool calls into one turn.
```

- 没有任何「怎么找代码」的指引；`grep` / `glob` 的描述只写能力不写时机。`read` 收到目录时返回 `. is a directory; use the ls tool instead`，而 `ls` 在 `default` 下不可用，模型照提示再调 `ls` 会得到 unknown tool。
- 前缀预算实测（字符 / 4）：`default` 系统提示 176 + 工具 783 ≈ 960 token；strict 运行时 codemode 再加约 390；`PROMPT_BUDGETS.default = 2000`。

### §1.2 网络现状

- 没有 `web_fetch` / `web_search`，协议层也不发任何供应商原生搜索工具（`src/ai/apis/*-request.ts` 的 `tools` 只有函数工具）。
- 现有「网络」只出现在权限侧：`auto` 规则层把 curl / wget / git fetch / npm install 判为网络命令 → 询问（`permissions/auto-safe.ts`）；`sandbox.network: deny` 让 bash 在沙箱内断网换免审批；分类器系统提示写明「使用网络 → ask」。也就是说 ama 的所有权限设计都把「联网」当作需要审批的高风险动作，却没给模型一条受控的联网路径。
- 外部 Agent 驱动（`src/drivers/native/*`）已经把 Claude / Codex 的 WebSearch / WebFetch 事件归一为 `kind: "fetch"`，ACP 事件表里也有 `web_fetch` / `web_search` → `fetch`：ama 作为客户端认识这类工具，自己却没有。

### §1.3 实验记录（2026-10-03，本机 Node 26.10，`dist/bundle/ama.cjs` 0.6.3）

环境：临时 `AMA_CONFIG_DIR` / `AMA_DATA_DIR`，`--no-session -p --output-format stream-json --max-turns 6 --max-cost 0.1`，缺省 `default` 权限模式（无人值守 ask → deny）。仓库用 `test/fixtures/bench/search-summarize/repo`（7 个文件）。真实模型经测试中转站 `packy`（key 来自 `~/.config/ama-test/packy.env`），合计约 12 次模型请求 + 7 次原始探测，估价 < $0.2。

| 编号 | 模型 / 预设                                                                                                 | 提示                                                              | 结果                                                                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | `fake/echo` + `AMA_FAKE_SCRIPT`（grep、glob 各一次）                                                        | 「find ignore parser」                                            | 两个工具并行执行成功、免审批：`-p` 下 read 类工具畅通，管线本身没问题                                                                                                                                                                                                                                                                         |
| E1   | `packy/deepseek-v4-flash`，`default`                                                                        | 哪些源文件经 `process.env` 读环境变量、变量名是什么（只回答文字） | 第 1 轮同时发 `grep{pattern:"process\\.env"}` 与 `bash ls`；grep 命中 3 文件，bash 被拒；第 2 轮给出正确答案。**会主动用 grep**，但顺手用 `bash ls` 看目录（因为没有 `ls`）                                                                                                                                                                   |
| E2   | `packy/kimi-k2.5`，`default`                                                                                | 同上                                                              | 第 1 轮 `grep{pattern:"process\\.env", glob:"*.{js,ts,jsx,tsx,mjs,cjs}"}`，第 2 轮正确答案；全程 1 次工具调用（中间有 1 次中转 5xx 自动重试）                                                                                                                                                                                                 |
| E3   | `packy/deepseek-v4-flash`，`minimal`                                                                        | 同上                                                              | `bash grep -rn` 被拒 → `bash ls` 被拒 → `read .`（报「use the ls tool」）→ 连猜 `index.js` / `server.js` / `src/config.js` …共 20 次 `read` 全部 not found，6 轮用尽、exit 8、**没有答案**。这就是「没有检索能力」的本地版本                                                                                                                  |
| E4   | `packy/deepseek-v4-flash`，`default`                                                                        | 查 npm 上 vitest 最新稳定版本号并给出来源                         | `bash npm view` 拒 → `bash curl registry.npmjs.org` 拒 → `codemode` 脚本里 `tools.bash(curl)` 拒 → `bash npm view dist-tags` 拒 → `bash ls ~/.npm/_cacache` 拒 → `glob package.json` 读本地版本；**5 次 bash 全被拒，最终只能说本地没装**                                                                                                     |
| E5   | `packy/kimi-k2.5`，`default`                                                                                | 同上                                                              | `npm view` → `curl` ×3 → `codemode` 内 `curl`，5 次全被拒，无答案；stderr 提示「-p has no one to approve; use --permission-mode auto-edit\|auto or --allow」——但即使在 TUI 里，这些也会弹 5 次审批                                                                                                                                            |
| P-A  | 原始 `POST /v1/responses`，`grok-4.7`，`tools:[{type:"web_search"}]`                                        | 「vitest 最新稳定版本？用搜索」                                   | **透传成功**：输出 `reasoning` → `message` → `web_search_call{action:{type:"search",query,sources:[…]}}` → `message` 带 `annotations:[{type:"url_citation",url,title,start_index,end_index}]`；`usage.num_server_side_tools_used: 1`、`server_side_tool_usage_details`、`cost_in_usd_ticks`；输入 16.5k token（搜索内容计入，13.3k 命中缓存） |
| P-E  | 同上，`web_search` + 一个 `function` 工具混合                                                               | 「回复 ok」                                                       | 接受混合工具表，正常返回                                                                                                                                                                                                                                                                                                                      |
| P-B  | `POST /v1/chat/completions`，`kimi-k2.5`，`tools:[{type:"builtin_function",function:{name:"$web_search"}}]` | 同上                                                              | 第一步返回 `tool_calls[{name:"$web_search",arguments:{query}}]`（透传成功）；第二步把 arguments 原样作为 `role:"tool"` 回传后得到「3.0.5，2025-02-04」——过时答案，疑似中转未真正执行搜索或 Kimi 在该线路上退化。**透传形状可用，结果需官方端点复测**                                                                                          |
| P-C  | `qwen3.8-flash`，`enable_search:true, search_options:{forced_search:true}`                                  | 同上                                                              | 回答「没有实时访问能力」，响应无 `search_info`：中转把 DashScope 私有字段吞掉（或该模型不支持）                                                                                                                                                                                                                                               |
| P-D  | `glm-5`，`tools:[{type:"web_search",web_search:{…}}]`                                                       | 同上                                                              | 400 `'name' is a required property - tools.*.function`：中转按 OpenAI 形状校验工具，智谱私有工具类型过不去                                                                                                                                                                                                                                    |

### §1.4 结论：为什么会「没有检索能力」

1. 网络一项是真缺失（D1）。模型其实知道要联网，只是唯一的路是 bash，而 bash 联网在 ama 的权限设计里恰好是最该被拦的动作。给模型一条**只读、受控、可审计**的联网路径（`web_fetch` / `web_search`），这个矛盾才解得开。
2. 本地检索在 `default` 预设下是好的；差的是 `minimal` 预设、`-p` 无人值守、以及几处误导（`read` 让用 `ls`）。改规则与文案即可（D3）。
3. 用户若常用 `minimal` 或 `coordinator`，确实会感到「不会搜」；这是预设取舍，不是缺陷，文档里说明清楚并建议 `+grep,+glob`。

## §2 各家原生搜索对照

### §2.1 对照表

| 供应商 / 协议                                                   | 请求形状                                                                                                                                                                                                                       | 结果 / 引用怎么回来                                                                                                                                                                                                                                                                                               | 计费                                                                                                                                    | 缓存与回放                                                                                                                                                                                                   | 中转透传（packy 实测）                      | ama 要改哪里                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAI Responses** `web_search`（旧名 `web_search_preview`）  | `tools:[{type:"web_search", search_context_size?:"low\|medium\|high", filters?:{allowed_domains\|blocked_domains}, user_location?, external_web_access?:bool}]`；可与 `function` 工具混用；`tool_choice` 照旧                  | 输出项 `web_search_call{id,status,action:{type:"search"\|"open_page"\|"find_in_page",query?,sources?[]}}`；`message.content[].annotations[]` 里 `url_citation{url,title,start_index,end_index}`；流式事件 `response.output_item.added/done`                                                                       | $10 / 1k 次 + 搜索内容按输入 token 计（非推理模型的 preview 版 $25 / 1k 且内容免费）；gpt-5 `minimal` 推理不支持                        | 服务端执行，前缀无影响；`store:false` 时回放要把 `web_search_call` 项带回（待实测是否必需）                                                                                                                  | **通**（grok-4.7 完整返回；P-A / P-E）      | `openai-responses-request.ts` 加服务端工具；`openai-responses.ts` 解析 `web_search_call` 项与 `annotations`；usage 解析 `num_server_side_tools_used`                 |
| **ChatGPT 订阅后端**（`chatgptBackend: siwc \| codex`）         | 同 Responses；Codex 发 `{type:"web_search", external_web_access:false}`（cached）/ `true`（live）；`/models?client_version=` 的条目带 `supports_search_tool`、`web_search_tool_type:"text_and_image"`                          | 同上                                                                                                                                                                                                                                                                                                              | 订阅内不另计费（`billing:"subscription"`）                                                                                              | 同上；标 `use_responses_lite` / `tool_mode:"code_mode_only"` 的模型拒绝 hosted 工具（Codex 改走独立 `web.run` / `/alpha/search`）                                                                            | —（真账户实测待做）                         | `auth/chatgpt/backend-client.ts` 取能力字段进发现缓存；`chatgpt-backend.ts` 白名单允许 `tools[].type:"web_search"`，收到 `unsupported_capability` 时去掉并本会话降级 |
| **Anthropic Messages** `web_search` / `web_fetch`（服务端工具） | `tools:[{type:"web_search_20250305", name:"web_search", max_uses?, allowed_domains?\|blocked_domains?, user_location?}]`；`web_fetch_20250910` 同形 + `citations:{enabled}`、`max_content_tokens`；新版 `_2026xxxx` 带动态过滤 | 内容块 `server_tool_use{id:"srvtoolu_…",name,input}` + `web_search_tool_result{tool_use_id,content:[{type:"web_search_result",url,title,encrypted_content,page_age}]}`；文本块 `citations[]{type:"web_search_result_location",url,title,encrypted_index,cited_text}`；`usage.server_tool_use.web_search_requests` | search $10 / 1k 次 + 内容 token；fetch 免费只计 token                                                                                   | **必须原样回放** `server_tool_use` / 结果块 / `encrypted_*`，改动即 400；`pause_turn` 要原样重发继续；与客户端工具同轮混用时 `stop_reason:"tool_use"` 且服务端工具下一请求才跑；工具定义可打 `cache_control` | 中转无 Claude 模型，未测                    | `anthropic-request.ts` 工具表加服务端工具并保持缓存断点在最后一个工具；`anthropic-messages.ts` 解析新块类型；`transform.ts` 跨模型降级；循环处理 `pause_turn`        |
| **Gemini** `google_search` / `url_context`                      | `tools:[{google_search:{}}, {url_context:{}}]`，Gemini 3 起可与 `functionDeclarations` 同列                                                                                                                                    | `candidates[].groundingMetadata{webSearchQueries, groundingChunks[{web:{uri,title}}], groundingSupports[{segment,groundingChunkIndices}], searchEntryPoint}`                                                                                                                                                      | Gemini 3：每月 5 000 次免费（付费项目），之后 $14 / 1k 次（按模型实际发起的查询数）；2.5：1 500 / 天免费后 $35 / 1k；搜索内容不计 token | 隐式缓存不受影响；回放无特殊要求                                                                                                                                                                             | 中转无 Gemini，未测                         | `google-request.ts` 工具表；`google-generative-ai.ts` 解析 `groundingMetadata` → `citations`                                                                         |
| **xAI** `web_search`（Responses，`grok-4.x`）                   | `tools:[{type:"web_search", allowed_domains?\|excluded_domains?(≤5), enable_image_understanding?}]`；旧 Chat Completions 的 `search_parameters` 已不推荐                                                                       | 同 OpenAI Responses 形状；另有 `usage.server_side_tool_usage_details`                                                                                                                                                                                                                                             | $5 / 1k 次 + 搜索内容 token（失败不计）                                                                                                 | 同 Responses                                                                                                                                                                                                 | **通**（P-A 即 xAI 模型经中转）             | 复用 Responses 线；目录 `xai` 模型标原生搜索能力                                                                                                                     |
| **Kimi** `$web_search`（Chat Completions）                      | `tools:[{type:"builtin_function", function:{name:"$web_search"}}]`；模型返回 `tool_calls[{name:"$web_search", arguments}]`，**客户端把 arguments 原样作为 tool 消息回传**，Kimi 服务端执行                                     | 结果内联进下一回复；`arguments.usage.total_tokens` 估算搜索内容 token；无结构化引用                                                                                                                                                                                                                               | ¥0.03 / 次 + 内容进 `prompt_tokens`；官方公告 2026-10-20 前后停用，改独立 REST                                                          | 多一次往返（回传 arguments）；前缀无影响                                                                                                                                                                     | 形状通、结果可疑（P-B）                     | `openai-request.ts` 加 builtin 工具；会话层识别 `$web_search` 调用 → 自动回传（不经审批，当作服务端工具）；**优先级低（将停用）**                                    |
| **通义（DashScope）** `enable_search`                           | 请求体顶层 `enable_search:true`，`search_options:{forced_search?, enable_source?, enable_citation?, citation_format?, search_strategy:"turbo"\|"max"\|"agent"}`                                                                | 非流式 `search_info.search_results[{index,title,url,site_name}]`；正文内 `[1]` 标记                                                                                                                                                                                                                               | `agent` 策略另计费，其余按 token                                                                                                        | 前缀无影响                                                                                                                                                                                                   | **不通**（中转吞字段，P-C）                 | `openai-request.ts` 按 compat 发顶层字段；`openai-completions.ts` 解析 `search_info`；只对 `dashscope` 官方端点开                                                    |
| **智谱** `web_search` 工具                                      | `tools:[{type:"web_search", web_search:{enable:"True", search_engine?, search_result?:"True", count?, search_recency_filter?, content_size?}}]`                                                                                | 结果以 `web_search` 字段返回（title、link、content、publish_date、media、icon），正文 `ref_n`                                                                                                                                                                                                                     | 按引擎 ¥0.01–0.05 / 次                                                                                                                  | 前缀无影响                                                                                                                                                                                                   | **不通**（中转按 OpenAI 校验工具类型，P-D） | 同通义：只对 `zhipu` 官方端点开                                                                                                                                      |
| **OpenRouter** `:online` / `plugins`                            | `model:"x:online"` 或 `plugins:[{id:"web", engine?:"native"\|"exa"\|…, max_results?, search_prompt?}]`                                                                                                                         | Chat Completions `message.annotations[]{type:"url_citation",url_citation:{url,title,content,start_index,end_index}}`                                                                                                                                                                                              | Exa $0.007 / 次（10 条）；native 按各家透传价                                                                                           | 前缀无影响                                                                                                                                                                                                   | n/a                                         | `openai-request.ts` 发 `plugins`；`openai-completions.ts` 解析 `annotations`                                                                                         |
| DeepSeek、MiniMax、Groq、Mistral、Ollama、LM Studio 等          | 无原生搜索                                                                                                                                                                                                                     | —                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                       | —                                                                                                                                                                                                            | —                                           | 走外部 API 回落                                                                                                                                                      |

### §2.2 外部搜索 API（无原生时的回落）

| 后端                  | 请求                                                                              | 免费额度（2026-09 公开信息）                              | 价格 / 1k 次                        | 返回                           | 备注                                                                       |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| Brave Search          | `GET api.search.brave.com/res/v1/web/search?q=&count=`，头 `X-Subscription-Token` | 2026-02 起新账户无免费档，改每月 $5 预充值（约 1 000 次） | $5                                  | 标题、URL、snippet、`page_age` | 独立索引；需信用卡                                                         |
| Tavily                | `POST api.tavily.com/search {query,max_results,search_depth,include_answer}`      | 1 000 积分 / 月，免卡                                     | $8（basic）/ $16（advanced 2 积分） | 标题、URL、`content` 正文摘录  | 自带正文片段，适合 LLM；LangChain 生态常用                                 |
| Exa                   | `POST api.exa.ai/search {query,numResults,contents:{text:true}}`，头 `x-api-key`  | 注册赠 $20 + 每月 $10 信用（各处说法不一）                | $7（10 条含全文）                   | 标题、URL、全文 / highlights   | 语义索引，可取全文，一次搜索顶 search + fetch                              |
| Serper（Google SERP） | `POST google.serper.dev/search {q,num}`，头 `X-API-KEY`                           | 一次性 2 500 次                                           | $1 → $0.3                           | Google 原始 SERP JSON          | 最便宜；无正文；预充值 6 个月过期                                          |
| SearXNG（自建）       | `GET <base>/search?q=&format=json`（服务端需开 `search.formats: [json]`）         | 自建                                                      | 0                                   | 多引擎聚合、标题、URL、content | 隐私最好；内网部署时与私网保护冲突，需 `search.searxng.url` 显式放行该主机 |
| DuckDuckGo HTML       | `GET html.duckduckgo.com/html/?q=` 解析 HTML                                      | —                                                         | 0                                   | 标题、`uddg=` 跳转 URL         | **不做**：违反条款、无公开限额、低频即 202 Ratelimit / 403，行为不可预期   |

推荐：**无原生时首选 Tavily（免卡 1 000 / 月、带正文摘录）**，其次 Brave（独立索引）、Exa（语义 + 全文）、Serper（最便宜的 Google）；自建用户给 SearXNG。缺省 `search.provider: "auto"` 的回落顺序：原生 → 按 `search.fallback` 列表（缺省 `["tavily","brave","exa","serper","searxng"]`）取第一个有 key / 有 URL 的。

### §2.3 同类产品的行为（只学行为）

| 产品        | web_fetch                                                                                                                                                                                            | web_search                                                                                                                                                                                                                                   | 权限                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Claude Code | `WebFetch(url, prompt)`：HTML → Markdown，再用一次独立模型调用按 prompt 提取（有损）；15 分钟缓存；跨主机重定向不自动跟，返回提示让模型再调一次；拒绝 localhost 与无点主机名；`Accept` 偏好 Markdown | `WebSearch` 走 Anthropic 服务端搜索，只回标题与 URL，不抓正文，模型再 WebFetch；每会话 ≤ 200 次                                                                                                                                              | Manual / acceptEdits 下 WebFetch 询问，可「该域名不再问」写入项目级 allow；预置文档域名免问；`auto` / bypass 不问 |
| Codex       | 无独立 fetch；`web_search` 的 `open_page` / `find_in_page` 动作由服务端完成                                                                                                                          | Responses 服务端 `web_search`；配置 `web_search = "disabled"\|"cached"\|"indexed"\|"live"`，缺省 `cached`（OpenAI 自家索引、不访问外网），full-access 时自动 `live`；`[tools.web_search]` 可设 `context_size`、`allowed_domains`、`location` | 服务端执行，不经本地审批；用 cached 模式降低提示注入面                                                            |
| Gemini CLI  | `web_fetch(prompt 含 ≤ 20 个 URL)`：优先 Gemini `urlContext`，失败回落本地抓取 + HTML→文本；拒私网 / 环回 / 内网，连接钉在解析出的 IP；弹确认框（Plan 模式必问）                                     | `google_web_search(query)`：另发一次带 `google_search` 的 Gemini 请求，返回综合文本 + 来源列表                                                                                                                                               | fetch 确认、search 不确认                                                                                         |

借鉴的结论：fetch 要有审批与私网保护；search 本身低风险可不审批；引用要回到用户；跨主机重定向不自动跟是便宜又安全的做法；不做「二次模型提取」（ama 缓存优先、零依赖，多一次模型调用既花钱又让结果有损）。

## §3 能力分层

```text
L0  本地检索（已有）         grep / glob / read / ls         → 只改描述、规则、错误文案；grep 加 filesOnly
L1  web_fetch（新）          URL → 正文                     → 内置、零依赖、权限类 network
L2  web_search（新）         查询 → 结果列表 / 原生带引用回答
      L2a 原生（服务端工具）  OpenAI Responses / Anthropic / Gemini / xAI …   → 协议层加服务端工具，不是 ama 函数工具
      L2b 外部 API           Tavily / Brave / Exa / Serper / SearXNG         → ama 函数工具 web_search
      L2c 都没有             不注册 web_search；web_fetch 仍在；描述里不提搜索
```

`search.provider: "auto"` 的解析在**会话开始**时做一次：`resolveWebCapabilities(model, provider, config, auth)` → `{ fetch: boolean; search: { kind: "native"; server: ServerToolSpec } | { kind: "external"; backend: SearchBackend } | undefined }`。结果写进会话状态与缓存指纹，会话内不变；`/model` 切换后重算，差异以工具表补丁追加（§9.1 允许）。

## §4 设计

### §4.1 契约变更（`src/ai/types.ts`、`src/tools/types.ts`，走契约变更流程）

```ts
// ai/types.ts
export interface Citation {
  url: string;
  title?: string;
  /** 在所属文本块内的字符区间（有则渲染为该段脚注；无则挂在块末）。 */
  start?: number;
  end?: number;
  /** 供应商给的摘录（≤ 300 字符）。 */
  citedText?: string;
}
export interface TextBlock {
  type: "text";
  text: string;
  textSignature?: string;
  citations?: Citation[];
  /** 供应商原始引用对象（Anthropic 的 encrypted_index 等），只回放给同 provider / model / api。 */
  citationsRaw?: unknown;
}
/** 服务端工具调用及其结果（原生 web_search / web_fetch）；原始 JSON 不透明保存，只回放给同 provider / model / api。 */
export interface ServerToolBlock {
  type: "serverTool";
  id: string;
  name: "web_search" | "web_fetch" | (string & {});
  /** 人读摘要：query 或 url。 */
  summary: string;
  /** 归一化的来源（给 TUI / -p / RPC）。 */
  sources?: { url: string; title?: string }[];
  /** 原始调用块（Anthropic `server_tool_use`、Responses `web_search_call` 项）。 */
  raw: unknown;
  /** 原始结果块（Anthropic `web_search_tool_result`，含 encrypted_content）；Responses 无单独结果块时缺省。 */
  rawResult?: unknown;
}
export type AssistantContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ServerToolBlock;

export interface Usage {
  // …现有字段
  /** 服务端工具调用次数（按名）；协议解析到才有。 */
  serverTools?: Record<string, number>;
}

/** 会话开始定稿、会话内不变的服务端工具（进缓存指纹）。 */
export interface ServerToolSpec {
  name: "web_search" | "web_fetch";
  /** 协议层按 api 翻译：Responses `{type:"web_search", …}`、Anthropic `{type:"web_search_20250305", …}`、Gemini `{google_search:{}}`。 */
  options?: {
    maxUses?: number;
    allowedDomains?: string[];
    blockedDomains?: string[];
    externalWebAccess?: boolean;
  };
}
export interface StreamOptions {
  // …现有字段
  serverTools?: readonly ServerToolSpec[];
}

export interface Model {
  // …现有字段
  /** 原生搜索能力（目录覆盖项 / 发现缓存写入；缺省 = 无）。 */
  nativeSearch?: {
    kind: "responses" | "anthropic" | "google" | "kimi" | "dashscope" | "zhipu" | "openrouter";
    costPer1k?: number;
  };
}

// tools/types.ts
export type ToolPermission = "read" | "write" | "execute" | "memory" | "network";
```

- `ModelCost` 不动；服务端工具费用由 `ai/cost.ts` 按 `nativeSearch.costPer1k × usage.serverTools.web_search` 加进 `cost.total`（新字段 `cost.tools?`），`/session` 与 `ama stats` 单列「搜索 n 次 $x」。
- `transform.ts` 跨模型回放：`serverTool` 块降为一行文本 `[web_search: <summary>] sources: url1, url2`；`citations` 保留（纯数据），`citationsRaw` 丢弃。
- `session-format.md` 增 `serverTool` 块与 `citations` 字段说明（会话文件向后兼容：旧版本读到未知块类型按文本降级，需在 `projection.ts` 加兜底）。

### §4.2 本地检索增强（[S-A]）

| 改动                                                                                                                                                                                                                | 文件                                                        | 前缀影响                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------- |
| 新规则（只在 `grep` 与 `glob` 都在活动集时）：`Locate code with grep/glob before reading; do not guess file paths.`                                                                                                 | `agent/prompt-rules.ts`                                     | +≈ 16 token，`default` 才出现 |
| `read` 收到目录：按活动集给提示——有 `ls` 说 `use ls`，否则有 `glob` 说 `use glob (e.g. pattern "dir/*")`，都没有说 `read a file inside it`；实现：`ToolContext` 加只读 `activeTools: ReadonlySet<string>`           | `tools/read.ts`、`tools/types.ts`、`agent/session-tools.ts` | 0（错误文案不在前缀）         |
| `grep` 加 `filesOnly?: boolean`：只输出命中文件路径（去重、按路径排序），描述加一句 `filesOnly lists matching files.`                                                                                               | `tools/grep.ts`                                             | +≈ 12 token                   |
| `glob` 描述补 `Use to discover files before read.`；`grep` 描述补 `Use to find where a symbol or text appears.`                                                                                                     | `tools/glob.ts`、`tools/grep.ts`                            | +≈ 14 token                   |
| `-p` 下 `minimal` / `coordinator` 预设遇到 bash 被拒已有 stderr 提示；补一句「`minimal` 预设没有 grep / glob，`tools.default: ["+grep","+glob"]` 可加」进 i18n `print` 文案（只在被拒命令形如 grep / rg / find 时） | `modes/print/*`、`i18n/messages/print.ts`                   | 0                             |
| 文档：`docs/design.md` §5.6 表与 `docs/codemode.md` 说明 `minimal` 的检索取舍                                                                                                                                       | docs                                                        | —                             |

不做：模糊文件名（glob 的 `*name*` 已够）、符号 / 定义跳转（需要语言解析或 LSP，零依赖做不到可用质量；留给 Skill 调 `rg` / `ctags`）、语义检索、跨仓库（`path` 参数本就允许仓库外绝对路径，受 deny 规则约束）。大仓库性能：现实现每个文件整读再逐行 `test`，百万行级仓库 100 命中上限会很快到；`filesOnly` + `glob` 过滤是给模型的缩范围手段，流式按行读取留作 [S-A] 的可选优化（不改输出形状）。

### §4.3 `web_fetch`（[S-B]）

```text
name: web_fetch     label: Fetch     permission: network     executionMode: parallel
annotations: { readOnly: true, openWorld: true }
promptSnippet: "web_fetch: fetch a public web page as text"
description: "Fetch a public http(s) URL and return its main content as Markdown (HTML) or text (JSON, plain text).
  Truncated at maxChars (default 50 KB) with an offset to continue; PDFs and binaries are not parsed.
  Cross-host redirects are reported, not followed."
parameters: { url: string (required), maxChars?: integer, offset?: integer, raw?: boolean }
```

行为规格：

- 仅 `http:` / `https:`；拒绝 URL 里的 userinfo（`user:pass@`）；URL ≤ 2 048 字符；主机名必须含 `.`（无点主机名与 `localhost` 一律拒：本机服务请模型用 bash curl 走审批）。
- **私网防护**：`dns.lookup(host, { all: true })` 全部地址都不得落在环回、链路本地（含 169.254.169.254 元数据）、RFC 1918、ULA（`fc00::/7`）、组播、`0.0.0.0/8`、IPv4 映射的以上段；用 `node:http(s).request` 并通过 `lookup` 选项钉住已检查的地址（防 DNS 重绑定）；每一跳重定向重新检查。`search.searxng.url` 指向私网时为它单独放行（仅该主机 + 端口，仅 `web_search` 后端用，`web_fetch` 不放行）。
- 重定向：同主机最多 5 跳自动跟；**跨主机不跟**，返回 `Redirected to <url>; call web_fetch with it if appropriate.`（模型下一次调用再过一次权限）。
- 限制：总超时 30 s、首字节 15 s；响应体上限 5 MB（流式读、超限截断并标注）；`Accept: text/markdown, text/html, text/plain, application/json;q=0.9, */*;q=0.1`；`User-Agent: ama/<version> (+https://github.com/Owlbay/armadra-agent)`；不发 cookie、不带任何自定义头、不支持 POST。
- 内容处理（`tools/web/html-to-markdown.ts`，零依赖、单文件 ≤ 600 行）：去 `script` / `style` / `noscript` / `svg` / `nav` / `footer` / `aside`；优先 `<main>` / `<article>` / `role=main`；保留标题层级、段落、列表、链接 `[text](url)`、行内 / 块代码、简单表格、图片只留 alt；解码实体；按 `<meta charset>` / `Content-Type` 处理编码（Node `TextDecoder` 支持的集合）。`raw:true` 返回原文（仍受 maxChars）。`application/json` 美化输出；`text/*` 原样；`application/pdf` 与其它二进制返回 `Binary content (<type>, <bytes>); not parsed.`（不进上下文全文）。
- 输出：首行 `# <title>` + `Source: <final url>`（+ `Retrieved: <ISO>` 不进内容、放 `details`，避免前缀变化——工具结果不在前缀，这里只是保持确定性），正文头截断到 `maxChars`（缺省 50 000，上限 200 000），末尾 `[Truncated at N chars; continue with offset=M]`；全文落 `outputs/<toolCallId>.txt`。`details: { status, contentType, bytes, truncated, cached, finalUrl }`。
- 缓存：会话内内存缓存 15 分钟（键 = 最终 URL + raw），`details.cached: true`；不落盘。
- 代理：Node 24.5+ 的 `http.setGlobalProxyFromEnv()` 已由 `cli/proxy.ts` 调用，`http.request` 同样生效；Node 22 不读代理环境变量（与模型请求一致，文档注明）。
- 结果进上下文走 `tool-runner` 的 `maxToolResultChars` 截断与档一裁剪（web 结果属可裁剪类，不进保护集）。

### §4.4 `web_search`（[S-C] 外部后端；[S-D] 原生）

函数工具（外部后端时注册）：

```text
name: web_search    label: Search    permission: read（见 §4.6 的理由）    executionMode: parallel
annotations: { readOnly: true, openWorld: true }
promptSnippet: "web_search: search the web (titles, URLs, snippets)"
description: "Search the web and return up to `limit` results as `n. title — url` with a snippet.
  Use for current information (versions, docs, errors); read a result with web_fetch."
parameters: { query: string (required), limit?: integer (default 5, max 10), recency?: "day"|"week"|"month"|"year", domains?: string[] }
```

- 输出确定性：结果按后端返回顺序编号；每条 `n. <title> — <url>\n   <snippet ≤ 300 字符>`；`details: { backend, count, tookMs }`；`structured: { results: [{title,url,snippet,publishedAt?}] }`（codemode 脚本与宿主用）。
- 后端接口 `tools/web/search-backend.ts`：`interface SearchBackend { readonly id: string; search(input: SearchInput, ctx: { signal, fetch }): Promise<SearchResult[]> }`，四家 + SearXNG 各一个 ≤ 150 行文件（`backends/{tavily,brave,exa,serper,searxng}.ts`），HTTP 走 `ai/http.ts` 的 `postJson` / 新增 `getJson`（统一超时 15 s、错误文案、key 不进错误信息）。
- key 发现：`resolveApiKey("<backend-id>")` 复用供应商的三级顺序（`config.search.<id>.apiKey` → `auth.json.providers["<id>"]` → 环境变量）；`ama auth set tavily` 直接可用（`auth set` 的 id 校验放开到搜索后端 id 列表）；`ama doctor` 新增一行「搜索：后端 / key 来源」。
- 速率与费用：会话内每次调用计 `usage{kind:"web_search"}` 自定义条目（不是模型 usage），`/session` 显示「搜索 n 次」；外部 API 不估价（各家计费单位不同），文档列价。
- 原生（§4.5）时**不注册**本函数工具，但系统提示 `tools` 节仍要让模型知道能搜：原生搜索由服务端决定何时触发，不需要描述；为稳定前缀，`tools` 节不列、`rules` 节不加。实测两家（Responses / Anthropic）都会在问「最新版本」时自动搜（P-A）。

### §4.5 原生搜索的协议层

**会话开始**：`resolveWebCapabilities()` 判定 `search.kind === "native"` 的条件：`search.provider` 为 `auto` 或 `native`；模型 `nativeSearch` 有值（目录覆盖 / 发现缓存 / 用户 `models[].nativeSearch`）；`compat.nativeWebSearch !== false`（官方主机缺省 true；**非官方 baseUrl 缺省 false**，中转用户要显式 `providers.packy.compat.nativeWebSearch: true`，或跑 `ama models search-probe packy/grok-4.7` 探测后写回——探测就是 P-A 那一次请求，约 $0.05）；没有 `permission.deny` 命中 `web_search`。满足则 `StreamOptions.serverTools = [{ name: "web_search", options }]`，并把 `serverTools` 的 JSON 加进缓存指纹（`ai/cache/fingerprint.ts`）。

**请求侧**：

| 协议                 | 翻译                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai-responses     | `tools` 数组**开头**插 `{type:"web_search", search_context_size: search.native.contextSize ?? "medium", filters?: {allowed_domains}, external_web_access: search.native.liveWeb ?? true}`（放开头让「最后一个工具」仍是函数工具，与现有缓存逻辑无关但保持确定）；`chatgptBackend` 白名单放行该项；codex 后端缺省 `external_web_access` 跟 Codex 的 cached 语义（`false`），用户 `search.native.liveWeb: true` 改 live |
| anthropic-messages   | `tools` 开头插 `{type:"web_search_20250305", name:"web_search", max_uses: 5, allowed_domains?}`（基础版，ZDR 可用、不需要 `allowed_callers`）；`cache_control` 仍打在最后一个函数工具上                                                                                                                                                                                                                               |
| google-generative-ai | `tools:[{google_search:{}}, {functionDeclarations:[…]}]`（Gemini 3 起同列；Gemini 2.x 不同列时不启用原生，回落外部）                                                                                                                                                                                                                                                                                                  |
| openai-completions   | 第二期：Kimi `builtin_function`、通义顶层字段、智谱工具项、OpenRouter `plugins`，各按 compat 开关                                                                                                                                                                                                                                                                                                                     |

**响应侧**（流解析 → `AssistantMessage.content`）：

- Responses：`response.output_item.added/done` 的 `web_search_call` → `serverTool` 块（`summary` = `action.query` 或 `action.url`，`sources` = `action.sources`，`raw` = 整个 item）；`message` 项 `content[].annotations[]` 的 `url_citation` → 所属文本块 `citations`；`usage` 解析 `num_server_side_tools_used` / `server_side_tool_usage_details` → `usage.serverTools`。回放：`convertAssistant` 在同模型时把 `serverTool.raw` 原样放回 `input`（Codex 的做法；若端点拒绝则按 400 文案去掉并记 compat `replayServerToolItems: false`，待实测）。
- Anthropic：`content_block_start` 的 `server_tool_use` → 开 `serverTool` 块并累积 `input_json_delta`；`web_search_tool_result` / `web_fetch_tool_result` → 配对 `tool_use_id` 填 `rawResult` 与 `sources`；文本块的 `citations_delta` → `citations` + `citationsRaw`；`usage.server_tool_use.web_search_requests`。回放：`convertAssistant` 把 `raw` / `rawResult` / `citationsRaw` 原样放回（同模型），这是硬要求。`stop_reason: "pause_turn"` 当前映射为 `stop`——改为新内部停因 `pause`，循环把该助手消息原样再发一次（上限 3 次），不算回合、不触发工具执行；与客户端工具混用的 `tool_use`（服务端工具无结果块）照常执行客户端工具后继续，服务端工具下一请求才有结果块（解析时按 `tool_use_id` 补到上一条助手消息的 `serverTool.rawResult`——需要 `session-run.ts` 允许回填上一条助手消息；如改动过大，首期把结果块作为新助手消息的首块单独保存并在回放时按原顺序发出）。
- Gemini：`groundingMetadata` 在最后一个 chunk；`groundingChunks` → 一个合成的 `serverTool{name:"web_search", summary: webSearchQueries.join(" | "), sources}` 块，`groundingSupports` → `citations`。

**事件**：`serverTool` 块流式到达时发 `tool_execution_start/end`，带新字段 `server: true`（RPC / `-p stream-json` 原样；TUI 用它渲染「服务端」标记、不走权限管线、不进重复调用检测）。`message_end` 后的 `AssistantMessage` 含 `citations`。

**权限**：服务端搜索不能逐次拦截。规则：`permission.deny` 含 `web_search` → 不发服务端工具；其它模式一律允许（搜索关键词外泄到模型供应商的风险，与把整个对话发给它相比不新增威胁面）。`plan` 模式同样允许（只读调研正是 plan 的用途）。

### §4.6 权限类 `network`（[S-B]）

参照 `memory` 类的做法（`permissions/memory-class.ts` 折成已有类走真值表），新建 `permissions/network-class.ts`：

| 模式        | `web_fetch`（network）                                                                                                                                                                                                                                                 | `web_search`（read；外部后端） |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `plan`      | **询问**（`-p` 下拒绝）：只读但可外泄，Gemini CLI 同样在 Plan 下必问                                                                                                                                                                                                   | 放行                           |
| `allowlist` | 只放行 allow 规则命中（`web_fetch(*.github.com)`、`web_fetch(https://docs.python.org/**)`），其余拒绝                                                                                                                                                                  | 放行（只读工具）               |
| `default`   | 询问；对话框选项 allow / deny / **allow for this domain this session**（`allow_session` 的归一化前缀 = 域名）                                                                                                                                                          | 放行                           |
| `auto-edit` | 同 default                                                                                                                                                                                                                                                             | 放行                           |
| `auto`      | 规则层：私网 / 非 http(s) → deny（执行层也会拒，双保险）；allow 规则 / 会话记忆 → allow；静态判定：域名在 `web.fetch.allowDomains`（缺省空）→ allow；其余交分类器（分类器提示补一句「fetching a public documentation or package-registry page read-only is routine」） | 放行                           |
| `full-auto` | 放行                                                                                                                                                                                                                                                                   | 放行                           |

- 规则语法：`web_fetch(<glob>)`，glob 对「`host/path`」匹配（不含 scheme），`*` 不跨 `/`、`**` 跨；裸域名 `example.com` 等价 `example.com/**` 并含子域（与 Anthropic / Claude Code 的域名语义一致）。`web_search` 规则不带括号。
- 危险命令表不适用；Hook PreToolUse 照常可拦（输入里有 `url`）。
- 与沙箱的关系：`web_fetch` / `web_search` 在 ama 进程内执行，不受 `sandbox.bash` / `sandbox.network` 影响——这正是设计意图：**bash 断网免审批 + web 工具显式受控联网**。文档在 `docs/sandbox.md`「已知绕过」节写明：模型可以用 `web_fetch` 把本地文件内容拼进 URL 外泄（`?q=<secret>`），所以 `web_fetch` 的 URL 查询串长度限制为 ≤ 1 024 字符、含 `=`/`&` 的查询串在审批预览里高亮；分类器提示把「URL 查询串里出现像密钥 / 长随机串的内容」列为 ask。
- 项目级 `.ama/config.json`：可设 `web.fetch.enabled: false`、`search.provider: "off"`、追加 `permission.deny`；`web.fetch.allowDomains` 只认用户级 / profile（放宽项）。
- Armadra 嵌入：宿主 `tools.disable("web_fetch")` / `tools.disable("web_search")` 即可（`host-api.md` 已有）；profile 新增 `web?: { fetch?: boolean; search?: boolean }` 作等价开关（画布节点间的「协作上下文」不经网络，不受影响）。

### §4.7 工具表、预设与缓存

- `default` 预设：`web_fetch` 固定加入（`PRESET_TOOLS.default` 加名字；`web.fetch.enabled: false` 或宿主禁用时 `available()` 为假、自然不出现）；`web_search` 由会话开始的解析结果决定是否注册（外部后端注册函数工具；原生不注册；都没有不注册）。`minimal` / `coordinator` 不加，`codemode-only` 脚本内可调（`tools.web_fetch()` / `tools.web_search()`）。
- 预算：两工具合计 ≈ 250 token，`default` 实测 960（strict ≈ 1 350）→ ≈ 1 600，`PROMPT_BUDGETS.default = 2000` 不动；`descriptions.test.ts` 的单工具 150 token 门照守。
- 缓存前缀：工具按名排序，`web_fetch` / `web_search` 排在 `write` 前，整个会话不变；原生服务端工具在 `StreamOptions.serverTools`，进缓存指纹与请求体快照测试；`cache-stability.test.ts` 加「20 回合 serverTools 字节相同」用例。
- 中途 `/model`：重算能力；`native → external` 时追加 `web_search` 函数工具（system 补丁 `toolsAdded`），`external → native` 时 `toolsRemoved`；都会打断前缀，但 `/model` 本来就打断（`model_changed` 已是未命中归因之一）。
- `get_tools`（RPC）与 `/tools` 列出 `web_fetch` / `web_search`，并多一列 `backend: "native" | "<id>" | undefined`。

### §4.8 引用与来源呈现

| 面                     | 呈现                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI 消息区             | 文本块里按 `citations[].start/end` 在段末插 `[n]`（无区间的挂块末）；消息末尾「Sources」块列 `n. title — url`（`ui.citations: "footnotes"（缺省）\| "inline"（直接 `[title](url)`）\| "off"`）。服务端工具调用渲染成工具行 `⌕ web_search "query"` + 折叠的来源列表，标 `server` |
| TUI 工具行             | `web_fetch`：标题 `fetch host/path`（`renderCall`），结果首行 `title · 12.3 KB · markdown`，展开看正文；`web_search`：标题 `search "query"`，结果列表 n 行                                                                                                                      |
| `-p` text              | 正文后空一行追加 `Sources:` 列表（有引用时）                                                                                                                                                                                                                                    |
| `-p json`              | `message.content[].citations` 原样；`serverTool` 块原样（`raw` 保留，宿主可丢）                                                                                                                                                                                                 |
| `-p stream-json` / RPC | `tool_execution_start/end{server:true}`；`message_update` 增量里 `citations` 随文本块结束一次性给出（Anthropic 的 `citations_delta` 合并后再发，避免半截引用）                                                                                                                  |
| ACP                    | `tool_call{kind:"fetch"}`（已有映射），引用放 `content[].annotations`（ACP 规范允许的扩展字段）                                                                                                                                                                                 |
| 会话文件               | 原样落盘；`ama sessions show` 打印 `[n]` 与来源                                                                                                                                                                                                                                 |

### §4.9 配置键与缺省

| 键                                                                | 类型 / 取值                                                                            | 缺省                                                 | 层级                       | `/config` 面板 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------- | -------------- |
| `web.fetch.enabled`                                               | boolean                                                                                | `true`                                               | 项目级只能设 `false`       | tools 组       |
| `web.fetch.maxChars`                                              | 1 000–200 000                                                                          | `50000`                                              | 项目级只能调小             | tools 组       |
| `web.fetch.timeoutMs`                                             | 5 000–120 000                                                                          | `30000`                                              | 用户级 / profile           | 否             |
| `web.fetch.allowDomains`                                          | string[]（auto 静态放行；default 下不免审批）                                          | `[]`                                                 | 用户级 / profile（放宽项） | 否（列表）     |
| `search.provider`                                                 | `"auto" \| "native" \| "off" \| "tavily" \| "brave" \| "exa" \| "serper" \| "searxng"` | `"auto"`                                             | 项目级只能设 `"off"`       | tools 组       |
| `search.fallback`                                                 | 后端 id 列表（`auto` 的回落顺序）                                                      | `["tavily","brave","exa","serper","searxng"]`        | 用户级 / profile           | 否             |
| `search.maxResults`                                               | 1–10                                                                                   | `5`                                                  | 任意                       | tools 组       |
| `search.native.liveWeb`                                           | boolean（Responses `external_web_access`；codex 后端缺省随 Codex 为 cached）           | 官方 / 中转 `true`；`chatgptBackend:"codex"` `false` | 用户级 / profile           | 否             |
| `search.native.contextSize`                                       | `"low" \| "medium" \| "high"`（Responses `search_context_size`）                       | `"medium"`                                           | 用户级 / profile           | 否             |
| `search.native.maxUses`                                           | 1–20（Anthropic `max_uses`）                                                           | `5`                                                  | 用户级 / profile           | 否             |
| `search.searxng.url`                                              | `http(s)://…`（允许私网主机，仅此后端）                                                | 无                                                   | 用户级 / profile           | 否             |
| `search.<backend>.apiKey`                                         | `"$ENV"` 或明文（同 `providers.<id>.apiKey` 规则）                                     | 无                                                   | 用户级 / profile           | 否             |
| `ui.citations`                                                    | `"footnotes" \| "inline" \| "off"`                                                     | `"footnotes"`                                        | 任意                       | ui 组          |
| `providers.<id>.compat.nativeWebSearch` / `models[].nativeSearch` | 见 §4.5                                                                                | 官方主机 true / 其余 false                           | 用户级                     | 否             |
| profile `web`                                                     | `{ fetch?: boolean; search?: boolean }`                                                | 都 `true`                                            | 宿主                       | —              |

环境变量：`AMA_WEB_FETCH=0` 等价 `web.fetch.enabled:false`；`AMA_SEARCH_PROVIDER` 覆盖 `search.provider`；各后端 key 的标准变量名见 D10。`config.schema.json`、`key-docs.ts`、`settings-registry.ts`、`config-keys.ts`（中英）同步。

### §4.10 i18n

- 模型侧文本（工具描述、规则、工具结果）仍为英文（与现有工具一致，不进 i18n）。
- 进 i18n 的：TUI 工具行标题模板（`msg().tools.webFetch.title(host)` 等）、`Sources` 标题、审批对话框的 `web_fetch` 文案与「本会话允许该域名」选项、`/config` 分组与键说明、`ama doctor` 的搜索行、`-p` 的降级提示（§4.11）、错误文案（私网拒绝、重定向、超时、后端缺 key）。新领域文件 `src/i18n/messages/web.ts`（en 为形状源），`catalog.ts` 登记一次。
- 工具 `label`（`Fetch` / `Search`）保持英文短词，与 `Bash` / `Grep` 一致。

### §4.11 RPC / SDK / 子命令 / 文档

- RPC：`get_tools` 行加 `backend?`；`session_start` 事件加 `web?: { fetch: boolean; search?: "native" | string }`；新增 `get_web_capabilities`（同形状，宿主随时可查）；事件新字段 `server`。`docs/rpc.md` 与 `docs/en/rpc.md` 同步。
- SDK：`createRuntime({ web?: { fetch?, search? } })` 与 `extraTools` 并列；`SearchBackend` 接口与 `defineSearchBackend()` 导出，宿主可注入自己的后端（Armadra 以后可接画布级搜索）。
- 子命令：`ama models search-probe <provider/model>`（一次最小请求测原生搜索透传并写回 `compat.nativeWebSearch`）；`ama doctor` 新行；`ama auth set <backend>` 接受搜索后端 id。
- 降级提示：会话开始若 `search.provider` 为 `auto` 且解析为「无」，TUI 启动头信息列加一行 `search: off (no native support, no search key — see ama auth set tavily)`（每配置目录提示一次，记 `notices.json`，与 codemode 提示同机制）；`-p` 不提示。模型侧不说，前缀不变。
- 文档：`docs/tools-web.md`（新，中文，含 en 版 `docs/en/tools-web.md`）：工具行为、权限、后端配置、费用、隐私声明；`docs/permissions.md` 加 `network` 类与 `web_fetch(...)` 规则；`docs/sandbox.md` 已知绕过节；`docs/providers.md` 原生搜索小节与 compat 键；`docs/design.md` §5.2 / §5.6 / §7 回写并链接本文；README 功能段加一句；`docs/gap-audit-2026-10.md` 的两行标「已被 search-plan.md 推翻」。

## §5 分批实施（2–3 个代理并行，文件所有权互不重叠）

| 批次 | 内容                                                                                                                                                                                                                                                                                                                               | 文件所有权                                                                                                                                                                                                                                                                                                                                                                                              | 依赖                | 验收                                                                                                                                                                                                                                                                                                              | 估量   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S-0  | **契约**：§4.1 类型；`ToolPermission` 加 `network`；`ToolContext.activeTools`；`StreamOptions.serverTools`；`Usage.serverTools`；`SessionEvent` 工具事件 `server?`；RPC 类型；配置类型与 schema / key-docs / settings-registry / config-keys 中英；`projection.ts` 未知块兜底；`transform.ts` 降级；fingerprint 纳入 `serverTools` | `src/ai/types.ts`、`src/tools/types.ts`、`src/agent/types*.ts`、`src/rpc.ts`、`src/config/{types,schema,json-schema,key-docs,settings-registry,merge}.ts`、`src/i18n/messages/config-keys.ts`、`src/session/projection.ts`、`src/agent/transform.ts`、`src/ai/cache/fingerprint.ts`、`src/contracts-search.test.ts`（新）、`docs/session-format.md`                                                     | —                   | `tsc` 通过；契约测试锁定新字段可选、旧会话文件可读；json-schema 一致性测试通过；`pnpm check:i18n`                                                                                                                                                                                                                 | 0.5 天 |
| S-A  | **本地检索增强**（§4.2）                                                                                                                                                                                                                                                                                                           | `src/tools/{read,grep,glob}.ts`、`src/agent/prompt-rules.ts`、`src/agent/session-tools.ts`（只加 `activeTools`）、对应测试、`src/modes/print/print-mode.ts` 提示句 + `src/i18n/messages/print.ts`、`docs/design.md` §5.6、`docs/codemode.md`                                                                                                                                                            | S-0                 | `descriptions.test.ts` 每工具 ≤ 150；`prompt-budget.test.ts` 不变通过；`prompt-rules.test.ts` 新规则只在 grep+glob 同在时出现；`read.test.ts` 三种目录提示；`grep.test.ts` `filesOnly` 确定性排序；复跑 E3（minimal）与 E1 看行为不劣化（可选、花钱）                                                             | 1 天   |
| S-B  | **`web_fetch` + `network` 权限类**（§4.3、§4.6）                                                                                                                                                                                                                                                                                   | `src/tools/web/{fetch,html-to-markdown,url-guard,http-get}.ts`（新）、`src/permissions/network-class.ts`（新）、`src/permissions/{pipeline,rules,auto-safe,classifier}.ts` 的接入点、`src/modes/interactive/approval-dialog.ts` 域名选项、`src/i18n/messages/web.ts`（新，与 S-C 共用需先建骨架）、`PRESET_TOOLS.default`、`docs/permissions.md`、`docs/sandbox.md`、`docs/tools-web.md` 新建           | S-0                 | 单测：私网 / 环回 / 元数据 / IPv6 映射 / 无点主机 / userinfo 全拒；跨主机重定向返回提示不跟；5 MB 与 maxChars 截断；HTML→MD 固定样例快照；本地 `http.createServer` 端到端（DNS 钉住用 `lookup` 注入）；权限真值表六模式 × allow 规则 × 会话记忆；`-p` default 下 `web_fetch` 被拒且 stderr 提示；前缀预算测试通过 | 2 天   |
| S-C  | **`web_search` 外部后端**（§4.4）：后端接口、五个后端、key 发现、`ama auth set` 放开、`doctor` 行、启动头降级提示、`-p` / TUI 结果渲染                                                                                                                                                                                             | `src/tools/web/{search,search-backend}.ts`、`src/tools/web/backends/*.ts`（新）、`src/cli/compose.ts`（`resolveWebCapabilities` 的外部分支 + 工厂）、`src/cli/subcommands/{auth,doctor}.ts`、`src/cli/web-notice.ts`（新）、`src/modes/interactive/tool-view.ts` 的两条 `renderCall/renderResult`（经工具自身的 `renderCall` 实现，不改 tool-view）、`docs/tools-web.md` 后端节、`docs/en/tools-web.md` | S-0                 | 每个后端用录制的 JSON fixture 单测（请求头含 key 不进错误与日志，`no-leak` 风格断言）；`auto` 回落顺序与 `off`；缺 key 不注册且 `get_tools` 不列；`structured.results` 形状；SearXNG 私网放行只对该主机                                                                                                           | 1.5 天 |
| S-D  | **原生搜索：Responses + Anthropic**（§4.5）：请求侧服务端工具、响应侧 `serverTool` / `citations` / usage、回放、`pause_turn`、混合调用、`chatgpt-backend` 白名单与降级、能力字段入目录 / 发现缓存、`compat.nativeWebSearch`、`ama models search-probe`、cost                                                                       | `src/ai/apis/{openai-responses-request,openai-responses,anthropic-request,anthropic-messages,chatgpt-backend,cache-usage}.ts`、`src/ai/cost.ts`、`src/ai/providers/catalog/{openai,xai,anthropic,chatgpt}.json`、`src/auth/chatgpt/{backend-client,discovered}.ts`、`src/agent/{session-run,loop}.ts` 的 `pause` 停因、`src/cli/subcommands/models-search-probe.ts`（新）、`docs/providers.md`          | S-0                 | 请求体快照（服务端工具在前、缓存断点位置不变、`serverTools` 不变时 20 回合字节相同）；流解析 fixture（P-A 的真实响应脱敏入库；Anthropic 按官方文档样例）；回放原样含 `encrypted_*`；跨模型降级；`pause_turn` 续发 ≤ 3；真实 probe 用中转 grok-4.7 跑一次（≈ $0.05）                                               | 2.5 天 |
| S-E  | **呈现与接口**（§4.8、§4.11）：TUI 脚注 / Sources / 服务端工具行、`-p` text Sources、RPC `get_web_capabilities` 与事件字段、SDK 导出、`/config` 面板行、`ama sessions show`                                                                                                                                                        | `src/modes/interactive/{message-view,tool-view}.ts`（引用渲染；与状态栏文件无交集）、`src/modes/print/print-mode.ts` 的 Sources（与 S-A 的一句提示分不同函数，顺序合入）、`src/modes/rpc/*`、`src/sdk.ts`、`src/modes/interactive/config-panel.ts`、`docs/{rpc,tui}.md` + `docs/en/*`、README 两份                                                                                                      | S-0、S-D 的 fixture | 消息视图快照（有 / 无引用、inline / footnotes / off）；`-p json` 含 `citations`；RPC e2e：`get_web_capabilities` 三态；`docs-links.test.ts` 通过                                                                                                                                                                  | 1.5 天 |
| S-F  | **第二期协议**：Gemini `google_search` + `groundingMetadata`；OpenRouter `plugins` + `annotations`；通义 / 智谱 compat（只对官方端点）；Kimi `$web_search` 视其停用时间决定是否做                                                                                                                                                  | `src/ai/apis/{google-request,google-generative-ai,openai-request,openai-completions}.ts`、目录 JSON、`docs/providers.md`                                                                                                                                                                                                                                                                                | S-D                 | 各协议 fixture 单测；真实 probe 需用户自己的 key（中转不透传）                                                                                                                                                                                                                                                    | 2 天   |

并行安排：S-0 先行（半天，一个代理）；之后 **A 代理 S-A → S-E**，**B 代理 S-B → S-C**，**C 代理 S-D → S-F**；S-E 的引用渲染用 S-D 提供的 fixture 先写快照，不等 S-D 合入。全部合入后由主会话复跑 §1.3 的 E1–E5 与 P-A 并把结果回写 §1.3，再发 0.7.0。

状态栏文件（`src/modes/interactive/status-*.ts`）本计划不碰；若想在状态栏显示「搜索 n 次」，交给负责状态栏的代理在其之后加一个只读字段。

## §6 风险

| 风险                                                                                         | 应对                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提示注入：抓回的网页正文进入上下文，可能携带「忽略之前指令」                                 | 工具结果已是「数据」位置；在 `web_fetch` 结果前加一行固定前缀 `Content fetched from <url> (untrusted):`；分类器把 URL 查询串含疑似密钥列为 ask；文档声明与 Anthropic 的 exfiltration 警告同义 |
| 数据外泄：模型把本地内容拼进 URL                                                             | 查询串 ≤ 1 024 字符；审批预览高亮查询串；`auto` 下交分类器；`sandbox.md` 写明这是已知面，`web.fetch.enabled:false` 或 deny 规则可关                                                           |
| SSRF / DNS 重绑定                                                                            | 解析后检查并钉住 IP（`lookup` 选项），每跳重检；元数据地址与无点主机名硬拒；单测覆盖                                                                                                          |
| 中转站对服务端工具的支持参差：有的透传、有的 400、有的静默吞掉                               | 非官方主机缺省不开原生；`search-probe` 一次写回 compat；400 含工具类型文案时本会话降级为外部后端并提示（不自动重试多次）                                                                      |
| Anthropic 回放严格：块顺序、`encrypted_*` 任何改动都 400；与客户端工具混用时结果块在下一请求 | 原始 JSON 不透明保存、按原顺序回放；fixture 覆盖混用场景；首期 `max_uses: 5` 限制长搜索循环；`pause_turn` 续发上限 3                                                                          |
| 费用：原生搜索内容 token 大（P-A 一次 16.5k 输入）；Anthropic / OpenAI $10 / 1k 次           | `/session` 与 `ama stats` 单列搜索次数与估价；`search.native.contextSize` 缺省 medium；`--max-cost` 照常生效（服务端工具费用计入）；文档列价                                                  |
| 前缀与缓存：`web_search` 的有无随 key / 模型变化，用户换模型后前缀变                         | 只在会话开始与 `/model` 时变；指纹纳入 `serverTools`，未命中归因能说出「serverTools changed」                                                                                                 |
| 零依赖 HTML→Markdown 质量有限（SPA、复杂表格）                                               | 优先 `main` / `article`；`raw:true` 兜底；文档声明不支持 JS 渲染页面（Anthropic 的 web_fetch 也不支持）                                                                                       |
| Kimi `$web_search` 将停用、通义 / 智谱私有字段中转不透传                                     | 放第二期，且只对官方端点开；不为它们改通用契约                                                                                                                                                |
| 会话文件兼容：旧版 ama 读新文件遇到 `serverTool` 块                                          | `projection.ts` 未知块按文本降级（S-0 先做）；`session-format.md` 记版本                                                                                                                      |

## §7 需用户确认事项（附推荐）

| #   | 事项                                                                                 | 推荐                                                                                |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| C1  | `web_fetch` 是否缺省进 `default` 预设（前缀 +≈ 130 token、每次请求都带）             | **是**。没有它，「查文档」只能走 bash；minimal 不加                                 |
| C2  | `web_fetch` 在 `default` 模式下询问还是放行？                                        | **询问**，带「本会话允许该域名」；`auto` 交分类器。与 Claude Code / Gemini CLI 一致 |
| C3  | `plan` 模式下 `web_fetch` 询问还是放行                                               | **询问**（`-p` 下拒绝）；`web_search` 放行                                          |
| C4  | 外部搜索后端首期接哪几家                                                             | Tavily、Brave、Exa、Serper、SearXNG 五个；不接 DuckDuckGo                           |
| C5  | 原生搜索对非官方 baseUrl（中转）缺省关、需 `search-probe` 或手写 compat 打开         | **是**（透传不可预测；一次探测 ≈ $0.05）                                            |
| C6  | ChatGPT codex 后端缺省 `external_web_access: false`（跟 Codex 的 cached），还是 live | **cached**，`search.native.liveWeb: true` 可改                                      |
| C7  | 引用缺省脚注（`[n]` + Sources）还是行内链接                                          | **脚注**                                                                            |
| C8  | 是否先只做「最小可用版本」（§8.3）                                                   | 建议先做最小版（S-0 + S-A + S-B + S-C），看两周实际使用再决定 S-D / S-E / S-F       |
| C9  | 是否把 `docs/gap-audit-2026-10.md` 中「不做内置 WebFetch / WebSearch」改标为被推翻   | 是，只加一行备注，不改原文                                                          |
| C10 | 第二期协议里 Kimi `$web_search`（2026-10-20 前后停用）是否还做                       | 不做，等其独立 REST 接口                                                            |
