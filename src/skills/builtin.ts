/**
 * 内置 Skill（替代把 ama 自身文档塞进系统提示）。
 *
 * 系统提示里只常驻索引的一条（名字 + 一句描述，约 60 token），正文按需读取。单文件 bundle 没有
 * docs 目录，所以正文是内联的配置速查（≤ 3 KB），会话发现时写到 `<dataDir>/builtin/<名>.md`（路径短，进前缀）
 * （内容不变不重写），模型用 read 读、用户用 `/skill:ama-docs` 调用都走现成路径。
 *
 * - 排在全部用户 / 项目 Skill 之后：同名时用户的优先，内置的静默让位（不报重名 warning）。
 * - 路径只取决于数据目录，会话开始时确定、会话内不变，不影响前缀稳定（设计 §9.1）。
 * - 写盘失败只记 warning 并跳过该内置 Skill。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Skill } from "./discover.js";

export const BUILTIN_SKILLS_DIR = "builtin";

export interface BuiltinSkill {
  name: string;
  description: string;
  body: string;
}

const AMA_DOCS_BODY = `# ama quick reference

ama is the coding agent running this session. Docs: https://github.com/Owlbay/armadra-agent (README.md, docs/).

## Files
- User config dir \`~/.config/ama/\` (\`AMA_CONFIG_DIR\`; Windows \`%APPDATA%\\ama\`): \`config.json\`, \`auth.json\` (keys, 0600), \`hooks.json\`, \`keybindings.json\`, \`trust.json\`, \`AGENTS.md\`, \`skills/\`, \`prompts/\`.
- Data dir \`~/.local/share/ama/\` (\`AMA_DATA_DIR\`): \`sessions/\` (JSONL), \`models-dev.json\`.
- Project: \`AGENTS.md\` (found upward from cwd), \`.ama/config.json\` (can only tighten), \`.ama/hooks.json\`, \`.ama/skills/\`, \`.ama/prompts/\` (need trust).
- Merge order: defaults < user < profile < project. \`ama config show\` prints effective values and sources; \`ama config path\`, \`ama config edit\`, \`ama doctor\`.

## config.json (common keys)
\`\`\`json
{ "version": 1, "defaultModel": "provider/model-id", "thinkingLevel": "medium",
  "permission": { "mode": "default", "allow": ["bash(git status*)"], "deny": ["write(**/.env*)"] },
  "tools": { "preset": "default", "default": ["+task", "-glob"] }, "providers": {} }
\`\`\`
Other sections have defaults: compaction, retry, codemode, hooks, ui, skills, cache, request.

## Providers and models
- Zero config: set a standard key env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, ...). \`OPENAI_BASE_URL\` / \`ANTHROPIC_BASE_URL\` are honored.
- Store a key: \`ama auth set <provider>\` (reads stdin), \`ama auth list\`, \`ama auth remove <provider>\`. Never put keys in config; use \`"apiKey": "$ENV_VAR"\` or \`"!command"\`.
- Relay / custom endpoint: \`ama providers add <name> --base-url <url> --key-env VAR --probe\`; models may set \`"api"\`: openai-completions | openai-responses | anthropic-messages | google-generative-ai.
- \`ama models list\`, \`ama models discover <provider>\`, \`ama models check provider/model\`. Model refs are \`provider/model[@channel]\`; switch with \`--model\` or \`/model\`.

## Permissions
Modes (\`--permission-mode\`, \`permission.mode\`, \`/permission\`, Shift+Tab): plan, default (ask for writes and commands), auto-edit, auto, full-auto, allowlist. Rules like \`bash(git push*)\`, \`write(src/**)\`; \`--allow\` / \`--deny\`. Dangerous commands always ask. Unattended runs (-p, RPC) treat "ask" as deny.

## Tools
Presets (\`--tools-preset\`, \`tools.preset\`): default, minimal, codemode-only, coordinator. \`/tools\` toggles tools; \`--codemode off|on|only\`.

## Sessions and rewind
- \`-c\` continues the latest session here, \`-r [id]\` resumes; \`/resume\`, \`/new\`, \`/fork\`, \`/tree\`, \`/compact\`.
- \`/rewind\` (or Esc Esc when idle) returns to before a user message: both, conversation only, or code only (edit/write checkpoints).
- \`ama sessions search|show|export\`, \`ama stats\`.

## Skills and hooks
Skills: \`<dir>/<name>/SKILL.md\` with \`name\` and \`description\` frontmatter in \`~/.config/ama/skills/\` or \`.ama/skills/\`; invoke with \`/skill:<name>\`. Hooks: \`hooks.json\` runs commands on PreToolUse, PostToolUse, UserPromptSubmit, Stop and more.
`;

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = Object.freeze([
  {
    name: "ama-docs",
    description: "How to configure and use ama itself.",
    body: AMA_DOCS_BODY,
  },
]);

export function builtinSkillPath(dataDir: string, name: string): string {
  return join(dataDir, BUILTIN_SKILLS_DIR, `${name}.md`);
}

/** 是否内置 Skill（启动头的「已加载」只数用户 / 项目的）。 */
export function isBuiltinSkill(skill: { name: string; location: string }): boolean {
  return (
    BUILTIN_SKILLS.some((b) => b.name === skill.name) &&
    skill.location.endsWith(join(BUILTIN_SKILLS_DIR, `${skill.name}.md`))
  );
}

export function builtinSkillText(skill: BuiltinSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
}

async function ensureFile(path: string, text: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === text) return;
  } catch {
    // 不存在：下面写
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

/** 在已发现的 Skill 之后追加内置 Skill（同名让位给已有的）；返回新数组与 warning。 */
export async function withBuiltinSkills(
  skills: readonly Skill[],
  dataDir: string,
  builtins: readonly BuiltinSkill[] = BUILTIN_SKILLS,
): Promise<{ skills: Skill[]; warnings: string[] }> {
  const out = [...skills];
  const warnings: string[] = [];
  const taken = new Set(skills.map((skill) => skill.name));
  for (const builtin of builtins) {
    if (taken.has(builtin.name)) continue;
    const baseDir = join(dataDir, BUILTIN_SKILLS_DIR);
    const location = builtinSkillPath(dataDir, builtin.name);
    try {
      await ensureFile(location, builtinSkillText(builtin));
    } catch (error) {
      // 与 skills/ 其它加载告警一样固定英文（模型侧模块不 import i18n，见 docs/guides/i18n.md）
      warnings.push(
        `built-in skill ${builtin.name} could not be written: ${(error as Error).message}`,
      );
      continue;
    }
    out.push({
      name: builtin.name,
      description: builtin.description,
      location,
      baseDir,
      disableModelInvocation: false,
      scope: "builtin",
    });
  }
  return { skills: out, warnings };
}
