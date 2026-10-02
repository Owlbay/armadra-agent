#!/usr/bin/env node
// 从 `codex app-server generate-json-schema --out <dir>` 的产物里抽出驱动依赖的形状，写成 shapes.json。
// 用法：node extract.mjs <schema-dir> [out.json]（缺省写到本目录 shapes.json）。不联网、不涉及账户。
// 只锁 Codex 驱动用到的方法与字段（docs/wave5-plan.md §5.2：12 个方法 + 5 类审批请求）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, outArg] = process.argv.slice(2);
if (!dir) {
  console.error("usage: node extract.mjs <schema-dir> [out.json]");
  process.exit(2);
}
const out = outArg ?? join(dirname(fileURLToPath(import.meta.url)), "shapes.json");
const load = (rel) => JSON.parse(readFileSync(join(dir, rel), "utf8"));

const OBJECTS = {
  InitializeParams: "v1/InitializeParams.json",
  ThreadStartParams: "v2/ThreadStartParams.json",
  ThreadResumeParams: "v2/ThreadResumeParams.json",
  TurnStartParams: "v2/TurnStartParams.json",
  TurnSteerParams: "v2/TurnSteerParams.json",
  TurnInterruptParams: "v2/TurnInterruptParams.json",
  AgentMessageDeltaNotification: "v2/AgentMessageDeltaNotification.json",
  ItemStartedNotification: "v2/ItemStartedNotification.json",
  ItemCompletedNotification: "v2/ItemCompletedNotification.json",
  TurnCompletedNotification: "v2/TurnCompletedNotification.json",
  TurnPlanUpdatedNotification: "v2/TurnPlanUpdatedNotification.json",
  ThreadTokenUsageUpdatedNotification: "v2/ThreadTokenUsageUpdatedNotification.json",
  ErrorNotification: "v2/ErrorNotification.json",
  CommandExecutionRequestApprovalParams: "CommandExecutionRequestApprovalParams.json",
  CommandExecutionRequestApprovalResponse: "CommandExecutionRequestApprovalResponse.json",
  FileChangeRequestApprovalParams: "FileChangeRequestApprovalParams.json",
  FileChangeRequestApprovalResponse: "FileChangeRequestApprovalResponse.json",
  PermissionsRequestApprovalParams: "PermissionsRequestApprovalParams.json",
  PermissionsRequestApprovalResponse: "PermissionsRequestApprovalResponse.json",
  ToolRequestUserInputParams: "ToolRequestUserInputParams.json",
  McpServerElicitationRequestResponse: "McpServerElicitationRequestResponse.json",
};

// 定义名 → 在哪个文件里找
const DEFINITIONS = {
  AskForApproval: "v2/ThreadStartParams.json",
  SandboxMode: "v2/ThreadStartParams.json",
  CommandExecutionApprovalDecision: "CommandExecutionRequestApprovalResponse.json",
  FileChangeApprovalDecision: "FileChangeRequestApprovalResponse.json",
  PermissionGrantScope: "PermissionsRequestApprovalResponse.json",
  McpServerElicitationAction: "McpServerElicitationRequestResponse.json",
  TurnStatus: "v2/TurnCompletedNotification.json",
  TokenUsageBreakdown: "v2/ThreadTokenUsageUpdatedNotification.json",
  ThreadTokenUsage: "v2/ThreadTokenUsageUpdatedNotification.json",
  Turn: "v2/TurnCompletedNotification.json",
  TurnPlanStep: "v2/TurnPlanUpdatedNotification.json",
};

const METHODS = {
  client: [
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/fork",
    "thread/read",
    "thread/list",
    "turn/start",
    "turn/steer",
    "turn/interrupt",
    "model/list",
    "account/rateLimits/read",
  ],
  server: [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
  ],
  notification: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "item/started",
    "item/completed",
    "turn/started",
    "turn/completed",
    "turn/plan/updated",
    "thread/tokenUsage/updated",
    "error",
  ],
};

function shape(node) {
  return {
    properties: Object.keys(node.properties ?? {}).sort(),
    required: [...(node.required ?? [])].sort(),
  };
}

function enums(node) {
  const values = new Set();
  const walk = (n) => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n.enum)) for (const v of n.enum) if (typeof v === "string") values.add(v);
    for (const key of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(n[key])) n[key].forEach(walk);
    if (n.type === "object" && n.properties && !n.enum && n.required?.length === 1)
      values.add(`{${n.required[0]}}`);
  };
  walk(node);
  return [...values].sort();
}

function methods(file) {
  const schema = load(file);
  const found = new Set();
  JSON.stringify(schema, (k, v) => {
    if (k === "method" && v && Array.isArray(v.enum)) v.enum.forEach((m) => found.add(m));
    return v;
  });
  return found;
}

function threadItemTypes() {
  const def = load("v2/ItemStartedNotification.json").definitions.ThreadItem;
  return (def.oneOf ?? def.anyOf ?? [])
    .map((v) => v.properties?.type?.enum?.[0])
    .filter(Boolean)
    .sort();
}

const result = {
  // 生成来源（CODEX_VERSION 环境变量，缺省 unknown）；比对时忽略
  source: `codex ${process.env.CODEX_VERSION ?? "unknown"} app-server generate-json-schema`,
  objects: {},
  definitions: {},
  methods: {},
  threadItemTypes: threadItemTypes(),
};
for (const [name, file] of Object.entries(OBJECTS)) result.objects[name] = shape(load(file));
for (const [name, file] of Object.entries(DEFINITIONS)) {
  const node = load(file).definitions?.[name];
  if (node === undefined) throw new Error(`definition ${name} missing in ${file}`);
  result.definitions[name] = node.properties ? shape(node) : { enum: enums(node) };
}
const known = {
  client: methods("ClientRequest.json"),
  server: methods("ServerRequest.json"),
  notification: methods("ServerNotification.json"),
};
for (const [side, list] of Object.entries(METHODS))
  result.methods[side] = list.map((m) => ({ method: m, present: known[side].has(m) }));
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${out}`);
