/**
 * PKCE（RFC 7636，S256）与随机串（docs/history/wave6-plan.md §4.1；R6 §4.3）。[W6-O]
 *
 * verifier 32 字节随机数的 base64url（43 字符），challenge = base64url(SHA-256(verifier)) 无填充；
 * `state` / `nonce` 同样 32 字节随机。只用 `node:crypto`。
 */

import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function base64url(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function s256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function generatePkce(): PkcePair {
  const verifier = randomToken(32);
  return { verifier, challenge: s256(verifier), method: "S256" };
}
