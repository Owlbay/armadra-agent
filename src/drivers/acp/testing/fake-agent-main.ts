/**
 * 假 ACP Agent 的进程入口：`node dist/drivers/acp/testing/fake-agent-main.js [--minimal]`。[W5-E]
 * 行为见 fake-agent.ts；stdin 结束即退出。
 */

import { runFakeAcpAgent } from "./fake-agent.js";

const minimal = process.argv.includes("--minimal");
void runFakeAcpAgent(process.stdin, process.stdout, { minimal }).then(() => process.exit(0));
