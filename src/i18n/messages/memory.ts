/**
 * 消息目录：memory（键名规范见 docs/guides/i18n.md）。[W6-M]
 *
 * en 是形状源；zh 用 `satisfies Messages<typeof en>`，缺键 / 多键 / 参数不符在 tsc 期报错。
 * 整句一个键、禁止片段拼接；插值写成函数，条件分支写进函数体。
 * 只给人看（`/memory`、`ama memory`、启动提示）；工具结果与系统节固定英文（memory/tool.ts、section.ts）。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  scope: { user: "user", project: "project", workspace: "workspace" },
  panel: {
    title: "Memory",
    off: "off",
    on: "on",
    disabled: "Memory is off. Turn it on with `ama memory enable`, or `--memory` for one run.",
    noEntries: "(no entries)",
    scopeLine: (scope: string, count: number, index: string, limit: string) =>
      `${scope} · ${plural(count, "entry", "entries")} · index ${index} / ${limit}`,
    entryUpdated: (date: string) => `updated ${date}`,
    stale: "older than 90 days; verify before relying on it",
    truncated: (omitted: number) =>
      `index over the limit: ${plural(omitted, "entry", "entries")} left out of the system prompt`,
    untrusted: "Project memory not loaded: this project is not trusted (start with --trust).",
    writesOff: "Writes are off for this session (/memory on to allow).",
    hint: "/memory show|edit|rm <name> · on|off · reload",
  },
  command: {
    usage: "Usage: /memory [show|edit|rm <name> | edit <scope> | on|off | reload]",
    notFound: (name: string) => `No memory entry named ${name}`,
    ambiguous: (name: string, matches: string) =>
      `${name} matches several entries: ${matches}. Use scope/file to pick one.`,
    deleted: (path: string) => `Deleted ${path}; it leaves the index from the next session.`,
    saved: (path: string) => `Saved ${path}; it appears in the index from the next session.`,
    unchanged: "No changes.",
    editCancelled: "The editor exited without saving; nothing changed.",
    writesOn: "Memory writes allowed for this session (each write still asks for approval).",
    writesOff: "Memory writes turned off for this session.",
    reloaded:
      "Memory index reloaded. The next request updates the memory section, which breaks the prompt cache once.",
    reloadUnchanged: "Memory index unchanged.",
    confirmTitle: "Delete memory entry?",
    confirmDelete: "Delete",
    confirmCancel: "Cancel",
    lineNoEditor: "The line interface cannot open an editor; use `ama memory edit`.",
    lineNeedsYes: (name: string) => `To delete, add --yes: /memory rm ${name} --yes`,
    newEntryName: (scope: string) => `new-${scope}-note`,
  },
  error: {
    credential: (kind: string) => `Looks like a credential (${kind}); not saved.`,
    tooLarge: (bytes: number, limit: number) =>
      `Entry is ${bytes} bytes; the limit is ${limit}. Keep entries short.`,
    tooMany: (limit: number) => `This scope already has ${limit} entries; delete one first.`,
    locked: "Memory is locked by another ama process; try again.",
    other: (message: string) => `Memory: ${message}`,
  },
  cli: {
    usage: `Usage: ama memory list [--scope user|project|all] [--json]
       ama memory show <name>
       ama memory edit [<name> | --scope user|project]
       ama memory rm <name> [--yes]
       ama memory path [--scope user|project|all]
       ama memory enable | disable
`,
    unknownScope: (scope: string) => `Unknown scope ${scope} (user | project | all)`,
    needName: (sub: string) => `ama memory ${sub} needs a name`,
    confirmRemove: (path: string) => `Delete ${path}? `,
    needsYes: "Not a terminal: add --yes to delete.",
    enabled: (file: string) => `Memory enabled in ${file}; it applies from the next session.`,
    disabled: (file: string) => `Memory disabled in ${file}.`,
    disabledNote: "(memory.enabled is false; entries are kept but not used)",
    untrusted: (cwd: string) =>
      `Project scope skipped: ${cwd} is not trusted (run ama --trust there once).`,
  },
};

export const zh = {
  scope: { user: "用户", project: "项目", workspace: "工作空间" },
  panel: {
    title: "记忆",
    off: "未开启",
    on: "已开启",
    disabled: "记忆未开启：`ama memory enable` 打开，或本次加 `--memory`。",
    noEntries: "（无条目）",
    scopeLine: (scope, count, index, limit) => `${scope} · ${count} 条 · 索引 ${index} / ${limit}`,
    entryUpdated: (date) => `更新于 ${date}`,
    stale: "超过 90 天未更新，使用前请核实",
    truncated: (omitted) => `索引超出上限：${omitted} 条没有进系统提示`,
    untrusted: "项目记忆未加载：项目未受信任（启动时加 --trust）。",
    writesOff: "本会话禁止写入记忆（/memory on 恢复）。",
    hint: "/memory show|edit|rm <名字> · on|off · reload",
  },
  command: {
    usage: "用法：/memory [show|edit|rm <名字> | edit <作用域> | on|off | reload]",
    notFound: (name) => `没有名为 ${name} 的记忆`,
    ambiguous: (name, matches) => `${name} 匹配多条：${matches}；用 作用域/文件 指定。`,
    deleted: (path) => `已删除 ${path}，下次会话起不再出现在索引。`,
    saved: (path) => `已保存 ${path}，下次会话起出现在索引。`,
    unchanged: "没有改动。",
    editCancelled: "编辑器未保存退出，没有改动。",
    writesOn: "本会话允许写入记忆（每次写入仍需审批）。",
    writesOff: "本会话禁止写入记忆。",
    reloaded: "已重读记忆索引：下次请求更新 memory 节，缓存前缀会断一次。",
    reloadUnchanged: "记忆索引没有变化。",
    confirmTitle: "删除这条记忆？",
    confirmDelete: "删除",
    confirmCancel: "取消",
    lineNoEditor: "行式界面不能打开编辑器：用 `ama memory edit`。",
    lineNeedsYes: (name) => `确认删除请加 --yes：/memory rm ${name} --yes`,
    newEntryName: (scope) => `new-${scope}-note`,
  },
  error: {
    credential: (kind) => `看起来像凭据（${kind}），未保存。`,
    tooLarge: (bytes, limit) => `条目 ${bytes} 字节，超过上限 ${limit}；请写短一些。`,
    tooMany: (limit) => `该作用域已有 ${limit} 条，先删掉一条。`,
    locked: "记忆正被另一个 ama 进程写入，请稍后再试。",
    other: (message) => `记忆：${message}`,
  },
  cli: {
    usage: `用法：ama memory list [--scope user|project|all] [--json]
      ama memory show <名字>
      ama memory edit [<名字> | --scope user|project]
      ama memory rm <名字> [--yes]
      ama memory path [--scope user|project|all]
      ama memory enable | disable
`,
    unknownScope: (scope) => `未知作用域 ${scope}（user | project | all）`,
    needName: (sub) => `ama memory ${sub} 需要名字`,
    confirmRemove: (path) => `删除 ${path}？`,
    needsYes: "不是终端：删除需加 --yes。",
    enabled: (file) => `已在 ${file} 开启记忆，下次会话起生效。`,
    disabled: (file) => `已在 ${file} 关闭记忆。`,
    disabledNote: "（memory.enabled 为 false：条目保留但不使用）",
    untrusted: (cwd) => `跳过项目作用域：${cwd} 未受信任（在该目录运行一次 ama --trust）。`,
  },
} satisfies Messages<typeof en>;
