/**
 * API Key 发现（设计 §3.5）。顺序：
 *   ① `--api-key`（只对 `--model` 指定的那家供应商）
 *   ② `--auth-file` / profile.authFile 指向的 auth.json
 *   ③ 用户级 `<configDir>/auth.json`（不是 0600 → warning 并照用）
 *   ④ config.json 的 `providers.<id>.apiKey`（`$ENV_NAME`、`${ENV_NAME}`、`!command`；`$$` 转义）
 *   ⑤ 环境变量：`provider.envKeys` 顺序（profile.authEnv=false 时跳过）
 *   ⑥ `requiresApiKey: false` 的供应商：无 key 也放行（source "none"）
 *
 * auth.json 的 `apiKey` 以 `!` 开头 = 执行命令取值（stdout 去首尾空白；超时 10 s；空输出或
 * 非零退出视为未配置，继续找下一来源）；同一命令进程内只执行一次。
 * 密钥只出现在 `resolve()` 的返回值里：warning 文案不含密钥与命令输出。
 *
 * [W6-O] auth.json 的 OAuth 条目（`type: "oauth"`，ChatGPT 登录）在 ②③ 的位置解析：每次从磁盘重读（绕过
 * `fileCache`），临近过期经 `auth/oauth/refresh.ts` 刷新（跨进程锁），返回 `{ source: "oauth" }`，并把 token 的
 * 上下文登记进 `auth/oauth/live.ts` 供协议层取账户 id、401 时强制刷新。永久失效（needsLogin）时仍返回旧 token
 * 并在登记里标 needsLogin，协议层据此直接报 `auth_expired`（不发请求）。
 */

import { exec } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerLiveToken } from "../../auth/oauth/live.js";
import { authExpiredError, freshOAuthEntry, type RefreshDeps } from "../../auth/oauth/refresh.js";
import { readOAuthEntry } from "../../auth/oauth/token-store.js";
import type { ApiKeyAuthEntry, AuthFile } from "../../config/types.js";
import { apiKeyEntry, isOAuthEntry, type OAuthAuthEntry } from "../../config/types-w6.js";
import type { ApiKeyResolution, ProviderData } from "../types.js";

export type KeyProvider = Pick<ProviderData, "id" | "envKeys" | "requiresApiKey">;

export interface KeyResolverOptions {
  /** ① `--api-key`：只对 provider 生效。 */
  cliApiKey?: { provider: string; apiKey: string } | undefined;
  /** ② `--auth-file` / profile.authFile。 */
  authFile?: string | undefined;
  /** ③ 用户级 auth.json；缺省 `<configDir>/auth.json`；null 关闭。 */
  userAuthFile?: string | null | undefined;
  /** ④ config.json 的 `providers.<id>.apiKey` 原始值。 */
  configKeys?: Readonly<Record<string, string | undefined>> | undefined;
  /** ⑤ 是否读环境变量（缺省 true）。 */
  useEnv?: boolean | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  onWarning?: ((message: string) => void) | undefined;
  /** `!command` 超时，缺省 10 000。 */
  commandTimeoutMs?: number | undefined;
  /** [W6-O] OAuth 刷新的依赖（fetch、配置 `auth.chatgpt`、测试注入）。 */
  oauth?: RefreshDeps | undefined;
}

/** 用户级配置目录：AMA_CONFIG_DIR > %APPDATA%\ama > $XDG_CONFIG_HOME/ama > ~/.config/ama。 */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env["AMA_CONFIG_DIR"]) return env["AMA_CONFIG_DIR"];
  if (process.platform === "win32" && env["APPDATA"]) return join(env["APPDATA"], "ama");
  if (env["XDG_CONFIG_HOME"]) return join(env["XDG_CONFIG_HOME"], "ama");
  return join(env["HOME"] ?? homedir(), ".config", "ama");
}

/** API key 条目；OAuth 条目（`type: "oauth"`）走 `oauthPath()` + token 存储。 */
type AuthEntry = ApiKeyAuthEntry;

/** 读 auth.json；不存在返回 undefined；格式错误 / 权限过宽记 warning。 */
export function readAuthFile(
  path: string,
  onWarning?: (message: string) => void,
): AuthFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "ENOENT") onWarning?.(`cannot read auth file ${path}`);
    return undefined;
  }
  if (process.platform !== "win32") {
    try {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        onWarning?.(
          `auth file ${path} has permissions ${mode.toString(8).padStart(4, "0")}; expected 0600`,
        );
      }
    } catch {
      // 读得到就不必再纠结 stat
    }
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("not an object");
    const providers = (value as { providers?: unknown }).providers;
    if (typeof providers !== "object" || providers === null) throw new Error("no providers");
    return value as AuthFile;
  } catch {
    onWarning?.(`auth file ${path} is not a valid auth.json; ignored`);
    return undefined;
  }
}

/**
 * 展开 config.json 的 `$NAME` / `${NAME}`（`$$` → `$`）。引用的变量未设置或为空 →
 * undefined（视为未配置）。
 */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const out = value.replace(
    /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match: string, braced: string | undefined, bare: string | undefined) => {
      if (match === "$$") return "$";
      const name = braced ?? bare ?? "";
      const resolved = env[name];
      if (resolved === undefined || resolved === "") missing = true;
      return resolved ?? "";
    },
  );
  return missing || out.length === 0 ? undefined : out;
}

export class ApiKeyResolver {
  private readonly options: KeyResolverOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly commandCache = new Map<string, Promise<string | undefined>>();
  private readonly fileCache = new Map<string, AuthFile | undefined>();

  constructor(options: KeyResolverOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
  }

  private warn(message: string): void {
    this.options.onWarning?.(message);
  }

  private authFiles(): string[] {
    const files: string[] = [];
    if (this.options.authFile) files.push(this.options.authFile);
    const user =
      this.options.userAuthFile === undefined
        ? join(defaultConfigDir(this.env), "auth.json")
        : this.options.userAuthFile;
    if (user && !files.includes(user)) files.push(user);
    return files;
  }

  private loadFile(path: string): AuthFile | undefined {
    if (!this.fileCache.has(path))
      this.fileCache.set(
        path,
        readAuthFile(path, (m) => this.warn(m)),
      );
    return this.fileCache.get(path);
  }

  /** auth.json 里该供应商的条目（按 ② ③ 顺序第一个）。 */
  authEntry(providerId: string): { entry: AuthEntry; path: string } | undefined {
    for (const path of this.authFiles()) {
      const entry = apiKeyEntry(this.loadFile(path)?.providers[providerId]);
      if (entry && typeof entry.apiKey === "string") return { entry, path };
    }
    return undefined;
  }

  /** [W6-O] 第一个给该供应商写了条目的 auth.json 若是 OAuth 条目，返回其路径。 */
  oauthPath(providerId: string): string | undefined {
    for (const path of this.authFiles()) {
      const raw = this.loadFile(path)?.providers[providerId];
      if (raw === undefined) continue;
      return isOAuthEntry(raw) ? path : undefined;
    }
    return undefined;
  }

  private register(path: string, providerId: string, entry: OAuthAuthEntry): void {
    const deps = this.options.oauth ?? {};
    registerLiveToken(entry.accessToken, {
      provider: providerId,
      flavor: entry.flavor,
      accountId: entry.accountId,
      planType: entry.planType,
      ...(entry.needsLogin === true ? { needsLogin: true } : {}),
      refresh: async () => {
        const next = await freshOAuthEntry(path, providerId, deps, {
          force: true,
          staleToken: entry.accessToken,
        });
        if (next === undefined) throw authExpiredError(providerId);
        this.register(path, providerId, next);
        return next.accessToken;
      },
    });
  }

  private async fromOAuth(providerId: string, path: string): Promise<ApiKeyResolution | undefined> {
    let entry: OAuthAuthEntry | undefined;
    try {
      entry = await freshOAuthEntry(path, providerId, this.options.oauth ?? {});
    } catch (error) {
      // 失效：用旧 token 登记 needsLogin，协议层报 auth_expired；暂时失败：先用现有 token
      entry = readOAuthEntry(path, providerId);
      const code = (error as { code?: unknown }).code;
      if (entry !== undefined && code === "auth_expired") entry = { ...entry, needsLogin: true };
      else this.warn(`${providerId}: OAuth token refresh failed (${String(code ?? "error")})`);
    }
    if (entry === undefined) return undefined;
    this.register(path, providerId, entry);
    return { apiKey: entry.accessToken, source: "oauth", origin: path };
  }

  private runCommand(
    command: string,
    extraEnv?: Record<string, string>,
  ): Promise<string | undefined> {
    const key = `${command}\0${JSON.stringify(extraEnv ?? {})}`;
    let pending = this.commandCache.get(key);
    if (!pending) {
      const timeout = this.options.commandTimeoutMs ?? 10_000;
      pending = new Promise((resolve) => {
        exec(
          command,
          { timeout, windowsHide: true, env: { ...this.env, ...extraEnv }, maxBuffer: 1 << 20 },
          (error, stdout) => {
            const value = String(stdout).trim();
            if (error || value.length === 0) {
              this.warn(`api key command failed or printed nothing: ${command.split(/\s+/)[0]}`);
              resolve(undefined);
            } else resolve(value);
          },
        );
      });
      this.commandCache.set(key, pending);
    }
    return pending;
  }

  private async fromAuthFiles(providerId: string): Promise<ApiKeyResolution | undefined> {
    for (const path of this.authFiles()) {
      const raw = this.loadFile(path)?.providers[providerId];
      if (isOAuthEntry(raw)) {
        const resolved = await this.fromOAuth(providerId, path);
        if (resolved) return resolved;
        continue;
      }
      const entry = apiKeyEntry(raw);
      if (!entry || typeof entry.apiKey !== "string" || entry.apiKey.length === 0) continue;
      const value = entry.apiKey.startsWith("!")
        ? await this.runCommand(entry.apiKey.slice(1), entry.env)
        : entry.apiKey;
      if (value) return { apiKey: value, source: "auth-file", origin: path };
    }
    return undefined;
  }

  private async fromConfig(providerId: string): Promise<string | undefined> {
    const raw = this.options.configKeys?.[providerId];
    if (!raw) return undefined;
    if (raw.startsWith("!")) return this.runCommand(raw.slice(1));
    return expandEnvRefs(raw, this.env);
  }

  private fromEnv(provider: KeyProvider): ApiKeyResolution | undefined {
    if (this.options.useEnv === false) return undefined;
    for (const name of provider.envKeys) {
      const value = this.env[name];
      if (value && value.trim().length > 0) {
        return { apiKey: value.trim(), source: "env", origin: name };
      }
    }
    return undefined;
  }

  async resolve(provider: KeyProvider): Promise<ApiKeyResolution> {
    const cli = this.options.cliApiKey;
    if (cli && cli.provider === provider.id && cli.apiKey) {
      return { apiKey: cli.apiKey, source: "cli" };
    }
    const fromFile = await this.fromAuthFiles(provider.id);
    if (fromFile) return fromFile;
    const fromConfig = await this.fromConfig(provider.id);
    if (fromConfig) return { apiKey: fromConfig, source: "config" };
    const fromEnv = this.fromEnv(provider);
    if (fromEnv) return fromEnv;
    return { apiKey: undefined, source: "none" };
  }

  /**
   * 同步判断「看起来配置了 key」（不执行 `!command`，只看配置是否存在；env 引用需已设置）。
   * 供 `findModel()` 在无斜杠引用时过滤候选。
   */
  hasConfiguredKey(provider: KeyProvider): boolean {
    const cli = this.options.cliApiKey;
    if (cli && cli.provider === provider.id && cli.apiKey) return true;
    if (this.authEntry(provider.id)?.entry.apiKey) return true;
    if (this.oauthPath(provider.id) !== undefined) return true;
    const raw = this.options.configKeys?.[provider.id];
    if (raw && (raw.startsWith("!") || expandEnvRefs(raw, this.env) !== undefined)) return true;
    return this.fromEnv(provider) !== undefined;
  }
}
