# 操作系统级沙箱

> 状态：第一阶段（`src/sandbox/**` 与 codemode 接入）与第二阶段（bash 沙箱与「沙箱内命令免审批」）都已实现。

## 为什么

codemode 子进程靠 Node 权限模型（`--permission`）隔离文件、子进程与 worker；网络只有 Node ≥ 25 的权限模型
才拒绝。Node 22 / 24 上脚本一旦逃出 `vm` 就能联网，所以这两个版本上 codemode 缺省关闭、权限类是 `execute`。

操作系统本身有现成的进程级沙箱：macOS 的 `sandbox-exec`（Seatbelt，SBPL 配置）、Linux 的 bubblewrap
（`bwrap`，命名空间 + 绑定挂载）。把子进程放进去，网络与写入由内核拒绝，不依赖 Node 版本，也不依赖 `vm` 没有
漏洞。第一阶段只用于 codemode 子进程；第二阶段给 bash 用。

## 分层

```text
使用方   codemode 子进程（src/codemode/host-side.ts）     bash（src/tools/bash.ts 的 spawnShell）
           │ wrapCommand(status, node, args, policy)           │ wrapBashCommand（src/sandbox/bash.ts）
OS 沙箱  src/sandbox/  ── detect.ts   探测 + 进程内缓存 + 开关
                       ── profile.ts  SBPL / bwrap / unshare 参数生成（纯函数）
                       ── wrap.ts     输入命令行与策略 → 输出包装后的命令行
                       ── bash.ts     bash 的配置 → 会话内固定的设定、每次调用的策略、拒绝提示
平台     /usr/bin/sandbox-exec   bwrap   unshare -r -n   （Windows：无）
```

- `src/sandbox/**` 只依赖 `node:` 内置模块，不 import codemode、tools、permissions；使用方只拿到「包装后的
  命令行」，自己 spawn。
- 策略 `OsSandboxPolicy`：`network: "deny" | "allow"`、`writable: string[]`（绝对路径；包装时取 realpath，
  不存在的路径丢弃）；bash 另用可选的 `readOnly`（可写目录里仍只读）、`hiddenDirs` / `hiddenFiles`（不可读）。
  其余读取放开（见「安全边界」）。
- 状态 `OsSandboxStatus`：`kind`（`sandbox-exec` / `bwrap` / `unshare` / `none`）、可执行文件路径、
  `isolatesNetwork`、`restrictsWrites`、给 doctor 的说明。

## 各平台实现

### macOS：`sandbox-exec`

`/usr/bin/sandbox-exec -p <profile> <命令> <参数…>`。`sandbox-exec` 在 `sandbox_init` 之后 `execvp`，pid
不变，进程组杀树照旧。配置（网络拒绝、只允许写 `/work`）：

```scheme
(version 1)
(allow default)
(deny network*)
(deny mach-lookup (global-name "com.apple.dnssd.service"))
(deny file-write*)
(allow file-write* (subpath "/work"))
(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))
```

- `allow default` 起步再逐项拒绝：`deny default` 需要列出 Node 启动用到的 mach 服务、sysctl、IOKit 等，随系统
  版本变化，维护成本高；我们要的只是「不联网、不越界写」。
- 网络：`network*` 覆盖 TCP / UDP / Unix 域套接字的 bind、connect、inbound。DNS：macOS 的解析经 mDNSResponder
  （Unix 套接字 `/var/run/mDNSResponder`，已被 `network*` 拒绝），另外拒绝 mach 服务
  `com.apple.dnssd.service`，堵住经 DNS 查询外带数据的通道（实测 `dns.lookup` 返回 `ENOTFOUND`）。
- 路径：SBPL 按真实路径（vnode）匹配。`/tmp`、`/var` 是指向 `/private/…` 的符号链接，临时目录在
  `/private/var/folders/…`；所以可写目录一律先 `realpath`，字符串转义 `\` 与 `"`，含控制字符的路径拒绝。
- `/dev/null` 等设备单独放行写；stdin / stdout / stderr 是继承的管道描述符，不经路径检查。

### Linux：bubblewrap，退而 `unshare`

`bwrap --die-with-parent --ro-bind / / --dev /dev [--unshare-net] [--bind P P …] -- <命令> <参数…>`：

- `--ro-bind / /` 递归只读绑定整个根（含 `/proc`、`/sys` 子挂载），`--dev /dev` 给一份最小的 devtmpfs
  （`/dev/null` 可写），可写目录再逐个 `--bind` 回来；
- `--unshare-net`：新网络命名空间，只有 down 的 lo，连本机端口也不通；
- 不用 `--unshare-pid` / `--proc`（挂 procfs 需要自己的 pid 命名空间）；不用 `--new-session`（会让子进程脱离
  进程组，超时杀树失效；codemode 的 stdio 是管道，没有 TIOCSTI 注入面——第二阶段 bash 再评估）；
- `--die-with-parent`：ama 退出时沙箱里的进程一起结束。

没有 bwrap 时试 `unshare -r -n -- <命令>`（用户命名空间映射为 root + 新网络命名空间）：**只隔离网络，不限制
写入**。codemode 的写入已由 Node 权限模型拒绝，所以对 codemode 足够；第二阶段的 bash 要求限制写入，只认 bwrap。
需要内核允许非特权用户命名空间：Ubuntu 23.10 起 AppArmor 默认限制（`kernel.apparmor_restrict_unprivileged_userns`），
`unshare` 往往失败；发行版的 bwrap 包带 AppArmor 配置，通常可用。

### Windows

没有可零依赖调用的进程级沙箱（AppContainer / Job Object 需要原生代码）。`kind: none`，行为与现状相同。

## 探测与降级

- 「存在」不等于「可用」：嵌套在别的沙箱里时 `sandbox_init` 会失败，容器里没有用户命名空间时 bwrap 会失败。
  所以探测是**用目标配置跑一次最小探针**：macOS `sandbox-exec -p <拒绝网络与写入的配置> /usr/bin/true`；Linux
  `bwrap … --unshare-net -- true`，失败再试 `unshare -r -n -- true`。退出码 0 才算可用，5 秒超时。
- 结果在进程内缓存（一次 `spawnSync`，约 10 ms）；探针的副作用为零。
- 开关：`sandbox.enabled`（`auto` 缺省 / `off`），环境变量 `AMA_SANDBOX=off` 覆盖。`off` 时 `kind: none`，
  说明写明是用户关闭。

降级真值表（codemode）：

| Node    | OS 沙箱                        | 网络隔离来源       | strict | codemode 权限类 | `default` 预设  |
| ------- | ------------------------------ | ------------------ | ------ | --------------- | --------------- |
| ≥ 25    | 可用                           | Node 权限模型 + OS | 是     | read            | on              |
| ≥ 25    | 不可用 / off                   | Node 权限模型      | 是     | read            | on              |
| 22 / 24 | sandbox-exec / bwrap / unshare | OS 沙箱            | 是     | read            | on              |
| 22 / 24 | 不可用 / off / Windows         | 无（`net!`）       | 否     | execute         | off（提示一次） |

- Node ≥ 25 也叠加 OS 沙箱（纵深防御）。Node ≥ 25 时 strict 只靠 Node 权限模型，OS 沙箱不可用不改变任何
  结论；Node 22 / 24 时 strict 依赖 OS 沙箱，所以子进程**必须**经包装启动，包装失败就报错，不悄悄裸跑。
- 能力只在启动时探测一次，之后同一进程内不变：工具描述（`Sandbox: …` 行、`network not isolated`）与权限类
  在同一环境下逐字节稳定（设计 §9.1）。换机器 / 换 Node / 改 `sandbox.enabled` 才可能变。
- 传入假设的 Node 版本做计算（测试、展示）时不探测 OS 沙箱，按「不可用」处理，需要时显式传入状态。

## 配置

| 键                 | 取值              | 缺省   | 说明                                                                                                |
| ------------------ | ----------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `sandbox.enabled`  | `auto` \| `off`   | `auto` | `auto`：探测可用就用；`off`：不用 OS 沙箱（codemode 与 bash 都不用）。`AMA_SANDBOX=off` 覆盖        |
| `sandbox.bash`     | `auto` \| `off`   | `off`  | bash 经 OS 沙箱运行（见「第二阶段」）。只认 sandbox-exec / bwrap                                    |
| `sandbox.network`  | `deny` \| `allow` | `deny` | bash 沙箱里的网络。`deny` 是 default 模式免审批的前提                                               |
| `sandbox.writable` | 字符串数组        | `[]`   | bash 沙箱追加的可写目录（绝对路径或 `~/…`；相对路径 warning 并忽略），例如 `["~/.npm", "~/.cache"]` |

- codemode 的策略是固定的（网络拒绝、不可写），不受 `network` / `writable` 影响。
- 只认用户级 / profile。项目级 `.ama/config.json` 只接受收紧的 `sandbox.network: "deny"`，其余忽略并 warning：
  `enabled` / `bash` 两个方向都不是单纯更严（打开 bash 沙箱会让 default 模式的命令免审批，关闭会让命令裸跑），
  `writable` 是放宽。
- 与第五波 C0 的键不冲突：现有配置没有 `sandbox` 段；`codemode.requireStrict` 语义扩展为「网络既不由 Node
  权限模型、也不由 OS 沙箱隔离时禁用」。

## 安全边界与已知绕过

- 沙箱防的是「脚本 / 命令绕过权限管线去联网或越界写」，不是对抗内核漏洞的隔离环境。
- 读取基本不限制：codemode 的读取已由 Node 权限模型限制为只读入口文件；bash 沙箱拒读凭据目录（见「第二阶段」），
  其余可读。
- `sandbox-exec` 被苹果标为 deprecated（man page），但仍随系统提供，系统组件与主流工具都在用；哪天移除，探针
  失败，自动降级到现状。SBPL 没有公开规范，语义以实测为准（集成测试在 macOS CI 上跑）。
- `allow default` 意味着未列出的操作都允许：例如 mach IPC 到其它系统服务、`process-exec`。codemode 子进程的
  子进程 / worker 已被 Node 权限模型拒绝；bash 会运行任意程序，`process-exec` 白名单不现实，重点仍是网络与写入
  （mach IPC 的余地见「第二阶段」的已知绕过）。
- 已有的进程外通道仍在：与父进程的 stdin / stdout（codemode 协议本身）、继承的描述符。codemode 父进程只认
  JSON 行协议，工具调用照常过权限。
- Linux `unshare` 不限制写入；`--ro-bind` 不挡已打开的可写描述符；`/dev/shm` 在 `--dev /dev` 下是新的。
- 环境变量：codemode 子进程本来就以空环境启动；沙箱不改变这一点。

## 第二阶段：bash 沙箱与免审批

实现：`src/sandbox/bash.ts`（设定与策略）、`src/tools/bash.ts` 的 `spawnShell`（唯一的进程创建点，前台与后台
共用）、`src/permissions/pipeline.ts`（判定）。组装根（`src/cli/compose.ts`）算一次设定，同一份交给 bash 工具与
权限管线，「这次调用会不会在沙箱里跑」两边结论一致。

### 生效条件与缺省

- `sandbox.bash: auto` 且探测到能限制写入的沙箱（`sandbox-exec` / bwrap）才生效；`unshare` 只隔离网络，不算；
  Windows、探测失败、`sandbox.enabled: off`、`AMA_SANDBOX=off` → 不包装，行为与以前完全相同。
- **`sandbox.bash` 缺省 `off`**：沙箱会让写 `~/.npm`、`~/.cache`、`~/.cargo` 的常见命令失败，先让用户试、按需
  用 `sandbox.writable` 补目录；开了才有免审批的好处。
- **`sandbox.network` 缺省 `deny`**：联网可外带数据，只有拒绝网络时「沙箱内免审批」才成立。`npm install` 之类
  在沙箱里会失败，模型看到拒绝提示后用 `sandbox: false` 重跑并经用户审批；想让它们在沙箱里直接成功，设
  `network: "allow"`，代价是这些命令不再免审批（写入仍受限）。
- 设定在会话开始时确定、会话内不变：沙箱生效时 bash 工具的 schema 多一个 `sandbox` 布尔参数、描述末尾多一句
  （`Runs in an OS sandbox (writes only in workspace/temp, no network); sandbox:false needs approval.`）；不生效时
  工具定义与以前逐字节相同。打开 `sandbox.bash` 后首个请求未命中缓存一次。

### 每次调用的策略

| 项     | 内容                                                                                                                                                                                      |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 可写   | 会话工作区（会话 cwd）、系统临时目录（`os.tmpdir()`）、POSIX 的 `/tmp`、ama 的输出目录（截断全文、后台输出）、`sandbox.writable`；`/dev/null` 等设备                                      |
| 只读   | 工作区里的 `.ama/`（项目 Hook 与配置）、`.git/hooks`、`.git/config`（`core.hooksPath`、`core.fsmonitor` 能让之后在沙箱外运行的 git 执行任意命令）                                         |
| 不可读 | `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.kube`、`~/.docker/config.json`、`~/.config/gcloud`、`~/.netrc`、`~/.pgpass`、`~/.git-credentials`、ama 的 `auth.json`（与权限规则层的机密路径同一批） |
| 网络   | `sandbox.network`                                                                                                                                                                         |

- macOS：SBPL 里后出现的规则优先，只读 / 不可读规则排在允许之后；不存在的只读路径按「父目录 realpath + 名字」
  写进配置，挡住新建（例如沙箱里 `mkdir .ama`）。
- Linux bwrap：只读路径在可写绑定之后 `--ro-bind` 回去，不可读目录挂空 `--tmpfs`、文件挂 `/dev/null`；bwrap 只能
  挂到已存在的路径，**不存在的 `.ama/`、`.git/hooks` 挡不住新建**（已知限制）。
- 包装失败（不应发生）时报错，不悄悄裸跑：权限管线已按「在沙箱内」放行。

### 越出沙箱

- 命令非零退出、且输出像是被沙箱拒绝（`Operation not permitted`、`Read-only file system`、`EPERM`、`EACCES`；
  `network: deny` 时另看 `Could not resolve host`、`ENOTFOUND`、`ECONNREFUSED` 等）时，输出末尾追加一行：
  `[sandbox: this command ran in ama's OS sandbox (…). If it failed because of that, rerun it with sandbox:false,
which needs the user's approval.]`。按文本猜测，可能误报（同样的错误不是沙箱造成的），提示写的是「如果」。
- `bash{…, sandbox: false}` 不经沙箱运行，**一律走正常审批**：default / auto-edit 询问（allow 规则、Hook allow、
  会话记忆可放行），auto 在规则层询问（不交给分类器），无人值守拒绝；full-auto 照旧放行；plan / allowlist 语义
  不变。结构化结果 `sandboxed: true` 标出经沙箱运行的调用（前台与后台）。

### 权限集成

判定顺序见 [permissions.md](permissions.md)「判定顺序」。要点：

- default / auto-edit：bash 调用若 (a) 将在沙箱内运行（没请求 `sandbox: false`）、(b) 沙箱拒绝网络、(c) 命令
  文本（含嵌套的 `sh -c` 等）不碰机密路径、(d) 嵌套不超深，模式产生的「询问」变「放行」。deny 规则、危险命令表、
  Hook ask 仍先于它生效。
- auto：沙箱不直接放行。规则层（网络、删除、受保护路径、项目外写入）与静态判定照旧；交给分类器的调用附一行
  `os_sandbox`（写入受限、网络是否拒绝）作为输入之一。理由：auto 的规则层是有意比 default 更细的防线，分类器
  仍是最后一关；直接放行会让 `rm -r` 这类规则层本该询问的命令绕过它。代价是 default + 沙箱放行的部分命令
  （例如工作区里的 `rm -r dist`）在 auto 下仍会询问。
- plan、allowlist、full-auto 语义不变。

### 已知绕过与限制

- **工作区内的写入不再逐次审批**：default 模式下 `write` / `edit` 工具仍询问，而沙箱里的 `echo … > src/a.ts`、
  `rm -r build` 免审批。这是设计取舍（同类产品的 auto-allow-if-sandboxed 也如此）；需要逐条看就别开 `sandbox.bash`。
- **读工作区里的机密文件**：OS 沙箱不挡工作区内的读，输出会进模型上下文。文本里出现机密路径（`cat .env`）的命令
  不免审批，但 `cat $(ls -a | grep env)` 这类动态拼出的路径看不出来。需要更严时对 `.env` 加 deny 规则。
- **留给沙箱外执行的内容**：沙箱里可以改 `package.json` 的 scripts、`Makefile` 等，之后在沙箱外（用户自己、
  `sandbox: false`）运行时生效。`.ama/`、`.git/hooks`、`.git/config` 已只读，其它构建配置不在名单里。
- `sandbox.writable` 加了家目录下的缓存目录时，沙箱里的命令能改它们（例如往 `~/.npm` 写入被污染的包缓存）。
- macOS `allow default`：mach IPC 到其它系统服务、`process-exec` 未限制；DNS 已拒绝，其余 XPC 服务理论上可能
  被用来间接联网或写文件（未逐个审计）。
- Linux bwrap 不用 `--new-session`（保留进程组，超时杀树才有效），终端注入面不存在：bash 的 stdio 是管道或
  文件，不是终端。不用 `--unshare-pid`：沙箱里能看到并向同用户的进程发信号。
- 后台 bash 由 ama 打开输出文件再交给子进程，输出目录无论在不在可写列表都能写。
- SDK（`createAgent`）不读 `sandbox.bash`，bash 不包装、权限照旧。

### 测试

- `src/permissions/sandbox-pipeline.test.ts`：假状态的真值表（模式 × 是否在沙箱内 × 危险命令 / deny / Hook ask /
  机密路径 / `sandbox: false` × 无人值守）。
- `src/tools/bash-sandbox.test.ts`、`src/cli/bash-sandbox-e2e.test.ts`：真机（macOS CI 的 sandbox-exec；Linux 有
  bwrap 时），写工作区成功、写工作区外失败并带提示、`.git/hooks` 只读、凭据目录不可读、`network: deny` 连不上
  本机端口、`sandbox: false` 不包装且无人值守时被拒、后台 bash 也被包装、从用户级配置生效且项目级关不掉。
  没有能限制写入的沙箱时跳过（Linux runner 没装 bubblewrap 或不允许用户命名空间时这组跳过）。
