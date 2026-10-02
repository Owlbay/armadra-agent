/**
 * `ama --help` 的文本（从 args.ts 搬出，args.ts 再导出）。[W5-C0]
 */

export const HELP_TEXT = `用法：ama [选项] [提示]
      ama <子命令> …

模式
  （缺省）                     终端界面；stdin / stdout 非 TTY 或 TERM=dumb 时自动降级为行式
  --no-tui                     行式界面（readline + 括号粘贴）
  -p, --print                  非交互：执行提示后退出。提示 = 参数 + stdin 管道内容；有提示参数时
                               只等管道首字节 2 s（AMA_STDIN_WAIT_MS），没收到就忽略并提示；
                               末尾加 - 则一直等到 EOF（如 npm test | ama -p 找原因 -）
  --no-stdin                   -p 不读 stdin（父进程留着管道、又不想等 2 s 时）
  --output-format <格式>       -p 的输出：text（缺省）| json | stream-json
  --max-turns <N>              -p 最多跑 N 轮（一次模型请求加其工具执行算一轮）；到达上限仍有
                               未完成的工具调用时提前结束，退出码 1
  --image <文件>               -p 随提示发送图片（可重复；png / jpg / gif / webp，单张 ≤ 5 MB）；
                               交互界面里写 @图片路径 或粘贴图片路径
  --mode rpc                   stdio JSONL 协议（供嵌入）
  --mode acp                   ACP 服务端（供 Zed / JetBrains / Armadra 驱动；尚未实现）
  --max-cost <USD>             一次运行的美元上限（尚未生效）
  --tui-mode <模式>            显示模式，第一期只有 regular（主屏）
  --quiet-startup <档>         启动画面：normal | header | silent

模型
  --model <provider/id>        模型（可配合 --provider 只写 id；@渠道 指定渠道，如 packy/kimi-k2.5@messages）
  --provider <id>              供应商（必须同时给 --model）
  --api-key <key>              只用于本次启动的 key（需要 --model；优先用 ama auth set）
  --thinking <级别>            off | minimal | low | medium | high | xhigh

会话
  -c, --continue               继续本目录最近的会话
  -r, --resume [id]            恢复会话（交互模式无 id 时弹选择器）
  --session-id <id>            使用指定 id 的会话（不存在则新建）
  --fork <id>                  从指定会话分叉出新会话
  --session-dir <目录>         会话目录（缺省 ~/.local/share/ama/sessions）
  --no-session                 会话只在内存里，不写会话文件（之后无法 --resume）
  --from <id>[#编号]           用旧会话的一条用户消息作提示（缺省最后一条；-p 时连图片一起；
                               编号见 ama sessions show）

权限与信任
  --permission-mode <模式>     default | auto-edit | plan | auto | full-auto | allowlist
                               （auto 由 ama 判断每一步；allowlist 只放行 allow 规则命中的，适合 CI）
  --allow <规则>               追加允许规则，可重复（如 "bash(git status*)"）
  --deny <规则>                追加拒绝规则，可重复（如 "write(**/.env*)"）
  --trust / --no-trust         信任 / 不信任当前项目（项目级 Hook、Skill、提示模板）

资源
  --system-prompt <文本|@文件> 追加系统提示：缺省作为最后一条规则追加（工具表等前缀不变，利于缓存）
  --system-prompt-mode <方式>  append（缺省）| replace（替换开头的角色说明，工具与项目上下文保留）
  --profile <文件>             宿主 profile.json（字段等价于对应参数，命令行优先）
  --host <模块>                宿主适配器模块（CJS / ESM）
  --instructions <文件>        追加指令文件，可重复
  --skill-dir <目录>           追加 Skill 目录，可重复
  --agent-dir <目录>           追加子 Agent 定义目录，可重复（尚未生效）
  --auth-file <文件>           auth.json 位置（缺省 ~/.config/ama/auth.json）
  --tools <a,b,…>              只启用这些工具
  --exclude-tools <a,b,…>      禁用这些工具
  --tools-preset <名>          工具预设：default（缺省）| minimal | codemode-only | coordinator
                               （codemode 是 codemode-only 的旧名，仍可用）
  --codemode <模式>            codemode 调用方式：off | on | only（缺省随预设）

子命令
  ama auth set <provider>      从 stdin 读取 key 写入 auth.json（0600）
  ama auth list                列出已保存 key 的供应商（不显示 key）
  ama auth remove <provider>   删除已保存的 key
  ama sessions list|show|prune 会话管理
  ama sessions search <关键词|/正则/> [--all] [--role user|assistant|tool] [--since 7d] [--limit N]
                               跨会话全文检索
  ama sessions export <id> [--format md|json|jsonl] [--output <文件>] [--branch leaf|all]
                               导出会话（已脱敏）
  ama models list [--provider <id>]  列出模型（含来源与 key 状态）
  ama models check <provider/id>     发一次最小请求检查可用性
  ama models discover <provider> [--probe] [--write] [--limit N]
                               从中转 /v1/models 列出模型，探测协议并写入配置
  ama models refresh [--provider <id>]  联网刷新 models.dev 元数据到数据目录（启动不联网；
                               旧名 refresh-catalog）
  ama providers add <id> --base-url <url> [--key-env VAR] [--probe] [--channel n=api@url] [--yes]
                               一键接入：列模型、补 models.dev 元数据、探测渠道、写入配置
  ama providers list|channels <id>|remove <id>|refresh <id>
                               供应商 → 渠道 → 模型；删除；重拉模型列表
  ama models cache-probe <provider/id> [--tokens N] [--gap-ms MS] [--yes] [--json]
                               判断端点是否报告缓存命中
  ama doctor                   配置层级、信任、key 来源、Hook、终端能力
  ama config show [--json]     生效配置与每项来源、将使用的模型
  ama config path              配置目录、数据目录与各文件路径
  ama config edit              用 $VISUAL / $EDITOR 打开 config.json
  ama init [--force]           建配置目录（0700）与 config.json、config.schema.json；已有的不覆盖
  ama stats [--since 7d] [--by day|week|month|provider|channel|model|project] [--all] [--json]
                               跨会话统计：请求、token、缓存命中率、费用、工具调用

其它
  -h, --help                   输出本帮助
  -v, --version                输出版本

退出码：0 正常 · 1 运行期错误 · 2 用法错误 · 3 配置错误 · 4 无可用模型或 key ·
        5 会话错误 · 6 宿主 / Hook 启动失败 · 7 -p 有工具调用被拒（无人审批；用
        --permission-mode auto-edit|auto 或 --allow 放行）· 8 -p 到达预算上限 ·
        78 宿主 API 版本不匹配 ·
        130 SIGINT · 143 SIGTERM
`;
