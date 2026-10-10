# R6 订阅类 OAuth 登录调研（ama，首期 ChatGPT）

> 调研日期 2026-10-03。只读，未改任何仓库代码，未输出任何 token。
> ama 基线：`armadra-agent@cdc9408`。Codex 源码：`github.com/openai/codex` main（浅克隆于 /tmp/codex-src）；本机 `codex-cli 0.160.0`。
> 按协调方转达的用户决定，推荐设计以「借用 Codex CLI 公开客户端 ID」为主，同时留出切换到自有客户端的配置位。

## 0. 结论

1. **ChatGPT 订阅：两条路都能走。**
   - **官方路线**：OpenAI 在 DevDay（2026-09-29）把「Sign in with ChatGPT」(SIWC) 扩展到**订阅额度共享**。开源或本地运行的应用可以**自助动态注册**：用 `client_id=dynamic_agent_client` 登录，服务端按「用户 × 工作空间」签发客户端，无需审批、无需 client secret。端点是 `api.openai.com/v1/responses`，scope 为 `chatgpt.tokens.use.direct`。用户可在 ChatGPT 设置里给每个应用设 10%–100% 的周上限。收费、远程托管的应用仍要填意向表等审批。
   - **借用 Codex 客户端**（用户已选）：用公开 ID `app_EMoamEEZ73f0CkXaXp7hrann`，经 `auth.openai.com/oauth/*` 拿到 token，再调 `chatgpt.com/backend-api/codex/responses`。OpenAI 人员公开表态支持第三方工具用 Codex 订阅，但**没有正式条款**。这条路依赖的是逆向得来的私有后端，随时可能变更或收紧。
2. **Claude 订阅**：Anthropic 明文禁止第三方提供 Claude.ai 登录、借用订阅凭据，也不允许收集或中转其 token（Claude Code 法务页）。ama **绝不能**自己实现 Claude OAuth。ama 现有的「驱动未修改的官方 `claude` CLI」做法在条文上被明确允许：最终用户用自己的订阅登录未修改的二进制。但 `claude -p` 属于「Agent SDK 用量」，而 2026-04 起官方对 third-party harness 有执法动作，原定 06-15 的「SDK 独立额度」又被暂停、**以后可能重启**。建议继续保留该驱动，不再扩展；不得读取或复用 `~/.claude` 凭据。
3. **GitHub Copilot**：只有正式合作方（2026-01 起）获官方支持；其他第三方调用 `copilot_internal` 有封号风险，**不做**。**Gemini CLI / Code Assist OAuth**：Google 明文禁止第三方使用，并已多次封号；2026-06-18 起个人和免费层的这条登录已整体下线，**不做**。
4. **ama 设计**：新增内置供应商 `chatgpt`（协议 `openai-responses`，新增 compat `chatgptBackend`）、新增 `ama auth login|logout|status chatgpt`。登录支持浏览器 PKCE + 本地回调（1455，被占用则退到 1457），无浏览器时用 `--device` 设备码或 `--paste` 粘贴回调 URL。token 存进 `auth.json` 的新形态 `oauth` 条目（文件权限 0600），用跨进程文件锁串行刷新。`clientId`、`issuer`、`baseUrl` 都可覆盖，以后换自有客户端只需改配置，必要时切换到官方动态注册路径（见 §4.10）。
5. **最大风险**：私有后端变更，包括 instructions 校验、请求头、字段白名单、attestation；还有条款灰区，以及 refresh token 轮换时多进程竞争导致整条登录失效（`refresh_token_reused`）。

---

## 1. ChatGPT 订阅

### 1.1 官方开放现状（SIWC + 订阅额度共享）

- **公告**：DevDay 2026（2026-09-29）上首批 16 家合作方（编码工具与应用厂商），之后陆续有新的合作方加入。登录身份功能 7 月已 beta、9 月中向所有人开放，新增的是「应用可消耗用户的订阅额度」（[The New Stack](https://thenewstack.io/sign-in-with-chatgpt/)、[learn.chatgpt.com](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)）。
- **计划与上限**：
  - 只有 Plus / Pro 能共享额度（身份登录所有账户都可用）。
  - 用户在 ChatGPT → Settings → Usage → App limits 给每个应用设周上限，按占总周额度的百分比（10%–100%）。上限只是封顶，不预留额度。
  - Plus 的 5 小时窗口由所有已连接应用共享。
  - 只有该应用上限设为 100% 且开启了 credits，额度耗尽后才会动用 credits。
  - 在应用里登出**不会**断开连接，要到 ChatGPT 设置里手动移除（[WorkOS](https://workos.com/blog/sign-in-with-chatgpt-plan-usage-scope)）。
- **非合作方能否自助**：
  - **网站和商业应用**：需申请 `oaiapp_…` 客户端，并精确登记 callback URL，目前是有限试用（[developers.openai.com/siwc](https://developers.openai.com/siwc/token-sharing-open-source)）。
  - **开源、个人本地运行的应用**：**可以自助**，走动态注册。原文大意是「plan usage 可用于开源项目、本地运行的个人项目和选定的私有应用」，收费或远程托管的应用要填[意向表](https://openai.com/form/sign-in-with-chatgpt-interest/)（[Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)）。
- **官方动态注册协议要点**（[sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)）：
  - 授权端点 `https://auth.openai.com/api/accounts/authorize`，token 端点 `https://auth.openai.com/api/accounts/oauth/token`。
  - 授权参数：`client_id=dynamic_agent_client`（首次）或已签发的 ID；`response_type=code`；`redirect_uri=http://127.0.0.1:<port>/auth/callback`（端口可变，scheme、host、path 不变）；`scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`；`resource=https://api.openai.com/v1`；`state`、`nonce`；PKCE `S256`；`agent_name_hint`（仅首次注册）；`ext_agent_host_id`（必填，每个安装稳定不变，可用 `urn:uuid:` 或 JWK thumbprint）；`id_token_hint` 和 `login_hint` 可选。
  - token 交换：表单编码，无 client secret，带 `resource`。必须校验 id_token（`iss=https://auth.openai.com`、`aud=签发的 client_id`、`nonce`、`exp`、JWKS 签名），并确认授予的 scope 里含 `chatgpt.tokens.use.direct`。
  - token 寿命：access token 1 小时；refresh token 30 天，每次刷新都会**轮换**出新的 refresh token。必须**串行刷新**，防止多进程竞争。登出时调用 OIDC discovery 里的 `revocation_endpoint`（[token-reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)、[profiles-and-sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)）。
  - 推理：调用 `https://api.openai.com/v1/responses`，带 `Authorization: Bearer`；模型列表从 `GET /v1/models` 取，筛选 `visibility=="list"`（[models-and-inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)）。
  - 限制（[preview-limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)）：
    - 必须带 `store:false` 和 `stream:true`，`input` 必须是数组。
    - 禁用字段：`background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier, temperature, top_logprobs, top_p, truncation, user`。
    - 不能用 `role:"system"` 的 item，改用 `instructions` 或 developer 消息。HTTP 下不能用 `previous_response_id`。
    - function / custom 工具**须放进 namespace 或通过 `additional_tools` 输入项提供**（格式需实测）。
    - 不支持图像生成、file search、Code Interpreter、托管 MCP、`tool_search`。
  - 错误码（[errors-and-recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)）：

    | 错误码                                        | 状态 | 处理                             |
    | --------------------------------------------- | ---- | -------------------------------- |
    | `subscription_sharing_usage_limit_exceeded`   | 429  | 暂停，引导到「Manage usage」     |
    | `subscription_sharing_user_not_eligible`      | 403  | 说明原因，不重试、不重新走 OAuth |
    | `subscription_sharing_unsupported_capability` | 400  | 去掉不支持的输入、工具或模型     |
    | `subscription_sharing_invalid_user`           | 401  | 让用户重新登录                   |
    | `subscription_sharing_usage_unavailable`      | 503  | 有界退避重试                     |
    | `subscription_sharing_user_unavailable`       | 503  | 有界退避重试                     |
    | `chatpass_v2_scope_not_authorized`            | 403  | 检查客户端与授权配置             |
    | `subscription_sharing_route_not_supported`    | 403  | 核对方法与端点                   |

  - 官方 DevKit（`openai/sign-in-with-chatgpt-devkit`，Node 22 + React）采用 **Noncommercial License**，ama **不能 vendor**，只能按文档自行实现协议。
  - 无浏览器或远程机器的官方方案只有一个：在本地登录后，把凭据文件安全地拷到远端，由远端负责后续刷新，并使用远端自己的 host id（[self-hosted-vms](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)）。文档未提供设备码流程。

### 1.2 借用 Codex CLI 公开客户端（用户已选，主方案）

**OpenAI 的态度**：

- 2026-01-09，Codex 负责人发文表示正与一款第三方编码工具合作、让 Codex 用户在其中使用订阅，并在探索支持更多第三方（[X](https://x.com/thsottiaux/status/2009742187484065881)）。
- 另有第三方工具的文档声称 OpenAI 明确支持在外部工具中用订阅 OAuth。
- [Codex for Open Source](https://developers.openai.com/community/codex-for-oss) 页面点名了若干第三方编码工具。
- 但这些都**不是条款或协议**。社区插件 README 自限「personal development use … not for production or multi-user」。

**技术细节**（以 codex-rs 源码为准，路径相对 `codex-rs/`）：

| 项                                         | 值                                                                                                                                                                                                                                                                                                                                                                                                                                | 证据                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| client_id                                  | `app_EMoamEEZ73f0CkXaXp7hrann`（公开客户端，无 secret；可用环境变量 `CODEX_APP_SERVER_LOGIN_CLIENT_ID` 覆盖）                                                                                                                                                                                                                                                                                                                     | `login/src/auth/manager.rs:1718`、`:216`                                                                                                  |
| issuer                                     | `https://auth.openai.com`                                                                                                                                                                                                                                                                                                                                                                                                         | `login/src/server.rs:77`                                                                                                                  |
| 授权端点                                   | `{issuer}/oauth/authorize`                                                                                                                                                                                                                                                                                                                                                                                                        | `login/src/server.rs:603`                                                                                                                 |
| token 端点（交换与刷新）                   | `{issuer}/oauth/token`；刷新可用 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 覆盖                                                                                                                                                                                                                                                                                                                                                          | `login/src/auth/manager.rs:212-214`                                                                                                       |
| scope                                      | 当前 `openid profile email offline_access api.connectors.read api.connectors.invoke`；社区插件只用前四个                                                                                                                                                                                                                                                                                                                          | `login/src/server.rs:608-610`；occa `lib/auth/auth.ts:10`                                                                                 |
| 额外授权参数                               | `id_token_add_organizations=true`、`codex_cli_simplified_flow=true`、`originator=codex_cli_rs`，可选 `allowed_workspace_id`                                                                                                                                                                                                                                                                                                       | `login/src/server.rs:596-602`、`login/src/auth/default_client.rs:42`                                                                      |
| PKCE                                       | S256，`code_challenge_method=S256`                                                                                                                                                                                                                                                                                                                                                                                                | `login/src/pkce.rs`                                                                                                                       |
| 回调                                       | `http://127.0.0.1:{port}/auth/callback`，首选 **1455**、回退 **1457**；绑定前会向旧监听者发 `GET /cancel` 抢占端口。社区插件用 `http://localhost:1455/auth/callback`                                                                                                                                                                                                                                                              | `login/src/server.rs:78-80,194,620-640`                                                                                                   |
| 刷新请求                                   | JSON 编码 `{grant_type:"refresh_token", client_id, refresh_token}`，无 scope 与 resource                                                                                                                                                                                                                                                                                                                                          | `login/src/auth/manager.rs:1626-1645`、`login/src/oauth/client.rs:81-88`                                                                  |
| 刷新的永久失败                             | `refresh_token_expired`、`refresh_token_reused`、`refresh_token_invalidated`、`invalid_grant`、401 → 必须重新登录；其余视为暂时失败                                                                                                                                                                                                                                                                                               | `login/src/auth/manager.rs:1680-1700`                                                                                                     |
| 设备码                                     | `POST {issuer}/api/accounts/deviceauth/usercode {client_id}` → 返回 `device_auth_id, user_code, interval`；用户打开 `{issuer}/codex/device` 输入码；轮询 `.../deviceauth/token {device_auth_id,user_code}` → 返回 `authorization_code, code_verifier`；再用 `redirect_uri={issuer}/deviceauth/callback` 走 `/oauth/token` 交换。`codex login --device-auth` 已有此功能，可能需要用户在 ChatGPT 安全设置里开启设备码授权（待实测） | `login/src/device_code_auth.rs:23-60,68,107,175,206`                                                                                      |
| 账户 id                                    | id_token 的 `https://api.openai.com/auth` 声明下的 `chatgpt_account_id`；`chatgpt_plan_type` 给出 plus / pro 等                                                                                                                                                                                                                                                                                                                   | `login/src/token_data.rs:34-96`                                                                                                           |
| 本机 `~/.codex/auth.json` 结构（只看形态） | `{auth_mode, OPENAI_API_KEY:null, last_refresh, tokens:{access_token,id_token,refresh_token,account_id}}`，权限 0600                                                                                                                                                                                                                                                                                                              | 本机检查                                                                                                                                  |
| 后端 base                                  | `https://chatgpt.com/backend-api/codex`；请求 `POST /responses`；模型列表 `GET /models?client_version=<ver>`                                                                                                                                                                                                                                                                                                                      | `model-provider-info/src/lib.rs:77`、`model-provider/src/models_endpoint.rs:470`、`codex-api/src/endpoint/models.rs:42`                   |
| 必需请求头                                 | `Authorization: Bearer <access>`、`ChatGPT-Account-ID: <account_id>`、`originator: codex_cli_rs`（社区插件同值）。会话头 `session-id`、`thread-id`（新版）或 `session_id`、`conversation_id`（旧插件），以及 `x-client-request-id`。旧插件另加 `OpenAI-Beta: responses=experimental`                                                                                                                                              | `model-provider/src/auth.rs:106`、`codex-api/src/requests/headers.rs:5-14`、`core/src/client.rs:1310-1320`、occa `lib/constants.ts:26-39` |
| 可选头                                     | `x-oai-attestation`（宿主集成可选，CLI 默认不发）、`x-codex-beta-features`、`x-openai-subagent`、`x-codex-turn-state`                                                                                                                                                                                                                                                                                                             | `core/src/attestation.rs`、`core/src/client.rs:160-168,2325-2340`                                                                         |
| 请求体（Codex 自身发的）                   | `model, instructions, input, tools, tool_choice:"auto", parallel_tool_calls, reasoning, store:false, stream:true, include, service_tier, prompt_cache_key, text, client_metadata`；**不发** `max_output_tokens`、`temperature`                                                                                                                                                                                                    | `core/src/client.rs:995-1012`                                                                                                             |
| 社区插件的改写                             | 强制 `store=false`；`include` 加 `reasoning.encrypted_content`；删除 `max_output_tokens`、`max_completion_tokens`                                                                                                                                                                                                                                                                                                                 | occa `lib/request/request-transformer.ts:450,524-528`                                                                                     |
| 系统提示 / instructions                    | 历史上后端只接受「授权的」instructions，自定义会报 400 `Instructions are not valid`（[openai/codex#3202](https://github.com/openai/codex/issues/3202)）。社区插件因此在 `instructions` 里放官方 Codex 提示（运行时从 GitHub 拉取，带 ETag 缓存），自身规则改放 developer 消息。之后有代理改为 instructions 可选。**现状需实测**                                                                                                   | occa `lib/prompts/codex.ts:43-236`                                                                                                        |
| 配额（响应头）                             | `x-codex-primary-used-percent`、`-primary-window-minutes`、`-primary-reset-at`、`secondary-*` 三项、`x-codex-limit-name`；另有其他计量族 `x-<limit>-…`；credits 头 `x-codex-credits-has-credits`、`-unlimited`、`-balance`                                                                                                                                                                                                        | `codex-api/src/rate_limits.rs:57-100,220-222`                                                                                             |
| 配额（SSE 事件）                           | `{"type":"codex.rate_limits", plan_type, rate_limits:{primary,secondary}, credits, metered_limit_name}`                                                                                                                                                                                                                                                                                                                           | `codex-api/src/rate_limits.rs:110-160`                                                                                                    |
| 配额（主动查询）                           | `GET https://chatgpt.com/backend-api/wham/usage`；网页入口 `https://chatgpt.com/settings/usage`                                                                                                                                                                                                                                                                                                                                   | `backend-client/src/client/rate_limit_resets.rs:126`、`tui/src/status/card.rs:54`                                                         |
| 错误码                                     | 429：`usage_limit_reached`（带 `resets_at`）、`usage_not_included`（计划不含）、`insufficient_quota`                                                                                                                                                                                                                                                                                                                              | `codex-api/src/api_bridge.rs:188-225`                                                                                                     |
| 可用模型                                   | 以 `/models` 返回为准，按账户和计划变化。社区插件曾硬编码 gpt-5.x 与 codex 系列，已过时，**不硬编码**                                                                                                                                                                                                                                                                                                                             | —                                                                                                                                         |

**条款风险**：

- OpenAI 的使用条款禁止「规避速率限制或限制」，也禁止把服务转售或中转给他人。只给本人用、只用本人订阅、不改配额逻辑，属于官方人员口头支持的灰区。
- 私有后端（`chatgpt.com/backend-api`）没有稳定性承诺，加 attestation、收紧 instructions 白名单、改请求头都可能让 ama 一夜失效。
- 以 `originator=codex_cli_rs` 冒充 Codex 有可识别风险。建议默认发 `codex_cli_rs`（兼容性最好），同时允许配置为 `ama`，并在登录提示中写明。

---

## 2. Claude 订阅（Anthropic）

- **条文**（[Claude Code · Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)「Authentication and credential use」）：
  - OAuth 只用于「ordinary use of Claude Code and other native Anthropic applications」。
  - 「Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users」。
  - 开发者不得「collect, store, or intermediate Claude.ai credentials or session tokens」。
  - 但不禁止「an end user from signing in to the unmodified Claude Code binary with their own Claude subscription」。
  - 可不经通知采取执法措施。
- **消费者条款**（2025-10-08 生效）：除 API Key 或明确许可外，禁止以「automated or non-human means, whether through a bot, script, or otherwise」访问服务（[consumer-terms](https://www.anthropic.com/legal/consumer-terms)）。
- **执法时间线**：
  - 2026-02-20 条款明文化。
  - 2026-04-04 12:00 PT 起，订阅不再覆盖 third-party harness（先从一款第三方工具开始，逐步扩大），只能用 extra usage 或 API Key（[Boris Cherny / X](https://x.com/bcherny/status/2040206440556826908)、TechCrunch 报道）。
  - 有人问「包一层 Claude Code headless / Agent SDK 的个人本地工具能否用订阅」，Cherny 回「Yep」。但也有报道称 `claude -p` 追加声明「运行在某第三方工具内」的系统提示后被 400 拒绝（[productcompass](https://www.productcompass.pm/p/claude-code-pricing)）。
  - 2026-05-13 宣布：06-15 起 Agent SDK、`claude -p`、第三方应用改走独立的「Agent SDK 月度 credit」（Pro $20、Max 5x $100、Max 20x $200）。**06-15 当天暂停**：「For now, nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits」（[support.claude.com](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)）。
- **对 ama 的评估**：
  - ama 已有 `src/drivers/native/claude-stream.ts`，用 `claude -p --input-format stream-json …` 驱动未修改的官方二进制，并刻意不用 `--bare`。在条文上属于允许的「最终用户用自己订阅登录未修改的二进制」。
  - 但在计费上，它属于 `claude -p` 和第三方应用用量，一旦 SDK credit 方案重启，就会改从独立 credit 扣除。另外，若 ama 在系统提示中自称第三方 harness，可能触发识别（以报道为证，未经官方确认）。
  - **建议**：
    1. 保留驱动，文档写明计费归属会随 Anthropic 政策变化；
    2. 绝不读取、复制或刷新 `~/.claude/.credentials.json` 或 Keychain 里的 token，也不实现 `ama auth login claude`；
    3. 不往 `--append-system-prompt` 注入「运行在 ama 内」之类的身份声明；
    4. `doctor` 中提示：Claude 订阅只能通过官方 CLI 使用，ama 原生供应商 `anthropic` 只接受 API Key。

## 3. 其它订阅

| 订阅                                         | 官方允许情况                                                                                                                                                                                                                                                      | 风险                                                                                                                                                                                                                | ama 建议                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| GitHub Copilot                               | 2026-01-16 官方宣布一款第三方编码工具可用 Pro / Pro+ / Business / Enterprise（正式合作，设备码登录）（GitHub Changelog）。另有「Agent apps」预览（[docs](https://docs.github.com/en/copilot/concepts/agents/agent-apps)）。非合作方调用 `copilot_internal` 无授权 | 社区回答和封禁案例指出，脚本化使用可能被停用 Copilot（[discussion #178117](https://github.com/orgs/community/discussions/178117)）。2026-06 起按 AI Credits 计费                                                    | **不做**。可等 GitHub 开放第三方注册，或走 Agent apps |
| Gemini CLI / Code Assist OAuth               | Gemini CLI 条款与 FAQ 明文禁止第三方软件使用其 OAuth（点名若干第三方工具）（[tos-privacy.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)、[FAQ](https://geminicli.com/docs/resources/faq/)）                             | 2026-02 起批量封号（会连带 Gemini CLI 和 Code Assist），二次违规永久封禁（[discussion #20632](https://github.com/google-gemini/gemini-cli/discussions/20632)）。2026-06-18 个人、Pro、Ultra、免费层的这条登录已下线 | **不做**。用 AI Studio Key 或 Vertex                  |
| Antigravity                                  | 同上，属于被封禁对象                                                                                                                                                                                                                                              | 高                                                                                                                                                                                                                  | 不做                                                  |
| 其它（Kimi、GLM、MiniMax 的 Coding Plan 等） | 多为「订阅制 API Key」，不是 OAuth                                                                                                                                                                                                                                | 低                                                                                                                                                                                                                  | 维持现有 Key 方案                                     |

---

## 4. ama 推荐设计（按用户决定：先借 Codex 客户端，预留自有客户端）

### 4.1 现状接入点

- 解析 key 的入口是 `ApiKeyResolver.resolve()`（`src/ai/providers/auth.ts:207-219`）。会话**每回合**通过 `streamOptions → resolveApiKey()` 重新解析（`src/agent/session.ts:130,184-187`），因此刷新可以挂在 resolve 上，无需改动 agent 循环。
- `KeySource = "cli"|"auth-file"|"config"|"env"|"none"`（`src/ai/types.ts:507`），需新增 `"oauth"`。
- `AuthFile.providers[id] = {apiKey, env?, baseUrl?}`（`src/config/types.ts:307-310`）。`auth-file.ts` 的 `describeAuthFile` / `classifyKeyValue` 假定 `apiKey` 一定存在（`src/config/auth-file.ts:109-118`），需要按条目形态分支处理。
- 已有原子写入：临时文件 0600 → rename → chmod（`src/config/auth-file.ts:68-74`），可直接复用。
- Responses 请求体（`src/ai/apis/openai-responses-request.ts:291-318`）会**无条件**发 `max_output_tokens`，有值时发 `temperature`，并按端点发 `prompt_cache_options` / `prompt_cache_retention`。`model.samplingParams` 会被 `Object.assign` 合并进请求体。这几处都要按新 compat 屏蔽。

### 4.2 命令

```
ama auth login chatgpt [--device | --paste] [--port N] [--no-browser] [--auth-file F]
ama auth logout chatgpt [--auth-file F]         # 删除本地条目并尽力撤销（借用模式无撤销端点时只删本地）
ama auth status [chatgpt]                       # 只显示账户邮箱的掩码、计划、过期时间、来源、clientId 类别
ama auth list                                   # 现有命令，新增 kind = "oauth"
```

- **首次登录的一次性提示**（用户已定）。它是 TTY 下的确认，不是条款同意弹窗：「使用 Codex CLI 的公开客户端登录 ChatGPT，仅限本人、个人使用；这是非官方用法，OpenAI 可能随时变更或限制；用量计入你的 ChatGPT 计划。」中英两版文案进 i18n。非 TTY 时须带 `--yes` 才继续。确认后在条目里记 `acknowledgedAt`，之后不再提示。
- **流程选择**：
  - 缺省：浏览器 PKCE。打开浏览器失败时打印 URL。
  - `--device`：设备码流程（§1.2）。
  - `--paste`：打印授权 URL，用户在任意机器完成登录后，把浏览器地址栏里的回调 URL（`http://127.0.0.1:1455/auth/callback?code=…&state=…`）粘回终端；ama 校验 state 后完成交换。适合 SSH 场景。回调页即使打不开，也不影响 code 有效。

### 4.3 浏览器 PKCE 与本地回调

- 用 `node:crypto` 生成 PKCE：32 字节 verifier（base64url），challenge 为 `S256` 的 base64url 无填充；`state` 取 32 字节随机数。
- 用 `node:http` 只监听 `127.0.0.1`。端口依次尝试 1455、1457（这两个是 Codex 客户端登记过的 redirect，其它端口大概率被拒，**需实测**）。端口被占用（如 `codex login` 正在运行）时，**不要**像 Codex 那样发 `/cancel` 去抢占别人的进程，而是提示「端口被占用，请先结束其他登录，或用 --paste」。
- 回调处理只认 `GET /auth/callback`：
  - 校验 `state`；有 `error` 参数时返回错误页；
  - 成功后返回静态页「可关闭此页」，**页面中不回显 code**；
  - 登录超时 5 分钟，Ctrl-C 时关闭监听。
- 交换 token：`POST {issuer}/oauth/token`，`application/x-www-form-urlencoded`，参数为 `grant_type=authorization_code, code, redirect_uri, client_id, code_verifier`。
- 从 id_token 解出 `https://api.openai.com/auth.chatgpt_account_id` 和 `chatgpt_plan_type`。借用模式下不做 JWKS 验签（Codex 也只是解码）；自有或动态注册模式**必须**验签与 nonce（§4.10）。计划为 free 时提示「该计划可能不含 Codex 用量」。

### 4.4 存储（`auth.json`，0600）

扩展 `AuthFile.providers[id]` 为联合类型（字段名 camelCase，不含 token 的字段可以对外展示）：

```jsonc
{
  "version": 1,
  "providers": {
    "openai": { "apiKey": "$OPENAI_API_KEY" },
    "chatgpt": {
      "type": "oauth",
      "flavor": "codex-borrowed", // 或 "siwc-dynamic" / "custom"
      "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
      "issuer": "https://auth.openai.com",
      "accountId": "…",
      "planType": "plus",
      "email": "…",
      "accessToken": "…",
      "refreshToken": "…",
      "idToken": "…",
      "expiresAt": 1790000000000,
      "lastRefresh": "2026-10-03T…Z",
      "acknowledgedAt": "2026-10-03T…Z",
    },
  },
}
```

- 读取：`authEntry()`、`fromAuthFiles()` 遇到 `type:"oauth"` 就走 `OAuthCredentialSource`；`hasConfiguredKey` 对 oauth 条目返回 true。
- `describeAuthFile` 对 oauth 条目只输出 `{provider, kind:"oauth", flavor, plan, expiresIn}`。
- **不复用、不读取 `~/.codex/auth.json`**。可以提供显式的 `ama auth import codex`，但默认不做：多进程轮换 refresh token 会让 Codex CLI 的登录失效，且属于跨应用凭据共享。
- 宿主模式下（profile 带 `authFile`），oauth 条目写入宿主指定的文件。

### 4.5 刷新与并发锁

- 触发条件：resolve 时发现 `expiresAt - now < 5min`，或请求返回 401（立即刷新一次后重试一次，仍失败就报错）。
- **进程内**：同一 provider 共用一个刷新 Promise，避免重复刷新。
- **跨进程**：在 `auth.json.lock` 上用 `open(O_CREAT|O_EXCL)` 建锁文件，内容写 pid 和时间戳。等待最多 15 秒；锁超过 60 秒视为陈旧锁，确认 pid 已死后删除。取得锁后**重新读取文件**：如果另一个进程已经刷新过（`lastRefresh` 更新或 refreshToken 已变），直接使用新 token。否则才发刷新请求：`POST {issuer}/oauth/token`，JSON `{grant_type, client_id, refresh_token}`（官方动态注册路径改用表单编码并带 `resource`）。写回时用原子 rename，写完再释放锁。
- 永久失败（`refresh_token_expired`、`refresh_token_reused`、`refresh_token_invalidated`、`invalid_grant`、401）：把条目标记为 `needsLogin:true`，不删 token，便于诊断；报错文案为「ChatGPT 登录已失效，请运行 ama auth login chatgpt」，错误对象为 `{code:"auth_expired"}`。暂时失败则退避重试 2 次。
- 现有 `ApiKeyResolver.fileCache` 会缓存文件内容（`auth.ts:111,133-140`），oauth 条目必须**绕过缓存**，否则长会话会一直用旧 token。

### 4.6 供应商 `chatgpt` 与协议 compat

- 内置供应商 `chatgpt`：`api:"openai-responses"`，`baseUrl:"https://chatgpt.com/backend-api/codex"`，`requiresApiKey:true`，`envKeys:[]`，`authHeader:"authorization-bearer"`。新增 compat `chatgptBackend:true`。
- 打开 `chatgptBackend` 后，请求体的变化：
  - 强制 `store:false`、`stream:true`；推理模型加 `include:["reasoning.encrypted_content"]`（现有 `supportsStore` 分支即可满足）。
  - **删除** `max_output_tokens`、`temperature`、`top_p`、`prompt_cache_retention`、`prompt_cache_options`，以及 `samplingParams` 中合并进来的禁用字段；可选地加 `tool_choice:"auto"` 和 `parallel_tool_calls`。
  - `prompt_cache_key = sessionId`（Codex 自己就发，**保留**）。
- 请求头：`ChatGPT-Account-ID`（取自条目）、`originator`（缺省 `codex_cli_rs`，可配置）、`session-id: <sessionId>`、`x-client-request-id: <sessionId>`。`OpenAI-Beta` 先不发，实测需要再加。
- **instructions 策略**新增 compat `instructionsMode: "native" | "developer-message"`，缺省 `native`，即直接用 ama 的系统提示。收到 400 `Instructions are not valid` 时，本会话自动切到 `developer-message`：`instructions` 留空（或填一段最小合法串，需实测），ama 的系统提示改成 `input` 开头的 `role:"developer"` 消息。**不要**从 GitHub 拉取或打包 Codex 官方 prompt：那是 Apache-2.0，可以合规使用，但会让 ama 的行为变成 Codex 那一套，并多一个联网依赖。
- 模型发现：`ama models discover chatgpt` 调用 `GET {base}/models?client_version=<ama 版本>`。返回字段格式私有，只取 slug 和显示名；上下文窗口未知时不猜。内置目录只放一个占位模型，提示用户先 discover。
- 工具：沿用 function tools。若后端要求 namespace（SIWC 文档有此规定，Codex 后端未见此要求），则在 compat 中加 `toolsInNamespace`，按实测结果决定。

### 4.7 配额与用量显示（订阅不按 token 计价）

- `cost` 记为 0，并标记 `billing:"subscription"`。统计和 `ama stats` 中单列「订阅用量」，不折算成美元。
- 解析响应头 `x-codex-primary-*`、`x-codex-secondary-*`、credits 头，以及 SSE 中的 `codex.rate_limits` 事件。TUI 状态栏显示「5h 用量 42%（14:20 重置）· 周用量 18%」。RPC / host 事件新增 `rateLimits` 字段，供 Armadra 展示（需同步 ama 的 host-api 文档）。
- `ama auth status chatgpt` 可以主动调用 `GET https://chatgpt.com/backend-api/wham/usage`，只显示百分比和重置时间。
- 429：
  - `usage_limit_reached` 按 `resets_at` 提示重置时间，**不重试**，并附 `https://chatgpt.com/settings/usage` 链接；
  - `usage_not_included` 提示当前计划不含该用量；
  - 映射为 `{code:"quota_exceeded"}`。

### 4.8 缓存影响

- 后端支持 `prompt_cache_key`，用量里会返回 cached tokens。沿用现有的「前缀稳定」策略即可；instructions 回退到 developer 消息后，前缀依然稳定。
- 后端不支持 `prompt_cache_retention` 或显式 30 分钟缓存，`cacheRetention:"long"` 自动降为 short（compat 把 `supportsLongCacheRetention` 和 `supportsExplicitPromptCacheMode` 设为 false）。
- 缓存省下的是**订阅配额**而不是钱，所以统计里显示命中率，不显示节省的金额。
- HTTP 下没有 `previous_response_id`，与 ama 现在每轮发送完整历史的做法一致。

### 4.9 嵌入宿主（Armadra）时的策略

- 宿主模式下 ama **不发起交互式登录**。Armadra 的界面引导用户在终端执行 `ama auth login chatgpt`，或由宿主在专门的「账户」面板中调用 `ama auth login chatgpt --paste`，用户自己完成登录。宿主**不读取、不保存、不转发 token**：token 只存在 ama 的 auth.json 中；凭据不得进入画布持久化、日志或 API 响应，这是 Armadra 约定里的 P0。
- 多个 ama 进程（画布上多个节点）共享同一个 auth.json，依靠 §4.5 的跨进程锁串行刷新，这一点是**必须**的。
- 宿主只消费 `rateLimits` 和 `{code:"auth_expired"|"quota_exceeded"}` 事件，用来展示状态和引导重新登录。
- 「仅限个人使用」意味着 Armadra 若做成多人或托管服务，**禁止**用一个 ChatGPT 登录服务多个用户。文档里要写明。

### 4.10 将来切换到自有或官方客户端的配置位

`config.json`（不含密钥）：

```jsonc
{
  "auth": {
    "chatgpt": {
      "flavor": "codex-borrowed", // "siwc-dynamic" | "custom"
      "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
      "issuer": "https://auth.openai.com",
      "authorizePath": "/oauth/authorize",
      "tokenPath": "/oauth/token",
      "redirectPorts": [1455, 1457],
      "redirectHost": "127.0.0.1",
      "scopes": ["openid", "profile", "email", "offline_access"],
      "originator": "codex_cli_rs",
    },
  },
  "providers": { "chatgpt": { "baseUrl": "https://chatgpt.com/backend-api/codex" } },
}
```

- `siwc-dynamic` 预设：
  - 授权和 token 路径改为 `/api/accounts/authorize`、`/api/accounts/oauth/token`；
  - `clientId:"dynamic_agent_client"`，首次登录后把签发的 ID 存进条目；
  - 授权参数加 `agent_name_hint:"ama"`、`ext_agent_host_id`（存在 `<configDir>/chatgpt-host.json`）、`resource`、`nonce`；
  - scope 为 `… resource.invoke chatgpt.tokens.use.direct`；
  - baseUrl 改为 `https://api.openai.com/v1`；
  - compat 去掉 account 头和 originator，额外删除 `metadata`、`user`、`safety_identifier`、`truncation`、`top_logprobs`、`max_tool_calls`；
  - 校验 id_token（JWKS 验签加 nonce），并确认授予的 scope 里有 `chatgpt.tokens.use.direct`；
  - 登出时调用 `revocation_endpoint`；
  - 错误映射见 §1.1。
- 环境变量覆盖：`AMA_CHATGPT_CLIENT_ID`、`AMA_CHATGPT_ISSUER`（测试用）、`AMA_CHATGPT_BASE_URL`。
- 两种 flavor 共用 PKCE、回调服务、存储、锁、刷新、配额框架，差异集中在一张「预设表」中。
- **建议**：上线借用方案后，尽快把 `siwc-dynamic` 作为第二个预设实现（工作量很小）。它是官方支持、免审批的路径，可以把借用方案降为「显式开启的备用」，从而大幅降低条款风险。

### 4.11 零依赖实现要点

- 只用 `node:crypto`（randomBytes、createHash；`createPublicKey` + `verify` 用于 RS256 JWKS 验签）、`node:http`、`fetch`、`node:fs`。
- 浏览器打开：macOS 用 `open`，Linux 用 `xdg-open`，Windows 用 `cmd /c start ""`。失败时只打印 URL。URL 用 argv 数组传入，不拼 shell 字符串。
- 用 `node:readline` 读取粘贴的回调 URL，复用 `ama auth set` 现有的无回显读取逻辑。
- 新模块：
  - `src/auth/oauth/pkce.ts`
  - `src/auth/oauth/callback-server.ts`
  - `src/auth/oauth/flows.ts`（browser / device / paste）
  - `src/auth/oauth/token-store.ts`（锁 + 原子写）
  - `src/auth/chatgpt/presets.ts`
  - `src/auth/chatgpt/claims.ts`
  - `src/ai/apis/chatgpt-rate-limits.ts`
- 日志红线：URL 中的 `code`、所有 token、id_token 原文都不进日志和错误信息；错误只带 HTTP 状态和 `error` 码。

### 4.12 测试方法

- **fake OAuth 服务器**（测试内 `node:http`，端口随机）：
  - 实现 `/oauth/authorize`（记录参数后 302 到 redirect_uri，带 code 和 state）、`/oauth/token`（校验 PKCE `S256(verifier)==challenge`，签发 `exp` 很短的假 JWT）、`/api/accounts/deviceauth/*`、`/.well-known/openid-configuration` + JWKS（测试密钥对现场生成）、`/revoke`。
  - 通过 `issuer` 和 `redirectPorts:[0]`（测试允许 0）注入。
- **fake 后端**：`/responses` 回放 SSE，校验请求头（`ChatGPT-Account-ID`、`originator`），并校验请求体**不含**禁用字段；返回 `x-codex-*` 头、`codex.rate_limits` 事件、429 `usage_limit_reached`、400 `Instructions are not valid`，用来验证 instructionsMode 自动回退。
- **并发**：同时起 5 个子进程刷新同一个 auth.json，断言 token 端点只被调用 1 次，所有进程最终拿到同一个新 token。fake 服务器在 refresh token 被重复使用时返回 `refresh_token_reused`，以此验证锁有效。
- **安全**：断言 auth.json 权限为 0600；断言 stdout、stderr、session 文件、RPC 事件中不出现 token 和 code（grep 预置的随机标记串）。
- **端口**：1455 被占用时退到 1457；两者都被占用时报错，并给出 `--paste` 提示。
- **手动 e2e**（需要用户的真实账户）：登录 → 跑 1 个回合 → `auth status` 显示配额 → 手动让 access token 过期后自动刷新 → 登出。

### 4.13 需要用户做的事

1. 执行 `ama auth login chatgpt`，在浏览器中用 Plus / Pro 账户登录并授权，并确认一次性风险提示。
2. （设备码模式）可能需要在 ChatGPT 的「Settings → Security」中开启 Codex 设备码授权（待实测）。
3. 不要同时用同一个 ChatGPT 账户在 ama 和 Codex CLI 里频繁登录登出；两者的 token 互相独立，但共享订阅配额。
4. 若将来切到 `siwc-dynamic`：在 ChatGPT「Settings → Usage → App limits」中给 ama 设置周上限。
5. 决定 `originator` 的默认值（`codex_cli_rs` 兼容性更好，`ama` 更透明），见 §5。

---

## 5. 风险与待定项

| #   | 风险 / 待定                                                            | 影响                           | 处置                                                                               |
| --- | ---------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| R1  | 私有后端变更（instructions 白名单、请求头、attestation、字段校验）     | 可能突然不可用                 | compat 开关 + 回退策略；保留 `siwc-dynamic` 作为第二通道；版本说明中标注「实验性」 |
| R2  | 条款灰区：借用他人的 OAuth 客户端，`originator` 冒充 Codex             | 账户受限（目前无公开封号先例） | 一次性提示；仅限个人使用；尽快上线官方动态注册预设                                 |
| R3  | refresh token 轮换竞争导致 `refresh_token_reused`                      | 所有进程掉线，需要重新登录     | 跨进程锁 + 刷新前重读文件（§4.5）；不与 `~/.codex` 共享 token                      |
| R4  | 回调端口固定为 1455 / 1457，与 Codex 登录冲突                          | 登录失败                       | 不抢占端口，给出 `--paste` 和 `--device` 替代                                      |
| R5  | Codex 登录时 `localhost` 与 `127.0.0.1` 的 redirect 是否都已登记       | 交换失败                       | 实测；配置项 `redirectHost` 可切换                                                 |
| R6  | `instructions` 是否仍被校验                                            | 400                            | 自动回退为 developer 消息；实测后定下缺省值                                        |
| R7  | 模型目录和上下文窗口未知                                               | 自动压缩关闭                   | discover 结果只填 slug；用户可在 `modelOverrides` 中补充 contextWindow             |
| R8  | 订阅成本无法用 token 计价                                              | 统计口径不一致                 | 设 `billing:"subscription"` 并单独展示                                             |
| R9  | Anthropic 的 SDK credit 方案恢复，或识别 harness                       | `claude` 驱动的计费归属改变    | 文档提示；不注入身份声明；不碰 Claude 凭据                                         |
| R10 | Copilot、Gemini 的诉求                                                 | 封号                           | 明确不做，在 doctor 和文档中说明原因                                               |
| D1  | `originator` 默认值：`codex_cli_rs` 还是 `ama`？                       | —                              | 待用户定；建议默认 `codex_cli_rs`，在 doctor 中显示                                |
| D2  | 是否提供 `ama auth import codex`                                       | —                              | 建议不提供，至少不默认                                                             |
| D3  | SIWC 文档要求「工具放进 namespace / additional_tools」的具体 JSON 形状 | 影响 `siwc-dynamic` 预设       | 用真实账户实测后补充                                                               |
| D4  | `wham/usage` 返回体字段是私有格式                                      | 显示可能出错                   | 只取百分比和重置时间，解析失败时静默                                               |
| D5  | 设备码是否需要用户在设置里开启                                         | 影响无头登录                   | 实测；`--paste` 作为兜底                                                           |

## 附：证据索引

- ama：
  - `src/ai/providers/auth.ts:1-13,107-233`
  - `src/config/auth-file.ts:68-118`
  - `src/config/types.ts:307-310`
  - `src/ai/types.ts:270-305,507-513`
  - `src/ai/apis/openai-responses-request.ts:291-318`
  - `src/agent/session.ts:128-135,184-187`
  - `src/cli/subcommands/auth.ts:23-26`
  - `src/drivers/native/claude-stream.ts:1-15`
  - `docs/guides/providers.md:169-178`
- codex-rs：
  - `login/src/server.rs:77-80,194,585-618,620-640`
  - `login/src/auth/manager.rs:212-216,1626-1700,1718`
  - `login/src/oauth/client.rs:81-88`
  - `login/src/device_code_auth.rs:23-60,68,107,175,206`
  - `login/src/token_data.rs:34-96`
  - `login/src/auth/default_client.rs:42`
  - `model-provider-info/src/lib.rs:77`
  - `model-provider/src/auth.rs:106`
  - `codex-api/src/requests/headers.rs:5-14`
  - `codex-api/src/rate_limits.rs:57-160,220-222`
  - `codex-api/src/api_bridge.rs:188-225`
  - `core/src/client.rs:160-168,995-1012,1300-1335`
  - `core/src/attestation.rs`
  - `backend-client/src/client/rate_limit_resets.rs:126`
- 社区：第三方 Codex 订阅认证插件（最新提交 2026-01-09）
  - `lib/constants.ts:10,26-39`
  - `lib/auth/auth.ts:6-10,186-192`
  - `lib/auth/server.ts:48`
  - `lib/request/request-transformer.ts:450,524-528`
  - `lib/prompts/codex.ts`
- 官方文档：
  - [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source)
  - [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
  - [token-reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
  - [profiles-and-sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
  - [models-and-inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
  - [errors-and-recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
  - [preview-limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
  - [self-hosted-vms](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
  - [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
  - [Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
  - [DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit)
  - [learn.chatgpt.com](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)
  - [Claude Code legal](https://code.claude.com/docs/en/legal-and-compliance)
  - [Anthropic consumer terms](https://www.anthropic.com/legal/consumer-terms)
  - [Claude Agent SDK & plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  - [Gemini CLI ToS](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
