# Documentation index

English · [简体中文](../README.md)

Most documents are written in Chinese; seven have English translations, kept in the same layout under `docs/en/`.
When a translation and the Chinese version differ, the Chinese version is authoritative. Relative links and the
`docs/…md` paths in source comments are checked by `pnpm check:docs` (`scripts/check-doc-links.mjs`).

| Directory     | Contents                                                                      |
| ------------- | ----------------------------------------------------------------------------- |
| `guides/`     | How to use ama and how it behaves today; kept in step with the code           |
| `reference/`  | Protocols and file formats; shape changes must update these                   |
| `design/`     | Target designs and the visual spec; each states its status in the first lines |
| `history/`    | Finished implementation plans and audits, kept for the record only            |
| `research/`   | Research reports, kept for the record only                                    |
| `benchmarks/` | Measurements and raw data                                                     |

## English translations

| Document                                    | Contents                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Terminal UI](guides/tui.md)                | Layout, status bar, keys, commands, rewind, approvals, agent bar, traces, `/config` |
| [Providers and models](guides/providers.md) | Built-in providers, channels, keys, ChatGPT login, relays, models.dev, caching      |
| [Permissions](guides/permissions.md)        | The six modes, decision order, auto's three tiers                                   |
| [Sessions](guides/sessions.md)              | Stats, search, `--from`, export, traces, checkpoints                                |
| [RPC protocol](reference/rpc.md)            | `ama --mode rpc`: stdio JSONL commands, responses and events                        |
| [ACP](reference/acp.md)                     | `ama --mode acp`, sign-in methods, deviations, the ACP client                       |
| [Host adapter API](reference/host-api.md)   | `@armadra/agent/host`: tools, approvals, injected messages, status                  |

## Chinese only

- Guides: [plan mode](../guides/plan.md), [sub-agents and external agents](../guides/agents.md) (with the
  capability matrix), [memory](../guides/memory.md), [command hooks](../guides/hooks.md),
  [codemode](../guides/codemode.md), [OS sandbox](../guides/sandbox.md), [interface language](../guides/i18n.md).
- Reference: [session file format](../reference/session-format.md).
- Design: [overall design](../design/design.md), [terminal UI visual spec](../design/tui-design.md),
  [search and web access](../design/search-plan.md) (only local search is implemented),
  [local extensions](../design/extensions.md) (draft, not implemented).
- History, research and benchmarks: see the [Chinese index](../README.md).
