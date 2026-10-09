# 对话中途的 system 消息：DeepSeek 实测（2026-10-09）

> 目的：决定 DeepSeek 是否打开 `supportsMidConvoSystemMessages`，也就是会话中途变化的系统提示节能否以「对话中途的 system 消息」送达而不改写开头。结论：**不打开**，改为通用做法——中途节补丁以 `<system-reminder>` 包裹的 user 消息追加在尾部（[providers.md](../providers.md)「缓存」）。
> 合计 **6 次请求**，按 deepseek-flash 目录价约 **$0.006**；中转的真实账单未单独核对。key 由 ama 自己的供应商注册表解析后只传给协议层，没有读取、打印或记录。

## 环境

- 测试中转站 `packy/deepseek-v4-flash@chat`（openai-completions），本分支 `pnpm build:lib` 的构建；请求经 ama 协议层（`ApiRegistry.stream`）发出，`maxTokens: 32`、思考关闭，相邻两次间隔 4 s。
- 固定前缀：`cache-probe` 同款确定性句子约 8.6k token，放在开头 system 的第二节；第一节是一句指令「暗号是 APPLE，问到时只回答暗号」。
- 中途更新：在第一轮问答之后插入「暗号改为 BANANA，取代之前的暗号」，再问同一句「暗号是什么」。三种送达方式：
  - **中途 system**：强制 `supportsMidConvoSystemMessages: true`，补丁按位置作为 system 消息插回；
  - **改写开头**：补丁折回开头的 system（本分支之前的行为）；
  - **尾部 user 提醒**：补丁作为 `<system-reminder>` 包裹的 user 消息追加在尾部（本分支采用的做法）。
- 端点的缓存读按 2048 token 一块计（[cache-2026-10-02](cache-2026-10-02.md) E1 与本次一致），所以读数是 2048 的倍数。

## 数据

| #   | 请求                       | 回答      | input | cacheRead | 前缀合计 | 读 / 前缀 |
| --- | -------------------------- | --------- | ----- | --------- | -------- | --------- |
| R1  | 基线：开头 APPLE，首轮提问 | APPLE     | 8651  | 0         | 8651     | 0%        |
| R2  | 中途 system 改为 BANANA    | **APPLE** | 505   | 8192      | 8697     | 94%       |
| R3  | 改写开头为 BANANA          | BANANA    | 8664  | 0         | 8664     | 0%        |
| R4  | R2 之后再问一轮            | **APPLE** | 524   | 8192      | 8716     | 94%       |
| R5  | 尾部 user 提醒改为 BANANA  | BANANA    | 506   | 8192      | 8698     | 94%       |
| R6  | R5 之后再问一轮            | BANANA    | 526   | 8192      | 8718     | 94%       |

## 结论

- **(a) 接受**：对话中途的 system 消息返回 200，没有报错。
- **(b) 不以最新一条为准**：R2、R4 两次都按开头那条回答 APPLE。中途 system 消息在这个端点上不能用来覆盖开头的系统提示，所以不为 DeepSeek（官方与中转）打开 `supportsMidConvoSystemMessages`。
- **(c) 前缀缓存**：中途 system 与尾部 user 提醒都保持了 8192（整块）的读数；改写开头从第 0 个 token 起失效，读数为 0，整段按全价重读。
- 尾部 user 提醒同时满足「模型按新内容回答」（R5、R6）与「前缀缓存保持」（94%），作为所有不支持中途 system 的端点的通用做法。移除工具的补丁仍折回开头：工具表本身变了，前缀本来就会失效。
- 实验里的提醒正文是一句手写的替换说明；实现渲染的是「System prompt section … was updated」加一句「取代之前的版本」，同样用 `<system-reminder>` 包裹、同样是 user 角色。
- 单次实验、每种方式一到两次请求，只取方向一致的结论；上游是否就是 DeepSeek 官方实现无法从中转区分。
