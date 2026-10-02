/**
 * `@armadra/agent/acp` 子路径（docs/wave5-plan.md §5.1，D14）。[W5-C0]
 *
 * 先导出驱动契约（ACP 词汇）与 NDJSON 分帧，供 Armadra 复用；ACP 类型（`drivers/acp/types.ts`）、
 * `AcpClient` 与假 Agent 路径由 W5-E 在这里追加导出。
 */

export type * from "./drivers/types.js";
export {
  WRITE_CHUNK_BYTES,
  createLineReader,
  writeChunked,
  type LineReader,
} from "./modes/rpc/jsonl.js";
