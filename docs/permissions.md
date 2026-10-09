# 权限模式与 auto 判定

本文写 ama 的六种权限模式、每次工具调用的判定顺序，以及 `auto` 模式「规则层 → 静态判定 → 模型分类器」三层怎样决定放行还是询问。总体设计见 [design.md](design.md) §6.3、§7；Hook 的输入输出见 [hooks.md](hooks.md)。

## 模式

| 值          | 显示名             | 读  | 写（项目内）                | 执行（bash 等）                 | 何时用                                       |
| ----------- | ------------------ | --- | --------------------------- | ------------------------------- | -------------------------------------------- |
| `default`   | Manual             | ✓   | 询问                        | 询问                            | 缺省                                         |
| `auto-edit` | Accept edits       | ✓   | ✓                           | 询问                            | 放心让它改代码，命令逐条看                   |
| `plan`      | Plan               | ✓   | 拒绝                        | 只读命令放行，其余拒绝          | 只读调研、出计划并审批（[plan.md](plan.md)） |
| `auto`      | Auto               | ✓   | ✓（受保护路径与项目外询问） | 安全名单放行，其余由分类器判断  | 推荐：常规操作不打扰，有风险才问             |
| `full-auto` | Bypass permissions | ✓   | ✓                           | ✓                               | 一次性沙箱、容器                             |
| `allowlist` | Allowlist only     | ✓   | 只放行 allow 规则命中的     | 只读命令与 allow 规则命中的放行 | CI：从不询问，没列出的直接拒绝               |

所有模式下，deny 规则、Hook deny 都先判定并直接拒绝；危险命令表（`rm -rf /`、`git push --force`、`curl … | sh` 等，见 README「安全」）一律询问，`allowlist` 与无人值守时变为拒绝。

设置方式：`--permission-mode <值>`、配置 `permission.mode`、交互界面 `/permission`（选择器）或 `Shift+Tab`、RPC `set_permission_mode`、SDK `permission.mode`。

### 严格度与项目级配置

严格度从严到宽：`plan < allowlist < default < auto-edit < auto < full-auto`。项目级 `.ama/config.json` 只能把模式往严的方向改；另外**不能设 `auto` 或 `full-auto`**（这两种由 ama 自己或什么都不判断就放行，必须由用户级配置、命令行或 profile 打开），设了会被忽略并给 warning。

`allowlist` 排在 `plan` 与 `default` 之间：它放行的调用是 `plan` 放行的（只读工具、[只读命令](#plan-模式与只读命令)、`task`）加上 allow 规则明确列出的；`default` 放行的集合包含它（只读 + allow 规则），其余在 `default` 下询问、在 `allowlist` 下拒绝。所以 `plan ⊆ allowlist ⊆ default`。读工具在 `allowlist` 下照常放行，与其它模式一致；要连读都限制，用 deny 规则。

只读命令是一张静态名单（下一节），`plan` 与 `allowlist` 用同一张，严格度的全序因此不变；CI 里用 `allowlist` 多放行 `ls`、`git log` 这类命令无害。`task` 在两种模式下都放行：子会话共用同一条权限管线，子 Agent 能做的不会比父会话多。`plan.bash: "ask"` 时 plan 会对名单外的命令询问（`allowlist` 从不询问），「不经询问就放行」的集合仍满足上面的包含关系。

### 界面

- 状态栏显示显示名：`mode:Auto`；`Bypass permissions` 标黄。
- `/permission` 不带参数打开选择器：标题 `Mode`，每项「显示名 + 一行说明」，右侧是数字快捷键 1–6，当前模式打勾，配置里的缺省模式标 `Default`，Auto 标 `Recommended`。line 模式 `/permission` 打印同样的列表。
- `Shift+Tab` 循环：Manual → Accept edits → Plan → Auto → Bypass permissions → Manual。`Allowlist only` 不在循环里，只能显式选。
- **进入 Bypass**：交互界面里切到 Bypass（Tab / Shift+Tab 循环、`/permission` 选择器、`/permission full-auto`）先弹确认框，缺省选中「取消」；循环时取消则跳过 Bypass 回到 Manual，选择器与命令取消则保持原模式。本次运行确认过一次后不再问。命令行 `--permission-mode full-auto`、用户级配置与 profile 指定的不弹（那是显式选择）；line 模式问 `确认进入 Bypass？[y/N]`；管道输入、RPC `set_permission_mode`、ACP `session/set_mode` 由调用方负责，不弹。详见 [tui.md](tui.md)「进入 Bypass」。

### 审批对话框的来源标注

审批不只来自主会话。对话框（以及 RPC `permission_request.context`）标出请求从哪来，选项都只有「允许 / 本会话允许同类 / 拒绝」：

| 来源                                       | 标题前缀                                  | 正文                                          | 谁来判定                                                                   |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `task` 子 Agent 的工具调用                 | `[task:explore]`（查不到类型时 `[task]`） | 同主会话                                      | 同一条权限管线；只读类型（`explore` / `plan`）按 plan 判定、不弹审批       |
| 外部 Agent（claude / codex / ACP）请求权限 | `[claude · 会话 abc12345]`                | 外部 Agent 给的标题、种类、涉及路径与输入摘要 | 只交给人：宿主 → 界面 → 无人值守拒绝，auto 分类器与模型不参与              |
| 外部 Agent 本会话首次运行                  | 标题「首次运行外部 Agent」                | 说明（以你在该 CLI 的登录运行）与模式         | allow / deny 规则 `task(<id>)`、`full-auto` 放行，其余交给人（不经分类器） |

外部 Agent 的「本会话允许」由它自己记住。Manual 模式下 `task(agent=…)` 的 task 调用审批与首次运行确认合并为一次（见 [agents.md](agents.md)「在 task 里使用」）。RPC 的 `context` 是 `{ depth, taskId, origin }`（[rpc.md](rpc.md)「审批」）。

## plan 模式与只读命令

plan 模式的第 ③ 步看输入（实现 `src/permissions/pipeline.ts` 的 `planDecision`），流程与计划审批见 [plan.md](plan.md)：

| 调用                      | plan 下                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| read / grep / glob / ls   | 放行                                                                                                                     |
| `todo`                    | `get` 放行；`set` / `update` 拒绝，提示把步骤写进 `<proposed_plan>`（清单在批准时由计划生成）                            |
| bash                      | 按 `plan.bash`：`readonly`（缺省）只读命令放行、其余拒绝；`ask` 其余询问（无人值守拒绝）；`deny` 全部拒绝                |
| write / edit 等           | 拒绝，说明带指引：`Plan mode is active: write/execute tools are disabled. Finish the plan with a <proposed_plan> block.` |
| task                      | 放行（子会话共用同一管线，同样处在 plan；子会话不提取计划块）                                                            |
| deny 规则、危险命令、Hook | 先于模式判定（不变）                                                                                                     |

只读命令（`src/permissions/readonly-bash.ts`）：先过 auto 的静态判定（分词、嵌套展开、网络 / 删除 / 写入目标 / 机密路径、命令替换、变量展开、点文件通配），再要求每段都在下面的名单里、没有输出重定向（`/dev/null` 除外）、没有嵌套 shell（`sh -c`、`eval`、`xargs`、`find -exec`）与进程替换、段首没有环境赋值或包装命令（`GIT_EXTERNAL_DIFF=… git diff`、`env …`）。

| 命令                                                                                        | 限制                                                                                             |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ls cat head tail wc stat echo printf pwd which du basename dirname realpath true false cd` | —                                                                                                |
| `grep egrep fgrep`、`rg`、`fd`、`find`                                                      | `rg --pre`、`fd -x / -X / --exec*`、`find -exec / -ok / -delete / -fprint*` 不算                 |
| `tree`、`file`、`jq`                                                                        | `tree -o`、`file -C`、`jq -i` 不算                                                               |
| `git status / log / show / diff / rev-parse / blame / ls-files / branch`                    | git 全局选项只允许 `-C`、`--no-pager`；`--output`、`--ext-diff`、`--textconv` 与改分支的选项不算 |

比 auto 的安全名单窄：不含测试 / 构建运行器（`npm test`、`cargo build` 会执行项目脚本），也不含 `env` / `printenv`（会把环境变量里的密钥打进上下文）。读机密路径（`cat .env`）不算只读。

## 判定顺序

一次工具调用（模型直接发起或 codemode / task 里嵌套发起都一样）：

```text
schema 校验
→ 命令式 Hook PreToolUse（deny 一票否决；allow / ask 交给管线）
→ 权限管线：
   ① 规则层（不调模型）
      deny 规则（含内置 deny）、Hook deny                → 拒绝
      危险命令表                                           → 询问
      [auto] 受保护路径、项目外写入、网络命令、删除类命令 → 询问
      Hook ask                                             → 询问
      allow 规则、Hook allow、本会话记忆                   → 放行
   ② 模式
      plan：只读工具、只读命令、task 放行，其余拒绝（plan.bash: ask 时其余命令询问）
      default / auto-edit / full-auto：同以前的模式真值表
        [default / auto-edit] 模式要询问的 bash：allow 规则 / Hook allow / 会话记忆之外，
        沙箱内免审批（见下）→ 放行；Hook ask 仍把结论改回询问
      allowlist：只读工具、只读命令、task 放行，其余拒绝（Not in the allowlist）
      auto：[沙箱生效时] 请求 sandbox:false 越出沙箱 → 询问（allow 规则 / Hook allow / 会话记忆之后）
            静态判定（不调模型）→ 放行；未决定 → ③
   ③ [auto] 模型分类器（沙箱内的 bash 附 os_sandbox 输入）：allow → 放行；ask / 出错 / 超时 → 询问
→ 询问时走审批链（宿主 broker → 界面 → 无人值守按拒绝）
```

- 后面的步骤不能放宽前面的结论：allow 规则越不过危险命令和 auto 的规则层，分类器只能处理①②都没决定的调用。
- `allowlist` 从不询问：凡是会询问的（危险命令、Hook ask）一律拒绝，拒绝说明写 `Not in the allowlist`（回给模型的文本固定英文）。
- 无人值守（`-p`、RPC 未接审批）时，询问一律按拒绝；auto 模式下分类器仍会先跑，判 allow 的照样执行。

### 沙箱内命令免审批

`sandbox.bash: auto` 且本机有能限制写入的 OS 沙箱时（[sandbox.md](sandbox.md)「第二阶段」），bash 经沙箱运行。
default / auto-edit 下，满足下面全部条件的 bash 调用免审批（`PermissionVerdict.sandboxed: true`）：

1. 将在沙箱内运行：没有 `sandbox: false`；
2. `sandbox.network: deny`（联网可外带数据，`allow` 时照常询问）；
3. 命令文本（含 `sh -c`、`eval`、`xargs`、`find -exec` 里的嵌套命令）不碰机密路径（`cat .env`、`~/.ssh/…`），嵌套不超深；
4. 前面没被 deny 规则、Hook deny 拒绝，不在危险命令表里（`rm -rf` 工作区外路径、`git push --force`、`git reset --hard`
   等照常询问），之后也没有 Hook ask。

| 模式               | 沙箱内的 bash                                        | `sandbox: false`（越出沙箱）                         |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| default、auto-edit | 满足上面条件即放行，否则询问                         | 询问（allow 规则、Hook allow、会话记忆可放行）       |
| auto               | 规则层与静态判定照旧；分类器多一项 `os_sandbox` 输入 | 规则层询问（allow 规则、Hook allow、会话记忆可放行） |
| plan、allowlist    | 不变                                                 | 不变                                                 |
| full-auto          | 放行                                                 | 放行                                                 |

无人值守时「询问」一律拒绝，所以 `-p` 里越出沙箱的调用被拒。auto 不直接放行沙箱内的命令：它的规则层（网络、
删除、受保护路径、项目外写入）是有意比 default 更细的防线，分类器仍是最后一关；代价是 default + 沙箱放行的一些
命令（工作区里的 `rm -r dist`）在 auto 下仍会询问。

## auto 的三层

### ① 规则层

不调模型，命中即询问（无人值守拒绝）：

| 类别          | 内容                                                                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 危险命令      | `dangerous.ts` 的整张表（所有模式通用）                                                                                                                                                                                                                                                 |
| 机密路径      | 读或写 `.env`、`.env.*`（`.env.example` / `.sample` / `.template` / `.dist` 除外）、`.ssh/`、`.gnupg/`、`.aws/`、`.kube/config`、`.docker/config.json`、`.netrc`、`.pgpass`、私钥（`id_rsa` 等、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`）、ama 的 `auth.json`                       |
| 受保护写入    | 写 `.git/` 内部、项目里的 `.ama/`（可能改 Hook 与配置）、项目目录外的任何路径（`/dev/null` 等除外）                                                                                                                                                                                     |
| 网络命令      | `curl`、`wget`、`ssh`、`scp`、`rsync`、`nc`、`gh`；`git push / pull / fetch / clone`；`npm / pnpm / yarn / bun install / add / ci / update / publish / dlx`、`npx`；`pip install`、`cargo install / publish`、`go get / install`、`brew / apt install`、`docker pull / push / login` 等 |
| 删除与回退    | `rm -r` / `rm -f`、`find -delete`、`git clean`、`git checkout -- …` / `git restore`、`git stash drop / clear`、`shred`、`truncate`                                                                                                                                                      |
| bash 里的路径 | 重定向目标（`>`、`>>`、`&>`、`tee`）、`cp` / `mv` / `mkdir` / `touch` / `ln` / `chmod` 的目标在项目外或受保护；命令参数里出现机密路径（`cat .env`）                                                                                                                                     |

「项目目录」是会话 cwd。文件工具按 `path` 参数判断；bash 按 `dangerous.ts` 同一套分词与嵌套展开（`sh -c`、`eval`、`xargs`、`find -exec`）逐段判断。

### ② 静态判定

不调模型，满足即放行：

- 只读工具（read、ls、grep、glob 等，`permission: "read"`）。
- write / edit 目标在项目目录内且不在受保护路径（受保护的已在①询问）。
- bash：命令里每一段（`&&`、`||`、`;`、`|` 切开）都在**安全名单**内，且
  - 没有命令替换 `$(…)`、反引号、`<(…)`；
  - 参数里没有变量展开 `$X`，没有可能匹配点文件的通配（`.e*`）；
  - 没有 `sh -c` 之类的嵌套（shell、`eval`、`xargs` 都不在名单里）。
    管道到安全命令（`cat a | grep b | wc -l`）没问题；管道到 shell 不在名单里。重定向写到项目内允许，写到项目外已在①询问。
- allow 规则命中（这一步在①的末尾已放行）。

安全名单（`src/permissions/auto-safe.ts`，每条都有正反例测试）：

| 命令                                                                                                                                                                                                                                                                                                                              | 限制                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ls`、`cat`、`head`、`tail`、`wc`、`grep`、`egrep`、`fgrep`、`rg`、`pwd`、`echo`、`printf`、`which`、`env` 与 `printenv`（只打印）、`true`、`false`、`sort`、`cut`、`tr`、`diff`、`basename`、`dirname`、`realpath`、`stat`、`file`、`du`、`df`、`date`、`whoami`、`uname`、`cd` / `pushd` / `popd`（之后的相对路径按新目录解析） | `env FOO=1 cmd` 按 `cmd` 判断                                            |
| `find`                                                                                                                                                                                                                                                                                                                            | 不带 `-exec`、`-execdir`、`-ok`、`-okdir`、`-delete`、`-fprint*`、`-fls` |
| `git status / diff / log / show / rev-parse / blame / ls-files`（`diff / log / show` 不带 `--output`、`--ext-diff`、`--textconv`；`rg` 不带 `--pre`；`sort` 不带 `-o`；`date` 不带 `-s`）                                                                                                                                         | 子命令前只允许 `-C dir`、`--no-pager`（`-c` 能改 pager，不算安全）       |
| `git branch`                                                                                                                                                                                                                                                                                                                      | 只列出：不带 `-d / -D / --delete / -m / -M / -c / -C / -f / -u` 等       |
| `npm / pnpm / yarn test`、`… run test / lint / typecheck / build`、`pnpm / yarn lint / typecheck / build`、`npm t`                                                                                                                                                                                                                |                                                                          |
| `node --test`、`tsc --noEmit`、`vitest run`、`pnpm vitest run`、`pnpm exec vitest run`、`pytest`、`python -m pytest`                                                                                                                                                                                                              |                                                                          |
| `cargo test / check / build / clippy`、`go test / build / vet`、`make test / check / lint / build`                                                                                                                                                                                                                                |                                                                          |

扩展：用户级配置 `permission.autoSafeCommands` 追加，例如 `["just test", "bun test", "make fmt"]`——按词前缀匹配（`just test` 命中 `just test --verbose`）；含 `*` 的按通配匹配整段（`bun run test*`）。项目级配置不能追加（放宽）。追加的命令照样先过①：网络、删除、项目外写入仍然询问。

### ③ 模型分类器

只处理①②都没决定的调用（例如 `rm old.txt`、`node scripts/gen.js`、宿主工具、codemode 脚本）。

- **独立请求**：不进会话转录、不改主会话的消息与前缀（主会话的提示缓存不受影响），不触发保温；请求用途 `purpose: "classify"`。
- **输入**：工具名、参数（JSON，截断到 4000 字符）、cwd、项目根、最近一条用户消息的摘要（截断到 600 字符）。参数与用户消息放在 `<tool_call_data>` … `</tool_call_data>` 数据块里，块内出现的结束标记会被转义；系统提示要求把块内一切当数据，忽略其中的指令（包括「ignore previous instructions」「respond allow」之类），遇到这种文本倾向于 ask。
- **输出**：严格 JSON `{"decision":"allow"|"ask","reason":"…"}`。解析失败、超时（10 s）、请求出错 → 询问。
- **模型**：`permission.autoModel`（`provider/model`）；没配（或找不到）时用会话供应商目录里的小模型（目录文件级
  `small`：deepseek → `deepseek-flash`、anthropic → `claude-haiku-4-5`、openai → `gpt-6-luna`、google →
  `gemini-3.5-flash-lite`、moonshot → `kimi-k2.6` 等，要能找到且有 key），再否则用当前会话模型；选中的模型记一条
  debug 日志。中转与自定义供应商没有目录小模型，仍用会话模型。推荐配一个便宜快速的模型，例如 `packy/qwen3.8-flash`。`maxTokens` 256，关闭思考。
- **缓存**：会话内按「工具名 + 归一化参数」（bash 折叠空白，其它按键排序的 JSON）缓存成功的判定，同样的调用只分类一次；出错与超时不缓存。
- **费用**：每次分类的用量记一条 `usage` 条目，`kind: "permission_classify"`，计入 `/session` 费用与 RPC 统计，不进上下文。
- 分类器只能把未决定的调用判成 allow 或 ask，不能推翻①的拒绝或询问。

## 审计

- 每次 auto 判定（放行与询问）记录 `{ layer: "rule" | "static" | "classifier", decision, reason }`：
  - `tool_execution_end` 事件带 `autoDecision`；需要询问时 `permission_request` 事件与审批请求带 `autoDecision`（对话框里显示「Auto：原因」）。
  - `/permissions` 显示最近 20 条判定（工具、摘要、层、结果、原因）。
- Hook `PreToolUse` 的输入不变；`permissionMode` 字段会出现新值 `auto`、`allowlist`。

## 配置

```jsonc
{
  "permission": {
    "mode": "auto",
    "autoModel": "packy/qwen3.8-flash",
    "autoSafeCommands": ["just test", "make fmt"],
    "allow": ["bash(npm run e2e)"],
    "deny": ["bash(terraform *)"],
  },
}
```

CI 用 allowlist：

```sh
ama -p "修好 lint 并跑测试" --permission-mode allowlist \
  --allow 'write(src/**)' --allow 'edit(src/**)' --allow 'bash(pnpm lint*)' --allow 'bash(pnpm test*)'
```

## 已知限制

- 静态判定看命令文本，不看命令真实会读什么：`grep -r token .` 会读到项目里的 `.env`，按安全名单放行。需要更严时，对 `.env` 加 deny 规则（`read(**/.env*)`、`bash(*.env*)`）。
- 「项目目录」就是 cwd，不跟随符号链接；在子目录启动时，上级目录算项目外。
- `npm test` / `make test` 之类会执行项目自己的脚本，安全名单按「在项目内跑测试与构建」放行；不信任的仓库请用 `default` 或 `plan`。
- `sudo` / `doas` 前缀的命令即使后面是安全命令也不算安全（`sudo` 本身在危险命令表里，询问）。
- 分类器是模型判断，不是安全边界。它前面的规则层不调模型、可审阅；真正不可接受的操作请写 deny 规则。
