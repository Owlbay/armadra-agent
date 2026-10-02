/**
 * `ama stats` 的增量索引缓存：`<数据目录>/stats-index.json`。[W4-D]
 *
 * - 每个会话文件一条：`{ mtimeMs, size, summary }`；mtime 或 size 变了就重扫，否则直接用摘要。
 * - 摘要里的日期是本地日期，所以索引记下时区（`Intl` 的 timeZone 与当前 UTC 偏移）；变了整份作废。
 * - 只是缓存：读不到、版本不对、JSON 坏了都当没有；写入走临时文件 + rename，失败忽略。
 * - 扫描全部目录时顺带删掉已不存在的文件的条目；只扫一个项目时保留别的条目。
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { summarizeSessionFile, type FileStatsSummary } from "./stats-scan.js";

export const STATS_INDEX_FILE = "stats-index.json";
// 2：桶加 subscription（[W6-I5]），旧索引里订阅请求被算成 $0 有价，整体重扫
const INDEX_VERSION = 2;

interface IndexEntry {
  mtimeMs: number;
  size: number;
  /** null = 文件不是有效会话（缓存「无效」本身，避免每次重读）。 */
  summary: FileStatsSummary | null;
}

interface IndexFile {
  version: number;
  zone: string;
  files: Record<string, IndexEntry>;
}

export function timeZoneKey(now = new Date()): string {
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // 无 Intl 时只看偏移
  }
  return `${zone}|${now.getTimezoneOffset()}`;
}

export interface CollectResult {
  summaries: FileStatsSummary[];
  /** 本次重扫的文件数（其余命中缓存）。 */
  scanned: number;
  cached: number;
  /** 无效 / 不可读的文件数。 */
  invalid: number;
}

/**
 * 取一批文件的摘要。`indexFile` 为 undefined 时不用缓存；`prune` 为 true 时删掉不在 `files` 里的条目。
 */
export function collectSummaries(
  files: readonly string[],
  options: { indexFile?: string; prune?: boolean } = {},
): CollectResult {
  const zone = timeZoneKey();
  let index: IndexFile = { version: INDEX_VERSION, zone, files: {} };
  if (options.indexFile !== undefined) {
    try {
      const loaded = JSON.parse(readFileSync(options.indexFile, "utf8")) as IndexFile;
      if (
        loaded.version === INDEX_VERSION &&
        loaded.zone === zone &&
        typeof loaded.files === "object"
      )
        index = loaded;
    } catch {
      // 没有或坏了：重建
    }
  }
  let dirty = false;
  const result: CollectResult = { summaries: [], scanned: 0, cached: 0, invalid: 0 };
  for (const file of files) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      result.invalid++;
      continue;
    }
    const hit = index.files[file];
    let summary: FileStatsSummary | null;
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      summary = hit.summary;
      result.cached++;
    } else {
      summary = summarizeSessionFile(file) ?? null;
      result.scanned++;
      index.files[file] = { mtimeMs: stat.mtimeMs, size: stat.size, summary };
      dirty = true;
    }
    if (summary === null) result.invalid++;
    else result.summaries.push(summary);
  }
  if (options.prune === true) {
    const keep = new Set(files);
    for (const key of Object.keys(index.files)) {
      if (!keep.has(key)) {
        delete index.files[key];
        dirty = true;
      }
    }
  }
  if (dirty && options.indexFile !== undefined) {
    try {
      mkdirSync(dirname(options.indexFile), { recursive: true, mode: 0o700 });
      const tmp = `${options.indexFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
      renameSync(tmp, options.indexFile);
    } catch {
      // 缓存写不进去不影响结果
    }
  }
  return result;
}
