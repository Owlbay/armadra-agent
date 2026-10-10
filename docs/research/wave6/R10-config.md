# R10 · ama 设置面板（`/config`）与命令行改配置 调研

> 只读调研；对象仓库 `/Users/yovinchen/Projects/Rust/Tauri/armadra-agent`（HEAD `07f5088`，v0.5.1）。
> 参照：工具 A 2.1.285 打包文本 `本机材料`（本机 CLI 为 2.1.287）、工具 B 0.160.0 二进制字符串、工具 C（`本机材料`）、工具 D（本机未安装，按公开资料，未逐条验证）。

## 0. 结论

1. **做一个数据驱动的 `/config` 面板 + `ama config get|set|unset|list`，两者共用一层「设置编辑核心」**（新文件 `src/config/settings-registry.ts` + `src/config/edit.ts`）：注册表给每个键标 _分组 / 类型 / 生效层级（即时 / 新会话 / 重启）/ 是否动缓存前缀 / 项目级可写性_；编辑核心负责「读盘 → 改一条路径 → `validateConfig` → 项目级跑 `restrictProjectConfig` 判断是否只收紧 → `writeConfigFile` 原子写 + `.bak`」。类型与枚举从现有 `buildConfigJsonSchema()` 推导，不再手写第二份。
2. **面板只收标量键**：76 个已登记叶子里约 **48 个**适合在面板里改（布尔 / 枚举 / 数字 / 模型引用）；`providers`、`permission.allow/deny/builtinDeny/autoSafeCommands`、`tools.default/disabled`、`*.dirs`、`sandbox.writable`、`agents.<id>`、hooks、密钥**不进面板**，只放一行「入口提示」（`ama providers …`、`/permissions`、`ama config edit`）。
3. **交互抄 工具 A 的骨架**：分组标题 + 「标签 · 当前值」行；`↑↓` 移动，`Enter`/`空格` 布尔取反、短枚举循环、长枚举/模型开子选择器、数字开单行输入；`/` 进入搜索（匹配键名、标签、枚举值）；`Esc` 先清搜索再关闭；关闭时把本次改动汇总成一条通知（工具 A 的 `Set X to Y` / `Config dialog dismissed` 做法）。
4. **写入层**：缺省用户级 `~/.config/ama/config.json`；`Tab` 切到「项目级」（`.ama/config.json`），只对项目级允许的键可写，且放宽被拒（复用 `restrictProjectConfig` 的同一规则）。profile 层与环境变量覆盖的键在面板里显示为**锁定**（工具 A 的 `lock` 做法），说明来源，不让改。
5. **生效**：分三档并在行尾标出——**即时**（ui 的大部分、`permission.mode`、`thinkingLevel`、`compaction.enabled`、`retry.enabled`、`cache.warming`、`ui.statusLine`）、**新会话**（`/new` 后生效：压缩阈值、重试参数、limits、fallbackModel、reminders …）、**重启**（工具表 / codemode / 沙箱 / hooks / skills / agents / `ui.ascii`）。改动**立即写盘**（不设「保存」按钮，与 工具 A、工具 C 一致）。
6. **缓存前缀提示**：会改工具表、系统提示或模型的项（`tools.preset`、`codemode.mode`、`defaultModel` 作用于当前会话时、`thinkingLevel`）在第一次改动时提示一次（参照 工具 A："Changing thinking mode mid-conversation will increase latency and may reduce quality."）。
7. **命令行**：`ama config get <key>`、`set <key> <value>`、`unset <key>`、`list [--json] [前缀]`，`--project` 写项目级；值按 schema 类型解析（`true/false`、数字、枚举、`--json` 传数组/对象）；非法值、项目级放宽一律非零退出（`ExitCode.Config`=3）。`config edit` 保留为「整文件编辑」逃生口。
8. **RPC / SDK 暂不暴露写入**：嵌入宿主（Armadra）走 profile，宿主不应改用户的全局配置；只考虑以后加只读 `get_config`。
9. **i18n**：面板标签、分组名、生效档提示放 `i18n/messages/config.ts`；键说明来自 `key-docs`，按 R8 的 D4 方案「schema 固定英文、`ama config show`/面板走 locale」。本批**依赖 R8 B0（`msg()` 与 `ui.language`）先合**，`ui.language` 由 B0 加入后面板自动出现。
10. **文件所有权**：本批新增文件为主，只在 `commands-core.ts`、`interactive/commands.ts`、`interactive-mode.ts`、`cli/subcommands/config.ts`、`docs/guides/tui.md` 各加少量接线；不碰 `key-docs.ts` 的文案（归 R8 B4）、不碰 Agent 栏 / 子 Agent 视图 / `/trace` / Memory / 登录的文件。

---

## 1. 参照产品

### 1.1 工具 A `/config`（2.1.285 打包文本）

**入口与命令**

- 斜杠命令 `config`，别名 `settings`，描述 "Open settings"，参数提示 `[key=value]`（@12025097：`aliases:["settings"],type:"local-jsx",name:"config"`）。另有非交互版本 "Set a setting by key"（`supportsNonInteractive:!0`），即 `/config key=value` 直接改一项；匹配不到时回 "isn't a /config setting. Run /config to see what's available."（@21783928）。
- 旧的独立命令 `/vim`、`/output-style` 已变成隐藏占位，描述 "moved to /config"（@12025097 附近 `Fqt("vim","Editor mode")`）——**零散设置命令向面板收拢**。
- 旧的 `config get|set|list|add|remove` 子命令在 2.1.287 已不存在：`--help` 的 Commands 列表里没有 `config`，打包文本里只剩一处过时提示（@33084339）。命令行改设置改为 `--settings <file/json>` 与直接编辑 `settings.json`。

**容器**：Settings 对话框四个标签页 `Status / Config / Usage / Stats`（@36719196：`$i,{title:"Status"…}`、`{title:"Config"…}`、`{title:"Usage"}`、`{title:"Stats"}`），`/config` 落在 Config 页。

**分组**（@36615173，`vo=[…]` 与 `wa={…}`）：

| 分组                                         | 设置项 id                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance                                   | theme, language, reduceMotion                                                                                                                              |
| Model & output                               | model, fast, switchModelsOnFlag, autoContinueAtUsageLimit, outputStyle, defaultView, verbose, autoCompact, thinking, permissionMode, useAutoModeDuringPlan |
| Display                                      | autoScroll, progressBar, tips, turnDuration, timeFormat, prStatus, externalEditorContext                                                                   |
| Input & controls                             | editor, askUserQuestionTimeout, modelProposedGoals, copyOnSelect, promptSuggestionEnabled, agentsView, checkpoints, workflows, … artifacts                 |
| Connections                                  | notifChannel, …, autoConnectIde, diffTool, chrome, remoteControl, …, apiKey                                                                                |
| Plugins / Advanced / Experimental / Internal | 插件选项；Advanced 标 "ADVANCED — MOVING TO SETTINGS.JSON"                                                                                                 |

分组标题全大写渲染（`Sa(o,d)` → `o.toUpperCase()`）。

**条目模型**（@21755000 起的设置表）：`{id, label, value, type, options?, optionsHint?, lock?, onChange}`，`type ∈ boolean | enum | managedEnum`。

- `boolean`：Enter / 空格取反（`if(h.type==="boolean"){let X=!h.value…}`）。
- `enum`：Enter / 空格**循环到下一个值**（`(h.options.indexOf(h.value)+1)%h.options.length`）；`pickToCommit` 的枚举改开 EnumPicker 子菜单。
- `managedEnum`：开专用子界面（Theme / Model / Language / Notifications …），或 TextEdit 自由输入（Language 的 hint："Any language name or ISO code (e.g. 'ja')"）。
- `optionsHint` 引导去专用命令（Model："For a specific model ID, use /model."）。
- `lock: {reason, source:"managed"}`：被托管策略锁住的项只显示原因不可改；`Se(n)` 判断某键生效来源不是 userSettings 时直接隐藏该项。
- onChange 可返回 `{error}`（弹 warning 通知，如 "Thinking can't be turned off for this model"）或 `{messageSuffix}`。

**交互**：底部提示 `enter/space change`、`/ search`、`Esc close`；搜索框占位 "Search settings…"，过滤规则 = id 含关键字 || 标签含关键字 || 枚举任一选项含关键字（@36640045 附近 `re.type==="enum"&&re.options.some(…)`）；搜索态 Esc = clear。关闭时汇总本次改动，逐条 `Enabled/Disabled X`、`Set X to Y`，无改动则 "Config dialog dismissed"（@36623500）。

**写到哪一层**：每项固定一层，用户不选。设置组件里三种写函数（@21755000 附近）：`R(e)` → `userSettings`（`~/.<工具A>/settings.json`，如 thinking、language）、`fe(e)` → `localSettings`（`.<工具A>/settings.local.json`，如 tips、reduceMotion、outputStyle）、`B(e,o)` → 全局状态 `~/.<工具A>.json`（editorMode、verbose、progressBar 等 UI 偏好）。项目共享层 `projectSettings` 不从面板写。

**生效**：几乎全部即时（直接改 AppState）；少数标签自带说明 "(this directory; applies next session)"（orgMemoryRead）。思考模式在对话进行中切换时提示 "Changing thinking mode mid-conversation will increase latency and may reduce quality."

本机 `~/.<工具A>/settings.json` 结构（只列键，略去值）：`permissions.{allow,deny,defaultMode}`、`env.*`、`enabledPlugins`、`alwaysThinkingEnabled`、`modelSettings`、`tui`、`switchModelsOnFlag`、`cleanupPeriodDays`、`includeCoAuthoredBy` 等——与面板项一一对应的只是一部分，规则列表与 env 都不在面板里。

### 1.2 工具 B 0.160.0

- 没有统一设置面板，按主题分散：`/model`（"choose what model and reasoning effort to use"）、`/permissions`（"choose what 工具 B is allowed to do"，原 `/approvals`）、`/experimental`（复选 + save，提示 "Some experimental features take effect only in new tasks or after restarting"）、`/statusline`、`/title`、`/theme`、`/keymap`、`/vim`、`/tui`（"choose the TUI mode for the next launch"）、`/debug-config`（"show config layers and requirement sources for debugging"）。
- 命令行：`-c key=value` 单次覆盖、`--strict-config`、`features list|enable|disable` 子命令（写 `config.toml`）。全权限切换有二次确认并提供 "Apply full access for this session"（只本会话）。
- 可借鉴：**层来源调试视图**（ama 已有 `config show` 的来源列）；「只本会话 / 写配置」二选一的措辞。

### 1.3 工具 C `/settings`

- 设置列表组件：条目 `{id,label,description,currentValue,values?,submenu?}`；Enter 或空格（搜索框为空时）激活：有 `values` 则循环（`(currentIndex+1)%values.length`），有 `submenu` 则开子菜单；可选搜索输入框。
- 设置写回 `settings-manager.js:425-450`：**写时重读磁盘文件，只覆盖本会话改过的字段**（`modifiedFields` / `modifiedNestedFields`），带文件锁——避免覆盖用户同时手改的内容。这一点 ama 应照搬。
- 描述直接写在条目上（选中时显示一行说明），与 ama 的 key-docs 思路一致。

### 1.4 工具 D `/settings`（未本机验证）

- 设置对话框带作用域选择（User / Workspace / System），条目旁标出「在其它作用域被改过」；schema 里有 `requiresRestart`，改了这类项会提示按 `r` 重启生效。
- 可借鉴：**作用域切换**与**需重启标记**——正好对应 ama 的用户级 / 项目级与三档生效。

---

## 2. ama 现状

### 2.1 配置键全集

`src/config/key-docs.ts` 的 `CONFIG_KEY_DOCS` 共 76 个叶子（`documentedLeaves()` 实测）；形状在 `types.ts` / `types-w5.ts`，校验在 `schema.ts:258 validateConfig` 与 `schema-w5.ts`，JSON Schema 在 `json-schema.ts:214 buildConfigJsonSchema()`（每个键有 `type`/`enum`/`default`，可直接作面板的类型来源）。缺省值：`DISPLAY_DEFAULTS`（key-docs.ts:40）+ `DYNAMIC_DEFAULTS`（运行时决定的键）。键说明目前**只有中文**（R8 已把 key-docs 列为 B4 的迁移对象）。

### 2.2 面板适合度

| 分组（建议）         | 进面板（类型）                                                                                                                                                                                                                                                                                                                                                 | 不进面板（入口提示）                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 界面                 | `ui.theme`(enum) `ui.markdown`(bool) `ui.showThinking`(enum) `ui.compact`(bool) `ui.animation`(bool) `ui.restoreOnCancel`(bool) `ui.statusLine`(enum) `ui.quietStartup`(enum) `ui.ascii`(bool/自动) ；R8 B0 后加 `ui.language`(enum)                                                                                                                           | `ui.tuiMode`（只有 regular，隐藏）                                                          |
| 模型                 | `defaultModel`(模型选择器) `thinkingLevel`(enum) `fallbackModel`(模型) `plan.model`(模型) `plan.thinkingLevel`(enum) `subagents.defaultModel`(模型) `models.aliases.fast/strong`(模型)                                                                                                                                                                         | `providers` → `ama providers …` / `ama auth`                                                |
| 权限                 | `permission.mode`(enum，Bypass 走现有确认) `permission.autoModel`(模型) `plan.bash`(enum) `plan.unattended`(enum)                                                                                                                                                                                                                                              | allow / deny / builtinDeny / autoSafeCommands → `/permissions` 查看、`ama config edit` 修改 |
| 工具与 codemode      | `tools.preset`(enum) `tools.maxToolResultChars`(数) `tools.bashTimeoutMs`(数) `codemode.mode`(enum+「跟随预设」) `codemode.inlineBudget`(数) `codemode.requireStrict`(bool) `images.resize`(enum) `hooks.timeoutMs`(数)                                                                                                                                        | `tools.default` / `tools.disabled` → `/tools` 与 `config edit`；Hook 本体 → `hooks.json`    |
| 压缩与缓存           | `compaction.enabled`(bool) `compaction.reserveTokens`/`keepRecentTokens`(数) `compaction.prune.keepResults`(数) `compaction.prune.clearAtLeast`(auto/数) `cache.warming`/`retention`(enum) `cache.minSavingsUsd`(数) `cache.missNotices`/`warmSubagents`(bool) `request.idleTimeoutMs`(数) `retry.enabled`(bool) `retry.maxRetries/baseDelayMs/maxDelayMs`(数) | `compaction.pruneExclude`（数组）                                                           |
| 会话与预算           | `limits.maxTurns`/`maxCostUsd`(数/不限) `reminders.*`(bool×4) `todo.reminder`(数) `checkpoints.mode`(enum) `checkpoints.maxFileBytes`/`keep`(数)                                                                                                                                                                                                               | —                                                                                           |
| 沙箱                 | `sandbox.enabled`(enum) `sandbox.bash`(enum) `sandbox.network`(enum)                                                                                                                                                                                                                                                                                           | `sandbox.writable`（数组）                                                                  |
| Agent                | `agents.maxConcurrent`(数) `agents.sessionBudgetUsd`(数/不限) `subagents.maxConcurrent/maxPending`(数)                                                                                                                                                                                                                                                         | `agents.<id>.*`、`agents.dirs`、`skills.dirs` → `config edit`                               |
| （R7 Memory 落地后） | `memory.*` 由 Memory 批次在注册表里加行                                                                                                                                                                                                                                                                                                                        | —                                                                                           |

合计约 48 项可在面板改；其余 ~25 项只显示只读值 + 入口提示，或干脆不列。

### 2.3 层级与合并

`merge.ts` 文件头注释与 `mergeConfigLayers`：**内置缺省 ← 用户级 ← profile.config ← 项目级（受限，只能收紧）← 命令行**；对象深合并、数组整体替换，累加型列表（`permission.allow/deny/autoSafeCommands`、`tools.disabled`、`skills.dirs`、`agents.dirs`）跨层拼接去重（merge.ts:76-83）。
项目级 `restrictProjectConfig(project, currentMode, label, currentPreset, currentMaxFileBytes, currentPlanBash)`（merge.ts:146）只接受：`permission.deny` 追加、`permission.mode` 更严且不能是 auto / full-auto、`compaction`（除 prune/pruneExclude）、`tools.disabled`、`tools.preset` 更严、`codemode.mode:"off"`、`ui`、`checkpoints.mode:"off"` / `maxFileBytes` 调小、`plan.bash` 更严、`reminders`、`sandbox.network:"deny"`；其余记 warning 并忽略。`cache`、`request`、第五波其余段只认用户级 / profile。环境变量覆盖：`AMA_CACHE_WARMING`、`AMA_CACHE_RETENTION`、`AMA_IDLE_TIMEOUT_MS`、`AMA_SANDBOX`、`AMA_CHECKPOINTS`、`AMA_ASCII`。项目级 config 不受 trust 门控（`trust.ts:96 trustGatedResources` 只管 hooks/skills/prompts）。
`ama config show` 已能逐键标来源 default / user / profile / project / cli（`cli/subcommands/config.ts` 的 `Layer` 与 `flatten`）——面板「来源」列可直接复用这段逻辑。

### 2.4 写回方式

`src/config/write.ts:12 writeConfigFile(path, config, {backup})`：mkdir → 已存在则复制 `<path>.bak` → 同目录 `<path>.<pid>.tmp` 写 `JSON.stringify(config, null, 2)+"\n"` → 沿用原权限 → rename。现有调用者：`models discover --write`、`providers` 两处。

- config.json 是**严格 JSON**（`load.ts:58 parseJsonText` 用 `JSON.parse`，只容 BOM），没有注释可丢；键顺序随 parse/stringify 保留；但**手排的格式会被规整成 2 空格**（需在文档里说明）。
- 缺口：不重读磁盘、不做「只改一条路径」；面板连续改多项时若用户同时 `config edit`，后写者覆盖前者。按 工具 C 的做法补 `editConfigPath()`：每次写前重读 → 改一条路径 → 校验 → 写。
- `.bak` 每次覆盖为上一版，连续改 10 次只剩最近一版；面板会频繁写，可接受（与现有行为一致），但不应为每次切换都产生多份备份。

### 2.5 当前会话的生效方式（代码证据）

- **启动时一次读取**：`interactive-mode.ts:128-164` 从 `runtime.config.ui` 构造 `createTheme`、`MessageView{showThinking, markdown, compact}`、`Loader{animation}`；`status-area.ts:77` 读 `ui.statusLine`。这些对象目前**没有 setter**（StatusArea 有 `toggle()`，status-area.ts:123）。主题对象被几十个组件持有引用，热切换需要 `PaletteTheme` 支持就地换调色板（`tui/theme.ts:285 createTheme` 返回新对象），然后 `tui.forceFullRedraw()`；终端回滚里的旧行颜色不会变。
- **会话级 setter 已有**：`setModel / setThinkingLevel / setPermissionMode / setActiveTools`（`agent/types.ts:440-443`、`session-settings.ts:90`），`setAutoCompaction / setAutoRetry`（`session.ts:467/471`，RPC 已用），`session.cache.setWarming`（`/cache warm`）。
- **每会话组装时读取**（`/new` `/resume` 后生效）：`compose-session.ts:326-371` 从 `assembly.config` 取 `compaction`、`retry`、`limits`、`fallbackModel`、`tools.maxToolResultChars`、`ui.restoreOnCancel`、`cache`、`request.idleTimeoutMs`、`subagents`。前提是编辑后**同步改 `runtime.config`**（现在是 `readonly config: AmaConfig`，`cli/runtime.ts:75`，需加一个受控的 `replaceConfig()`）。
- **进程级、需重启**：`compose.ts:140-165` 的 OS 沙箱、bash 沙箱、`bashTimeoutMs`、图片缩放；工具注册表（preset / codemode / disabled / default）在组装时定型；hooks、skills、agents 目录同理；`ui.ascii`、`ui.quietStartup` 只影响启动。
- **缓存前缀**：`ai/cache/fingerprint.ts` 指纹 = 系统提示 + 工具表 + 模型；所以工具类与模型类改动会让首个请求 `prefix_changed` / `model_changed`。`thinkingLevel` 不进指纹，但 Anthropic 端改思考参数会失效消息缓存，仍应提示。

---

## 3. 推荐设计

### 3.1 设置注册表（`src/config/settings-registry.ts`，新）

```ts
interface SettingSpec {
  key: string; // "ui.theme"
  group: "ui" | "model" | "permission" | "tools" | "context" | "session" | "sandbox" | "agents";
  kind: "bool" | "enum" | "number" | "model" | "optionalNumber"; // 由 JSON Schema 推导，可覆盖
  options?: readonly string[]; // 枚举值，取自 types.ts 的常量（CODEMODE_MODES 等）
  apply: "now" | "nextSession" | "restart";
  prefix?: boolean; // 改它会动缓存前缀
  project: "deny" | "tighten" | "any"; // 与 restrictProjectConfig 一致，单测互相校验
  envOverride?: string; // "AMA_CACHE_WARMING" 等，存在则锁定
  hint?: MsgKey; // 不进面板的项给入口提示
}
```

- 一致性测试：注册表每个 key 都在 `CONFIG_KEY_DOCS` 叶子里；`kind/options` 与 `buildConfigJsonSchema()` 对得上；`project` 字段与 `restrictProjectConfig` 的实际行为对得上（对每个键构造放宽 / 收紧样例跑一遍）。
- 其他批次（Memory、i18n 的 `ui.language`）**只需在表里加一行**。

### 3.2 编辑核心（`src/config/edit.ts`，新）

- `getConfigValue(layers, key) → {value, source}`（复用 `config show` 的 flatten / 来源判定，抽成公共函数）。
- `setConfigValue({scope: "user"|"project", key, value, cwd, env})`：重读目标文件（不存在则 `minimalConfig()`）→ `setPath` → `validateConfig`，有 error 拒绝 → project 层再跑 `restrictProjectConfig(candidate, …)`，若该键出现在 warnings（被忽略），拒绝并给出原因（「项目级只能收紧 permission.mode」）→ `writeConfigFile(path, next, {backup:true})`。
- `unsetConfigValue`：删路径，空对象段一并删掉，恢复为下层值。
- 返回 `{effective, source, apply, prefixChanged}` 供面板 / CLI 输出。
- 值解析 `parseValue(spec, raw)`：`true/false/on/off/1/0`、数字（可带 `_`）、枚举（大小写不敏感、接受别名如 `codemode`）、`none`/`default` 表示 unset。

### 3.3 `/config` 面板（`src/modes/interactive/config-panel.ts`，新）

布局（居中覆盖层，复用 `Box` + `SelectList` 的渲染风格；`SelectList` 没有分组标题和行内值列，建议新写 `SettingsList` 组件放 `src/tui/components/settings-list.ts`，或在面板文件内实现，避免改动 `select-list.ts`）：

```
 设置                                     写入：用户级 ~/.config/ama/config.json   [Tab 切换]
 / 搜索…
 界面
 › 主题                    dark              即时
   Markdown 渲染           true              即时
   思考内容                collapsed         即时
   底部信息行              full              即时
   ASCII 字形              自动 (false)      重启
 模型
   缺省模型                anthropic/…       新会话   <- 来源 user
   思考强度                medium            即时 · 动缓存
 权限
   权限模式                default           即时     [锁定] 项目级 plan 生效
 …
 ─────────────────────────────────────────────
 配色主题：dark、light，或 auto（按 COLORFGBG 猜…）           ← 当前项的 key-docs 说明（dim，折行）
 ↑↓ 选择 · Enter/空格 修改 · / 搜索 · Tab 用户级/项目级 · Esc 关闭
```

- 每行：标签（i18n）· 当前生效值（dim 标出来源：default / user / profile / project / cli / env）· 生效档。不用 emoji，锁用 `[锁定]` 文字或 theme 的 dim+warning 色。
- 交互：`↑↓`/`PgUp/PgDn`/`Home/End`；`Enter`/`空格`：bool 取反、≤4 项枚举循环、长枚举与模型开子选择器（模型复用 `pickers.ts` 的 `modelItems`，思考复用 `thinkingItems`，权限复用 `permissionPickerSpec` 与 Bypass 确认 `confirmMode`）、数字开单行输入（可复用 `Editor` 单行模式，Enter 提交、Esc 放弃，非法值红字留在输入框）；`Backspace`/`Delete` 在当前项上 = unset（回到下层值，需二次确认一次）；`/` 搜索（键名、标签、枚举值、说明都匹配），搜索中 Esc 清空；`Tab` 切写入层。
- 锁定：被 `env` / `cli` / `profile` 覆盖的项可以改写入层的值，但行尾标「当前由 X 覆盖，修改在 X 撤掉后生效」；项目级切换下不允许的键整行 dim、Enter 给出原因。
- 写盘：每次修改**立即**调用 `setConfigValue`；失败弹 error 通知并回滚显示值。
- 热应用（`apply:"now"`）：经一个 `ConfigApplier`（`interactive-mode.ts` 注入）分派——`ui.*` 调 `view.setOptions / loader.setAnimation / area.setMode / theme.replace` 后 `forceFullRedraw`；`thinkingLevel` → `session.setThinkingLevel`；`permission.mode` → `session.setPermissionMode`（但若项目级更严则提示「项目级 plan 仍生效」）；`compaction.enabled` / `retry.enabled` → `setAutoCompaction / setAutoRetry`；`cache.warming` → `session.cache.setWarming`；同时 `runtime.replaceConfig(remerged)` 让 `/new` 拿到新值。
- **模型 / 思考类的语义**：面板改的是「缺省值」。`defaultModel` 写盘后询问一次「同时切换当前会话？」（缺省是）；`thinkingLevel`、`permission.mode` 直接同时作用于当前会话（工具 A 同样即时）。
- 缓存提示：本面板生命周期内，第一次改动 `prefix:true` 的项且当前会话已有助手消息时，在面板底部提示一行「会改变缓存前缀，下一次请求按未命中计费」，不弹确认。
- 关闭汇总：Esc 关闭时在消息区打一条 info，逐条「主题：dark → light（用户级）」；需重启的项额外一行「以下项重启后生效：…」；无改动不打（或「设置未改动」）。
- `/config key=value`（或 `/config key value`）：不开面板，直接设一项（走同一 `setConfigValue`，用户级），给出与 CLI 相同的回显；`/config` 带未知键时提示「不是可设置项，用 /config 查看」。
- 现有零散命令保留：`/model`、`/thinking`、`/permission`、`/statusline` 仍只影响本会话；面板项的说明里注明「只改本会话请用 /model」，与 工具 A 的 `optionsHint` 一致。

### 3.4 命令行 `ama config`

```
ama config get <key> [--json]                  生效值 + 来源 + 生效档
ama config set <key> <value> [--project] [--json-value]
ama config unset <key> [--project]
ama config list [前缀] [--json] [--all]        缺省只列可设置项；--all 列全部（等价 show 的扁平版）
ama config show / path / edit                  保持现状
```

- 类型校验复用 schema；`set` 对数组 / 对象键默认拒绝，`--json-value` 时允许（如 `tools.disabled '["bash"]'`），这样规则列表也有命令行入口但不进面板。
- `--project` 写 `<cwd>/.ama/config.json`，放宽被拒，错误信息与面板一致。
- 退出码：成功 0；未知键 / 非法值 / 放宽被拒 = 3（`ExitCode.Config`）；写失败 = RuntimeError。
- 只读子命令（get / list）不触发 `autoInitConfigDir`，与 `config show` 同规则（`main.ts` 的只读名单需加上）。
- 这也补上 R8 风险 R1 里要用的 `ama config set ui.language zh`。

### 3.5 RPC / SDK

- 不加 `set_config`：Armadra 等宿主以 profile 控制嵌入实例，宿主不该写用户全局文件；面板在 profile 模式下仍可用（写用户级），但 profile 覆盖的项显示锁定。
- 可选（后续）：只读 `get_config`（生效值 + 来源，`apiKey` 只给种类），契约要进 `docs/reference/rpc.md`。
- SDK 已有 `CreateSessionOptions.config`（sdk.ts:185）作内存覆盖，不需要写盘接口；`edit.ts` 的函数可以从 `@armadra/agent` 导出给二次开发用，但不进本批。

### 3.6 i18n

- 面板固定文案（分组名、档位「即时 / 新会话 / 重启」、锁定说明、按键提示、汇总句式）→ `src/i18n/messages/config.ts`（R8 B0 建目录与 `msg()`）。
- 设置项标签是新文案（key-docs 只有说明没有短标签）：放在同一 messages 文件，键 = 配置键名；英文标签可直接用键名的人话形式。
- 键说明：调用 R8 规划的 `keyDoc(path)`（locale 感知）；R8 B4 未合前回落中文。
- 枚举值本身（`dark`、`collapsed`）不翻译，避免与配置文件写法不一致。

### 3.7 测试要点

1. **注册表一致性**：键 ⊂ key-docs 叶子；kind/options 与 JSON Schema 一致；`project` 标记与 `restrictProjectConfig` 实测一致。
2. **编辑核心**：写回保持其它字段与键顺序（含 `$schema`、`providers` 原样）、2 空格 + 尾换行、`.bak` 生成、原权限 0600 保持；写前重读（模拟外部改动后再 set，外部改动不丢）；`unset` 清空段；非法值（枚举外、负数、字符串给数字键）拒绝且文件字节不变；项目级放宽（`permission.mode: full-auto`、`cache.*`、`tools.preset: codemode-only` 在当前 default 下）被拒且文件不变；收紧被接受。
3. **CLI**：get / set / unset / list 的文本与 `--json` 输出、退出码、`--project`、只读子命令不 init。
4. **面板帧黄金**（沿用 `interactive-frames.test.ts` 的虚拟屏）：初始帧、分组标题、选中行、来源与档位列、锁定行、搜索过滤后帧、数字输入错误帧、窄屏（60 列）截断、ASCII 模式、light 主题。
5. **热应用**：改 `ui.compact` / `ui.showThinking` 后新消息块的渲染变化；`ui.statusLine` 与 Ctrl+G 状态一致；`permission.mode` 进入 Bypass 走确认、取消则不写盘；`thinkingLevel` 改后 `session.state.thinkingLevel` 变化；`/new` 后会话拿到新 `compaction.reserveTokens`。
6. **汇总通知**：多项改动的汇总文本；需重启项单列。
7. **`/config key=value`**：line 模式与交互模式都可用，未知键提示。

---

## 4. 文件所有权（建议）

**本批新增**：`src/config/settings-registry.ts`、`src/config/edit.ts`（+ 测试）、`src/modes/interactive/config-panel.ts`（+ 帧测试）、`src/tui/components/settings-list.ts`（若独立成组件，+ `src/tui.ts` 一行导出）、`src/cli/subcommands/config-set.ts`（get/set/unset/list，避免把 `config.ts` 撑大）、`src/i18n/messages/config.ts`（依赖 R8 B0 的目录）。

**本批少量改动（热点，先约定行位）**：

- `src/modes/commands-core.ts`：`BUILTIN_COMMANDS` 加一行 `config`，`switch` 加 `/config key=value` 分支（文本版，line 模式也能用）。第六波 `/trace`、Memory 可能也往这张表加行——约定各自追加在表尾、不重排。
- `src/modes/interactive/commands.ts`：`/config` 无参时开面板（与 `/permissions` 同样在 `runInteractiveCommand` 前段拦截）；`CommandUi` 加可选 `configPanel?()`。
- `src/modes/interactive/interactive-mode.ts`：注入 `ConfigApplier`（拿到 view / loader / area / theme / session）；`MessageView`、`Loader`、`StatusArea` 各加一个 setter（各自文件里几行）。
- `src/tui/theme.ts`：`PaletteTheme` 加就地换调色板。
- `src/cli/runtime.ts`：`replaceConfig()`；`src/cli/subcommands/config.ts`：用法串与分派加四个子命令，抽出 flatten / 来源判定给 `edit.ts` 复用；`src/cli/main.ts` 只读名单。
- `docs/guides/tui.md`（「配置与排错」节加 `/config`）、`docs/guides/providers.md` 或 README 的 `ama config` 用法。

**避开**：`agent-ui.ts`、`agent-panels.ts`、`subagent-view.ts`、`status-bar.ts`/`status-line.ts`（Agent 栏 / 子 Agent 视图批次）；`/trace` 相关新文件；Memory 的 `memory/**` 与其配置键（Memory 批次在 `types-w5`/`schema-w5`/`key-docs` 加键后，自己在 `settings-registry.ts` 追加一行）；`cli/subcommands/auth.ts`（ChatGPT 登录）；`key-docs.ts` 的说明文字（R8 B4）——本批**不新增配置键**，因此不碰 `types.ts`/`schema.ts`/`json-schema.ts`。
**顺序**：R8 B0 → 本批；与 R8 B2（`modes/interactive/**`）在 `commands.ts`、`interactive-mode.ts` 有交集，建议本批先合或 B2 把这两个文件留到最后。

---

## 5. 风险与待定项

**风险**

- **R1 热切换主题**：主题对象被到处持有；就地换调色板可行，但已进入终端回滚的历史行颜色不变（ama 是主屏模式）。若实现代价大，`ui.theme` 退化为「重启」档。
- **R2 并发写**：面板与 `config edit`、`models discover --write`、另一个 ama 进程同时写；写前重读能解决大部分，仍无文件锁（工具 C 有）。可接受，文档说明。
- **R3 格式规整**：手写的 config.json 第一次被面板写回后会被重新缩进；`.bak` 只保留上一版。
- **R4 项目级与用户级认知**：用户在用户级改了 `permission.mode`，但项目级更严导致「改了没变化」——必须在行内显示生效来源，否则会被当成 bug。
- **R5 Bypass / full-auto 写盘**：把 `permission.mode` 持久化为 full-auto 影响以后所有会话；面板里进入这两档要有确认，并在确认文案里说明「写入用户级，以后每次启动都生效」；也可只允许面板把缺省设到 auto 为止（待定 D3）。
- **R6 profile 嵌入**：在 Armadra 终端节点里打开 `/config` 改用户级，会影响用户独立使用的 ama；需在面板标题提示「嵌入模式：写入用户级配置」。
- **R7 i18n 依赖**：若 R8 B0 延后，本批要么写中文字面量由 R8 B5 收尾，要么等待；推荐等待 B0（B0 体量小）。

**待定（需拍板）**

- **D1** 面板里改 `defaultModel` 是否同时切换当前会话（推荐：询问一次，缺省是）；`thinkingLevel` / `permission.mode` 是否同时作用当前会话（推荐：是）。
- **D2** 是否在面板里提供「只本会话」开关（工具 B 风格），还是保持「面板 = 持久化、零散命令 = 本会话」的分工（推荐后者，简单）。
- **D3** 面板能否把 `permission.mode` 持久化为 `full-auto`（推荐：允许但二次确认）。
- **D4** 标签页：是否像 工具 A 一样把 `/session`、`/cache` 并进同一对话框做 `状态 / 设置 / 用量` 标签（推荐本批不做，保持现有面板，后续再议）。
- **D5** `ama config set` 是否支持数组键（推荐支持 `--json-value`，面板不支持）。
- **D6** `/config key=value` 写用户级还是询问（推荐写用户级，与 CLI 缺省一致）。
