# Changelog

English · [简体中文](CHANGELOG.zh-CN.md)

> This file is in English starting with 0.6.0. Release notes for 0.1 through 0.5.1 are in Chinese in
> [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md). New entries go into both files.

## Unreleased

Wave 6 (docs/wave6-plan.md) contracts and infrastructure (W6-C0):

- **Interface language**: new `AMA_LANG`, `--lang zh|en`, config `ui.language` (`auto` / `zh` / `en`), and `language` for
  profiles and the SDK. `auto` decides from `LC_ALL` / `LC_MESSAGES` / `LANG` and falls back to English. Message catalogs live in
  `src/i18n/`; interface text is migrated by later batches, so this build's interface is still Chinese. Development conventions
  are in [docs/i18n.md](docs/i18n.md); `pnpm check:i18n` runs in CI (a baseline of Chinese lines that may only shrink).
- **Text sent to the model is always English** (independent of the interface language; requests are byte-identical in both
  languages): the tool-result truncation marker `[… N chars omitted …]`, the compaction prune placeholder `[pruned: …]`, summary
  serialization truncation, `Tool calls:` / `Files changed:` and failure notes in external agent reports, hook block reasons and
  allowlist denial notes. Only tool results in new sessions are affected, the cache prefix is untouched; scripts that parse tool
  results by the old Chinese markers need updating.
- **Trace persistence**: session files gain `custom{customType:"ama.trace"}` entries (one `step` per model request, plus retry
  waits, fallbacks, compaction, auxiliary requests and external agent turn skeletons). They hold only ids, times and counts, no
  content, never enter the context and do not change requests. RPC clients see extra `entry_appended` events for them.
  Sub-sessions also measure time to first token and throughput.
- **RPC**: `permission_request.context` may carry `toolCallId` (approvals for this session's own tool calls now have `context`
  too); `keySource` may be `oauth`; the new command `get_trace` is registered (returns `not_implemented` until the trace batch
  lands).
- **Config**: the new keys `ui.replyLanguage`, `ui.agentBar`, `memory.*` and `auth.chatgpt.*` are validated and written to
  `config.schema.json` (the features arrive with later batches). Project level can only set `memory.enabled` to `false`;
  `ui.replyLanguage` and `auth` are user level only; the agent bar is off by default in embedding hosts. Command-line
  `--memory` / `--no-memory`; `auth.json` can hold OAuth entries (`type: "oauth"`).
- `ama memory`, `/config`, `/trace` and `/memory` are registered and currently reply "not available yet".
- The bundle is emitted as UTF-8 (Chinese is no longer escaped as `\uXXXX`), about 40 KB smaller.
- **English CLI interface** (W6-I1): `ama --help`, the startup screen and startup errors, exit code descriptions, and the
  output and errors of `ama providers` / `models` / `stats` / `sessions export` · `search` / `init` follow the interface
  language (`AMA_LANG=en` / `--lang en`); Chinese output is unchanged word for word. The `advice` of
  `ama models cache-probe --json` is human-readable text and follows the interface language too.
- **Bilingual docs and config descriptions** (W6-I4): `README.md` and `CHANGELOG.md` are now English (shown on the npm page);
  the Chinese versions moved to `README.zh-CN.md` and `CHANGELOG.zh-CN.md` (which keeps the full 0.1–0.5.1 history).
  `docs/en/` adds English versions of `tui`, `permissions`, `providers`, `rpc`, `host-api` and `sessions`; the Chinese docs keep
  their paths. Config key descriptions, validation diagnostics and `ama init` output follow the interface language;
  `config.schema.json` descriptions are written in the current interface language and rewritten by the next `ama init` (or any
  command that auto-initializes) after switching. `pnpm release:check` understands the new CHANGELOG layout.

## Earlier releases

See [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (Chinese).
