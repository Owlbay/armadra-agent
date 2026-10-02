# 操作系统级沙箱

> 状态：第一阶段（`src/sandbox/**` 与 codemode 接入）已实现；第二阶段（bash 沙箱与「沙箱内命令免审批」）
> 是设计，等 W5-H2（`src/tools/bash.ts`）与 W5-F（`src/permissions/**`）合入后再做。

## 为什么

codemode 子进程靠 Node 权限模型（`--permission`）隔离文件、子进程与 worker；网络只有 Node ≥ 25 的权限模型
才拒绝。Node 22 / 24 上脚本一旦逃出 `vm` 就能联网，所以这两个版本上 codemode 缺省关闭、权限类是 `execute`。

操作系统本身有现成的进程级沙箱：macOS 的 `sandbox-exec`（Seatbelt，SBPL 配置）、Linux 的 bubblewrap
（`bwrap`，命名空间 + 绑定挂载）。把子进程放进去，网络与写入由内核拒绝，不依赖 Node 版本，也不依赖 `vm` 没有
漏洞。第一阶段只用于 codemode 子进程；第二阶段给 bash 用。

## 分层

```text
使用方   codemode 子进程（src/codemode/host-side.ts）     bash（第二阶段，src/tools/bash.ts）
           │ wrapCommand(status, node, args, policy)           │
OS 沙箱  src/sandbox/  ── detect.ts   探测 + 进程内缓存 + 开关
                       ── profile.ts  SBPL / bwrap / unshare 参数生成（纯函数）
                       ── wrap.ts     输入命令行与策略 → 输出包装后的命令行
平台     /usr/bin/sandbox-exec   bwrap   unshare -r -n   （Windows：无）
```

- `src/sandbox/**` 只依赖 `node:` 内置模块，不 import codemode、tools、permissions；使用方只拿到「包装后的
  命令行」，自己 spawn。
- 策略 `OsSandboxPolicy`：`network: "deny" | "allow"`、`writable: string[]`（绝对路径；包装时取 realpath，
  不存在的路径丢弃）。读取一律放开（见「读取策略」）。
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

| 键                | 取值            | 缺省   | 说明                                                                                    |
| ----------------- | --------------- | ------ | --------------------------------------------------------------------------------------- |
| `sandbox.enabled` | `auto` \| `off` | `auto` | `auto`：探测可用就用；`off`：不用 OS 沙箱。`AMA_SANDBOX=off` 覆盖。只认用户级 / profile |

- 第一阶段只加这一个键。codemode 的策略是固定的（网络拒绝、不可写），不需要配置；`sandbox.network` /
  `sandbox.writable` 只对第二阶段的 bash 有意义，届时再加（见下），避免出现没有效果的键。
- 整段只认用户级 / profile：项目级 `.ama/config.json` 里写 `sandbox` 一律忽略并 warning（`merge.ts` 的缺省
  分支），防止仓库关掉用户的沙箱。
- 与第五波 C0 的键不冲突：现有配置没有 `sandbox` 段；`codemode.requireStrict` 语义扩展为「网络既不由 Node
  权限模型、也不由 OS 沙箱隔离时禁用」。

## 安全边界与已知绕过

- 沙箱防的是「脚本 / 命令绕过权限管线去联网或越界写」，不是对抗内核漏洞的隔离环境。
- 读取不限制：codemode 的读取已由 Node 权限模型限制为只读入口文件；bash 第二阶段再考虑拒读敏感目录
  （`~/.ssh`、`~/.aws`、ama 的 `auth.json` 等）。
- `sandbox-exec` 被苹果标为 deprecated（man page），但仍随系统提供，系统组件与主流工具都在用；哪天移除，探针
  失败，自动降级到现状。SBPL 没有公开规范，语义以实测为准（集成测试在 macOS CI 上跑）。
- `allow default` 意味着未列出的操作都允许：例如 mach IPC 到其它系统服务、`process-exec`。codemode 子进程的
  子进程 / worker 已被 Node 权限模型拒绝；bash 第二阶段会运行任意程序，届时评估收紧（如 `process-exec` 白名单
  不现实，重点仍是网络与写入）。
- 已有的进程外通道仍在：与父进程的 stdin / stdout（codemode 协议本身）、继承的描述符。codemode 父进程只认
  JSON 行协议，工具调用照常过权限。
- Linux `unshare` 不限制写入；`--ro-bind` 不挡已打开的可写描述符；`/dev/shm` 在 `--dev /dev` 下是新的。
- 环境变量：codemode 子进程本来就以空环境启动；沙箱不改变这一点。

## 第二阶段：bash 沙箱与免审批（设计）

前置条件：W5-H2（`src/tools/bash.ts`、`truncate.ts`）与 W5-F（`src/permissions/**`）合入 main；本阶段的
`src/sandbox/**` 接口不变。

1. 配置：加 `sandbox.bash: "off" | "auto"`（缺省 off，先让用户试）、`sandbox.network: "deny" | "allow"`（缺省
   deny）、`sandbox.writable: string[]`（缺省只有工作区 cwd 与 `$TMPDIR` 的 realpath；`~` 展开）。只认用户级 /
   profile。
2. bash 工具：`sandbox.bash: auto` 且 `kind` 能限制写入（sandbox-exec / bwrap；`unshare` 不算）时，命令经
   `wrapCommand(status, shell, ["-c", cmd], { network, writable })` 启动。`ToolResult.structured` 加
   `sandboxed: true`；沙箱拒绝导致的失败（`Operation not permitted` / `EPERM`）在结果末尾追加一行提示，告诉模型
   可以请求不经沙箱重跑（`dangerouslyDisableSandbox: true` 参数，走正常审批）。
3. 权限集成：权限管线新增一个判定来源 `sandbox`——`default` 模式下，bash 调用若 (a) 将在沙箱内运行、(b) 没有
   请求跳过沙箱、(c) 不命中 deny 规则与内置危险命令表，则按 `read` 类处理免审批；`plan` 模式仍按 `plan.bash`；
   `deny` 规则永远优先。审批记录与 Hook 输入带 `sandboxed: true`，Hook 可以拒绝。
4. 网络例外：`sandbox.network: allow` 时命令可联网但写入仍受限——不再满足「免审批」的条件（联网可外带数据），
   仍按 execute。以后可加域名白名单（需要本地代理，非零依赖之外再议）。
5. 状态栏与 doctor：显示 `sandbox` 状态（W5-A 合入之后改状态栏渲染）。
6. 测试：macOS 真机的写越界、联网、免审批路径；fake 状态下的权限真值表；Linux bwrap 用例在 CI 安装 bubblewrap
   后跑（需要改 ci.yml：`sudo apt-get install -y bubblewrap`，单独 PR 提议）。
