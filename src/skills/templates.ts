/**
 * 提示模板 `prompts/<cmd>.md`（设计 §5.3）。[B3]
 *
 * - 发现：profile `promptDirs` → `<configDir>/prompts/` → `<cwd>/.ama/prompts/`（需信任）；只取目录
 *   的直接 `*.md` 子文件，文件名即命令名；重名保留先发现者并 warning。frontmatter 可给
 *   `description`（缺省取正文首个非空行）与 `argument-hint`。
 * - 参数按 shell 规则切分（空白分隔，单 / 双引号，反斜杠转义）。
 * - 占位：`$1…$N`、`$@` / `$ARGUMENTS`（全部参数）、`${N}`、`${N:-默认}`、`${@:-默认}`、`${@:N}`、
 *   `${@:N:L}`；`\$` 为字面 `$`。模板里没有任何占位而用户给了参数时，参数接在正文后（空一行）。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export interface PromptTemplate {
  name: string;
  path: string;
  description: string;
  argumentHint?: string;
  scope: PromptScope;
}

export type PromptScope = "cli" | "profile" | "user" | "project";

export interface PromptSource {
  dir: string;
  scope: PromptScope;
  requiresTrust: boolean;
}

export const TEMPLATE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export function promptSources(options: {
  cwd: string;
  configDir: string;
  cliDirs?: readonly string[];
  profileDirs?: readonly string[];
}): PromptSource[] {
  const out: PromptSource[] = [];
  for (const d of options.cliDirs ?? [])
    out.push({ dir: resolve(options.cwd, d), scope: "cli", requiresTrust: false });
  for (const d of options.profileDirs ?? []) {
    out.push({ dir: resolve(options.cwd, d), scope: "profile", requiresTrust: false });
  }
  out.push({ dir: join(options.configDir, "prompts"), scope: "user", requiresTrust: false });
  out.push({ dir: join(options.cwd, ".ama", "prompts"), scope: "project", requiresTrust: true });
  return out;
}

export async function discoverPromptTemplates(
  sources: readonly PromptSource[],
  options: { trusted: boolean },
): Promise<{ templates: PromptTemplate[]; warnings: string[]; skippedUntrusted: string[] }> {
  const templates: PromptTemplate[] = [];
  const warnings: string[] = [];
  const skippedUntrusted: string[] = [];
  const seen = new Map<string, PromptTemplate>();
  for (const source of sources) {
    let names: string[];
    try {
      if (!(await stat(source.dir)).isDirectory()) continue;
      names = await readdir(source.dir);
    } catch {
      continue;
    }
    if (source.requiresTrust && !options.trusted) {
      skippedUntrusted.push(source.dir);
      continue;
    }
    for (const file of names.filter((n) => n.endsWith(".md")).sort()) {
      const name = file.slice(0, -3);
      const path = join(source.dir, file);
      if (!TEMPLATE_NAME_RE.test(name)) {
        warnings.push(`${path}: invalid command name "${name}"`);
        continue;
      }
      const existing = seen.get(name);
      if (existing) {
        warnings.push(`${path}: prompt "/${name}" already defined at ${existing.path}; ignored`);
        continue;
      }
      let text: string;
      try {
        if (!(await stat(path)).isFile()) continue;
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      const desc = fm.data["description"];
      const firstLine =
        fm.body
          .split("\n")
          .find((l) => l.trim() !== "")
          ?.trim() ?? "";
      const template: PromptTemplate = {
        name,
        path,
        description: typeof desc === "string" && desc !== "" ? desc : firstLine.slice(0, 80),
        scope: source.scope,
      };
      const hint = fm.data["argument-hint"];
      if (typeof hint === "string" && hint !== "") template.argumentHint = hint;
      seen.set(name, template);
      templates.push(template);
    }
  }
  return { templates, warnings, skippedUntrusted };
}

/** shell 风格切分。 */
export function parseCommandArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let has = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) current += text[++i];
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      current += text[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current !== "") args.push(current);
      current = "";
      has = false;
    } else {
      current += ch;
    }
  }
  if (has || current !== "") args.push(current);
  return args;
}

const PLACEHOLDER = /\\\$|\$\{(@|\d+)(?::-([^}]*)|:(\d+)(?::(\d+))?)?\}|\$(ARGUMENTS|@|\d+)/g;

export function hasPlaceholders(body: string): boolean {
  return [...body.matchAll(PLACEHOLDER)].some((m) => m[0] !== "\\$");
}

export function expandTemplate(body: string, args: readonly string[]): string {
  const all = args.join(" ");
  const expanded = body.replace(
    PLACEHOLDER,
    (whole, braced?: string, def?: string, start?: string, len?: string, bare?: string) => {
      if (whole === "\\$") return "$";
      const key = braced ?? bare;
      if (key === "@" || key === "ARGUMENTS") {
        if (start !== undefined) {
          const from = Math.max(0, Number(start) - 1);
          const slice = len !== undefined ? args.slice(from, from + Number(len)) : args.slice(from);
          return slice.join(" ");
        }
        if (def !== undefined) return args.length > 0 ? all : def;
        return all;
      }
      const value = args[Number(key) - 1];
      if (def !== undefined) return value === undefined || value === "" ? def : value;
      return value ?? "";
    },
  );
  if (!hasPlaceholders(body) && args.length > 0) return `${expanded.replace(/\s+$/, "")}\n\n${all}`;
  return expanded;
}

export interface PromptCommand {
  name: string;
  args: string[];
  rawArgs: string;
}

export function parsePromptCommand(text: string): PromptCommand | undefined {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const rawArgs = (m[2] ?? "").trim();
  return { name: m[1] as string, args: parseCommandArgs(rawArgs), rawArgs };
}

/** `/name args` 命中模板则返回展开文本；否则 undefined（交给斜杠命令表）。 */
export async function expandPromptCommand(
  text: string,
  templates: readonly PromptTemplate[],
  read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<{ text: string; template: PromptTemplate } | undefined> {
  const cmd = parsePromptCommand(text);
  if (!cmd) return undefined;
  const template = templates.find((t) => t.name === cmd.name);
  if (!template) return undefined;
  const body = parseFrontmatter(await read(template.path)).body.replace(/^\n+/, "");
  return { text: expandTemplate(body, cmd.args), template };
}
