/**
 * 假 ACP Agent 的进程入口：`node dist/drivers/acp/testing/fake-agent-main.js [--minimal] [--config-options] [--config-only] [--auth-required]`。[W5-E]
 * 行为见 fake-agent.ts；stdin 结束即退出。
 */

import { runFakeAcpAgent } from "./fake-agent.js";

const minimal = process.argv.includes("--minimal");
const configOptions = process.argv.includes("--config-options");
const configOnly = process.argv.includes("--config-only");
const authRequired = process.argv.includes("--auth-required");
void runFakeAcpAgent(process.stdin, process.stdout, {
  minimal,
  configOptions,
  configOnly,
  authRequired,
}).then(() => process.exit(0));
