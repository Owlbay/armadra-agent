/**
 * JWT 解码与 JWKS 验签（R6 §4.11：`createPublicKey` + `verify`，零依赖）。[W6-O]
 *
 * 支持 RS256 / RS384 / RS512 / PS256 / ES256 / ES384；其它 alg（含 `none`）一律拒绝。
 * 错误只带原因码，不带 token 原文。
 */

import { createPublicKey, verify, constants, type JsonWebKey } from "node:crypto";
import { AmaError } from "../../errors.js";

export type JwtPayload = Record<string, unknown>;

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: JwtPayload;
  signingInput: string;
  signature: Buffer;
}

function invalid(reason: string): AmaError {
  return new AmaError("oauth_invalid_token", `invalid id_token: ${reason}`, { detail: { reason } });
}

function json(segment: string | undefined, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8")) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    // 落到下面
  }
  throw invalid(`malformed ${what}`);
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid("malformed");
  return {
    header: json(parts[0], "header"),
    payload: json(parts[1], "payload"),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2] ?? "", "base64url"),
  };
}

/** 只解码 payload；解不开返回 undefined（codex flavor 取声明用，不验签）。 */
export function jwtClaims(token: string | undefined): JwtPayload | undefined {
  if (token === undefined) return undefined;
  try {
    return decodeJwt(token).payload;
  } catch {
    return undefined;
  }
}

export interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

const ALGS: Record<string, { hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true },
  ES256: { hash: "sha256", ec: true },
  ES384: { hash: "sha384", ec: true },
};

/** 按 header 的 alg / kid 在 JWKS 里找钥并验签；不通过抛 `oauth_invalid_token`。 */
export function verifyJwtSignature(decoded: DecodedJwt, keys: readonly Jwk[]): void {
  const alg = typeof decoded.header["alg"] === "string" ? decoded.header["alg"] : "";
  const spec = ALGS[alg];
  if (spec === undefined) throw invalid(`unsupported alg ${alg.slice(0, 16) || "(none)"}`);
  const kid = decoded.header["kid"];
  const candidates = keys.filter(
    (key) =>
      (kid === undefined || key.kid === kid) &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === alg),
  );
  if (candidates.length === 0) throw invalid("no matching key");
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      const ok = verify(
        spec.hash,
        Buffer.from(decoded.signingInput),
        spec.pss
          ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
          : spec.ec
            ? { key, dsaEncoding: "ieee-p1363" }
            : key,
        decoded.signature,
      );
      if (ok) return;
    } catch {
      // 这把钥不合用，试下一把
    }
  }
  throw invalid("bad signature");
}
