import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeJwt, jwtClaims, verifyJwtSignature, type Jwk } from "./jwt.js";

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("JWT", () => {
  it("ES256 验签（ieee-p1363）；换钥失败", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const input = `${b64({ alg: "ES256", kid: "e" })}.${b64({ sub: "x" })}`;
    const sig = sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" });
    const token = `${input}.${sig.toString("base64url")}`;
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e" } as Jwk;
    expect(() => verifyJwtSignature(decodeJwt(token), [jwk])).not.toThrow();
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(() =>
      verifyJwtSignature(decodeJwt(token), [{ ...other.export({ format: "jwk" }), kid: "e" }]),
    ).toThrow(/bad signature/);
  });

  it("alg none / 无匹配 kid / 坏格式都拒绝；错误不含 token 原文", () => {
    const none = `${b64({ alg: "none" })}.${b64({ sub: "SECRET-PAYLOAD" })}.`;
    expect(() => verifyJwtSignature(decodeJwt(none), [])).toThrow(/unsupported alg/);
    const rs = `${b64({ alg: "RS256", kid: "zz" })}.${b64({})}.AA`;
    expect(() => verifyJwtSignature(decodeJwt(rs), [{ kid: "k1", kty: "RSA" }])).toThrow(
      /no matching key/,
    );
    try {
      decodeJwt("SECRET.only");
    } catch (error) {
      expect((error as Error).message).not.toContain("SECRET");
    }
    expect(jwtClaims("garbage")).toBeUndefined();
    expect(jwtClaims(none)).toEqual({ sub: "SECRET-PAYLOAD" });
  });
});
