/**
 * 测试用 fake OAuth / ChatGPT 后端（docs/history/wave6-plan.md §4.6）。`node:http` 随机端口；不进 bundle。
 *
 * OAuth：authorize（记参数、302 回 redirect_uri；SIWC 注册时带签发的 client_id 与 scope）、token（校验 PKCE；
 * 授权码 / 刷新；刷新轮换，旧 refresh token 再用 → `refresh_token_reused`）、deviceauth、discovery + JWKS
 * （现场生成 RSA 密钥对）、revoke。后端：`/v1/responses`、`/codex/responses`、`/v1/models`、`/codex/models`、
 * `/wham/usage`，按脚本回放；给了 `codexModels` 时 `/codex/models` 改按 `client_version` 过滤（不带 → 400，
 * 低于条目的 `minimal_client_version` 不给），与真实 codex 后端一致。
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  query: URLSearchParams;
}

export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  /** SSE 事件（JSON 对象）或原始文本。 */
  events?: unknown[];
  body?: unknown;
}

export interface FakeOAuthOptions {
  /** SIWC 注册时签发的 id。 */
  issuedClientId?: string;
  /** 回调与 token 响应里的 scope；缺省含 chatgpt.tokens.use.direct。 */
  scope?: string;
  accessTtlS?: number;
  /** 改 id_token 声明（坏 nonce 等）。 */
  idTokenClaims?: (claims: Record<string, unknown>) => Record<string, unknown>;
  /** 用另一把钥签 id_token（验签失败）。 */
  wrongKey?: boolean;
  /** 刷新响应延迟（并发测试）。 */
  refreshDelayMs?: number;
  /** 刷新直接失败的错误码。 */
  refreshError?: string;
  /** 设备码轮询先返回几次 403。 */
  devicePending?: number;
  marker?: string;
  /** codex 模型目录（`/codex/models` 按 `client_version` 过滤后返回 `{ models }`）。 */
  codexModels?: Record<string, unknown>[];
}

/** `a.b.c` 比较；非数字段按 0。 */
function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export class FakeOAuthServer {
  readonly requests: RecordedRequest[] = [];
  readonly responses: ScriptedResponse[] = [];
  readonly revoked: string[] = [];
  refreshCalls = 0;
  exchangeCalls = 0;
  issuer = "";
  private server: Server | undefined;
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  private readonly otherKey: KeyObject;
  private readonly codes = new Map<
    string,
    { challenge: string; nonce: string; clientId: string; redirectUri: string }
  >();
  private current = new Map<string, string>(); // refresh token → client id
  private readonly used = new Set<string>();
  private seq = 0;
  private devicePolls = 0;

  constructor(readonly options: FakeOAuthOptions = {}) {
    this.key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    this.issuer = `http://127.0.0.1:${port}`;
    return this.issuer;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  get marker(): string {
    return this.options.marker ?? "MARK";
  }

  /** 预置一个可刷新的 refresh token（不经登录）。 */
  seedRefreshToken(token: string, clientId: string): void {
    this.current.set(token, clientId);
  }

  private next(prefix: string): string {
    this.seq++;
    return `${prefix}-${this.seq}-${this.marker}-${randomBytes(4).toString("hex")}`;
  }

  idToken(claims: Record<string, unknown>): string {
    const header = { alg: "RS256", kid: "k1", typ: "JWT" };
    const final = this.options.idTokenClaims ? this.options.idTokenClaims(claims) : claims;
    const input = `${b64url(header)}.${b64url(final)}`;
    const key = this.options.wrongKey ? this.otherKey : this.key.privateKey;
    return `${input}.${sign("sha256", Buffer.from(input), key).toString("base64url")}`;
  }

  private tokens(clientId: string, nonce: string): Record<string, unknown> {
    const refresh = this.next("rt");
    this.current.set(refresh, clientId);
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: this.next("at"),
      refresh_token: refresh,
      id_token: this.idToken({
        iss: this.issuer,
        aud: clientId,
        sub: "user-sub-1",
        nonce,
        exp: now + 3600,
        iat: now,
        email: "alice@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" },
      }),
      token_type: "Bearer",
      expires_in: this.options.accessTtlS ?? 3600,
      scope: this.scope,
    };
  }

  private get scope(): string {
    return (
      this.options.scope ??
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.issuer);
    const record: RecordedRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      headers: req.headers,
      body,
      query: url.searchParams,
    };
    this.requests.push(record);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    const params = (): Record<string, string> =>
      String(req.headers["content-type"]).includes("json")
        ? (JSON.parse(body || "{}") as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(body));
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return json(200, {
          issuer: this.issuer,
          jwks_uri: `${this.issuer}/jwks`,
          revocation_endpoint: `${this.issuer}/revoke`,
        });
      case "/jwks":
        return json(200, {
          keys: [
            {
              ...this.key.publicKey.export({ format: "jwk" }),
              kid: "k1",
              use: "sig",
              alg: "RS256",
            },
          ],
        });
      case "/api/accounts/authorize":
      case "/oauth/authorize": {
        const q = url.searchParams;
        const code = this.next("code");
        const registering = q.get("client_id") === "dynamic_agent_client";
        const clientId = registering
          ? (this.options.issuedClientId ?? "oaiapp_issued")
          : (q.get("client_id") ?? "");
        this.codes.set(code, {
          challenge: q.get("code_challenge") ?? "",
          nonce: q.get("nonce") ?? "",
          clientId,
          redirectUri: q.get("redirect_uri") ?? "",
        });
        const back = new URL(q.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        if (url.pathname.startsWith("/api/")) {
          if (registering) back.searchParams.set("client_id", clientId);
          back.searchParams.set("scope", this.scope);
        }
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      case "/api/accounts/oauth/token":
      case "/oauth/token": {
        const p = params();
        if (p["grant_type"] === "authorization_code") {
          this.exchangeCalls++;
          const saved = this.codes.get(p["code"] ?? "");
          if (!saved) return json(400, { error: "invalid_grant" });
          const challenge = createHash("sha256")
            .update(p["code_verifier"] ?? "")
            .digest("base64url");
          if (challenge !== saved.challenge) return json(400, { error: "invalid_grant" });
          if (p["redirect_uri"] !== saved.redirectUri) return json(400, { error: "invalid_grant" });
          if (p["client_id"] !== saved.clientId) return json(400, { error: "invalid_client" });
          this.codes.delete(p["code"] ?? "");
          return json(200, this.tokens(saved.clientId, saved.nonce));
        }
        if (p["grant_type"] === "refresh_token") {
          this.refreshCalls++;
          if (this.options.refreshDelayMs)
            await new Promise((r) => setTimeout(r, this.options.refreshDelayMs));
          if (this.options.refreshError) return json(400, { error: this.options.refreshError });
          const token = p["refresh_token"] ?? "";
          if (this.used.has(token)) return json(400, { error: "refresh_token_reused" });
          const clientId = this.current.get(token);
          if (clientId === undefined) return json(400, { error: "invalid_grant" });
          this.used.add(token);
          this.current.delete(token);
          const out = this.tokens(clientId, "");
          delete out["id_token"];
          return json(200, out);
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      case "/api/accounts/deviceauth/usercode":
        return json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "1" });
      case "/api/accounts/deviceauth/token": {
        this.devicePolls++;
        if (this.devicePolls <= (this.options.devicePending ?? 1))
          return json(403, { error: "authorization_pending" });
        const code = this.next("code");
        const verifier = "device-verifier-0123456789abcdef0123456789abcdef";
        this.codes.set(code, {
          challenge: createHash("sha256").update(verifier).digest("base64url"),
          nonce: "",
          clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
          redirectUri: `${this.issuer}/deviceauth/callback`,
        });
        return json(200, {
          authorization_code: code,
          code_verifier: verifier,
          code_challenge: "x",
        });
      }
      case "/codex/models": {
        const catalog = this.options.codexModels;
        if (catalog === undefined) return this.backend(res);
        const version = url.searchParams.get("client_version");
        if (version === null) return json(400, { error: { message: "client_version required" } });
        return json(200, {
          models: catalog.filter(
            (m) => compareVersion(version, String(m["minimal_client_version"] ?? "0")) >= 0,
          ),
        });
      }
      case "/revoke":
        this.revoked.push(params()["token"] ?? "");
        res.writeHead(200).end();
        return;
      default:
        return this.backend(res);
    }
  }

  private backend(res: ServerResponse): void {
    const scripted = this.responses.shift() ?? { events: completedEvents("ok") };
    const status = scripted.status ?? 200;
    if (scripted.events === undefined || status !== 200) {
      res.writeHead(status, { "content-type": "application/json", ...scripted.headers });
      res.end(JSON.stringify(scripted.body ?? {}));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", ...scripted.headers });
    for (const event of scripted.events) {
      const data = typeof event === "string" ? event : JSON.stringify(event);
      res.write(`data: ${data}\n\n`);
    }
    res.end();
  }
}

/** 一段最小的成功 SSE（一个文本块）。 */
export function completedEvents(text: string, extra: unknown[] = []): unknown[] {
  return [
    { type: "response.created", response: { id: "resp_1" } },
    ...extra,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    },
    { type: "response.output_text.delta", output_index: 0, delta: text },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", content: [{ type: "output_text", text }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
      },
    },
  ];
}

/** 跟随 302 打到本地回调（代替浏览器）。 */
export async function followAuthorize(url: string): Promise<void> {
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location");
  if (location) await fetch(location);
}
