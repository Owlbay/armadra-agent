/**
 * SIWC 的 `ext_agent_host_id`（docs/history/wave6-plan.md D16）：每个安装稳定不变，存
 * `<dataDir>/chatgpt-host.json`（0600，按安装、不随 dotfiles 同步），形如 `urn:uuid:…`。[W6-O]
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOST_ID_FILE = "chatgpt-host.json";

export function hostIdPath(dataDir: string): string {
  return join(dataDir, HOST_ID_FILE);
}

export function readOrCreateHostId(dataDir: string): string {
  const path = hostIdPath(dataDir);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { hostId?: unknown };
    if (typeof value.hostId === "string" && /^urn:uuid:[0-9a-f-]{36}$/i.test(value.hostId))
      return value.hostId;
  } catch {
    // 不存在或损坏：重建
  }
  const hostId = `urn:uuid:${randomUUID()}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ version: 1, hostId }, null, 2)}\n`, { mode: 0o600 });
  return hostId;
}
