/**
 * 消息目录：auth（键名规范见 docs/i18n.md）。[W6-C0 建空壳，归 W6-O]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 文案里从不放 token、code、账户 id；邮箱只放掩码。
 */

import type { Messages } from "../types.js";

export const en = {
  usage: `Usage: ama auth set <provider> [--auth-file <file>]   read the key from stdin
      ama auth list [--auth-file <file>]
      ama auth remove <provider> [--auth-file <file>]
      ama auth login chatgpt [--flavor siwc|codex] [--paste | --device] [--port <n>] [--no-browser] [--yes] [--auth-file <file>]
      ama auth logout chatgpt [--auth-file <file>]
      ama auth status [chatgpt] [--auth-file <file>]
`,
  kind: { literal: "key", command: "!command", envRef: "env reference", oauth: "oauth" },
  needProvider: (action: string) => `ama auth ${action} needs <provider>`,
  extraArgs: (args: string) => `unexpected arguments: ${args}`,
  badProvider: (provider: string) => `invalid provider id: ${provider}`,
  unknownAction: (action: string) => `unknown auth subcommand: ${action}`,
  setPrompt: (provider: string) => `Enter the API key for ${provider} (hidden), then press Enter: `,
  noKeyFromStdin: "no key read from stdin",
  saved: (provider: string, path: string) => `Saved the key for ${provider} → ${path} (0600)`,
  warning: (text: string) => `ama: warning: ${text}`,
  listEmpty: (path: string) => `${path}: no saved keys`,
  removed: (provider: string, path: string) => `Removed the key for ${provider} (${path})`,
  notFound: (path: string, provider: string) => `ama: ${path} has no ${provider}`,
  oauthSummary: (flavor: string, plan: string | undefined, needsLogin: boolean) =>
    `${flavor}${plan !== undefined ? ` · ${plan}` : ""}${needsLogin ? " · sign-in expired" : ""}`,
  login: {
    onlyChatgpt: (provider: string) =>
      `ama auth login supports only chatgpt (got ${provider}); use ama auth set for API keys`,
    badFlavor: (flavor: string) => `--flavor must be siwc or codex: ${flavor}`,
    badPort: (port: string) => `--port needs a port number (0–65535): ${port}`,
    pasteDevice: "--paste and --device cannot be used together",
    deviceNeedsCodex:
      "--device is only available with --flavor codex (Sign in with ChatGPT has no device code); use --paste on a machine without a browser",
    codexNotice:
      "--flavor codex signs in with the Codex CLI's public client. This is unofficial use: for your own personal use only, OpenAI may change or restrict it at any time, and usage counts against your ChatGPT plan.",
    codexConfirm: "Continue? [y/N] ",
    codexNeedsYes: "--flavor codex needs a one-time confirmation; without a terminal pass --yes",
    cancelled: "cancelled",
    openedBrowser: (url: string) =>
      `Opened the browser to sign in. If nothing opened, visit:\n  ${url}\nWaiting for the browser (5 minutes; Ctrl-C to cancel)…`,
    openUrl: (url: string) =>
      `Open this URL in a browser to sign in:\n  ${url}\nWaiting for the browser (5 minutes; Ctrl-C to cancel)…`,
    pastePrompt: (url: string) =>
      `Open this URL in any browser and sign in:\n  ${url}\nThen paste the full URL from the address bar (http://127.0.0.1:…/auth/callback?code=…) and press Enter (input is hidden): `,
    deviceCode: (url: string, code: string) =>
      `Open ${url} and enter the code ${code} (valid for 15 minutes). Continue only if you started this login.`,
    pageSuccess: "Signed in to ama. You can close this page and return to the terminal.",
    pageFailure: "Sign-in failed. Return to the terminal for details.",
    loggedIn: (flavor: string, plan: string | undefined, email: string | undefined, path: string) =>
      `Signed in to ChatGPT (${flavor}${plan !== undefined ? ` · ${plan}` : ""}${email !== undefined ? ` · ${email}` : ""}) → ${path} (0600)`,
    siwcLimitHint:
      "Tip: set a weekly limit for ama in ChatGPT → Settings → Usage → App limits. For personal use only; never share one sign-in between several people.",
    freePlanHint: (plan: string) =>
      `Note: the "${plan}" plan may not include subscription usage for ama.`,
    modelHint:
      "Use it with --model chatgpt/<model>; list the models your account can use with ama models discover chatgpt.",
  },
  errors: {
    portsBusy: (ports: string, codex: boolean) =>
      `callback port ${ports} is in use: finish the other sign-in first, or use --paste${codex ? " / --device" : ""}`,
    timeout: "sign-in timed out; run the command again",
    denied: (error: string) => `sign-in was not authorized (${error})`,
    stateMismatch: "the pasted URL does not belong to this sign-in (state mismatch); start again",
    noCode: "the pasted URL has no code; copy the whole address after the browser redirects",
    invalidToken: (reason: string) => `id_token failed verification (${reason}); sign-in rejected`,
    scopeMissing: (scope: string) =>
      `the grant lacks ${scope}: allow ama to use your plan on the consent page and sign in again`,
    noClientId: "dynamic registration returned no client id; try again later",
    noAccount: "the id_token has no ChatGPT account id; sign in with a ChatGPT account",
    deviceUnavailable:
      "device code sign-in is not enabled; it may need to be turned on in ChatGPT → Settings → Security, or use --paste",
    http: (what: string) => `${what}; try again later`,
    network: (what: string) => `${what} (network error); check the connection or proxy`,
    lockTimeout: "auth.json is locked by another ama process; try again",
    aborted: "sign-in cancelled",
  },
  logout: {
    revoked: (provider: string, path: string) =>
      `Signed out of ${provider}: token revoked and removed from ${path}`,
    notRevoked: (provider: string, path: string) =>
      `Signed out of ${provider} (removed from ${path}); revocation could not be confirmed — you can disconnect ama in ChatGPT → Settings`,
    local: (provider: string, path: string) => `Signed out of ${provider}: removed from ${path}`,
    notLoggedIn: (provider: string, path: string) => `ama: ${path} has no sign-in for ${provider}`,
  },
  status: {
    none: (path: string) => `${path}: no OAuth sign-ins`,
    header: (provider: string, summary: string, email: string | undefined) =>
      `${provider}  ${summary}${email !== undefined ? ` · ${email}` : ""}`,
    expiresIn: (duration: string) =>
      `  access token valid for ${duration} (refreshed automatically)`,
    expired: "  access token expired (refreshed on next use)",
    needsLogin: (provider: string) => `  sign-in expired: run ama auth login ${provider}`,
    quota: (parts: string) => `  quota: ${parts}`,
    quotaWindow: (window: string, percent: number, reset: string | undefined) =>
      `${window} ${percent}%${reset !== undefined ? ` (resets ${reset})` : ""}`,
    window5h: "5h",
    windowWeek: "weekly",
    windowOther: (duration: string) => `${duration} window`,
    quotaSiwc: "  quota: only reported when exceeded; see ChatGPT → Settings → Usage",
    quotaUnavailable: "  quota: unavailable",
  },
  report: {
    section: "Subscription usage",
    row: (requests: number, input: string, output: string, cacheRead: string, hit: string) =>
      `${requests} requests · input ${input} · output ${output} · cache read ${cacheRead} (hit rate ${hit}) · not billed in USD`,
    quotaKey: "quota",
  },
  doctor: {
    oauth: (flavor: string, plan: string | undefined, state: string) =>
      `oauth (${flavor}${plan !== undefined ? ` · ${plan}` : ""} · ${state})`,
    valid: (duration: string) => `valid ${duration}`,
    expired: "expired, refreshed on next use",
    needsLogin: "sign-in expired",
    relogin: (provider: string) => `${provider}: sign-in expired, run ama auth login ${provider}`,
  },
};

export const zh = {
  usage: `用法：ama auth set <provider> [--auth-file <文件>]   从 stdin 读取 key
      ama auth list [--auth-file <文件>]
      ama auth remove <provider> [--auth-file <文件>]
      ama auth login chatgpt [--flavor siwc|codex] [--paste | --device] [--port <n>] [--no-browser] [--yes] [--auth-file <文件>]
      ama auth logout chatgpt [--auth-file <文件>]
      ama auth status [chatgpt] [--auth-file <文件>]
`,
  kind: { literal: "key", command: "!命令", envRef: "环境变量引用", oauth: "oauth" },
  needProvider: (action) => `ama auth ${action} 需要 <provider>`,
  extraArgs: (args) => `多余的参数：${args}`,
  badProvider: (provider) => `供应商 id 不合法：${provider}`,
  unknownAction: (action) => `未知的 auth 子命令：${action}`,
  setPrompt: (provider) => `输入 ${provider} 的 API key（不回显），回车结束：`,
  noKeyFromStdin: "没有从 stdin 读到 key",
  saved: (provider, path) => `已保存 ${provider} 的 key → ${path}（0600）`,
  warning: (text) => `ama: 警告：${text}`,
  listEmpty: (path) => `${path}：没有保存的 key`,
  removed: (provider, path) => `已删除 ${provider} 的 key（${path}）`,
  notFound: (path, provider) => `ama: ${path} 中没有 ${provider}`,
  oauthSummary: (flavor, plan, needsLogin) =>
    `${flavor}${plan !== undefined ? ` · ${plan}` : ""}${needsLogin ? " · 登录已失效" : ""}`,
  login: {
    onlyChatgpt: (provider) =>
      `ama auth login 只支持 chatgpt（收到 ${provider}）；API key 用 ama auth set`,
    badFlavor: (flavor) => `--flavor 只能是 siwc 或 codex：${flavor}`,
    badPort: (port) => `--port 需要端口号（0–65535）：${port}`,
    pasteDevice: "--paste 与 --device 不能同时使用",
    deviceNeedsCodex:
      "--device 只在 --flavor codex 下可用（官方 ChatGPT 登录没有设备码）；没有浏览器的机器用 --paste",
    codexNotice:
      "--flavor codex 借用 Codex CLI 的公开客户端登录。这是非官方用法：仅限本人个人使用，OpenAI 可能随时变更或限制，用量计入你的 ChatGPT 计划。",
    codexConfirm: "继续吗？[y/N] ",
    codexNeedsYes: "--flavor codex 需要一次性确认；没有终端时请加 --yes",
    cancelled: "已取消",
    openedBrowser: (url) =>
      `已在浏览器打开登录页；如果没有打开，请访问：\n  ${url}\n等待浏览器完成（5 分钟；Ctrl-C 取消）…`,
    openUrl: (url) =>
      `请在浏览器打开下面的地址登录：\n  ${url}\n等待浏览器完成（5 分钟；Ctrl-C 取消）…`,
    pastePrompt: (url) =>
      `在任意浏览器打开下面的地址并登录：\n  ${url}\n然后把地址栏里的完整 URL（http://127.0.0.1:…/auth/callback?code=…）粘贴到这里并回车（不回显）：`,
    deviceCode: (url, code) =>
      `打开 ${url} 并输入代码 ${code}（15 分钟内有效）。只在这次登录是你自己发起时继续。`,
    pageSuccess: "ama 已登录，可以关闭此页回到终端。",
    pageFailure: "登录失败，请回到终端查看原因。",
    loggedIn: (flavor, plan, email, path) =>
      `已登录 ChatGPT（${flavor}${plan !== undefined ? ` · ${plan}` : ""}${email !== undefined ? ` · ${email}` : ""}）→ ${path}（0600）`,
    siwcLimitHint:
      "提示：可在 ChatGPT → 设置 → Usage → App limits 给 ama 设周上限。仅限本人使用，不要让多人共用一个登录。",
    freePlanHint: (plan) => `注意：「${plan}」计划可能不含给 ama 用的订阅额度。`,
    modelHint:
      "用 --model chatgpt/<模型> 使用；账户可用的模型用 ama models discover chatgpt 查看。",
  },
  errors: {
    portsBusy: (ports, codex) =>
      `回调端口 ${ports} 被占用：请先结束其它登录，或用 --paste${codex ? " / --device" : ""}`,
    timeout: "登录超时，请重新运行命令",
    denied: (error) => `授权未通过（${error}）`,
    stateMismatch: "粘贴的 URL 不属于这次登录（state 不符），请重新开始",
    noCode: "粘贴的 URL 里没有 code；请在浏览器跳转后复制完整地址",
    invalidToken: (reason) => `id_token 校验失败（${reason}），已拒绝这次登录`,
    scopeMissing: (scope) => `授权缺少 ${scope}：请在授权页允许 ama 使用你的计划额度后重新登录`,
    noClientId: "动态注册没有返回 client id，请稍后再试",
    noAccount: "id_token 里没有 ChatGPT 账户 id，请用 ChatGPT 账户登录",
    deviceUnavailable:
      "设备码登录未开启：可能需要在 ChatGPT → 设置 → Security 里打开，或改用 --paste",
    http: (what) => `${what}，请稍后再试`,
    network: (what) => `${what}（网络错误），请检查网络或代理`,
    lockTimeout: "auth.json 正被另一个 ama 进程锁定，请重试",
    aborted: "已取消登录",
  },
  logout: {
    revoked: (provider, path) => `已登出 ${provider}：token 已撤销并从 ${path} 删除`,
    notRevoked: (provider, path) =>
      `已登出 ${provider}（已从 ${path} 删除）；未能确认撤销，可在 ChatGPT → 设置里断开 ama`,
    local: (provider, path) => `已登出 ${provider}：已从 ${path} 删除`,
    notLoggedIn: (provider, path) => `ama: ${path} 中没有 ${provider} 的登录`,
  },
  status: {
    none: (path) => `${path}：没有 OAuth 登录`,
    header: (provider, summary, email) =>
      `${provider}  ${summary}${email !== undefined ? ` · ${email}` : ""}`,
    expiresIn: (duration) => `  access token 还剩 ${duration}（自动刷新）`,
    expired: "  access token 已过期（下次使用时自动刷新）",
    needsLogin: (provider) => `  登录已失效：运行 ama auth login ${provider}`,
    quota: (parts) => `  配额：${parts}`,
    quotaWindow: (window, percent, reset) =>
      `${window} ${percent}%${reset !== undefined ? `（${reset} 重置）` : ""}`,
    window5h: "5 小时",
    windowWeek: "周",
    windowOther: (duration) => `${duration} 窗口`,
    quotaSiwc: "  配额：只在超限时可知；在 ChatGPT → 设置 → Usage 查看",
    quotaUnavailable: "  配额：暂不可用",
  },
  report: {
    section: "订阅用量",
    row: (requests, input, output, cacheRead, hit) =>
      `${requests} 次请求 · 输入 ${input} · 输出 ${output} · 缓存读 ${cacheRead}（命中率 ${hit}）· 不折算美元`,
    quotaKey: "配额",
  },
  doctor: {
    oauth: (flavor, plan, state) =>
      `oauth（${flavor}${plan !== undefined ? ` · ${plan}` : ""} · ${state}）`,
    valid: (duration) => `剩 ${duration}`,
    expired: "已过期，下次使用时刷新",
    needsLogin: "登录已失效",
    relogin: (provider) => `${provider}：登录已失效，运行 ama auth login ${provider}`,
  },
} satisfies Messages<typeof en>;
