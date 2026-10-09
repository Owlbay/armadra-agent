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
 * 4. 双语文档（第六波 §5.5、D21，`checkDocs()`）：`README.md`（英文）/ `README.zh-CN.md`、`CHANGELOG.md`（英文，
 *    从 0.6.0 起）/ `CHANGELOG.zh-CN.md`（中文，含 0.1–0.5.1 全部历史）、`docs/en/` 七篇都在，且列进
 *    `package.json files`；README 与 CHANGELOG 两份顶部互链；`CHANGELOG.zh-CN.md` 有当前版本段，版本 ≥ 0.6.0
 *    时 `CHANGELOG.md` 也要有（段标题 `## 0.6.0（…）` / `## 0.6.0 (…)`，「未发布 / Unreleased」不算）。
 * 5. 英文文档滞后提示（§5.5，只提示不失败，`staleTranslations()`）：`docs/en/<篇>.md` 头部记着翻译时的中文版
 *    提交（`as of commit \`abc1234\``）；中文版此后又改了超过 `STALE_COMMITS` 次时提示同步。浅克隆看不到
 *    基准提交时跳过。
 * 6. 全局命令（内存设计 D7，`checkBin()`）：`bin.ama` 指向单文件 bundle `dist/bundle/*.cjs`，且与
 *    `exports["./bundle"]` 相同；文件已构建时首行必须是 `#!/usr/bin/env node`（`pnpm run ci` 里本检查在
 *    构建之前，未构建只提示）。
 *
 * 纯函数 `checkRelease()` 导出给测试；CLI 部分只负责读 git 与文件（`--root <dir>` 换仓库根，
 * 测试用）。CI 的 checkout 需要
 * `fetch-depth: 0` 才看得到 tag。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** `docs/en/` 首批英文文档（D21）。 */
export const EN_DOCS = ["tui", "permissions", "providers", "rpc", "host-api", "sessions", "acp"];

/** 发布必须带的双语文档。 */
export const DOC_FILES = [
  "README.md",
  "README.zh-CN.md",
  "CHANGELOG.md",
  "CHANGELOG.zh-CN.md",
  ...EN_DOCS.map((name) => `docs/en/${name}.md`),
];

/** npm 不会自动打包、需要列进 `package.json files` 的（README.md 由 npm 自动带上）。 */
export const PACKED_DOC_FILES = DOC_FILES.filter((file) => file !== "README.md");

/** 英文 CHANGELOG 从这个版本起。 */
export const ENGLISH_CHANGELOG_SINCE = "0.6.0";

/** 顶部互链：文件 → 必须出现的链接目标。 */
const CROSS_LINKS = {
  "README.md": "README.zh-CN.md",
  "README.zh-CN.md": "README.md",
  "CHANGELOG.md": "CHANGELOG.zh-CN.md",
  "CHANGELOG.zh-CN.md": "CHANGELOG.md",
};

/** CHANGELOG 里有没有该版本的段（`## 0.6.0（2026-…）`、`## 0.6.0 (…)`、`## v0.6.0`）。 */
export function hasVersionSection(text, version) {
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+v?${escaped}(?=\\s*(?:$|[(（]))`, "m").test(text ?? "");
}

/** `package.json files` 的一项是否覆盖该路径（原样、目录前缀或 `*` 通配）。 */
export function filesEntryCovers(entry, path) {
  const clean = String(entry).replace(/^\.\//, "").replace(/\/$/, "");
  if (clean === path || path.startsWith(`${clean}/`)) return true;
  if (!clean.includes("*")) return false;
  const re = clean
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${re}$`).test(path);
}

/**
 * 双语文档检查。
 * @param {{ version: string, docs: Record<string, string | undefined>, packageFiles: string[] }} input
 *   `docs`：DOC_FILES 每个路径的内容（不存在为 undefined）。
 * @returns {{ errors: string[], notes: string[] }}
 */
export function checkDocs(input) {
  const errors = [];
  const notes = [];
  for (const file of DOC_FILES) {
    if (input.docs[file] === undefined) errors.push(`缺少 ${file}`);
  }
  for (const file of PACKED_DOC_FILES) {
    if (!input.packageFiles.some((entry) => filesEntryCovers(entry, file)))
      errors.push(`package.json files 没有包含 ${file}`);
  }
  for (const [file, target] of Object.entries(CROSS_LINKS)) {
    const text = input.docs[file];
    if (text === undefined) continue;
    const top = text.split("\n").slice(0, 10).join("\n");
    if (!top.includes(`](${target})`)) errors.push(`${file} 顶部缺少到 ${target} 的链接`);
  }
  const current = parseVersion(input.version);
  if (current !== undefined) {
    const zh = input.docs["CHANGELOG.zh-CN.md"];
    if (zh !== undefined && !hasVersionSection(zh, input.version))
      errors.push(`CHANGELOG.zh-CN.md 没有 ${input.version} 的段`);
    const since = parseVersion(ENGLISH_CHANGELOG_SINCE);
    const en = input.docs["CHANGELOG.md"];
    if (compareVersions(current, since) >= 0) {
      if (en !== undefined && !hasVersionSection(en, input.version))
        errors.push(`CHANGELOG.md 没有 ${input.version} 的段`);
    } else
      notes.push(`CHANGELOG.md 从 ${ENGLISH_CHANGELOG_SINCE} 起记录，${input.version} 只查中文`);
  }
  return { errors, notes };
}

/** `bin.ama` 必须是的首行。 */
export const BIN_SHEBANG = "#!/usr/bin/env node";

const stripDot = (path) => String(path).replace(/^\.\//, "");

/**
 * 全局命令检查（D7）。
 * @param {{ bin: unknown, exportsBundle: unknown, head?: string }} input
 *   `bin`：package.json 的 `bin`；`exportsBundle`：`exports["./bundle"]`；`head`：bin 文件首行（未构建为 undefined）。
 * @returns {{ errors: string[], notes: string[] }}
 */
export function checkBin(input) {
  const errors = [];
  const notes = [];
  const target = input.bin !== null && typeof input.bin === "object" ? input.bin.ama : undefined;
  if (typeof target !== "string") {
    errors.push("package.json bin.ama 缺失");
    return { errors, notes };
  }
  if (!/^dist\/bundle\/[^/]+\.cjs$/.test(stripDot(target)))
    errors.push(`bin.ama（${target}）不是单文件 bundle dist/bundle/*.cjs`);
  if (typeof input.exportsBundle !== "string" || stripDot(input.exportsBundle) !== stripDot(target))
    errors.push(`bin.ama（${target}）与 exports["./bundle"]（${input.exportsBundle}）不一致`);
  if (input.head === undefined) notes.push(`${stripDot(target)} 尚未构建，跳过 shebang 检查`);
  else if (input.head.replace(/\r$/, "") !== BIN_SHEBANG)
    errors.push(`${stripDot(target)} 首行不是 ${BIN_SHEBANG}`);
  return { errors, notes };
}

/** 中文版在英文版基准之后改了超过这么多次就提示（不失败）。 */
export const STALE_COMMITS = 5;

/** 英文文档头部记的中文版基准提交。 */
export function translationBasis(text) {
  return /as of commit `([0-9a-f]{7,40})`/.exec(text ?? "")?.[1];
}

/**
 * 英文文档滞后提示。
 * @param {{ name: string, basis: string | undefined, commits: number | undefined }[]} docs
 *   `commits`：中文版在 `basis` 之后的提交数（看不到基准时 undefined，跳过）。
 * @returns {string[]} 提示
 */
export function staleTranslations(docs, threshold = STALE_COMMITS) {
  const notes = [];
  for (const { name, basis, commits } of docs) {
    if (basis === undefined || commits === undefined || commits <= threshold) continue;
    notes.push(
      `docs/${name}.md 在 docs/en/${name}.md 的基准 ${basis} 之后改了 ${commits} 次（> ${threshold}），英文版可能需要同步`,
    );
  }
  return notes;
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
  const docs = {};
  for (const file of DOC_FILES) {
    const path = join(root, file);
    docs[file] = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }
  const docResult = checkDocs({
    version: pkg.version,
    docs,
    packageFiles: Array.isArray(pkg.files) ? pkg.files : [],
  });
  result.errors.push(...docResult.errors);
  result.notes.push(...docResult.notes);
  const binTarget = typeof pkg.bin === "object" && pkg.bin !== null ? pkg.bin.ama : undefined;
  const binPath = typeof binTarget === "string" ? join(root, binTarget) : undefined;
  const binResult = checkBin({
    bin: pkg.bin,
    exportsBundle: pkg.exports?.["./bundle"],
    ...(binPath !== undefined && existsSync(binPath)
      ? { head: readFileSync(binPath, "utf8").slice(0, 200).split("\n")[0] }
      : {}),
  });
  result.errors.push(...binResult.errors);
  result.notes.push(...binResult.notes);
  const translations = EN_DOCS.map((name) => {
    const basis = translationBasis(docs[`docs/en/${name}.md`]);
    const count =
      basis === undefined
        ? undefined
        : git(root, ["rev-list", "--count", `${basis}..HEAD`, "--", `docs/${name}.md`]);
    const commits = count === undefined ? undefined : Number(count.trim());
    return { name, basis, commits: Number.isInteger(commits) ? commits : undefined };
  });
  result.notes.push(...staleTranslations(translations));
  result.ok = result.errors.length === 0;
  for (const note of result.notes) process.stdout.write(`release-check: ${note}\n`);
  for (const error of result.errors) process.stderr.write(`release-check: ✗ ${error}\n`);
  if (!result.ok) process.exit(1);
  process.stdout.write(`release-check: ok（${pkg.version}）\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
