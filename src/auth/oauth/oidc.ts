/**
 * OIDC discovery、JWKS 与 id_token 校验（docs/wave6-plan.md §4.1 id_token 行；R6 §1.1）。[W6-O]
 *
 * SIWC 必须：JWKS 验签 + `iss` = issuer、`aud` 含签发的 client id、`nonce` = 本次登录的、`exp` 未过
 * （允许 60 s 时钟偏差）。discovery 与 JWKS 每进程按 issuer 缓存一次。
 */

import { AmaError } from "../../errors.js";
import { decodeJwt, verifyJwtSignature, type Jwk, type JwtPayload } from "./jwt.js";
import { getJson, type FetchLike } from "./token-client.js";

export interface OidcDiscovery {
  issuer?: string;
  jwksUri?: string;
  revocationEndpoint?: string;
}

const discoveryCache = new Map<string, Promise<OidcDiscovery>>();

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function fetchDiscovery(fetchFn: FetchLike, issuer: string): Promise<OidcDiscovery> {
  const key = trimSlash(issuer);
  let pending = discoveryCache.get(key);
  if (pending === undefined) {
    pending = getJson(fetchFn, `${key}/.well-known/openid-configuration`, "OIDC discovery").then(
      (value) => {
        const str = (k: string): string | undefined =>
          typeof value[k] === "string" ? (value[k] as string) : undefined;
        const out: OidcDiscovery = {};
        const iss = str("issuer");
        if (iss !== undefined) out.issuer = iss;
        const jwks = str("jwks_uri");
        if (jwks !== undefined) out.jwksUri = jwks;
        const revoke = str("revocation_endpoint");
        if (revoke !== undefined) out.revocationEndpoint = revoke;
        return out;
      },
    );
    pending.catch(() => discoveryCache.delete(key));
    discoveryCache.set(key, pending);
  }
  return pending;
}

export async function fetchJwks(fetchFn: FetchLike, uri: string): Promise<Jwk[]> {
  const value = await getJson(fetchFn, uri, "JWKS");
  const keys = value["keys"];
  return Array.isArray(keys)
    ? (keys.filter((k) => typeof k === "object" && k !== null) as Jwk[])
    : [];
}

/** 测试用：清掉 discovery 缓存。 */
export function clearOidcCache(): void {
  discoveryCache.clear();
}

export interface IdTokenExpectations {
  issuer: string;
  /** 签发的 client id；`aud` 必须含它。 */
  audience: string;
  nonce: string;
  now?: number;
}

function reject(reason: string): AmaError {
  return new AmaError("oauth_invalid_token", `invalid id_token: ${reason}`, { detail: { reason } });
}

/** 验签并校验声明；返回 payload。 */
export async function validateIdToken(
  fetchFn: FetchLike,
  idToken: string,
  expect: IdTokenExpectations,
): Promise<JwtPayload> {
  const decoded = decodeJwt(idToken);
  const discovery = await fetchDiscovery(fetchFn, expect.issuer);
  if (discovery.jwksUri === undefined) throw reject("issuer has no jwks_uri");
  verifyJwtSignature(decoded, await fetchJwks(fetchFn, discovery.jwksUri));
  const claims = decoded.payload;
  if (trimSlash(String(claims["iss"] ?? "")) !== trimSlash(expect.issuer)) throw reject("iss");
  const aud = claims["aud"];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(expect.audience)) throw reject("aud");
  if (claims["nonce"] !== expect.nonce) throw reject("nonce");
  const exp = claims["exp"];
  const now = (expect.now ?? Date.now()) / 1000;
  if (typeof exp !== "number" || exp + 60 < now) throw reject("exp");
  return claims;
}
