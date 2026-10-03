/**
 * `ama auth login | logout | status chatgpt`（docs/wave6-plan.md §4.2、D16）。[W6-O]
 *
 * - login：flavor 取 `--flavor` > 用户级 `auth.chatgpt.flavor` > siwc；`--paste` / `--device`（只 codex）/ 缺省
 *   浏览器；codex 首次在 TTY 下一次性确认「非官方、仅个人使用」（非 TTY 需 `--yes`），`acknowledgedAt` 入条目；
 *   成功后在刷新锁下写 auth.json（0600）。
 *   成功后查一次模型列表写发现缓存（`<dataDir>/models/discovered/chatgpt.json`，失败静默）。
 * - logout：SIWC 先撤销 refresh token（失败照样删本地，提示到 ChatGPT 设置里断开）；codex 只删本地；
 *   同时删发现缓存。
 * - status：flavor、计划、掩码邮箱、access token 剩余、needsLogin；codex 另查 `wham/usage` 显示配额。
 *
 * 输出里从不出现 token、code、账户 id；错误按码渲染（i18n），不回显响应原文。
 */

import { isAmaError } from "../../errors.js";
import { describeAuthFile, readAuthFile } from "../../config/auth-file.js";
import { loadConfigFile } from "../../config/load.js";
import { CONFIG_FILE, resolveConfigDir, resolveDataDir } from "../../config/paths.js";
import {
  CHATGPT_FLAVORS,
  isOAuthEntry,
  type ChatGptAuthConfig,
  type ChatGptFlavor,
  type OAuthAuthEntry,
} from "../../config/types-w6.js";
import { formatDuration, msg } from "../../i18n/index.js";
import { UsageError } from "../../cli/args.js";
import type { CliIo } from "../../cli/deps.js";
import { ExitCode } from "../../cli/exit-codes.js";
import { openBrowser, type BrowserOpener } from "../oauth/browser.js";
import type { LoginStep } from "../oauth/flows.js";
import { readOAuthEntry, withRefreshLock, writeOAuthEntry } from "../oauth/token-store.js";
import type { FetchLike } from "../oauth/token-client.js";
import { clearDiscoveredCache, writeDiscoveredCache } from "../../ai/providers/discovered-cache.js";
import { fetchCodexUsage, listChatGptModels } from "./backend-client.js";
import { maskEmail } from "./claims.js";
import { loginChatGpt, revokeChatGpt, type LoginMethod } from "./login.js";
import { CHATGPT_PROVIDER_ID, chatgptBaseUrl } from "./presets.js";
import { quotaParts } from "./quota-text.js";

export interface AuthCliDeps {
  fetch?: FetchLike;
  openBrowser?: BrowserOpener;
  now?: () => number;
  /** `--paste` 读回调 URL；缺省 `io.readStdin`（TTY 下一行不回显）。 */
  readLine?: () => Promise<string>;
}

export interface AuthCliArgs {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
  path: string;
}

function userAuthConfig(io: CliIo): ChatGptAuthConfig | undefined {
  try {
    const path = `${resolveConfigDir({ env: io.env })}/${CONFIG_FILE}`;
    return loadConfigFile("config", path)?.value.auth?.chatgpt;
  } catch {
    return undefined;
  }
}

function providerOf(args: AuthCliArgs, action: string): string {
  const provider = args.positionals[1];
  if (provider === undefined) throw new UsageError(msg().auth.needProvider(action));
  if (args.positionals.length > 2)
    throw new UsageError(msg().auth.extraArgs(args.positionals.slice(2).join(" ")));
  if (provider !== CHATGPT_PROVIDER_ID)
    throw new UsageError(msg().auth.login.onlyChatgpt(provider));
  return provider;
}

/** AmaError → 本地化的一行（不含响应原文）。 */
export function loginErrorText(error: unknown, flavor: ChatGptFlavor): string {
  const m = msg().auth.errors;
  if (!isAmaError(error)) return (error as Error)?.message ?? String(error);
  const detail = (error.detail ?? {}) as {
    ports?: number[];
    reason?: string;
    error?: string;
    scope?: string;
  };
  switch (error.code) {
    case "oauth_ports_busy":
      return m.portsBusy((detail.ports ?? []).join(" / "), flavor === "codex");
    case "oauth_timeout":
      return m.timeout;
    case "oauth_denied":
      return m.denied(detail.error ?? "error");
    case "oauth_state_mismatch":
      return m.stateMismatch;
    case "oauth_no_code":
      return m.noCode;
    case "oauth_invalid_token":
      return m.invalidToken(detail.reason ?? "invalid");
    case "oauth_scope_missing":
      return m.scopeMissing(detail.scope ?? "chatgpt.tokens.use.direct");
    case "oauth_no_client_id":
      return m.noClientId;
    case "oauth_no_account":
      return m.noAccount;
    case "oauth_device_unavailable":
      return m.deviceUnavailable;
    case "oauth_device_unsupported":
      return msg().auth.login.deviceNeedsCodex;
    case "oauth_http":
    case "oauth_bad_response":
      return m.http(error.message);
    case "oauth_network":
      return m.network(error.message);
    case "auth_lock_timeout":
      return m.lockTimeout;
    case "aborted":
      return m.aborted;
    default:
      return error.message;
  }
}

function parseFlavor(
  raw: string | undefined,
  config: ChatGptAuthConfig | undefined,
): ChatGptFlavor {
  const value = raw ?? config?.flavor ?? "siwc";
  if (!(CHATGPT_FLAVORS as readonly string[]).includes(value))
    throw new UsageError(msg().auth.login.badFlavor(value));
  return value as ChatGptFlavor;
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new UsageError(msg().auth.login.badPort(raw));
  return port;
}

/** 确认输入两种语言都认（y / yes / 是 / 好），与界面语言无关。 */
function isYes(answer: string): boolean {
  return /^\s*(y|yes|\u662f|\u597d)\s*$/i.test(answer);
}

export async function runLogin(
  args: AuthCliArgs,
  io: CliIo,
  deps: AuthCliDeps = {},
): Promise<number> {
  const m = msg().auth.login;
  const provider = providerOf(args, "login");
  const config = userAuthConfig(io);
  const flavor = parseFlavor(args.values.get("flavor"), config);
  const port = parsePort(args.values.get("port"));
  if (args.flags.has("paste") && args.flags.has("device")) throw new UsageError(m.pasteDevice);
  const method: LoginMethod = args.flags.has("device")
    ? "device"
    : args.flags.has("paste")
      ? "paste"
      : "browser";
  if (method === "device" && flavor !== "codex") throw new UsageError(m.deviceNeedsCodex);
  const existing = readOAuthEntry(args.path, provider);
  let acknowledgedAt: string | undefined;
  if (flavor === "codex") {
    acknowledgedAt = existing?.flavor === "codex" ? existing.acknowledgedAt : undefined;
    if (acknowledgedAt === undefined) {
      io.stderr(`${m.codexNotice}\n`);
      if (!args.flags.has("yes")) {
        if (!io.stdinIsTTY) {
          io.stderr(`ama: ${m.codexNeedsYes}\n`);
          return ExitCode.Usage;
        }
        io.stderr(m.codexConfirm);
        const answer = await io.readStdin();
        io.stderr("\n");
        if (!isYes(answer)) {
          io.stderr(`ama: ${m.cancelled}\n`);
          return ExitCode.RuntimeError;
        }
      }
      acknowledgedAt = new Date((deps.now ?? Date.now)()).toISOString();
    }
  }
  const onStep = (step: LoginStep): void => {
    if (step.kind === "open_url")
      io.stderr(`${step.opened ? m.openedBrowser(step.url) : m.openUrl(step.url)}\n`);
    else if (step.kind === "paste_prompt") io.stderr(m.pastePrompt(step.url));
    else io.stderr(`${m.deviceCode(step.url, step.userCode)}\n`);
  };
  let entry: OAuthAuthEntry;
  try {
    entry = await loginChatGpt({
      flavor,
      method,
      noBrowser: args.flags.has("no-browser"),
      dataDir: resolveDataDir({ env: io.env }),
      env: io.env,
      config,
      entry: existing,
      port,
      acknowledgedAt,
      deps: {
        fetch: deps.fetch ?? fetch,
        openBrowser: deps.openBrowser ?? openBrowser,
        onStep,
        readLine: async () => {
          const line = await (deps.readLine ?? (() => io.readStdin()))();
          if (io.stdinIsTTY) io.stderr("\n");
          return line;
        },
        pages: { success: m.pageSuccess, failure: m.pageFailure },
      },
    });
    await withRefreshLock(args.path, async () => writeOAuthEntry(args.path, provider, entry));
  } catch (error) {
    io.stderr(`ama: ${loginErrorText(error, flavor)}\n`);
    return ExitCode.RuntimeError;
  }
  io.stdout(`${m.loggedIn(flavor, entry.planType, maskEmail(entry.email), args.path)}\n`);
  if (entry.planType === "free") io.stdout(`${m.freePlanHint(entry.planType)}\n`);
  if (flavor === "siwc") io.stdout(`${m.siwcLimitHint}\n`);
  const count = await cacheModels(io, entry, config, deps);
  io.stdout(`${count === undefined ? m.modelHint : m.modelsCached(count)}\n`);
  return ExitCode.Ok;
}

/**
 * 登录后查一次账户可用的模型（只读的模型列表接口，不消耗额度）并写发现缓存，`/model` 由此列出；
 * 任何失败静默（返回 undefined，调用方改提示 `ama models discover chatgpt`）。
 */
async function cacheModels(
  io: CliIo,
  entry: OAuthAuthEntry,
  config: ChatGptAuthConfig | undefined,
  deps: AuthCliDeps,
): Promise<number | undefined> {
  try {
    const models = await listChatGptModels(
      deps.fetch ?? fetch,
      chatgptBaseUrl(entry.flavor, io.env),
      {
        flavor: entry.flavor,
        accessToken: entry.accessToken,
        accountId: entry.accountId,
        originator: config?.originator,
      },
    );
    if (models.length === 0) return undefined;
    const dataDir = resolveDataDir({ env: io.env });
    writeDiscoveredCache(dataDir, CHATGPT_PROVIDER_ID, { models, flavor: entry.flavor });
    return models.length;
  } catch {
    return undefined;
  }
}

export async function runLogout(
  args: AuthCliArgs,
  io: CliIo,
  deps: AuthCliDeps = {},
): Promise<number> {
  const m = msg().auth.logout;
  const provider = providerOf(args, "logout");
  const entry = readOAuthEntry(args.path, provider);
  if (entry === undefined) {
    io.stderr(`${m.notLoggedIn(provider, args.path)}\n`);
    return ExitCode.RuntimeError;
  }
  const revoked =
    entry.flavor === "siwc"
      ? await revokeChatGpt(deps.fetch ?? fetch, entry, { env: io.env, config: userAuthConfig(io) })
      : undefined;
  try {
    await withRefreshLock(args.path, async () => writeOAuthEntry(args.path, provider, undefined));
  } catch (error) {
    io.stderr(`ama: ${loginErrorText(error, entry.flavor)}\n`);
    return ExitCode.RuntimeError;
  }
  clearDiscoveredCache(resolveDataDir({ env: io.env }), provider);
  const text =
    revoked === undefined
      ? m.local(provider, args.path)
      : revoked
        ? m.revoked(provider, args.path)
        : m.notRevoked(provider, args.path);
  io.stdout(`${text}\n`);
  return ExitCode.Ok;
}

export async function runStatus(
  args: AuthCliArgs,
  io: CliIo,
  deps: AuthCliDeps = {},
): Promise<number> {
  const m = msg().auth.status;
  if (args.positionals.length > 2)
    throw new UsageError(msg().auth.extraArgs(args.positionals.slice(2).join(" ")));
  const only = args.positionals[1];
  const now = (deps.now ?? Date.now)();
  const { file } = readAuthFile(args.path);
  const entries = Object.entries(file.providers).filter(
    (pair): pair is [string, OAuthAuthEntry] =>
      isOAuthEntry(pair[1]) && (only === undefined || pair[0] === only),
  );
  if (entries.length === 0) {
    io.stdout(`${m.none(args.path)}\n`);
    return ExitCode.Ok;
  }
  const summaries = new Map(describeAuthFile(file, now).map((s) => [s.provider, s]));
  const config = userAuthConfig(io);
  for (const [provider, entry] of entries) {
    const summary = summaries.get(provider);
    io.stdout(
      `${m.header(
        provider,
        msg().auth.oauthSummary(entry.flavor, entry.planType, entry.needsLogin === true),
        maskEmail(entry.email),
      )}\n`,
    );
    const left = summary?.expiresIn ?? entry.expiresAt - now;
    if (entry.needsLogin === true) io.stdout(`${m.needsLogin(provider)}\n`);
    else io.stdout(`${left > 0 ? m.expiresIn(formatDuration(left)) : m.expired}\n`);
    if (entry.flavor === "siwc") io.stdout(`${m.quotaSiwc}\n`);
    else if (entry.needsLogin !== true && left > 0) {
      const quota = await fetchCodexUsage(deps.fetch ?? fetch, chatgptBaseUrl("codex", io.env), {
        flavor: "codex",
        accessToken: entry.accessToken,
        accountId: entry.accountId,
        originator: config?.originator,
      });
      const parts = quota === undefined ? undefined : quotaParts(quota, now);
      io.stdout(`${parts === undefined ? m.quotaUnavailable : m.quota(parts)}\n`);
    }
  }
  return ExitCode.Ok;
}
