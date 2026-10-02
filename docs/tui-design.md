# ama 终端界面视觉设计 v1

> 适用：`src/tui/**`（组件库）与 `src/modes/interactive/**`（交互模式）。基线 main 217017c。
> 约束不变：主屏模式（不用备用屏，历史进终端回滚，tmux `capture-pane` 可读）、差分渲染、运行时零依赖、`NO_COLOR` / 16 / 256 / truecolor 降级、40 列可用、中文宽字符正确、Windows Terminal 可用、括号粘贴。
> 参考对象只有两个：Pi 1.0（组件模型、主题 JSON 的角色划分）与 Claude Code（视觉语言：`›` 输入、`⏺` / `⎿` 工具层级、spinner 动词、底部模式提示、编号审批）。

## 0. 现状诊断（对照 test/fixtures/tui/*.txt）

| 现象                                                                                         | 位置                                   | 问题                                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| 首行 `ama 0.1.0 · Enter 发送 · Esc 中断 · Ctrl+C 两次退出 · /help 命令`                      | `cli/startup-screen.ts` `headerLine()` | 标题行塞满按键说明，没有身份信息（模型 / 目录 / 模式）；40 列折成两行   |
| 用户消息 `› 文本`，续行顶格                                                                  | `message-view.ts` `addUser`            | 多行用户消息第二行与助手正文无法区分                                    |
| 助手正文、工具、提示全部顶格、块间统一空一行                                                 | `message-view.ts` `add()`              | 没有层级：连续三个工具调用占 6 行；提示与正文同权重                     |
| 工具 `● read  README.md` + 顶格缩进 2 的结果                                                 | `tool-view.ts`                         | 结果没有「挂在调用下」的视觉连接；`… 另 2 行（Ctrl+O 展开）` 与结果同色 |
| 代码块全宽圆角框、正文整体橙色（`code`）                                                     | `markdown.ts` `renderCode`             | 大段橙色抢眼；语言标签与边框同样醒目                                    |
| 输入框两条全宽 `─`，无提示符、无占位                                                         | `editor.ts`                            | 空闲时看不出这是输入区；与状态栏的分隔线视觉重复（三条线叠在一起）      |
| 状态栏 `fake/echo · think:medium · ↑12.3k ↓1.2k · cache 80% · $0.002 · ctx 1% · mode:Manual` | `status-bar.ts`                        | 全部同权重、`key:value` 机器味；40 列截断成 `…` 丢掉最重要的模式        |
| 审批框 `[y] 允许  [n] 拒绝  [a] 本会话允许同类  [v] 完整输入` 一行                           | `approval-dialog.ts`                   | 40 列折行后难读；没有「当前选项」概念，不能方向键选                     |
| 压缩摘要是全宽 Box                                                                           | `message-view.ts` `addSummaryCard`     | 与代码块、审批框三种东西共用同一种重框                                  |
| 运行中 `⠋ 工作中 · Esc 中断 (0s)`                                                            | `interactive-mode.ts` `syncLoader`     | 不知道在做什么（思考 / 回复 / 跑哪个工具），没有 token 计数             |

## 1. 设计原则

1. **三级信息层级，用缩进而不是颜色表达。** 第 0 列：用户 `›`、工具 `⏺`、提示符号（`✗ ! ↻ ◇`）；第 2 列：结果连接符 `⎿` 与助手正文的续行；第 4 列：工具输出正文。颜色只做第二通道——`capture-pane` 不带 `-e` 时得到的纯文本仍然能读出结构。
2. **留白按组分配，不按块平均。** 一个「回合」（用户消息 → 助手正文 → 若干工具调用 → 助手正文）内部，相邻工具调用之间不空行；回合之间空一行；`ui.compact: true` 时全部不空行。24 行的 tmux 节点里能多看 30% 内容。
3. **颜色克制：一屏最多三种彩色。** 正文 `text`、次要 `muted`、禁用 / 装饰 `dim` 三级灰；彩色只给状态（成功 / 警告 / 错误）、焦点（`accent`）和身份（`user` / `tool`）。背景色只在 ≥ 256 色时用，且只用于「选中行」与 diff 行底色；16 色与 `NO_COLOR` 下靠字形与粗体。
4. **状态一目了然。** 每个可变状态都有字形：`⏺` 颜色 + 结果行首字（`✓ ✗`）、spinner 动词、状态栏模式名；颜色与字形冗余编码，去掉颜色不丢信息。
5. **对读屏友好。** 每行末尾重置样式、不用 OSC 8 超链接、不用 bg 跨整行、没有只靠颜色区分的字段；状态栏永远是最后一行，输入框永远在它上面，宿主可以用倒数第 1 / 第 3 行锚定。
6. **差分友好。** 流式期间只有正在增长的块变行；spinner 行每帧只改一个字；代码块永远全宽（不随内容变宽），避免框线抖动；所有「运行中 → 完成」的切换都是**原地替换**，行数只增不减（结果行追加在标题下面）。
7. **窄屏优先裁剪，不换布局。** 40 列与 80 列是同一套组件、同一套规则：截断 / 丢字段 / 折行，不切换成另一种结构（避免两套黄金两套 bug）。

## 2. 主题

### 2.1 语义色（`SemanticColor`）

在现有 11 个名字上**只加 3 个**：`muted`（正文与 dim 之间的次要文字）、`link`、`selection`（选中行底色，只在 ≥ 256 色时作 bg 用）。`component.ts` 是契约文件，这是唯一需要改的契约点。

| 名字        | 用途                                             | dark truecolor | dark 256 | dark 16 | light truecolor | light 256 | light 16 |
| ----------- | ------------------------------------------------ | -------------- | -------- | ------- | --------------- | --------- | -------- |
| `text`      | 正文、工具摘要、代码块正文                       | `#e4e4e4`      | 254      | 7       | `#1c1c1c`       | 234       | 0        |
| `muted`     | 结果摘要、列表圆点、表格线、思考正文             | `#a8a8a8`      | 248      | 7       | `#585858`       | 240       | 8        |
| `dim`       | 占位、折叠提示、分隔符 `·`、时间                 | `#6c6c6c`      | 242      | 8       | `#8a8a8a`       | 245       | 8        |
| `accent`    | 焦点、选中项、运行中 `⏺`、标题 h1/h2、spinner    | `#5fafff`      | 75       | 12      | `#005fd7`       | 26        | 4        |
| `success`   | 成功 `⏺` / `✓`、diff `+`、ctx < 70%              | `#5fd787`      | 78       | 10      | `#008700`       | 28        | 2        |
| `warning`   | `!` 提示、重试、ctx ≥ 70%、Bypass 模式           | `#ffd75f`      | 221      | 11      | `#af5f00`       | 130       | 3        |
| `error`     | `✗`、失败 `⏺`、diff `−`、ctx ≥ 90%、危险审批     | `#ff5f5f`      | 203      | 9       | `#d70000`       | 160       | 1        |
| `user`      | 用户 `›`、输入框提示符                           | `#87afff`      | 111      | 12      | `#005faf`       | 25        | 4        |
| `assistant` | 保留（= text）                                   | `#e4e4e4`      | 254      | 7       | `#1c1c1c`       | 234       | 0        |
| `tool`      | 工具名                                           | `#af87ff`      | 141      | 13      | `#8700af`       | 91        | 5        |
| `border`    | 框线、规则线、`⎿`、引用竖线                      | `#585858`      | 240      | 8       | `#bcbcbc`       | 250       | 7        |
| `code`      | **只用于行内代码**与审批框里的命令               | `#ffaf5f`      | 215      | 11      | `#875f00`       | 94        | 3        |
| `link`      | Markdown 链接文字（下划线）                      | `#87d7ff`      | 117      | 14      | `#0087af`       | 31        | 6        |
| `selection` | 选中行 bg（≥ 256 色）；16 色下退化为 accent 粗体 | `#303030`      | 236      | —       | `#e4e4e4`       | 254       | —        |

- truecolor 值全部取自 xterm 256 立方 / 灰阶上的点，所以 256 色回退**无损**（`rgbTo256` 直接命中）；16 色列是期望值，加一条测试锁定 `rgbTo16(parseHex(x)) === 期望`，防止 `distance()` 权重调整后变色。
- 阈值着色统一走一个工具函数 `levelColor(ratio, {warnAt: .7, dangerAt: .9})`（`Meter.level()` 已有，提到 theme.ts 导出），状态栏 ctx、Meter、`/session` 上下文行都用它。
- bg 规则：`theme.caps.colors >= 256` 时 `selection` 作 bg；否则 `theme.bg("selection", s)` 返回 `bold(fg("accent", s))`。diff 行**不加 bg**（tmux 里 bg 跨行与截断后的 `\x1b[0m` 组合常出现「尾巴」）。
- `ui.theme: "auto"`：不发查询序列。顺序：`COLORFGBG`（`15;0` → dark，`0;15` → light）→ `TERM_PROGRAM=Apple_Terminal` 且无 COLORFGBG → dark → 缺省 dark。文档里明说 auto 只是猜，建议显式配置。

### 2.2 字形与 ASCII 回退

新增 `src/tui/glyphs.ts`：`interface Glyphs`、`UNICODE_GLYPHS`、`ASCII_GLYPHS`、`detectAscii(env)`。挂到 `Theme`（`theme.glyphs`），所有组件通过 theme 取，不另加参数。

| 键                      | Unicode                | ASCII           | 用处                                    |
| ----------------------- | ---------------------- | --------------- | --------------------------------------- |
| `prompt`                | `›`                    | `>`             | 用户消息、输入框                        |
| `tool`                  | `⏺`                    | `*`             | 工具调用标题                            |
| `result`                | `⎿`                    | `L`             | 结果连接符                              |
| `ok` / `fail` / `warn`  | `✓` `✗` `!`            | `v` `x` `!`     | 结果摘要首字、提示                      |
| `thinking`              | `✻`                    | `~`             | 思考块                                  |
| `queued`                | `↳`                    | `->`            | 排队消息                                |
| `retry`                 | `↻`                    | `@`             | 重试提示                                |
| `card`                  | `▎`                    | `\|`            | 左侧竖条卡片（压缩摘要、/session 面板） |
| `expand` / `collapse`   | `▸` `▾`                | `>` `v`         | 可展开提示                              |
| `warm`                  | `♨`                    | `~`             | 缓存保温                                |
| `bullet[]`              | `• ◦ ▪`                | `- * +`         | 列表                                    |
| `meter`                 | `▮ ▯`                  | `# .`           | 余量条                                  |
| `box`                   | `╭ ╮ ╰ ╯ │ ─`          | `+ + + + \| -`  | 边框                                    |
| `spinner[]`             | 10 帧盲文 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 4 帧 `- \ \| /` | Loader                                  |
| `ellipsis`              | `…`                    | `...`           | 截断                                    |
| `arrowUp` / `arrowDown` | `↑` `↓`                | `^` `v`         | token 计数                              |

- 触发 ASCII：`ui.ascii: true` 或 `AMA_ASCII=1`，或自动检测：`LANG`/`LC_ALL`/`LC_CTYPE` 不含 `UTF-8`、`TERM=linux`、Windows 上 `WT_SESSION` 与 `TERM_PROGRAM` 都为空（旧 conhost）。Windows Terminal 走 Unicode。
- `⏺`（U+23FA）在部分 emoji 字体下渲染为两格但 `codePointWidth` 判 1 格。对策：`ansi.ts` 的宽度表不改（保持 wcwidth 一致）；提供 `ui.glyphs: "unicode" | "safe" | "ascii"` 三档？——**不加**。只在文档「排错」里说明用 `AMA_ASCII=1`，并在 tui-frames 测试里锁定 `visibleWidth("⏺") === 1`。

## 3. 逐屏样稿

记号：样稿行内 `⟨accent⟩` 这类标注在实际渲染中不存在；为了保持列宽准确，着色说明统一写在每张样稿下面。所有 80 列样稿左边界是终端第 0 列。

### 3.1 启动头

`ui.quietStartup: normal`（80 列）：

```
╭──────────────────────────────────────────────────────────╮
│ ✻ ama 0.1.0                                               │
│                                                           │
│ 模型   anthropic/claude-sonnet-4-5@messages · 思考 medium  │
│ 目录   ~/Projects/armadra-agent · 已信任（trust.json）     │
│ 模式   Accept edits · 预设 default · codemode on           │
│ 已加载 CLAUDE.md, AGENTS.md · 3 Skill · 2 模板 · 4 Hook    │
│                                                           │
│ /help 命令 · Shift+Tab 切模式 · Ctrl+O 展开工具输出        │
╰──────────────────────────────────────────────────────────╯
```

- 框宽 `min(width, 60)`，不居中（左对齐，便于回滚里对齐正文）；边框 `border`；`✻ ama 0.1.0` 粗体，`✻` `accent`；键名列 `dim`，值 `text`，模型 `accent`，`已信任` `success` / `未信任` `warning`，`Bypass permissions` 时模式值 `warning`；最后一行 `dim`。
- 警告条数 `警告   2 条（ama doctor 查看）` 用 `warning`，放在「已加载」之后。
- `header` 档（profile 缺省）：一行 `✻ ama 0.1.0 · anthropic/claude-sonnet-4-5 · Accept edits · /help`，无框。`silent` 不输出。

40 列（normal 自动降为无框多行，键列省略）：

```
✻ ama 0.1.0
anthropic/claude-sonnet-4-5 · medium
~/Projects/armadra-agent · 已信任
Accept edits · default · codemode on
CLAUDE.md, AGENTS.md · 3 Skill · 4 Hook
/help · Shift+Tab 切模式
```

规则：`width < 56` 时去框去键列；路径用 `~` 缩写并从左侧截断（`…/armadra-agent`）。

### 3.2 用户消息

```
› 帮我检查差分渲染在小终端里是否正确，宽字符 😀 也要对齐，
  顺便看看 resize 之后光标位置对不对
```

- `›` `user` 粗体；文本 `text`；续行缩进 2 列对齐正文首字（当前实现顶格）。
- 运行中插话 `↳ 插话  继续：再加一个 resize 的测试`、排到之后的 `↳ 之后  …`、宿主注入 `↳ 宿主  …`：整行 `muted`，`↳` `dim`。（原 `↳ steer` / `↳ followUp` / `↳ host` 改中文标签，`origin` 字段不变。）
- 40 列同样规则，折行点由 `wrapTextWithAnsi` 决定（宽字符间可断）。

### 3.3 助手 Markdown

```
差分渲染的规则

我先看一下 src/tui/tui.ts 的 diff() 逻辑，然后只改必要的部分。
见 差分渲染说明 (docs/tui.md#差分渲染)。

1. 首帧全量输出
2. 修改 diff()：首变化行在视口之上时全量重画
   • 已滚出终端顶部的历史行留在回滚里
3. 跑测试

╭─ ts ─────────────────────────────────────────────────────────────────────────╮
│ if (first < viewportTop) fullViewport();                                     │
│ for (let i = first; i <= last; i++) out.push(moveTo(i) + clear + lines[i]); │
╰──────────────────────────────────────────────────────────────────────────────╯

▎ 注意：已滚出终端顶部的历史行不再重绘。

情况      写入
─────────────────
改一行    1 行
resize    一屏
```

- h1 / h2：`accent` 粗体；h3+：`text` 粗体。标题后不加下划线。
- 段落 `text`；行内代码 `code`（不加反引号）；粗体 / 斜体按 SGR；链接：文字 `link` + 下划线，URL 在后面以 ` (url)` `dim` 追加，文字与 URL 相同时只显示一次。
- 列表：数字 / 圆点 `muted`（原 `accent`，太跳）；嵌套圆点 `• ◦ ▪`。
- 代码块：**全宽**（不随内容收缩，避免流式时框线抖动）；边框 `border`，语言标签 `dim`；正文 `text`（原 `code` 橙色整块去掉）；`width < 8` 退化为裸文本。
- 引用：`▎`（原 `│`）`border` + 正文 `muted` 斜体。
- 表格：首行粗体，其下加一条 `─` 规则线（`border`），列间两个空格（原 `│`，去掉竖线更干净）；超宽截断。
- `ui.markdown: false` 时整段 `text`。

40 列下代码块仍全宽（内宽 36），长行按列硬断；列表缩进保持。

### 3.4 思考块

折叠（缺省 `collapsed`）、流式中、展开：

```
✻ 思考中…

✻ 思考 · 1.2k token

✻ 思考 · 1.2k token  ▾
  先确认差分逻辑在 viewportTop 之上的情形……
  然后看 resize 路径是否清掉旧行。
```

- `✻` 与文字 `dim` 斜体；流式中 `思考中…` 末尾三点由 Loader 不驱动（避免每帧重绘思考行）；完成后换成 token 数。
- Ctrl+O 现在**同时**展开思考块与工具输出（`collapsed` 模式下；`hidden` 不受影响，`full` 本来就展开）；展开时标题末尾 `▾`，正文缩进 2 列 `muted` 斜体，最多 60 行后 `… 另 N 行`。

### 3.5 工具调用

通用结构：第 0 列 `⏺`，工具名，摘要；第 2 列 `⎿` + **一行结果摘要**；第 4 列输出正文；折叠提示 `… 另 N 行（Ctrl+O 展开）`。相邻工具调用之间不空行。

**read**

```
⏺ read src/tui/tui.ts:1+120
  ⎿ 读取 120 行
       1  /**
       2   * TUI 主类（设计 §12.1、§12.2，主屏 regular 模式）。[B4]
       3   *
    … 另 117 行（Ctrl+O 展开）
```

- `⏺` 运行中 `accent`、成功 `success`、失败 `error`；工具名 `tool` 粗体；摘要 `text`；`⎿` `border`；摘要行 `muted`；行号右对齐宽 6 `dim`，正文 `text`；折叠提示 `dim`。

**edit（diff）**

```
⏺ edit src/tui/tui.ts
  ⎿ 2 处修改 · +5 −2
    @@ -212,4 +212,7 @@
    212    if (first === -1) return;
    213 -  if (first < this.viewportTop(height)) {
    213 +  if (first < this.viewportTop(height) || lines.length < prev.length) {
    214 +    // 内容变短也走全量，避免残影
    … 另 9 行（Ctrl+O 展开）
```

- `@@` `dim`；`-` 行 `error`，`+` 行 `success`，上下文 `muted`；行号列 `dim`（旧 / 新各取一个，宽 4）。折叠 12 行，展开 400 行。`+N −M` 在摘要行用对应颜色。

**bash（流式尾部 → 完成）**

```
⏺ bash pnpm vitest run src/tui
  ⎿ ⠋ 运行中 · 4s
     ✓ src/tui/ansi.test.ts (31)
     ✓ src/tui/theme.test.ts (12)
     ⠋ src/tui/tui.test.ts

⏺ bash pnpm vitest run src/tui
  ⎿ 退出 0 · 2.1s · 48 行
     Test Files  6 passed (6)
          Tests  112 passed (112)
       Duration  2.08s
    … 另 45 行（Ctrl+O 展开）

⏺ bash git push --force origin main
  ⎿ 退出 128 · 0.3s
     fatal: refusing to update checked out branch
```

- 运行中摘要行带 spinner（与底部 Loader 同帧，`accent`）；尾部 8 行 `muted`；完成后摘要 `退出 0 · 耗时 · 行数`，非零退出码 `error`，正文（stderr）`error`。工具输出先 `cleanLines()` 去 ANSI（现有）。

**grep / glob**

```
⏺ grep requestRender in src/
  ⎿ 14 处匹配 · 6 个文件
     src/tui/tui.ts:180: requestRender(immediate = false): void {
     src/tui/components/loader.ts:52: this.requestRender();
     src/tui/components/editor.ts:311: this.options.requestRender();
    … 另 11 行（Ctrl+O 展开）
```

- 文件路径部分 `text`，行号与冒号 `dim`，命中片段 `muted`（需要 grep 结果 `details.matches`；没有结构化数据时整行 `muted`）。

**codemode 与嵌套内层调用**

```
⏺ codemode const files = await tools.glob("src/**/*.ts")
  ⎿ 3 个内层调用 · 脚本输出 2 行
    ⏺ glob src/**/*.ts
      ⎿ 42 个文件
    ⏺ read src/tui/tui.ts
      ⎿ 读取 399 行
    ⏺ grep requestRender in src/
      ⎿ 14 处匹配 · 6 个文件
     42 files, 14 matches
```

- 内层调用整体右移 2 列，复用同一组件（`ToolView.render(width - 2)` 已有）；折叠时只显示最近 5 个内层标题 + 摘要行（不显示内层正文）；展开时完整。`… 前 N 个调用` `dim`。

**task 子 Agent**

```
⏺ task 检查 src/tui 的测试覆盖缺口
  ⎿ 子 Agent · 运行中 1m05s · 7 次工具调用 · ↓3.4k

⏺ task 检查 src/tui 的测试覆盖缺口
  ⎿ 完成 · 1m42s · 9 次工具调用 · ↑28k ↓4.1k
     缺口主要在 overlay.ts 的 bottom 锚点与 editor 的粘贴折叠……
    … 另 6 行（Ctrl+O 展开）
```

- 运行中摘要每秒刷新耗时（`tool_execution_update` 的 partial 带统计时解析；否则只显示 `运行中 · 耗时`）。

40 列（以 edit 为例）：

```
⏺ edit src/tui/tui.ts
  ⎿ 2 处修改 · +5 −2
    @@ -212,4 +212,7 @@
    -  if (first < this.viewportTop(hei…
    +  if (first < this.viewportTop(hei…
    … 另 10 行（Ctrl+O 展开）
```

- `width < 60` 时 diff 行不显示行号列（省 5 列）、折叠行截断加 `…`（不折行）；展开时折行。

### 3.6 提示：错误、重试、压缩、缓存

```
✗ 模型调用失败：401 invalid x-api-key（anthropic）

↻ 重试 1/3（2s 后）：429 rate_limit_error

▎ 上下文已压缩  128k → 24k token
▎ 用户要求检查差分渲染与 resize 行为；已修改 diff() 并补测试……
▎ … 另 4 行

! 缓存未命中（空闲 7 分钟后）：重计费 38.2k token（约 $0.11）
! 上下文已用 72%，约剩 9 回合（按最近 5 回合均值）
✗ 上下文已用 91%，约剩 1 回合

⛔ Hook 阻止：pre-tool-use 拒绝了 bash（禁止 force push）
已拒绝 bash
```

- `✗` + 文本 `error`；`↻` 行 `warning`；`!` 行 `warning`；≥ 90% 的 ctx 提示升为 `✗` `error`；`⛔` 行 `warning`；审批结果说明（已拒绝 / 已取消）`dim`。
- 压缩摘要卡：改为**左竖条卡片**（`▎` `border`，标题 `text` 粗体，token 变化 `muted`，摘要 `muted`），不再用全宽 Box——Box 只留给代码块、启动头、覆盖层三处。
- 助手消息收尾状态（`已中断` / `输出达到长度上限`）保持一行 `dim` / `warning`。

### 3.7 运行中 spinner

```
⠋ 思考中 · 4s · Esc 中断
⠹ 回复中 · 12s · ↓≈1.2k · Esc 中断
⠸ 运行 bash · 38s · Esc 中断
⠼ 等待确认 · 2m10s
⠴ 压缩上下文 · 6s · Esc 中断
⠦ 重试 2/3 · 2s 后
```

- spinner `accent`；动词 `text`；其余 `dim`。动词由事件推导：`message_start(assistant)` → 思考中（有 thinking 块在流）/ 回复中；`tool_execution_start` → `运行 <工具名>`（并行多个时 `运行 3 个工具`）；审批打开 → `等待确认`（无 Esc 提示，Esc 由对话框消费）；`compaction_start` → 压缩上下文；`auto_retry_start` → 重试 n/m。
- `↓≈N` 是本回合输出 token 的估算（`estimateTokens`，4 字符 ≈ 1），`message_end` 后用真实 usage 修正；没有文本时不显示。
- 帧率：80 ms（12.5 fps）；耗时只在整秒变化；ASCII 模式 4 帧 250 ms；`ui.animation: false`（或检测到 `AMA_ASCII`）时 spinner 固定为 `·`，整行每秒只因耗时变一次。
- 位置不变：排队消息之下、输入框之上。

### 3.8 排队消息

```
  ↳ 插话  继续：再加一个 resize 的测试
  ↳ 之后  顺便更新 docs/tui.md
    Alt+↑ 取回 · Esc 回填并中断
⠋ 运行 bash · 38s · Esc 中断
```

- 整体 `muted`，标签 `dim`，缩进 2 列（与 `⎿` 对齐，表示「挂在当前回合下」）；超过 3 条时首行 `… 另 N 条`。

### 3.9 输入框

空闲、占位（80 列）：

```
────────────────────────────────────────────────────────────────────────────────
› 输入消息，/ 命令，@ 文件，Shift+Enter 换行
────────────────────────────────────────────────────────────────────────────────
```

多行、粘贴折叠、超出可视行：

```
─── ↑ 2 ────────────────────────────────────────────────────────────────────────
  把这段日志贴给你看：
  [粘贴 #1 · 142 行]
  第三行是我自己打的，请对比 ▌
─── ↓ 1 ────────────────────────────────────────────────────────────────────────
```

补全弹层（`/` 命令）：

```
────────────────────────────────────────────────────────────────────────────────
› /mo▌
────────────────────────────────────────────────────────────────────────────────
  › /model      [provider/model]  切换模型
    /mode                         切换权限模式
  (1/2) Tab 接受 · Esc 关闭
```

- 上下规则线 `border`；提示符 `›` `user` 粗体，`disableSubmit`（审批中）时 `dim`；占位 `dim`，获焦时也显示直到有输入（原实现只在失焦时显示——交互模式里编辑器永远获焦，所以占位从未出现过）。续行缩进 2 列对齐。
- 光标：反显一格（现有）；硬件光标仍摆到该处供输入法。
- 粘贴折叠标记 `[粘贴 #1 · 142 行]`：`accent` 不下划线；提交展开（现有）。
- 规则线上的 `↑ 2` / `↓ 1` `dim`（现有，颜色改 dim）。
- 补全：最多 8 行；选中行 `selection` bg（≥ 256 色）否则 `accent` 粗体 + `›`；label 列对齐，参数提示 `dim`，描述 `muted`；尾行 `(1/2) Tab 接受 · Esc 关闭` `dim`。`@` 文件补全同样，目录以 `/` 结尾。
- 规则：输入框与状态栏之间**不再有第三条线**——状态栏自己没有上边线，靠输入框的下边线分隔；提示行（`HintLine`）在两者之间，空时 0 行。

40 列：

```
────────────────────────────────────────
› 读一下 README，说说是什么▌
────────────────────────────────────────
```

### 3.10 底部状态栏

> 第五波 W5-A（wave5-plan §1）起分两种布局：`ui.statusLine: "full"`（独立终端缺省，两行）与 `"compact"`（有 profile 的嵌入宿主缺省，一行）；`Ctrl+G`（`app.statusLine.toggle`）或 `/statusline [full|compact]` 切换，只影响本会话。实现：`status-line.ts`（速率行）、`status-bar.ts`（状态栏）、`status-area.ts`（装配）。

`full`，宽屏（按用户样例：速率行 `•` 与括号，状态栏 `|` 分隔）：

```
tps: 100 tok/s • 546 tok / 5.5s (avg 100 · ttft 1.4s)                 ↑12k ↓1.2k · cache 83% ♨ · [-]
Manual | shift+tab 切换        claude-opus-5-5 medium | Ctx 3.0% | vitaweave ⎇ main 5ae9e54 (+12,-3) | $0.26 | 2h24m
```

`compact`，80 列（原单行状态栏 + git 与时长）：

```
Manual        claude-opus-5-5 · ctx 3% · vitaweave ⎇ main 5ae9e54 +12 −3 · 2h24m
```

`compact` 超宽（≥ 110 列）时 ctx 换成小表：`ctx ▮▮▮▯▯▯▯▯▯▯ 34%`；`full` 总是 `Ctx 3.0%`。

- 两区：左区「模式 + 切换提示」，右区信息，中间用空格撑开；装不下时退回单区。分隔符：`compact` 固定 `·`；`full` 状态栏 `|`、速率行 `tps: … • … (avg · ttft)` 加右区 `·`。同组项以空格相连：`full` 下行的「模型 思考级别」，以及「目录 ⎇ 分支 短提交 +a −b / (+a,-d)」。
- **速率行**（只在 `full`）：`tps:` 流式中取最近 2 s 窗口的瞬时值、前缀 `accent`，结束后是该请求的平均值（生成不足 0.25 s 的整块回复记 `—`）；`N tok / T`（从首 token 起）；`avg` 会话均速；`ttft` 首 token 延迟。右区是从状态栏迁来的用量类项，行尾 `[-]`。流式中由 `telemetry_tick`（≤ 2 Hz）刷新，只有这一行随流变化；状态栏仍只在事件时刷新。
- 整行基色 `dim`；模式名 `text`（Bypass permissions → `warning`，Plan → `accent`）；模型 `accent`；`think` 级别只显示值；`ctx` 按阈值 `success`/`warning`/`error`（`full` 保留一位小数）；`rebill $x` `warning`；`queue 1` `warning`；codemode 后的 `net!` `error`（Node 权限模型与 OS 沙箱都不隔离网络时）；宿主状态 `[…]` `dim`。
- 模型名缩写：`width < 100` 去掉供应商前缀；`< 60` 再去掉 `@渠道`；`< 48` 去掉 `-4-5` 之类版本后缀（按 `-\d` 截）。
- ASCII（字形表）：`⎇` → `git`（`branch`）、`•` → `*`（`dot`）、`−` → `-`、`♨` → `~`；无色时信息不丢。
- 会变的数字（tps、输出量 / 耗时、avg、ttft、`full` 的 ctx、时长）在判断放不放得下时按最宽形状占位，数值变化不会让某项时有时无（40 列不抖动）。

丢弃顺序（宽度不够时先丢优先级数字大的）：

| 速率行（`full`） | 优先级 | `full` 下行      | 优先级 | `compact`                     | 优先级 |
| ---------------- | ------ | ---------------- | ------ | ----------------------------- | ------ |
| `tps`、`[-]`     | 永不丢 | 模式             | 永不丢 | 模式                          | 永不丢 |
| `ttft`           | 1      | 模型             | 0      | 模型                          | 0      |
| `avg`            | 2      | `ctx`            | 1      | `ctx`                         | 1      |
| 宿主状态         | 3      | `$` 费用         | 2      | 会话时长                      | 3      |
| `preset`         | 4      | 会话时长         | 3      | git 分支与提交                | 4      |
| `rebill`         | 5      | git 分支与提交   | 4      | 目录名                        | 5      |
| `cache`          | 6      | 目录名           | 5      | git `+a −b`                   | 6      |
| `↑ ↓` token      | 7      | git `+a −b`      | 6      | `codemode`                    | 7      |
| `queue`          | 8      | 思考级别         | 7      | `queue`                       | 8      |
| `codemode`       | 9      | `shift+tab 切换` | 12     | 思考级别                      | 9      |
| `N tok / T`      | 10     |                  |        | `↑ ↓` token / cache / `$`     | 10–12  |
|                  |        |                  |        | rebill / preset / 宿主 / 提示 | 13–16  |

`< 40` 列时不显示 `shift+tab 切换`。

40 列（`full`）：

```
tps: 99 tok/s (ttft 1.4s)            [-]
Manual            claude-opus | Ctx 3.0%
```

tmux 节点里宿主要解析最后一行：嵌入缺省 `compact`，字段顺序固定、分隔符固定为 `·`，模式永远在最左，布局与第五波之前相同（输入框在倒数第 3 行）；`full` 时输入框在倒数第 4 行。

### 3.11 审批对话框

```
╭─ 需要确认 ───────────────────────────────────────────────────────────────────╮
│ bash  危险命令                                                               │
│ $ rm -rf build dist/*.map > out.log                                          │
│                                                                              │
│ 删除 build/：目录，132 个文件，1.2 MB                                        │
│ 删除 dist/*.map：含通配符或变量，未展开，实际范围可能更大                    │
│ 覆盖写入 out.log：文件，4.0 KB                                               │
│ 这条命令可能有破坏性，请确认                                                 │
│                                                                              │
│   1. 允许                                                              y     │
│   2. 本会话允许同类                                                    a     │
│ › 3. 拒绝                                                              n Esc │
│                                                                              │
│ ↑↓ 选择 · Enter 确认 · v 完整输入                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
```

- 标题由原因决定：`需要确认`（mode）/ `危险命令`（dangerous）/ `Hook 要求确认`；子 Agent 发起前缀 `[task] `。边框颜色随预览严重度：danger `error`、warn `warning`、其余 `border`。
- 工具名 `tool` 粗体，原因标签 `error` / `warning` / `dim`；命令 `code`；预览行按严重度着色（现有）；Auto 判定行 `warning`。
- 选项编号列表（Claude Code 风格）：选中行 `›` + `selection` bg；右侧按键提示 `dim`。缺省选中：dangerous → 拒绝；其余 → 允许。按键 `y / a / n / Esc / 1 2 3 / ↑↓ Enter / v` 全部有效（旧按键不废）。edit / write 的输入摘要（`−/+` 摘要、`写入 N 行`、本会话未读过标黄）保留。
- 覆盖层仍为 `bottom` 锚定全宽；对话框打开时输入框提示符变 `dim`，Loader 动词 `等待确认`。

40 列：

```
╭─ 危险命令 ───────────────────────────╮
│ bash                                 │
│ $ rm -rf build dist/*.map > out.log  │
│ 删除 build/：目录，132 个文件，1.2   │
│ MB                                   │
│ 删除 dist/*.map：含通配符，范围可能  │
│ 更大                                 │
│   1. 允许                        y   │
│   2. 本会话允许同类              a   │
│ › 3. 拒绝                        n   │
│ ↑↓ Enter · v 完整输入                │
╰──────────────────────────────────────╯
```

`width < 56`：标题行只放原因、工具名另起一行；预览行折行；去掉空行；按键提示缩短。

### 3.12 模式选择器（已实现，微调）

```
╭─ 权限模式 ───────────────────────────────────────────────────────╮
│                                                                  │
│    Manual                                            Default  1  │
│     写文件、执行命令前询问                                       │
│  › ✓ Accept edits                                             2  │
│     自动接受文件编辑，执行命令仍询问                             │
│    Plan                                                       3  │
│     只读调研，只跑只读命令，出计划后审批执行                     │
│    Auto                                          Recommended  4  │
│     由 ama 判断每一步：安全的自动放行，有风险的才问              │
│    Bypass permissions                                         5  │
│     全部放行（危险命令仍询问）                                   │
│    Allowlist only                                             6  │
│     只放行 allow 规则命中的，其余拒绝，从不询问                  │
│                                                                  │
│  ↑↓ 选择 · 1-6 直接选 · Enter 确认 · Esc 取消                    │
╰──────────────────────────────────────────────────────────────────╯
```

- 标题 `Mode` → `权限模式`（与 /help 一致）；`✔` → `✓`（glyph 表）；选中行 label + 描述两行都上 `selection` bg；徽标 `Default` `dim`、`Recommended` `accent`；底部加按键提示行 `dim`；上下各留一空行（`paddingY: 1`）。
- 40 列：Box 宽 `width - 2`，描述截断（现有）。

### 3.13 面板：/model、/session、/cache、/permissions

**/model**（居中覆盖层，可过滤）

```
╭─ 选择模型 ───────────────────────────────────────────────────────╮
│ › claude▌                                                        │
│                                                                  │
│  anthropic · messages · key ✓                                    │
│  › ✓ claude-sonnet-4-5          200k · img                       │
│      claude-opus-4-1            200k · img                       │
│  packy · messages · key ✓                                        │
│      kimi-k2.5@messages         256k                             │
│  openai · 无 key                                                 │
│      gpt-5                      400k · img                       │
│  (1/4) ↑↓ 选择 · Enter 确认 · Esc 取消                           │
╰──────────────────────────────────────────────────────────────────╯
```

- 过滤框第一行，`›` `accent`；分组标题 `dim`（`无 key` 的组 `dim` 且项 `dim`）；当前模型 `✓`；说明列 `muted`。

**/session、/cache**（消息区，左竖条卡片 + KeyValue + Meter）

```
▎ 会话 3f2a9c1e · ~/.local/share/ama/sessions/…/3f2a9c1e.jsonl
▎ 模型      anthropic/claude-sonnet-4-5 · 思考 medium · 权限 Accept edits
▎ 消息      用户 7 · 助手 9 · 工具调用 23
▎ 用量      输入 3.4k · 输出 9.4k · 缓存读 118k · 缓存写 6.2k · $0.42
▎ 上下文    ▮▮▮▯▯▯▯▯▯▯ 34% · 68k / 200k
▎
▎ 缓存
▎   输入      3.4k = 缓存读 2.2k（65%）+ 未缓存 1.2k
▎   报告状态  reported
▎   命中率    最近 84% · 会话 65%
▎   未命中    1 次，重计费 38.2k token ≈ $0.11（空闲超时 1）
▎   保温      streaming · 下次 2m10s · 期望节省 $0.18 ≥ $0.05
```

- `▎` `border`；键列 `dim`（KeyValue 现有）；值 `text`；上下文行用 `Meter`（阈值着色）。`/cache` 只输出「缓存」段。`describeSession()` 继续产出 KeyValueRow，交互模式用 `Card(KeyValue)` 渲染而不是把文本拍进 `addNotice`。

**/permissions**

```
▎ 权限模式  Accept edits（auto-edit）
▎ 判定顺序  deny 规则 → Hook deny → 危险命令确认 → 权限模式 → allow 规则 /
▎           Hook allow / 本会话记忆 → 询问
▎ 规则（3）
▎   allow  bash(git *)                [project]
▎   allow  read(**)                   [user]
▎   deny   bash(rm -rf *)             [builtin]
▎ 最近的 auto 判定（2）
▎   规则层    allow  bash git status — 只读命令
▎   分类器    ask    edit src/… — 修改受保护路径（缓存）
```

- `allow` `success`、`deny` `error`、`ask` `warning`；来源 `[…]` `dim`。判定顺序长行折行对齐值列（KeyValue 现在不折行；加 `wrap: true` 选项）。

### 3.14 退出摘要

退出前追加到消息区（留在回滚里），然后 `tui.stop()`：

```
─ 会话 3f2a9c1e · 12 分钟 · 7 回合 · ↑128k ↓9.4k · cache 81% · $0.42（重计费 $0.03）
  恢复：ama --resume 3f2a9c1e
```

- 整体 `dim`，会话 id 与 `ama --resume …` `text`；没有用量（0 回合）时只输出第一行到 `回合`；SIGTERM 路径也走这里（`exit()` 里 `view.add` 后 `tui.stop()`，不等异步）。

## 4. 交互细节

- **动画**：Loader 80 ms；bash 运行中摘要行的 spinner 与 Loader 共用 `frame`（Loader 暴露 `frame` 或 ToolTracker 订阅 Loader tick），保证一帧只多改一行；`ui.animation: false` / ASCII → 静态 `·`，耗时每秒更新。
- **Ctrl+O**：全局切换（现有），范围扩大到思考块（§3.4）；提示行 `工具输出：展开`。
- **流式防闪烁**：Markdown 按块缓存只重渲末块（现有）；代码块固定全宽；工具调用标题行在运行中不变（spinner 不放标题，放 `⎿` 摘要行）；状态栏只在事件时 `refresh()`；状态栏右区 token 数在流式期间不更新（`message_end` 才更新），避免每 chunk 改最后一行。
- **行数只增不减**：运行中 → 完成的替换保持 ≥ 原行数（bash 尾部 8 行 → 完成后 3 行 + 折叠提示会变短；允许，但差分会清多出的行——这是现有 `diff()` 覆盖的路径）。
- **宽度变化**：全量重画最后一屏（现有）；Markdown / ToolView / KeyValue 缓存都带 width 键；启动头 Box 按新宽重算是否去框。
- **覆盖层**：审批 bottom 全宽；选择器 center 宽 `min(width - 2, 72)`；覆盖层打开时编辑器提示符变 dim、Loader 动词 `等待确认`。
- **tmux**：所有新字形都是 1 列；`▎`（U+258E）、`⎿`、`⏺` 在 Windows Terminal + Cascadia / 等宽回退字体下测过宽度为 1；检测失败的用户用 `AMA_ASCII=1`。

## 5. 实施清单

### 5.1 配置项（只加必要的）

| 键             | 类型                          | 缺省     | 说明                   |
| -------------- | ----------------------------- | -------- | ---------------------- |
| `ui.theme`     | `"dark" \| "light" \| "auto"` | `dark`   | 新增 `auto`（§2.1）    |
| `ui.ascii`     | boolean                       | 自动检测 | `AMA_ASCII=1` 等价     |
| `ui.compact`   | boolean                       | `false`  | 块间不空行、启动头无框 |
| `ui.animation` | boolean                       | `true`   | false → spinner 静态   |

改 `src/config/types.ts`（`UiConfig`）、`src/config/schema.ts`（`checkSection("ui", …)` 加键）、`src/config/json-schema.ts`、`docs/design.md §10.2`。`AMA_ASCII` 加进 `src/config/paths.ts` 旁的环境变量表（有文档的话）。

### 5.2 按文件改动

**组件库 `src/tui/`**

- `component.ts`：`SemanticColor` 加 `muted` `link` `selection`；`Theme` 加 `readonly glyphs: Glyphs`。
- `glyphs.ts`（新）：§2.2 的表、`detectAscii(env)`。
- `theme.ts`：新色板；`createTheme(name | "auto", { caps, ascii })`；`PlainTheme` 也带 glyphs；`levelColor()` 导出；`bg("selection")` 在 < 256 色时退化。
- `components/box.ts`：`borderColor?: SemanticColor`（审批严重度）；`paddingY` 已有。新增 `components/card.ts`：左竖条卡片（`▎` 前缀 + 可选标题行），不加边框，用于压缩摘要与面板。
- `components/loader.ts`：帧表来自 `theme.glyphs.spinner`；`setMessage` 改成 `setVerb(verb, extras[])`；暴露 `frame`；`animation: false` 支持；耗时整秒才触发渲染。
- `components/markdown.ts`：颜色调整（标题 / 列表 / 代码块正文 / 链接 / 引用 / 表格规则线）；`renderInline` 链接输出 `link` + ` (url)`。
- `components/editor.ts`：首行 `› ` 提示符、续行缩进 2、占位在获焦时也显示、`promptColor` 随 `disableSubmit` 变 dim、粘贴标记文案 `[粘贴 #N · M 行]`、规则线标签 dim；补全列表尾行提示。
- `components/select-list.ts`：选中行 `selection` bg（stacked 时两行）、`footer?: string`、`currentValue?: string` 画 `✓`；过滤框 `› `。
- `components/key-value.ts`：`wrap?: boolean`（值折行对齐）。
- `components/meter.ts`：字形取 glyphs。
- `components/text.ts` / `container.ts` / `spacer.ts` / `overlay.ts`：不改。
- `tui.ts` / `ansi.ts` / `terminal.ts`：不改（新增一条测试锁定新字形宽度为 1）。

**交互模式 `src/modes/interactive/`**

- `startup-header.ts`（新）：由 `StartupInfo` 结构体画 §3.1 的框 / 无框两态；`cli/startup-screen.ts` 新增 `startupInfo(runtime): StartupInfo`（结构化字段），`buildStartupScreen` 保留给 line 模式。
- `message-view.ts`：`addUser` 续行缩进与中文标签；思考块 `✻` + 展开态（`setThinkingExpanded`）；`addNotice` 字形走 glyphs，`info` 级不加前缀；`addSummaryCard` 改 Card；回合分组（相邻 `ToolView` 之间不加 Spacer；`compact` 全部不加）；新增 `addExitSummary(stats)`、`addPanel(title, rows)`。
- `tool-view.ts`：标题 `⏺ name summary`；新增 `summaryLine()`（按工具：read 行数、edit `N 处修改 · +a −b`、bash `退出 c · 耗时 · 行数`、grep `N 处匹配 · M 个文件`、codemode `N 个内层调用`、task 状态）；结果正文缩进 4；diff 行号列（`width ≥ 60`）；运行中 `⎿ ⠋ 运行中 · Ns` 使用共享 spinner frame；需要在 `finish()` 记录耗时（`start` 时记 `now()`，options 加 `now`）。
- `status-bar.ts`：两区布局、模型名缩写、`shift+tab 切换` 提示（优先级 12）、`preset` 仅非 default、ctx Meter（≥ 110 列）。
- `approval-dialog.ts`：编号选项 + 方向键 / 数字 / 旧按键；缺省选中按原因；标题按原因；`Box` 边框色按严重度；`< 56` 列紧凑态。
- `pickers.ts`：`title: "权限模式"`、`footer`、`currentValue`；模型选择器 `currentValue` 画 `✓`。
- `commands.ts`：`/session` `/cache` `/permissions` 走 `ui.panel(title, rows)`（CommandUi 新增），不再拍成文本 notice；`/help` 文案同步新按键。
- `key-dispatch.ts`：Ctrl+O 同时切思考块；审批打开时不拦 ↑↓ / 数字（`inactive()` 已覆盖）。
- `interactive-mode.ts`：Loader 动词状态机（§3.7）；编辑器 `placeholder`；`exit()` 前 `view.addExitSummary`；主题 `auto` / ascii / compact / animation 接线；去掉 `tui.addChild(new Spacer())`（消息区与排队消息之间的空行改由排队组件自带）。
- `startup-ui.ts`：迷你 TUI 的问句 `? ` 改 `› `？——**不改**，保持启动期问答与正文区分。

**文档与示例**

- `docs/tui.md`：布局图、按键表、配置项、ASCII 模式与排错；`docs/design.md §12.5–§12.7` 同步（语义色 14 个、glyphs）。
- `examples/tui-demo.ts`：加 Card、新 Loader API、审批编号选项演示。

### 5.3 新增 / 更新的帧黄金

`test/fixtures/tui/`（80x24 与 40x24 各一份，除注明）：

| 文件                                 | 场景                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `run-*.txt`（更新）                  | 启动头 normal、输入、工具运行中、完成、Ctrl+O、退出摘要                  |
| `header-quiet-80x24.txt`（新）       | `quietStartup: header` 一行头                                            |
| `markdown-*.txt`（新，tui-frames）   | 标题 / 列表 / 代码块 / 链接 / 引用 / 表格                                |
| `thinking-expanded-*.txt`（新）      | Ctrl+O 展开思考块                                                        |
| `tools-*.txt`（新）                  | read / edit diff / bash 运行中与完成 / grep / codemode 嵌套 / task，一屏 |
| `notices-80x24.txt`（新）            | 错误 / 重试 / 压缩卡 / 缓存未命中 / Hook 阻止                            |
| `loader-verbs-80x24.txt`（新，多帧） | 思考中 → 回复中 → 运行 bash → 等待确认                                   |
| `editor-*.txt`（新）                 | 占位 / 多行溢出 / 粘贴折叠 / 补全弹层                                    |
| `status-widths.txt`（新）            | 40 / 60 / 80 / 110 列状态栏各一行                                        |
| `approval-*.txt`（更新）             | 编号选项、danger 红框、`< 56` 紧凑态                                     |
| `mode-picker-*.txt`（更新）          | 新标题、底部提示、选中 bg（MemoryTerminal 无色，只验布局）               |
| `panel-session-80x24.txt`（新）      | /session 卡片                                                            |
| `ascii-run-80x24.txt`（新）          | `AMA_ASCII=1` 整条 run 序列                                              |
| `theme-16color.test.ts`（新单测）    | 14 色 → 16 色索引表锁定；新字形宽度为 1                                  |

更新命令不变：`AMA_UPDATE_GOLDEN=1 pnpm vitest run src/modes/interactive src/tui`。

### 5.4 提交顺序（细粒度，每步可独立合并、测试绿）

1. `tui: 新增 glyphs.ts 与 Theme.glyphs；ASCII 检测`（纯增量，PlainTheme 带 glyphs；无视觉变化）
2. `tui: 语义色加 muted/link/selection，新色板，16 色表测试，levelColor`
3. `config: ui.theme auto / ui.ascii / ui.compact / ui.animation`（schema + types + json-schema + 文档）
4. `tui: Loader 动词 API、共享 frame、animation 关闭`
5. `tui: Card 组件；Box.borderColor；KeyValue.wrap；Meter 字形`
6. `tui: Markdown 配色与链接 / 表格 / 引用样式`（更新 markdown 单测与新 markdown 帧黄金）
7. `tui: Editor 提示符、续行缩进、占位、粘贴标记、补全尾行`（editor 单测 + editor 帧黄金）
8. `tui: SelectList 选中底色、footer、currentValue`
9. `interactive: 启动头组件 + startupInfo`（run 黄金更新 1/4）
10. `interactive: message-view 用户续行 / 思考块 / 提示字形 / 压缩卡 / 回合分组`
11. `interactive: tool-view ⏺/⎿ 布局、摘要行、diff 行号、耗时`（tools 黄金）
12. `interactive: 状态栏两区与缩写`（status-widths 黄金）
13. `interactive: Loader 动词状态机接线`（loader-verbs 黄金）
14. `interactive: 审批对话框编号选项与严重度边框`（approval 黄金）
15. `interactive: 选择器标题 / footer / ✓；/session /cache /permissions 面板`（mode-picker、panel 黄金）
16. `interactive: 退出摘要；Ctrl+O 含思考块`（run 黄金收尾）
17. `docs/examples: tui.md、design.md §12、tui-demo`
18. `test: ascii-run 黄金 + 全量黄金审阅`

### 5.5 风险

| 风险                                                                         | 影响                                                                        | 对策                                                                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 多行组件高度在差分下变化（bash 尾部 8 行 → 完成 4 行；思考展开；审批紧凑态） | 下方所有行位移，`diff()` 重写从首变化行到底；在 24 行终端里几乎等于整屏重写 | 可接受（现有行为）；保证一帧内只发生一次高度变化：`finish()` 与 `update()` 不在同一 tick 触发两次渲染（`requestRender` 已合并到 nextTick） |
| 首变化行滚出视口触发 `fullViewport`                                          | 工具调用很长时每次追加都全视口重画                                          | 结果正文折叠上限不变（3 / 8 / 12 行），折叠态高度有界                                                                                      |
| `selection` bg 在 tmux 老版本 / 16 色下残留                                  | 选中行尾出现色块                                                            | 只在 ≥ 256 色启用；每行末尾 `\x1b[0m`（`compose()` 已保证）；`spliceLine` 中段后已有 reset                                                 |
| `⏺` `⎿` `▎` 在个别字体下宽度不一致                                           | 列错位、差分误判                                                            | 宽度表以 wcwidth 为准，不随字体改；文档给 `AMA_ASCII=1`；黄金用 MemoryTerminal 不受字体影响                                                |
| 状态栏两区用空格撑开                                                         | 窄屏频繁回退单区，文本抖动                                                  | 两区切换阈值取整 10 列（hysteresis 无需，resize 本来全量重画）                                                                             |
| Loader 动词状态机与事件乱序（tool_end 先于 message_update）                  | 动词闪回                                                                    | 动词按「当前最深状态」取：有运行中工具 → 运行 X；否则有流式助手消息 → 思考 / 回复；否则压缩 / 重试                                         |
| `auto` 主题猜错                                                              | 浅色终端下 dark 色板对比度差                                                | 文档明说；`/theme` 不做，改配置即可                                                                                                        |
| 黄金文件数翻倍                                                               | 审阅成本                                                                    | 每个新黄金只覆盖一屏；`AMA_UPDATE_GOLDEN` 后用 `git diff --stat` 审                                                                        |
| `SemanticColor` 契约变更                                                     | 外部用 `@armadra/agent/tui` 的宿主自定义 Theme 编译失败                     | 新字段都是必填——改为 Theme 实现里由 `createTheme` 填充，宿主若自实现 Theme 需补 3 个颜色与 `glyphs`；在 CHANGELOG 标 breaking              |
