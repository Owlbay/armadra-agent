/**
 * auto 模式规则层的受保护路径（§7.4，docs/guides/permissions.md「规则层」）。
 *
 * - **机密路径**（读写都询问）：`.env` / `.env.*`（`.example` / `.sample` / `.template` / `.dist` 除外）、
 *   `*.env`、`.ssh/`、`.gnupg/`、`.aws/`、`.kube/config`、`.docker/config.json`、`.config/gcloud/`、
 *   `.netrc`、`.pgpass`、`.git-credentials`、私钥（`id_rsa` 等、`*.pem`、`*.key`、`*.p12`、`*.pfx`、
 *   `*.jks`、`*.keystore`、`*.ppk`）、ama 自己的 `ama/auth.json`。
 * - **受保护写入**（只对写询问）：机密路径，`.git` 目录内部，项目里的 `.ama/`（Hook 与配置可能借此放宽），
 *   项目目录外的任何路径（`/dev/null`、`/dev/stdout`、`/dev/stderr`、`/dev/tty` 除外）。
 *
 * 判断按词法路径（不跟随符号链接，与规则匹配一致）。返回英文短说明（进审计与 tool_result），
 * 不受保护返回 undefined。
 */

import { basename, relative } from "node:path";
import { isWithin, toPosix } from "../tools/paths.js";

const ENV_EXEMPT = /\.(example|sample|template|dist)$/i;
const KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
const KEY_EXT = /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i;
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws"]);
const SECRET_FILES = new Set([".netrc", ".pgpass", ".git-credentials"]);
const DEVICE_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

function segments(absPath: string): string[] {
  return toPosix(absPath).split("/").filter(Boolean);
}

/** 机密文件或目录：读与写都要询问。 */
export function secretPathReason(absPath: string): string | undefined {
  const parts = segments(absPath);
  const name = basename(absPath);
  if ((/^\.env(\..+)?$/.test(name) || /\.env$/.test(name)) && !ENV_EXEMPT.test(name)) {
    return `secret file ${name}`;
  }
  if (KEY_FILE.test(name) || KEY_EXT.test(name)) return `private key or certificate ${name}`;
  if (SECRET_FILES.has(name)) return `credentials file ${name}`;
  const dir = parts.slice(0, -1);
  const secretDir = parts.find((p) => SECRET_DIRS.has(p));
  if (secretDir !== undefined) return `credentials directory ${secretDir}/`;
  for (let i = 0; i < dir.length; i++) {
    const a = dir[i];
    const b = parts[i + 1];
    if (a === ".kube" && b === "config") return "kubeconfig";
    if (a === ".docker" && b === "config.json") return "docker credentials";
    if (a === ".config" && b === "gcloud") return "gcloud credentials";
    if ((a === "ama" || a === ".ama") && b === "auth.json" && i + 2 === parts.length) {
      return "ama API key file";
    }
  }
  return undefined;
}

/** 写入受保护的原因：机密、`.git` 内部、项目 `.ama/`、项目外；可以写返回 undefined。 */
export function writeProtectionReason(absPath: string, projectRoot: string): string | undefined {
  if (DEVICE_SINKS.has(toPosix(absPath))) return undefined;
  const secret = secretPathReason(absPath);
  if (secret !== undefined) return secret;
  if (segments(absPath).includes(".git")) return "writes inside .git";
  if (!isWithin(projectRoot, absPath)) return "writes outside the project directory";
  const rel = toPosix(relative(projectRoot, absPath));
  if (rel === ".ama" || rel.startsWith(".ama/")) return "writes to the project .ama/ config";
  return undefined;
}

/** 是否在项目目录内（含项目根本身）。 */
export function insideProject(absPath: string, projectRoot: string): boolean {
  return isWithin(projectRoot, absPath);
}
