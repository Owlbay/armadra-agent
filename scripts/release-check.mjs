#!/usr/bin/env node
/**
 * 发布前版本检查（第三波 §2.4「Release 双 bundle」）：`pnpm run release:check`，已并入 `pnpm run ci`。
 *
 * 规则（与上一个 `v*` tag 比较；仓库还没有 tag 时只做形状检查并通过）：
 * 1. `package.json.version` 是 `x.y.z`（可带预发布后缀），且不低于上一个 tag 的版本；
 * 2. 对外协议常量 `HOST_API_VERSION`（src/host/types.ts）、`RPC_PROTOCOL_VERSION`（src/rpc.ts）、
 *    `SESSION_FORMAT_VERSION`（src/session/types.ts）与上一个 tag 不同 → 版本必须是**破坏性升级**：
 *    主版本号变化；主版本为 0 时按 semver 0.x 惯例，次版本号变化即可；
 * 3. 在 tag 构建里（`GITHUB_REF_TYPE=tag`）tag 名必须等于 `v<version>`，比较对象是它之前的 tag。
 *
 * 纯函数 `checkRelease()` 导出给测试；CLI 部分只负责读 git 与文件（`--root <dir>` 换仓库根，
 * 测试用）。CI 的 checkout 需要
 * `fetch-depth: 0` 才看得到 tag。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROTOCOL_CONSTANTS = [
  { name: "HOST_API_VERSION", file: "src/host/types.ts" },
  { name: "RPC_PROTOCOL_VERSION", file: "src/rpc.ts" },
  { name: "SESSION_FORMAT_VERSION", file: "src/session/types.ts" },
];

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `1.2.3` / `1.2.3-rc.1` → 数组；不合法 → undefined。 */
export function parseVersion(text) {
  const m = VERSION_RE.exec(String(text ?? "").replace(/^v/, ""));
  if (!m) return undefined;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] };
}

/** a < b → 负；预发布版本低于同号正式版。 */
export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** 从 TS 源码里取 `export const NAME = 1 as const;` 的数值。 */
export function readConstant(source, name) {
  const m = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source ?? "");
  return m ? Number(m[1]) : undefined;
}

/**
 * @param {{ version: string, previous?: { tag: string, version: string, constants: Record<string, number|undefined> },
 *   constants: Record<string, number|undefined>, refTag?: string }} input
 * @returns {{ ok: boolean, errors: string[], notes: string[] }}
 */
export function checkRelease(input) {
  const errors = [];
  const notes = [];
  const current = parseVersion(input.version);
  if (current === undefined) {
    errors.push(`package.json version "${input.version}" 不是 x.y.z`);
    return { ok: false, errors, notes };
  }
  for (const { name } of PROTOCOL_CONSTANTS) {
    if (input.constants[name] === undefined) errors.push(`源码里找不到 ${name}`);
  }
  if (input.refTag !== undefined && input.refTag !== `v${input.version}`) {
    errors.push(`tag ${input.refTag} 与 package.json 版本 v${input.version} 不一致`);
  }
  const previous = input.previous;
  if (previous === undefined) {
    notes.push("没有更早的 v* tag：只检查版本形状");
    return { ok: errors.length === 0, errors, notes };
  }
  const before = parseVersion(previous.version);
  if (before === undefined) {
    errors.push(`上一个 tag ${previous.tag} 不是合法版本`);
    return { ok: false, errors, notes };
  }
  if (compareVersions(current, before) < 0) {
    errors.push(`版本 ${input.version} 低于上一个 tag ${previous.tag}`);
  }
  const changed = PROTOCOL_CONSTANTS.filter(
    ({ name }) =>
      previous.constants[name] !== undefined && previous.constants[name] !== input.constants[name],
  ).map(({ name }) => `${name} ${previous.constants[name]} → ${input.constants[name]}`);
  if (changed.length > 0) {
    const breaking =
      current.major !== before.major || (before.major === 0 && current.minor !== before.minor);
    if (!breaking) {
      const need = before.major === 0 ? "次版本号（0.x）" : "主版本号";
      errors.push(
        `协议常量变了（${changed.join("，")}），版本 ${input.version} 相对 ${previous.tag} 需要升${need}`,
      );
    } else notes.push(`协议常量变化（${changed.join("，")}）已随破坏性版本升级`);
  }
  notes.push(`相对 ${previous.tag}：版本 ${previous.version} → ${input.version}`);
  return { ok: errors.length === 0, errors, notes };
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** 上一个 v* tag（按版本排序；排除 refTag 本身与高于当前版本的 tag）。 */
function previousTag(root, refTag) {
  const tags = (git(root, ["tag", "--list", "v*", "--merged", "HEAD"]) ?? "")
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t && t !== refTag && parseVersion(t) !== undefined)
    .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));
  return tags.at(-1);
}

function main(argv) {
  const at = argv.indexOf("--root");
  const root =
    at >= 0 && argv[at + 1] ? argv[at + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const constants = {};
  for (const { name, file } of PROTOCOL_CONSTANTS) {
    constants[name] = readConstant(readFileSync(join(root, file), "utf8"), name);
  }
  const refTag =
    process.env.GITHUB_REF_TYPE === "tag" ? (process.env.GITHUB_REF_NAME ?? undefined) : undefined;
  const input = { version: pkg.version, constants };
  if (refTag !== undefined) input.refTag = refTag;
  const tag = previousTag(root, refTag);
  if (tag !== undefined) {
    const show = (file) => git(root, ["show", `${tag}:${file}`]);
    const before = {};
    for (const { name, file } of PROTOCOL_CONSTANTS) before[name] = readConstant(show(file), name);
    const tagPkg = show("package.json");
    input.previous = {
      tag,
      version: tagPkg ? JSON.parse(tagPkg).version : tag.slice(1),
      constants: before,
    };
  }
  const result = checkRelease(input);
  for (const note of result.notes) process.stdout.write(`release-check: ${note}\n`);
  for (const error of result.errors) process.stderr.write(`release-check: ✗ ${error}\n`);
  if (!result.ok) process.exit(1);
  process.stdout.write(`release-check: ok（${pkg.version}）\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
