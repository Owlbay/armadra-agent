#!/usr/bin/env node
// 开发者本地用真 key 录 SSE 样本（设计 §1.2、§15；CI 不跑）。
//
//   node scripts/record-sse.mjs --api anthropic-messages --model claude-sonnet-4-6 \
//     --key-env ANTHROPIC_API_KEY --scenario tool --case tool-single
//   node scripts/record-sse.mjs --api openai-completions --base-url https://api.deepseek.com \
//     --model deepseek-v4-pro --key-env DEEPSEEK_API_KEY --scenario thinking --case reasoning-deepseek
//
// 场景：text / thinking / tool / tool-multi / length / overflow。429 无法稳定触发，需要时手工
// 并发打满后用 --scenario text 重录。
// 输出 test/fixtures/sse/<api>/<case>.txt（格式见该目录 README）：只记录状态码与白名单响应头，
// 不记录请求、不记录 key。录完用 UPDATE_GOLDEN=1 重新生成黄金文件并逐条审阅差异。

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    api: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    "key-env": { type: "string" },
    scenario: { type: "string", default: "text" },
    case: { type: "string" },
    "max-tokens": { type: "string" },
    "overflow-chars": { type: "string", default: "1200000" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

function usage(message) {
  if (message) console.error(`record-sse: ${message}`);
  console.error(
    "usage: record-sse.mjs --api anthropic-messages|openai-completions --model <id> --key-env <ENV> " +
      "--case <name> [--scenario text|thinking|tool|tool-multi|length|overflow] [--base-url <url>] " +
      "[--max-tokens <n>] [--out <dir>] [--dry-run]",
  );
  process.exit(message ? 2 : 0);
}

if (values.help) usage();
const api = values.api;
if (api !== "anthropic-messages" && api !== "openai-completions") usage("--api is required");
if (!values.model) usage("--model is required");
if (!values.case || !/^[a-z0-9-]+$/.test(values.case)) usage("--case must match [a-z0-9-]+");
const scenario = values.scenario;
const SCENARIOS = ["text", "thinking", "tool", "tool-multi", "length", "overflow"];
if (!SCENARIOS.includes(scenario)) usage(`--scenario must be one of ${SCENARIOS.join(", ")}`);
const apiKey = values["key-env"] ? process.env[values["key-env"]] : undefined;
if (!values["dry-run"] && !apiKey)
  usage(`environment variable ${values["key-env"] ?? "(--key-env)"} is empty`);

const anthropic = api === "anthropic-messages";
const baseUrl = (
  values["base-url"] ?? (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1")
).replace(/\/+$/, "");

const TOOLS = [
  {
    name: "read",
    description: "Read a text file from the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path" } },
      required: ["path"],
    },
  },
  {
    name: "ls",
    description: "List a directory.",
    parameters: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
  },
];

const PROMPTS = {
  text: "Say hello in one short sentence that includes the Chinese word 世界.",
  thinking: "Which is larger, 9.11 or 9.9? Think it through, then answer in one line.",
  tool: "Read the file README.md. Use the read tool; do not answer before calling it.",
  "tool-multi":
    "Read a.ts and b.ts in parallel with two read tool calls, and list the src directory.",
  length: "Write a long story about a lighthouse keeper.",
  overflow: `${"lorem ipsum ".repeat(Math.ceil(Number(values["overflow-chars"]) / 12))}\nSummarize.`,
};

const useTools = scenario === "tool" || scenario === "tool-multi";
const maxTokens = Number(values["max-tokens"] ?? (scenario === "length" ? 16 : 1024));
const prompt = PROMPTS[scenario];

function anthropicRequest() {
  const body = {
    model: values.model,
    max_tokens: scenario === "thinking" ? 4096 : maxTokens,
    stream: true,
    system: [
      { type: "text", text: "You are a terse assistant.", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: prompt }],
  };
  if (useTools) {
    body.tools = TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (scenario === "thinking") body.thinking = { type: "enabled", budget_tokens: 2048 };
  return {
    url: `${baseUrl}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey ?? "",
    },
    body,
  };
}

function openaiRequest() {
  const body = {
    model: values.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: "You are a terse assistant." },
      { role: "user", content: prompt },
    ],
  };
  if (useTools) body.tools = TOOLS.map((t) => ({ type: "function", function: t }));
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey ?? ""}` },
    body,
  };
}

const request = anthropic ? anthropicRequest() : openaiRequest();
const outDir = values.out ?? join(root, "test", "fixtures", "sse", api);
const outFile = join(outDir, `${values.case}.txt`);

if (values["dry-run"]) {
  const shown = { ...request, headers: { ...request.headers } };
  for (const key of Object.keys(shown.headers)) {
    if (/authorization|api-key/i.test(key)) shown.headers[key] = "<redacted>";
  }
  if (scenario === "overflow") shown.body = { ...shown.body, messages: "<large>" };
  console.log(JSON.stringify({ outFile, ...shown }, null, 2));
  process.exit(0);
}

const KEEP_HEADERS = ["content-type", "retry-after"];
const response = await fetch(request.url, {
  method: "POST",
  headers: request.headers,
  body: JSON.stringify(request.body),
});
const meta = [`#status ${response.status}`];
for (const name of KEEP_HEADERS) {
  const value = response.headers.get(name);
  if (value) meta.push(`#header ${name}: ${value}`);
}
const body = await response.text();
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${meta.join("\n")}\n${body}`);
console.error(`record-sse: ${response.status} → ${outFile} (${body.length} chars)`);
if (body.includes(apiKey)) {
  console.error("record-sse: WARNING response body contains the API key; file not kept");
  writeFileSync(outFile, "");
  process.exit(1);
}
