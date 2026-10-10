# 本地扩展（设计草案）

> 状态：**设计草案，尚未实现**。本文描述的目录、配置键、HostApi 新面与 `ama doctor` 输出目前都不存在；实现前以本文为讨论基础，实现时以代码为准并改写本文。现行可用的扩展点是命令式 Hook（[hooks.md](../guides/hooks.md)）与单个宿主适配器（[host-api.md](../reference/host-api.md)）。

## 动机

命令式 Hook 适合「在某个时机跑一条命令」，宿主适配器适合「把 ama 接进一个外部系统」（如 Armadra 画布），但同一时刻只能有一个适配器，而且它由宿主（profile / `--host`）指定。用户常见的小需求——运行结束后给出下一步建议、桌面通知、每回合自动打 git 检查点、自定义斜杠命令——需要进程内的事件与少量 UI 能力，又不该占用宿主的位置。本地扩展就是**用户自己装的、可以有多个的宿主适配器**。

## 位置与加载

- 用户级目录：`~/.config/ama/extensions/*.{mjs,cjs}`（`AMA_CONFIG_DIR` 下的 `extensions/`），按文件名排序加载。
- profile：`extensions: ["/abs/a.mjs", …]`（绝对路径），排在用户级目录之后。
- **不支持项目级**（仓库里的 `.ama/extensions/` 不加载）：扩展以进程权限运行、能注册工具，等同于执行任意代码，不随仓库分发。
- 宿主适配器（`--host` / profile `host`）仍然最先加载；扩展在它之后、组装会话之前，与适配器处于启动序列的同一步（[design.md](design.md) §11.1 第 13 步）。

## 契约

扩展复用宿主适配器的模块形状 `HostModule`（`hostApi` + `create(api)`），拿到的是同一个 `HostApi`。差别只在多个共存时的规则：

| 面                           | 多个扩展 / 适配器共存时                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `tools.register`             | 按加载顺序先到先得；同名冲突时后来者的注册失败（抛 `tool_exists`），记 warning，扩展其余部分照常 |
| `tools.disable`              | 累加                                                                                             |
| `instructions.add`           | 按加载顺序追加到 `host` 节                                                                       |
| `events.on`                  | 都收到                                                                                           |
| `approvals.setBroker`        | **只允许第一个设置者**（通常是宿主适配器）；其余调用忽略并 warning                               |
| `ui.notify` / `ui.setStatus` | 都可用；状态栏按键名区分                                                                         |
| `cache.onWarmingDecision`    | 现有规则：最后注册且未注销的处理器生效                                                           |
| `create()` 失败 / 超时       | 宿主适配器失败仍是退出码 6；**扩展失败只记 warning 并跳过**，不阻止启动                          |
| 版本不等                     | 宿主适配器仍是退出码 78；扩展跳过并 warning                                                      |

实现上把 `activateHost` 推广为列表：第一个是宿主适配器（若有），其后是扩展；每个模块拿一个独立的 `HostApiBinding`（各自的工具清单与状态键），共享同一个工具注册表、事件总线与 broker 槽。

## 新增 HostApi 面

只有一项是新的，另两项沿用：

- `api.commands.register({ name, description, run(args, ctx) })`（新）：注册斜杠命令。`commands-core` 查内置命令表之后、提示模板之前查这张表，命中则调用 `run`，返回现有的 `CommandResult`（`{ kind: "handled", message? }` / `{ kind: "prompt", text }`）；`ctx` 提供当前会话。与内置命令同名时注册失败。RPC `get_commands` 以 `source: "extension"` 列出。
- `api.cache.onWarmingDecision(handler)`（已有）：返回 `"warm" | "stop"`，最后一个处理器胜出。
- `api.ui.setStatus(key, text?)`（已有）。

**不开放渲染层**：扩展不能替换或插入界面组件、不能接管按键（不做 UI mod）。界面上的表达只有消息区通知、状态栏键值与斜杠命令的输出文本。

## 信任

- 首次发现扩展目录非空（或 profile 的 `extensions` 有新条目）时：交互模式列出每个文件的路径与 sha256，询问是否启用；非交互模式拒绝加载并 warning。
- 决定写进 `trust.json` 的新段 `extensions`，按**文件哈希**记录：`{ "path": "/abs/x.mjs", "sha256": "…", "trusted": true, "at": "ISO" }`。文件内容改变后哈希不符，重新询问。
- `--no-trust` 同时禁用全部扩展；profile 的 `trustProject` 不影响扩展。
- `ama doctor` 列出已启用与被跳过的扩展、哈希与跳过原因。

## 典型用例

| 用例       | 做法                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| 下一步建议 | `events.on("agent_settled")` 后根据最后的回复给出 2–3 条建议，`ui.notify` 显示                        |
| 桌面通知   | `agent_settled` 与 `tool_approval_requested` 时向终端写 OSC 777 通知序列                              |
| git 检查点 | `turn_start` 时 `git stash create` 记录一个不改工作区的检查点，配合 `commands.register("/undo")` 回滚 |
| 自定义命令 | `commands.register({ name: "standup", run })` 汇总今天的会话                                          |
| 保温策略   | `cache.onWarmingDecision` 按时段或预算否决空闲保温                                                    |

## 未决

- 扩展是否需要声明能力（只读事件 / 注册工具 / 注册命令），信任对话框按能力展示。
- `commands.register` 的命令能否接参数补全。
- 扩展之间是否需要依赖顺序（目前只有文件名排序）。
