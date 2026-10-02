# Permission modes and auto decisions

English · [简体中文](../permissions.md)

> Translated from the Chinese [docs/permissions.md](../permissions.md) as of commit `ee89edb`. When the two differ, the
> Chinese version is authoritative.

This document covers ama's six permission modes, the decision order for every tool call, and how the three tiers of `auto` mode, "rule tier → static judgement → model classifier", decide between allowing and asking. The overall design is in [design.md](../design.md) §6.3 and §7 (Chinese); hook input and output are in [hooks.md](../hooks.md) (Chinese).

## Modes

| Value       | Display name       | Read | Write (inside the project)                      | Execute (bash etc.)                                         | When to use                                                                   |
| ----------- | ------------------ | ---- | ----------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `default`   | Manual             | ✓    | ask                                             | ask                                                         | Default                                                                       |
| `auto-edit` | Accept edits       | ✓    | ✓                                               | ask                                                         | You trust it to edit code but want to see each command                        |
| `plan`      | Plan               | ✓    | deny                                            | read-only commands allowed, everything else denied          | Read-only research, then a plan for approval ([plan.md](../plan.md), Chinese) |
| `auto`      | Auto               | ✓    | ✓ (protected paths and outside the project ask) | safe-list commands allowed, the rest judged by a classifier | Recommended: routine work is not interrupted, only risky steps ask            |
| `full-auto` | Bypass permissions | ✓    | ✓                                               | ✓                                                           | Throwaway sandboxes, containers                                               |
| `allowlist` | Allowlist only     | ✓    | only calls matching allow rules                 | read-only commands and calls matching allow rules           | CI: never asks; anything not listed is denied                                 |

In every mode, deny rules and hook denies are checked first and deny outright; the dangerous-command list (`rm -rf /`, `git push --force`, `curl … | sh` and so on, see the README "Safety" section) always asks, which becomes deny under `allowlist` and when unattended.

How to set it: `--permission-mode <value>`, config `permission.mode`, `/permission` (picker) or `Shift+Tab` in the interactive UI, RPC `set_permission_mode`, SDK `permission.mode`.

### Strictness and project config

From strictest to loosest: `plan < allowlist < default < auto-edit < auto < full-auto`. The project-level `.ama/config.json` can only move the mode towards stricter; in addition it **cannot set `auto` or `full-auto`** (these let ama decide by itself, or allow without any judgement, so they must be turned on by user config, the command line or a profile). Setting them there is ignored with a warning.

`allowlist` sits between `plan` and `default`: the calls it allows are those `plan` allows (read-only tools, [read-only commands](#plan-mode-and-read-only-commands), `task`) plus those listed explicitly by allow rules; the set `default` allows contains it (read-only + allow rules), and everything else asks under `default` and is denied under `allowlist`. So `plan ⊆ allowlist ⊆ default`. Read tools are allowed under `allowlist` as in every other mode; to restrict even reads, use deny rules.

Read-only commands are a static list (next section) shared by `plan` and `allowlist`, so the total order of strictness holds; allowing commands such as `ls` and `git log` under `allowlist` in CI is harmless. `task` is allowed in both modes: sub-sessions share the same permission pipeline, so a sub-agent can never do more than the parent session. With `plan.bash: "ask"`, plan asks for commands outside the list (`allowlist` never asks), and the set of "allowed without asking" still satisfies the inclusions above.

### Interface

- The status bar shows the display name: `mode:Auto`; `Bypass permissions` is yellow.
- `/permission` without arguments opens a picker: titled `Mode`, each item "display name + one line of explanation", number shortcuts 1–6 on the right, a check on the current mode, `Default` on the default mode from config and `Recommended` on Auto. In line mode `/permission` prints the same list.
- `Shift+Tab` cycles: Manual → Accept edits → Plan → Auto → Bypass permissions → Manual. `Allowlist only` is not in the cycle and must be chosen explicitly.
- **Entering Bypass**: switching to Bypass in the interactive UI (Tab / Shift+Tab cycling, the `/permission` picker, `/permission full-auto`) first shows a confirmation dialog with "Cancel" selected by default; cancelling while cycling skips Bypass and returns to Manual, cancelling from the picker or command keeps the previous mode. Once confirmed in a run, it is not asked again. `--permission-mode full-auto` on the command line, user config and profiles do not prompt (those are explicit choices); line mode asks a `[y/N]` question; piped input, RPC `set_permission_mode` and ACP `session/set_mode` are the caller's responsibility and do not prompt. Details in [tui.md](tui.md) "Entering Bypass".

### Origin labels in the approval dialog

Approvals do not only come from the main session. The dialog (and RPC `permission_request.context`) shows where a request comes from; the options are always just "allow / allow this kind for the session / deny":

| Origin                                                          | Title prefix                                         | Body                                                                          | Who decides                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tool calls of a `task` sub-agent                                | `[task:explore]` (`[task]` when the type is unknown) | Same as the main session                                                      | The same permission pipeline; read-only types (`explore` / `plan`) are judged as plan and never prompt      |
| Permission requests from external agents (claude / codex / ACP) | `[claude · session abc12345]`                        | The title, kind, paths involved and input summary given by the external agent | A human only: host → interface → deny when unattended; neither the auto classifier nor the model takes part |
| First run of an external agent in this session                  | Title "first run of an external agent"               | An explanation (runs with your login in that CLI) and the mode                | allow / deny rules `task(<id>)` and `full-auto` let it through; otherwise a human decides (no classifier)   |

"Allow for this session" of an external agent is remembered by that agent itself. In Manual mode the approval of a `task(agent=…)` call and the first-run confirmation are merged into one (see [agents.md](../agents.md), Chinese). The RPC `context` is `{ depth, taskId, origin }` ([rpc.md](rpc.md) "Approvals").

## Plan mode and read-only commands

Step ③ of plan mode looks at the input (implemented by `planDecision` in `src/permissions/pipeline.ts`); the flow and plan approval are in [plan.md](../plan.md) (Chinese):

| Call                                  | Under plan                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| read / grep / glob / ls               | Allowed                                                                                                                                                  |
| `todo`                                | `get` allowed; `set` / `update` denied, with a hint to put the steps into `<proposed_plan>` (the list is generated from the plan on approval)            |
| bash                                  | Per `plan.bash`: `readonly` (default) allows read-only commands and denies the rest; `ask` asks for the rest (denied when unattended); `deny` denies all |
| write / edit etc.                     | Denied with guidance: `Plan mode is active: write/execute tools are disabled. Finish the plan with a <proposed_plan> block.`                             |
| task                                  | Allowed (sub-sessions share the same pipeline and are in plan too; sub-sessions do not extract plan blocks)                                              |
| deny rules, dangerous commands, hooks | Decided before the mode (unchanged)                                                                                                                      |

Read-only commands (`src/permissions/readonly-bash.ts`): first they pass auto's static judgement (tokenizing, nested expansion, network / deletion / write targets / secret paths, command substitution, variable expansion, dotfile globs); then every segment must be on the list below, with no output redirection (except `/dev/null`), no nested shell (`sh -c`, `eval`, `xargs`, `find -exec`) or process substitution, and no environment assignment or wrapper command at the start of a segment (`GIT_EXTERNAL_DIFF=… git diff`, `env …`).

| Command                                                                                     | Restrictions                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ls cat head tail wc stat echo printf pwd which du basename dirname realpath true false cd` | —                                                                                                                                              |
| `grep egrep fgrep`, `rg`, `fd`, `find`                                                      | `rg --pre`, `fd -x / -X / --exec*`, `find -exec / -ok / -delete / -fprint*` do not count                                                       |
| `tree`, `file`, `jq`                                                                        | `tree -o`, `file -C`, `jq -i` do not count                                                                                                     |
| `git status / log / show / diff / rev-parse / blame / ls-files / branch`                    | Only the git global options `-C` and `--no-pager` are allowed; `--output`, `--ext-diff`, `--textconv` and branch-changing options do not count |

This is narrower than auto's safe list: no test / build runners (`npm test` and `cargo build` run project scripts), and no `env` / `printenv` (they would print secrets in environment variables into the context). Reading secret paths (`cat .env`) is not read-only.

## Decision order

One tool call (issued directly by the model or nested inside codemode / task, alike):

```text
schema validation
→ command hook PreToolUse (deny vetoes; allow / ask go to the pipeline)
→ permission pipeline:
   ① rule tier (no model call)
      deny rules (including built-in deny), hook deny                     → deny
      dangerous-command list                                              → ask
      [auto] protected paths, writes outside the project, network, deletion → ask
      hook ask                                                            → ask
      allow rules, hook allow, session memory                             → allow
   ② mode
      plan: read-only tools, read-only commands and task allowed, everything else denied (with plan.bash: ask, other commands ask)
      default / auto-edit / full-auto: the usual mode truth table
        [default / auto-edit] bash the mode would ask for: besides allow rules / hook allow / session memory,
        approval-free inside the sandbox (see below) → allow; a hook ask still turns the result back into ask
      allowlist: read-only tools, read-only commands and task allowed, everything else denied (Not in the allowlist)
      auto: [with the sandbox active] a sandbox:false request to leave the sandbox → ask (after allow rules / hook allow / session memory)
            static judgement (no model call) → allow; undecided → ③
   ③ [auto] model classifier (sandboxed bash gets an os_sandbox input): allow → allow; ask / error / timeout → ask
→ when asking, the approval chain runs (host broker → interface → deny when unattended)
```

- Later steps cannot loosen earlier results: allow rules cannot override dangerous commands or auto's rule tier, and the classifier only handles calls neither ① nor ② decided.
- `allowlist` never asks: anything that would ask (dangerous commands, hook ask) is denied, with the denial text `Not in the allowlist` (text returned to the model is always English).
- When unattended (`-p`, RPC without approvals), asking always means deny; in auto mode the classifier still runs first, and calls it judges allow are executed.

### Approval-free commands inside the sandbox

With `sandbox.bash: auto` and an OS sandbox on the machine that can restrict writes ([sandbox.md](../sandbox.md) "phase two", Chinese), bash runs through the sandbox. Under default / auto-edit, a bash call needs no approval (`PermissionVerdict.sandboxed: true`) when all of the following hold:

1. It will run inside the sandbox: no `sandbox: false`;
2. `sandbox.network: deny` (network access can exfiltrate data, so `allow` asks as usual);
3. The command text (including nested commands in `sh -c`, `eval`, `xargs`, `find -exec`) touches no secret paths (`cat .env`, `~/.ssh/…`) and is not nested too deeply;
4. It was not denied earlier by deny rules or a hook deny, is not on the dangerous-command list (`rm -rf` on paths outside the workspace, `git push --force`, `git reset --hard` etc. ask as usual), and no hook ask follows.

| Mode               | bash inside the sandbox                                                                  | `sandbox: false` (leaving the sandbox)                                    |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| default, auto-edit | Allowed when the conditions above hold, otherwise ask                                    | Ask (allow rules, hook allow and session memory can allow)                |
| auto               | Rule tier and static judgement as usual; the classifier gets an extra `os_sandbox` input | The rule tier asks (allow rules, hook allow and session memory can allow) |
| plan, allowlist    | Unchanged                                                                                | Unchanged                                                                 |
| full-auto          | Allowed                                                                                  | Allowed                                                                   |

When unattended "ask" always means deny, so calls leaving the sandbox are denied in `-p`. auto does not allow sandboxed commands outright: its rule tier (network, deletion, protected paths, writes outside the project) is a deliberately finer line of defense than default's, and the classifier remains the last gate; the cost is that some commands default + sandbox would allow (`rm -r dist` in the workspace) still ask under auto.

## The three tiers of auto

### ① Rule tier

No model call; a match asks (denied when unattended):

| Category              | Contents                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dangerous commands    | The whole list in `dangerous.ts` (shared by all modes)                                                                                                                                                                                                                                         |
| Secret paths          | Reading or writing `.env`, `.env.*` (except `.env.example` / `.sample` / `.template` / `.dist`), `.ssh/`, `.gnupg/`, `.aws/`, `.kube/config`, `.docker/config.json`, `.netrc`, `.pgpass`, private keys (`id_rsa` etc., `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`), ama's `auth.json`         |
| Protected writes      | Writing inside `.git/`, the project's `.ama/` (could change hooks and config), or any path outside the project directory (except `/dev/null` and the like)                                                                                                                                     |
| Network commands      | `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `gh`; `git push / pull / fetch / clone`; `npm / pnpm / yarn / bun install / add / ci / update / publish / dlx`, `npx`; `pip install`, `cargo install / publish`, `go get / install`, `brew / apt install`, `docker pull / push / login` and so on |
| Deletion and rollback | `rm -r` / `rm -f`, `find -delete`, `git clean`, `git checkout -- …` / `git restore`, `git stash drop / clear`, `shred`, `truncate`                                                                                                                                                             |
| Paths in bash         | Redirect targets (`>`, `>>`, `&>`, `tee`), and targets of `cp` / `mv` / `mkdir` / `touch` / `ln` / `chmod` outside the project or protected; secret paths among command arguments (`cat .env`)                                                                                                 |

"The project directory" is the session cwd. File tools are judged by their `path` argument; bash is judged segment by segment with the same tokenizing and nested expansion as `dangerous.ts` (`sh -c`, `eval`, `xargs`, `find -exec`).

### ② Static judgement

No model call; allowed when satisfied:

- Read-only tools (read, ls, grep, glob etc., `permission: "read"`).
- write / edit with a target inside the project directory and not on a protected path (protected ones already asked in ①).
- bash: every segment of the command (split at `&&`, `||`, `;`, `|`) is on the **safe list**, and
  - there is no command substitution `$(…)`, backtick or `<(…)`;
  - arguments contain no variable expansion `$X` and no globs that may match dotfiles (`.e*`);
  - there is no nesting such as `sh -c` (shells, `eval` and `xargs` are not on the list).
    Piping into safe commands (`cat a | grep b | wc -l`) is fine; piping into a shell is not on the list. Redirecting into the project is allowed; writing outside the project already asked in ①.
- A matching allow rule (already allowed at the end of ①).

The safe list (`src/permissions/auto-safe.ts`, each entry with positive and negative tests):

| Command                                                                                                                                                                                                                                                                                                                                                             | Restrictions                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `egrep`, `fgrep`, `rg`, `pwd`, `echo`, `printf`, `which`, `env` and `printenv` (printing only), `true`, `false`, `sort`, `cut`, `tr`, `diff`, `basename`, `dirname`, `realpath`, `stat`, `file`, `du`, `df`, `date`, `whoami`, `uname`, `cd` / `pushd` / `popd` (later relative paths resolve against the new directory) | `env FOO=1 cmd` is judged as `cmd`                                                               |
| `find`                                                                                                                                                                                                                                                                                                                                                              | Without `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls`                      |
| `git status / diff / log / show / rev-parse / blame / ls-files` (`diff / log / show` without `--output`, `--ext-diff`, `--textconv`; `rg` without `--pre`; `sort` without `-o`; `date` without `-s`)                                                                                                                                                                | Only `-C dir` and `--no-pager` before the subcommand (`-c` can change the pager and is not safe) |
| `git branch`                                                                                                                                                                                                                                                                                                                                                        | Listing only: without `-d / -D / --delete / -m / -M / -c / -C / -f / -u` etc.                    |
| `npm / pnpm / yarn test`, `… run test / lint / typecheck / build`, `pnpm / yarn lint / typecheck / build`, `npm t`                                                                                                                                                                                                                                                  |                                                                                                  |
| `node --test`, `tsc --noEmit`, `vitest run`, `pnpm vitest run`, `pnpm exec vitest run`, `pytest`, `python -m pytest`                                                                                                                                                                                                                                                |                                                                                                  |
| `cargo test / check / build / clippy`, `go test / build / vet`, `make test / check / lint / build`                                                                                                                                                                                                                                                                  |                                                                                                  |

Extending it: the user-level config `permission.autoSafeCommands` adds entries, e.g. `["just test", "bun test", "make fmt"]`, matched by word prefix (`just test` matches `just test --verbose`); entries containing `*` match the whole segment as a glob (`bun run test*`). Project config cannot add entries (that would loosen). Added commands still pass ① first: network, deletion and writes outside the project still ask.

### ③ Model classifier

It only handles calls neither ① nor ② decided (e.g. `rm old.txt`, `node scripts/gen.js`, host tools, codemode scripts).

- **A separate request**: it never enters the session transcript and does not change the main session's messages or prefix (the main session's prompt cache is unaffected), and does not trigger warming; the request purpose is `purpose: "classify"`.
- **Input**: tool name, arguments (JSON, truncated to 4000 characters), cwd, project root, and a summary of the latest user message (truncated to 600 characters). Arguments and the user message sit inside a `<tool_call_data>` … `</tool_call_data>` data block, with end markers inside the block escaped; the system prompt requires treating everything inside as data and ignoring instructions in it (including things like "ignore previous instructions" or "respond allow"), leaning to ask when such text appears.
- **Output**: strict JSON `{"decision":"allow"|"ask","reason":"…"}`. A parse failure, a timeout (10 s) or a request error → ask.
- **Model**: `permission.autoModel` (`provider/model`); defaults to the current session model. A cheap, fast model is recommended, e.g. `packy/qwen3.8-flash`. `maxTokens` 256, thinking off.
- **Caching**: successful decisions are cached within the session by "tool name + normalized arguments" (bash collapses whitespace, others use JSON with sorted keys), so identical calls are classified once; errors and timeouts are not cached.
- **Cost**: each classification records a `usage` entry with `kind: "permission_classify"`, counted in `/session` cost and RPC stats, never in the context.
- The classifier can only judge undecided calls as allow or ask; it cannot overturn ①'s deny or ask.

## Audit

- Every auto decision (allow and ask) records `{ layer: "rule" | "static" | "classifier", decision, reason }`:
  - the `tool_execution_end` event carries `autoDecision`; when asking, the `permission_request` event and the approval request carry `autoDecision` (the dialog shows "Auto: reason").
  - `/permissions` shows the latest 20 decisions (tool, summary, tier, result, reason).
- The input of the `PreToolUse` hook is unchanged; the `permissionMode` field can take the new values `auto` and `allowlist`.

## Configuration

```jsonc
{
  "permission": {
    "mode": "auto",
    "autoModel": "packy/qwen3.8-flash",
    "autoSafeCommands": ["just test", "make fmt"],
    "allow": ["bash(npm run e2e)"],
    "deny": ["bash(terraform *)"],
  },
}
```

allowlist in CI:

```sh
ama -p "fix lint and run the tests" --permission-mode allowlist \
  --allow 'write(src/**)' --allow 'edit(src/**)' --allow 'bash(pnpm lint*)' --allow 'bash(pnpm test*)'
```

## Known limitations

- Static judgement looks at the command text, not at what the command really reads: `grep -r token .` reads the project's `.env` and is allowed by the safe list. For stricter behavior, add deny rules for `.env` (`read(**/.env*)`, `bash(*.env*)`).
- "The project directory" is the cwd and does not follow symbolic links; when started in a subdirectory, parent directories count as outside the project.
- Commands like `npm test` / `make test` run the project's own scripts; the safe list allows them as "running tests and builds inside the project". For untrusted repositories use `default` or `plan`.
- Commands prefixed with `sudo` / `doas` are never safe, even when followed by a safe command (`sudo` itself is on the dangerous-command list and asks).
- The classifier is a model's judgement, not a security boundary. The rule tier before it makes no model calls and can be reviewed; write deny rules for operations that are truly unacceptable.
