# RPC 协议（stdio JSONL）

由 B6 补全（B9 统稿）；在此之前以 [design.md](design.md) 为准。

## 缓存统计与事件（草稿，W3-C2）

`get_session_stats` 的 `data` 是 `SessionStats`；会话层缓存接线后带 `cache`（`SessionCacheStats`，第三波 §1.10）：

```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "tokens": { "input": 1177, "output": 64, "cacheRead": 2176, "cacheWrite": 0, "total": 3417 },
    "cacheHitRate": 0.65,
    "cache": {
      "reporting": "reported",
      "lastHitRate": 0.84,
      "hitRate": 0.65,
      "reBilledTokens": 0,
      "reBilledUsd": 0,
      "misses": { "count": 0, "byReason": {} },
      "warming": { "mode": "streaming", "state": "stopped", "reason": "no_ttl" },
      "contextRemainingTokens": 127077,
      "estimatedTurnsLeft": 2443
    }
  }
}
```

| 字段                                            | 说明                                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `reporting`                                     | 当前端点（供应商、baseUrl 主机、模型）的三态：`unknown` / `reported` / `silent`；只在内存，同一进程内跨会话复用                             |
| `lastHitRate` / `hitRate`                       | 最近一次 / 会话累计命中率（0–1）；`unknown` / `silent` 时没有 `lastHitRate`，不报缓存的请求不进 `hitRate` 分母                              |
| `reBilledTokens` / `reBilledUsd`                | 未命中重计费合计；有无价模型参与时没有 `reBilledUsd`                                                                                        |
| `misses`                                        | `count` 与 `byReason`（`prefix_changed` / `model_changed` / `idle` / `subtask` / `evicted`）；统计计入全部未命中，不受界面提示门槛影响      |
| `warming`                                       | `mode`（`off` / `streaming` / `idle`）、`state`（`inactive` / `scheduled` / `stopped`）、`nextWarmAt`、停止原因 `reason`、`sent`、`costUsd` |
| `contextRemainingTokens` / `estimatedTurnsLeft` | 上下文余量与按最近 5 回合增量估算的剩余回合                                                                                                 |
| `subagents`                                     | task 子会话汇总：`count`、`hitRate`、`reBilledTokens`                                                                                       |

`tokens` / `cacheHitRate` 保持旧口径（全部请求进分母），新客户端用 `cache`。

三个事件与其它会话事件一样逐行推送（`--output-format stream-json` 同形状）：

```json
{"type":"cache_miss","missedTokens":142000,"missedCost":0.1278,"reason":"evicted","idleMs":3}
{"type":"cache_warm","phase":"scheduled","nextWarmAt":1790000000000}
{"type":"cache_warm","phase":"sent","usage":{"input":1,"output":1,"cacheRead":12000,"cacheWrite":0,"totalTokens":12002},"cost":0.0012}
{"type":"cache_warm","phase":"stopped","reason":"no_cache_hits"}
{"type":"context_pressure","percent":71,"threshold":70,"remainingTokens":57990,"estimatedTurnsLeft":6}
```

`ama -p --output-format json` 的结果对象另有 `cache` 字段，形状同上。
