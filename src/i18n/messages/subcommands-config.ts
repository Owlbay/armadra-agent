/**
 * 消息目录：subcommands 里 `ama config show|path|edit`（`configShow`，含 doctor 共用的模型 / codemode
 * 说明）与 `ama models discover`（`discover`）。由 messages/subcommands.ts 引用。[W6-I5]
 *
 * zh 逐字节保留迁移前的原文。
 */

import { plural } from "../format.js";
import type { Messages } from "../types.js";

export const en = {
  configShow: {
    usage: `Usage: ama config show [--json] [--profile <file>] [--auth-file <file>]
                       [--tools-preset <name>] [--codemode off|on|only]
       ama config path    Config directory, data directory and file paths
       ama config edit    Open config.json in $VISUAL / $EDITOR (prints the path without an editor)
`,
    unknownAction: (action: string) => `Unknown config subcommand: ${action}`,
    /** `ama config path`：标签列宽对齐由调用方补空格。 */
    missing: "  (missing)",
    configDir: "Config directory",
    dataDir: "Data directory",
    projectLevel: "Project",
    noEditor: (path: string) =>
      `${path}\n($VISUAL / $EDITOR is not set; open the file above in an editor)\n`,
    editorFailed: (editor: string, path: string) =>
      `ama: the editor exited abnormally (${editor}); the file is at ${path}\n`,
    registryMissing: "provider registry not assembled",
    zeroConfigLocal: (provider: string, rule: string) =>
      `zero-config: local ${provider} is reachable; ${rule}`,
    zeroConfigKey: (provider: string, source: string, rule: string) =>
      `zero-config: ${provider} has a key (${source}); ${rule}`,
    providersHeading: "Providers:",
    baseUrlFromEnv: (env: string) => ` (baseUrl from environment variable ${env})`,
    layerDefault: "built-in defaults",
    layerCli: "command line",
    sandboxIsolated: (node: number) => `Node ${node} isolates the network`,
    sandboxOs: (node: number, kind: string) =>
      `Node ${node}, network isolated by the OS sandbox ${kind}`,
    sandboxNone: (node: number) => `Node ${node} < 25, network not isolated`,
    codemodeExplicit: (sandbox: string) => `codemode.mode set explicitly (${sandbox})`,
    codemodeFollowsPreset: (preset: string, sandbox: string) =>
      `follows preset ${preset} (${sandbox})`,
    presetAlias: (layer: string, label: string, preset: string, canonical: string) =>
      `${layer} (${label}) writes tools.preset with the old name ${preset}; the canonical name is ${canonical}`,
    defaultSource: (reason: string) => `default (${reason})`,
    heading:
      "Effective config (sources: default built-in ← user ← profile ← project tighten-only ← cli)",
    layerLine: (name: string, label: string) => `  ${name}: ${label}`,
    model: (ref: string | undefined, reason: string) => `Model: ${ref ?? "(none)"}  ${reason}`,
    tools: (tools: string, preset: string, codemode: string) =>
      `Tools: ${tools} (preset ${preset}, codemode ${codemode})`,
    codemode: (mode: string, reason: string) => `codemode: ${mode}  ${reason}`,
    bashSandbox: (detail: string) => `bash sandbox: ${detail}`,
    note: (text: string) => `Note: ${text}`,
    warning: (text: string) => `Warning: ${text}`,
  },
  discover: {
    limitPositive: (raw: string) => `--limit needs a positive integer: ${raw}`,
    notInUserConfig: (provider: string, path: string) =>
      `ama: ${provider} is not in the user config (${path}); nothing written\n`,
    nothingToWrite: (kept: number) =>
      `\nNo new models to write${kept > 0 ? ` (${plural(kept, "model")} already present, not overwritten)` : ""}\n`,
    written: (path: string, provider: string, added: number, kept: number, backup: boolean) =>
      `\nWrote ${path}: ${provider} +${plural(added, "model")}` +
      `${kept > 0 ? `, ${kept} already present and not overwritten` : ""}` +
      `${backup ? ` (original backed up as ${path}.bak)` : ""}\n`,
    skippedNoTools: (ids: string) => `Skipped models without tool calling (models.dev): ${ids}\n`,
    unmatchedWarning: (ids: string) =>
      `ama: warning: ${ids} not matched in models.dev, no contextWindow, auto-compaction off; ` +
      `add it in config.json or set modelsDev when needed\n`,
    listFailed: (provider: string, error: string) =>
      `ama: failed to fetch the model list of ${provider}: ${error}\n`,
    found: (provider: string, count: number, url: string) =>
      `${provider}: found ${plural(count, "model")} (${url})\n`,
    unmatched: "  models.dev: no match",
    image: " · image",
    reasoning: " · reasoning",
    noTools: " · no tool calling",
    configured: (api: string) => `  configured (${api})`,
    probeHeader: (count: number, order: string, requests: number, extra: number, limit: number) =>
      `\nProbing protocols: ${plural(count, "model")} (${order}), at most ${plural(requests, "request")}` +
      `${extra > 0 ? `; ${extra} more over --limit ${limit} are not probed` : ""}\n`,
    unavailable: "unavailable (all three protocols failed)",
    probeStopped: (reason: string) => `ama: probing stopped early (${reason})\n`,
    cached: (path: string) => `Model list cached at ${path}; /model shows these models\n`,
  },
};

export const zh = {
  configShow: {
    usage: `用法：ama config show [--json] [--profile <文件>] [--auth-file <文件>]
                        [--tools-preset <名>] [--codemode off|on|only]
      ama config path    配置目录、数据目录与各文件路径
      ama config edit    用 $VISUAL / $EDITOR 打开 config.json（没有编辑器时打印路径）
`,
    unknownAction: (action) => `未知的 config 子命令：${action}`,
    missing: "  （不存在）",
    configDir: "配置目录",
    dataDir: "数据目录",
    projectLevel: "项目级",
    noEditor: (path) => `${path}\n（没有设置 $VISUAL / $EDITOR，请用编辑器打开上面的文件）\n`,
    editorFailed: (editor, path) => `ama: 编辑器退出异常（${editor}）；文件在 ${path}\n`,
    registryMissing: "注册表未装配",
    zeroConfigLocal: (provider, rule) => `零配置：本地 ${provider} 可达；${rule}`,
    zeroConfigKey: (provider, source, rule) => `零配置：${provider} 有 key（${source}）；${rule}`,
    providersHeading: "供应商：",
    baseUrlFromEnv: (env) => `（baseUrl 来自环境变量 ${env}）`,
    layerDefault: "内置缺省",
    layerCli: "命令行",
    sandboxIsolated: (node) => `Node ${node} 网络已隔离`,
    sandboxOs: (node, kind) => `Node ${node} 网络由操作系统沙箱 ${kind} 隔离`,
    sandboxNone: (node) => `Node ${node} < 25 网络未隔离`,
    codemodeExplicit: (sandbox) => `codemode.mode 显式设置（${sandbox}）`,
    codemodeFollowsPreset: (preset, sandbox) => `跟随预设 ${preset}（${sandbox}）`,
    presetAlias: (layer, label, preset, canonical) =>
      `${layer}（${label}）的 tools.preset 写的是旧名 ${preset}，规范名 ${canonical}`,
    defaultSource: (reason) => `default（${reason}）`,
    heading: "生效配置（来源：default 内置 ← user ← profile ← project 只能收紧 ← cli）",
    layerLine: (name, label) => `  ${name}：${label}`,
    model: (ref, reason) => `模型：${ref ?? "（无）"}  ${reason}`,
    tools: (tools, preset, codemode) => `工具：${tools}（预设 ${preset}，codemode ${codemode}）`,
    codemode: (mode, reason) => `codemode：${mode}  ${reason}`,
    bashSandbox: (detail) => `bash 沙箱：${detail}`,
    note: (text) => `提示：${text}`,
    warning: (text) => `警告：${text}`,
  },
  discover: {
    limitPositive: (raw) => `--limit 需要正整数：${raw}`,
    notInUserConfig: (provider, path) => `ama: ${provider} 不在用户级配置（${path}）里，未写入\n`,
    nothingToWrite: (kept) =>
      `\n没有新模型要写入${kept > 0 ? `（${kept} 个已存在，未覆盖）` : ""}\n`,
    written: (path, provider, added, kept, backup) =>
      `\n已写入 ${path}：${provider} 新增 ${added} 个模型` +
      `${kept > 0 ? `，${kept} 个已存在未覆盖` : ""}${backup ? `（原文件备份为 ${path}.bak）` : ""}\n`,
    skippedNoTools: (ids) => `跳过不支持工具调用的模型（models.dev）：${ids}\n`,
    unmatchedWarning: (ids) =>
      `ama: 警告：${ids} 在 models.dev 未匹配，没有 contextWindow，自动压缩关闭；` +
      `需要时在 config.json 里补上或写 modelsDev\n`,
    listFailed: (provider, error) => `ama: ${provider} 模型列表获取失败：${error}\n`,
    found: (provider, count, url) => `${provider}：发现 ${count} 个模型（${url}）\n`,
    unmatched: "  models.dev 未匹配",
    image: " · 图片",
    reasoning: " · 思考",
    noTools: " · 不支持工具调用",
    configured: (api) => `  已配置（${api}）`,
    probeHeader: (count, order, requests, extra, limit) =>
      `\n探测协议：${count} 个模型（${order}），最多 ${requests} 次请求` +
      `${extra > 0 ? `；另有 ${extra} 个超出 --limit ${limit}，未探测` : ""}\n`,
    unavailable: "不可用（三种协议均失败）",
    probeStopped: (reason) => `ama: 探测提前停止（${reason}）\n`,
    cached: (path) => `模型列表已缓存到 ${path}，/model 里会列出这些模型\n`,
  },
} satisfies Messages<typeof en>;
