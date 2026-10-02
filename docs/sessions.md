# 会话统计、检索、复用、导出与检查点

这几条命令都只读会话目录（`<数据目录>/sessions`，`--session-dir` 可改；文件格式见 [session-format.md](session-format.md)）：不加锁、不修复半行、不改文件，正在运行的会话也能读。范围缺省是**当前目录**的会话，`--all` 看全部。

## 统计：`ama stats`

```
ama stats [--since 7d|30d|today|YYYY-MM-DD] [--until …]
          [--by day|week|month|provider|channel|model|project]
          [--project <目录> | --all] [--top N] [--json] [--no-cache]
```

```
$ ama stats --by model
全部时间 · 项目 /home/me/proj · 2 个会话
请求         9（对话 7 · permission_classify 1 · cache_warm 1）
回合         3 · 平均耗时 23.3s
Token        输入 8.7k · 输出 1.7k · 缓存读 74.3k · 缓存写 0
缓存命中率   89.5%（报告缓存的端点 2/2，其余不进分母）
费用         $0.0398（另有 3 次请求无价，未计入）
错误 / 重试  0 / 0

                             会话  请求  回合  输入  输出  缓存读  缓存写  命中率     费用
anthropic/claude-sonnet-4-5     1     6     2  4.1k   731   72.3k       0   94.6%  $0.0398
packy/deepseek-v4-flash         1     3     1  4.6k   980      2k       0   30.8%        —

工具调用 Top 5
  read  3
  edit  2
  …
```

- `--since` / `--until`：`7d` 是含今天的最近 7 天，`today` 是今天，日期是本地日期；两端都含。
- `--by project` 没给 `--project` 时看全部项目。`--json` 输出同样的数据（另带 `files`：扫描 / 命中缓存 / 无效的文件数）。

### 口径

| 项          | 怎么算                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 请求        | 每次模型请求一次：回合里的 assistant 消息记「对话」；`usage` 条目按 `kind` 分开（`cache_warm` 保温、`permission_classify` auto 分类…）；`compaction` / `branch_summary` 带的用量记同名 kind。失败后重试的那次也算请求 |
| 回合        | 一条非 `steer` 的用户消息开始一个回合，到下一条为止；至少有一条 assistant 才计。耗时 = 最后一条 assistant 的落盘时间 − 用户消息的落盘时间                                                                             |
| token       | `input` 不含缓存部分（同会话层）；缓存读 / 写分开列                                                                                                                                                                   |
| 缓存命中率  | cacheRead /（input + cacheRead + cacheWrite），只算**报告缓存**的端点：同一 `provider/model@channel` 在扫描范围内出现过任何非零缓存读写才算；其余端点不进分母（与会话层三态一致，不报缓存的中转不会把命中率拉成 0）   |
| 费用        | 只加带 `usage.cost` 的请求（模型有价格）；无价请求数单独报，全部无价时只给 token；订阅计费（ChatGPT 登录，`usage.billing: "subscription"`）的请求另起「订阅」一行计数，不进费用、不算无价                             |
| 工具调用    | assistant 里的工具调用块按名字计；codemode 脚本内的调用不展开                                                                                                                                                         |
| 错误 / 重试 | `stopReason: "error"` 的 assistant；`context_edit{reason:"retry"}`（自动重试剔除的失败尝试）                                                                                                                          |
| 渠道        | 最近一条 `model_change` 与请求同 provider / model 时取它的 `channel`                                                                                                                                                  |

`task` 子会话是独立文件，按它自己的 cwd 计入。

### 性能与索引

- 扫描按行进行；`toolResult`、`custom`、`label` 等与统计无关的行按行首的 `{"type":…,"message":{"role":…` 直接跳过、不解析（ama 写的行 type 总是第一个键；别的程序写的行退回完整解析）。
- 每个文件的摘要缓存在 `<数据目录>/stats-index.json`，按文件 mtime 与大小失效；时区变化整份作废；扫描全部时顺带删掉已不存在的文件。`--no-cache` 不读也不写。
- 实测（本机，`src/session/stats-perf.test.ts`）：1000 个会话、67 MB（每个 12 回合、24 次工具调用、2 KB 工具结果），冷扫描约 160 ms，命中索引约 15 ms。

## 检索：`ama sessions search`

```
ama sessions search <关键词|/正则/标志> [--all] [--role user|assistant|tool] [--since 7d] [--limit N] [--json]
```

```
$ ama sessions search parser
3f9a1c2e#1    2026-09-29 01:00  /home/me/proj  user       修复 parser 在空输入时崩溃的 bug
3f9a1c2e@4    2026-09-29 01:00  /home/me/proj  tool       src/parser.ts:42: if (input.length === 0)
```

- 关键词不区分大小写；`/…/` 是 JavaScript 正则（标志照写，如 `/todo|fixme/i`）。
- 检索用户文本、助手文本与工具调用（`名字 参数 JSON`）、工具结果；不检索思考、system 与 custom。`--role` 可逗号分隔多个。
- 每行：会话 id 前 8 位 + 编号（user 是 `#n`，可直接给 `--from`；其它是条目序号 `@k`，即文件里第 k 条条目）、时间、项目、角色、片段。stdout 是终端且没设 `NO_COLOR` 时命中处高亮，否则纯文本。`--json` 每条命中一行。
- 最新的会话在前；`--limit` 缺省 20。关键词不含引号与反斜杠时先在原始行上预筛，不命中的行不解析。

## 复用：`sessions show` 编号与 `--from`

`ama sessions show <id>` 在末尾列出用户消息，按文件顺序编号（含插话 `steer`、排队 `followUp` 与宿主注入，标出 origin 与图片数）：

```
用户消息（ama --from 3f9a1c2e#<编号> 复用）：
  #1   2026-09-29 01:00:06  修复 parser 在空输入时崩溃的 bug
  #2   2026-09-29 01:00:44  顺便把错误信息改成中文
```

`--from <id>[#编号]` 用那条消息作新提示（不写编号取最后一条），开的是新会话，可以换模型：

```sh
ama -p --from 3f9a1c2e#1 --model packy/deepseek-v4-flash      # 同一个问题换个模型问
ama -p --from 3f9a1c2e "只改测试，不动实现"                   # 位置参数接在原文后面（空一行）
ama --from 3f9a1c2e#2                                          # 交互界面：作为初始提示直接发送
```

- `-p` 时原消息里的图片一并发送（写进临时目录、走 `--image` 的校验，模型不收图片时退出 2；运行后删除）。交互 / 行式界面只带文本，有图片时在 stderr 提示一行。
- 编号越界、格式不对 → 退出 2；会话不存在 → 退出 5。`--mode rpc` 不支持。

## 导出：`ama sessions export`

```
ama sessions export <id> [--format md|json|jsonl] [--output <文件>] [--branch leaf|all]
```

| 格式         | 内容                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `md`（缺省） | 给人读：用户消息（带编号）、助手文本、工具调用（参数 JSON 截到 500 字符）与结果（截到 2000 字符）、压缩 / 分支摘要、切换模型、末尾用量表；思考与 system 不写，图片写占位 |
| `json`       | `{ format: "ama.session-export", version: 1, session, branch, leafId, userMessages, usage, entries }`，`entries` 是原条目                                                |
| `jsonl`      | 头 + 所选条目，与会话文件同形状，可以再被 ama 读回（不带 `leaf` 行）                                                                                                     |

- `--branch leaf`（缺省）是根到当前叶子的分支（与 `/tree` 当前位置一致）；`all` 是文件里全部条目。
- `--output` 写文件（权限 0600），否则写 stdout。
- **脱敏**：导出前把 key / token 形态的字符串换成 `[REDACTED]`——`sk-…`、`sk-ant-…`、`ghp_…`、`github_pat_…`、`xox?-…`、`AIza…`、`AKIA…`、`npm_…`、JWT、`Bearer` / `Basic` 凭据、PEM 私钥块，以及 `apiKey` / `secret` / `token` / `password` / `authorization` 之后紧跟 `:` 或 `=` 的值；json / jsonl 里键名像机密的字符串值整段遮掉。图片的 base64 保留。只认形态，不保证遮全，分享前仍请自己看一遍。

## 轨迹：`ama sessions trace`

```
ama sessions trace <id|文件> [--html [文件]] [--json] [--output <文件>] [--open]
                   [--branch leaf|all] [--no-content] [--children] [--now <毫秒>]
```

把会话的轨迹（与 `/trace` 同一棵树，见 [tui.md](tui.md)「轨迹」）导出成**单个 HTML 文件**，用来分享或排查「这次回答慢在哪里」。
`<id>` 可以是 id 前缀，也可以直接给会话文件路径；只读，不加锁，正在运行的会话也能导。

- **HTML**（缺省，`--html` / `--format html`）：顶部是汇总（回合、请求、工具次数、总耗时、token、缓存命中、ttft p50 / p90、平均吞吐、费用）；
  中间左侧是树（回合 → 请求 → 工具 → 子调用 / 子 Agent / 外部 Agent 回合），右侧是瀑布图——横轴是会话时间，首 token 等待、解码、
  工具、子 Agent、重试等待、压缩 / 辅助请求分色，进行中的节点只画起点；回合之间超过 2 秒的空闲压成 2 秒（刻度仍标原始时间）。
  下方是详情（与 `/trace` 的详情卡片相同，含提示、回复、参数与结果预览）。可以搜索（`/`，Enter / Shift+Enter 在匹配间跳）、按回合跳转、
  缩放（按钮或 Ctrl + 滚轮）、全部展开 / 折叠，`↑↓` 选择、`←→` 折叠 / 展开。深浅色跟随系统。行数再多也只建可见的一屏 DOM（虚拟列表）。
- **自包含**：样式与脚本内联，没有任何外部资源，页面带 CSP（`default-src 'none'`），离线打开即可；页脚写 ama 版本与生成时间。
- **脱敏**：整棵数据与正文都按 `sessions export` 的规则先脱敏，正文预览再脱敏一次；数据块里 `<`、`>`、`&` 一律转义，
  提示或工具输出里的 `</script>`、HTML 标签只会原样显示成文字。只认形态，分享前仍请自己看一遍。
- `--no-content`：只留结构、时间与数字（没有提示、参数、结果，也没有错误原文），适合只想分享性能问题时。
- `--children`：内嵌 ama 子 Agent 子会话里节点的预览；缺省只嵌它们的结构与数字。外部 Agent 本来就只有骨架。
- 预览按条截断（参数 500、其余 2000 字符），整份预览上限 4 MB 字符，超出后更早的预览置空并在详情里注明。
- `--json`（或 `--format json`）：与 RPC `get_trace` 同形的 JSON（[rpc.md](rpc.md)「轨迹」），包含全部回合、已加载的子会话轨迹与本会话节点的 `previews`
  （`--no-content` 时没有）。
- 输出：`--html <文件>`（文件名以 `.html` / `.htm` 结尾时才当作值，否则用 `--output`）或 `--output <文件>` 写文件（0600），否则写 stdout。
  `--open` 写好后用系统浏览器打开（没给文件时写到临时目录）。
- `--now <毫秒>` 固定页脚的生成时间：同一会话、同样的参数，输出逐字节相同。
- 0.6 之前的会话没有计时记录，时间按条目时间推算（详情里注明「推算」），不改会话文件。

## 检查点与文件备份

回滚代码（`/rewind`，设计见 [rewind-plan.md](rewind-plan.md)）依赖检查点：每个新回合开始时，ama 记下 edit / write 改过的文件当时的内容。

- **存储位置**：备份按内容 sha256 存在 `<数据目录>/file-history/blobs/<前 2 位>/<sha256>`，原字节、不压缩；多个会话、多个检查点共用，同内容只存一份。会话文件里只有 `ama.checkpoint` / `ama.checkpoint-track` 两类 `custom` 条目（记哈希，不进上下文）。会话目录不在缺省位置时（`--session-dir`、宿主 profile 的 `sessionDir`），目录登记在 `file-history/roots.json`，清理时一并扫描。
- **跟踪范围**：edit / write（含 codemode 内层调用与 task 子会话）第一次写某文件之前备份它；之后每个新回合按当前磁盘内容重拍已跟踪的文件，所以 bash 或手动对这些文件的改动也会进下一个检查点。bash 新建或改动的其它文件不跟踪。
- **清理**：`ama sessions prune` 结束后扫描全部会话文件（含 `.trash/` 里还能找回的）里的检查点引用，删除未被引用且超过 1 天的备份；`--dry-run` 只报告。`ama doctor` 的「目录」一节显示备份数与占用。
- **配置**：`checkpoints.mode`（`tools` 缺省 / `shadow-git` / `off`，环境变量 `AMA_CHECKPOINTS` 覆盖；`shadow-git` 见下）、`checkpoints.maxFileBytes`（缺省 5 MiB）、`checkpoints.keep`（缺省 100，更早的检查点不再列为回滚点）。项目级 `.ama/config.json` 只能把 `mode` 设为 `off`、把 `maxFileBytes` 调小。
- **限制**：
  - 超过 `maxFileBytes` 的文件、符号链接与非普通文件不备份，回滚时报告无法恢复。
  - 恢复时目标是符号链接、硬链接（链接数 > 1）、非普通文件，或父目录已被移动 / 换成链接，都跳过并列出原因；备份已被清理时报告 `backup_missing`。
  - 冲突检测：文件当前内容既不是 ama 最后写入的、也不是最近检查点记录的，视为回合外的手动修改，缺省跳过。「ama 最后写入」只在进程内存里；恢复会话后以最近检查点为准，上一回合 ama 写过、之后未再建检查点的文件会被当作冲突（可选择覆盖）。
  - git 状态不动：只记 HEAD，回滚时 HEAD 变了给出提示。
  - 内存会话（不落盘）没有检查点。

### 影子 git 模式（`checkpoints.mode: "shadow-git"`）

`tools` 模式只看 edit / write 碰过的文件；影子 git 在此之外，每个新回合把整个工作目录快照进一个独立的 git 仓库，bash 或手动的新增、修改、删除、重命名也能回滚。

- **仓库**：`<数据目录>/file-history/shadow/<sha256(工作目录) 前 16 位>/`，以 `--git-dir` / `--work-tree` 指向工作目录，不碰你自己仓库的对象、索引、引用与 HEAD。同一工作目录的会话共用一个影子仓库（每个进程用自己的索引文件）；`ama sessions prune` 不清理影子仓库，不再需要时可整个删掉对应目录（删掉后这些检查点按 `tools` 记录恢复）。`ama doctor` 在 file-history 一行里显示影子仓库个数与占用。
- **快照**：新回合开始时 `git add -A` + `write-tree` + `commit-tree`（父为上一个影子提交），提交 id 记进检查点的 `shadowCommit`。影子仓库用固定身份、空的全局 / 系统配置（不读你的签名、钩子、过滤器与模板），`core.autocrlf=false` 且关掉换行转换，存的是磁盘原字节；`gc.auto=0`。
- **忽略**：工作目录里的 `.gitignore` 生效；工作目录在 git 仓库里时，你的仓库判定为忽略的路径（上级目录的 `.gitignore`、`info/exclude`、全局忽略文件）同样不进影子仓库；`.git` 一律排除。
- **恢复**：把当前工作目录写成树，与目标提交比较，只处理有差异的文件；冲突与安全检查与 `tools` 相同（符号链接、硬链接、非普通文件、路径上的目录被换成链接都跳过）。「已知」的当前内容 = 最近一个影子快照里的、ama 最后写入的或最近检查点记录的，其余视为回合外的改动，缺省跳过。被忽略的文件不碰；edit / write 改过、但不在影子仓库里的文件（工作目录外、被忽略）按 `tools` 记录恢复。目标检查点没有影子提交（降级之后、或影子仓库已删）时整次按 `tools` 恢复。
- **护栏**：以下情况本会话降级为 `tools` 并提示一次——PATH 里找不到 `git`；工作目录（不含忽略的）超过 20 000 个文件（第一次快照前检查）；单次快照超过 3 秒（这次的提交保留）。工作目录是家目录或文件系统根目录时不启用。
- **限制**：
  - 最近一个回合里 bash 的改动要到下一个回合开始才进快照；在那之前回滚，这些改动与手动修改分不开，算冲突（可选择覆盖）。
  - git 只记可执行位：恢复时只调整可执行位，其它权限位保留；符号链接与子模块不恢复。
  - 影子仓库收录全部未忽略的文件，大文件也会存进去（不受 `maxFileBytes` 限制，恢复时超过它的报告无法恢复）；没有 `.gitignore` 的大目录建议用 `tools`。

## 回滚（会话内）

`/rewind`、RPC `rewind`、SDK `session.rewind()` 回到某条用户消息之前（设计见 [rewind-plan.md](rewind-plan.md)）：

- 回滚点是活动路径上开启新回合的用户消息，从旧到新；运行中插话、排队消息与 Stop Hook 续跑的消息并入当前回合，不单列。运行中回滚报 `busy`。
- 对话回滚复用 `/tree` 换叶子：离开的分支留在文件里，可以再从 `/tree` 回去；模型、思考级别与权限模式保持当前，不随回滚改变。之后第一次请求的 system、工具表与落点之前的消息和回滚前逐字节相同，提示缓存照常命中。
- 「已读」集合按新路径上成功的 read / write 调用重算，再去掉被恢复、删除或与目标检查点不一致的文件——模型要改这些文件得先重新 read。
- 仅对话或仅代码时，下一次提示前在末尾追加一条 `ama.rewind-note` 告诉模型哪些文件与对话不一致；对话 + 代码不追加。
- 内存会话与 `checkpoints.mode: "off"` 不建检查点，只能仅对话。
- 运行中 Esc 中断、本回合还没有任何回复或工具调用时，撤回该回合并回填原消息（`ui.restoreOnCancel`，缺省 true）。

## 请求明细（设计，未实现）

计划在会话里追加 `custom{customType:"ama.request"}`（不进上下文），每次模型请求一条：

```json
{
  "type": "custom",
  "customType": "ama.request",
  "data": {
    "purpose": "turn",
    "provider": "packy",
    "model": "kimi-k2.5",
    "channel": "messages",
    "startedAt": "…",
    "firstByteMs": 820,
    "durationMs": 6400,
    "httpStatus": 200,
    "attempt": 1,
    "stopReason": "toolUse"
  }
}
```

暂不实现的原因：HTTP 状态与首字节时间只在协议层（`src/ai/http.ts`、各 `apis/*`）可见，重试在 `agent/session-run.ts`，记录点要同时碰这几处，正与超时 / 重试反馈的改动重叠。现阶段 `ama stats` 用已有数据近似：回合耗时取落盘时间差，重试取 `context_edit{reason:"retry"}`，失败取 `stopReason: "error"`。实现时在 `StreamOptions.onResponse` 旁加一个请求结束回调，由会话层把上面的字段写成 `custom` 条目；`ama stats` 读到后按请求给出耗时分布与 HTTP 状态计数。
