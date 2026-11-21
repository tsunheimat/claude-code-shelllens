# Shell Insight

When Claude stops and hands the prompt back while shells are still running, Shell Insight says what it is waiting for, in a row directly above the prompt:

```
● Waiting 0:36 · CI run, API image and unit tests (3 tasks)
  CI run watch 0:44 · API image build 0:41 · Unit tests 0:38 · output 11s ago
```

While Claude is working it shows nothing: the spinner already says so. When it stops with nothing left running, the row reads `○ Stopped — nothing running`.

## Try it locally

Requires Claude Code with native mod support (tested on **2.1.329**) and a model enabled by your session or gateway. From this checkout:

```sh
claude --plugin-dir "$PWD"
```

Ask Claude to start a harmless script in the background and end its turn; `tests/manual/` has three. To install for future sessions across projects, run `claude plugin install shell-insight --marketplace "$PWD" --scope user` from this checkout. Configure it with `/plugin configure` and remove it with `claude plugin uninstall shell-insight@shell-insight-local`.

**Privacy and cost:** when the agent stops with work running, the plugin sends the tasks' descriptions, commands, eligible script contents, the last 4 KB of their output and the agent's last message, sanitized, to the session's configured model endpoint, including a custom gateway. That is one request per stop, plus at most one a minute while new output appears. Redaction is best-effort, not a guarantee: disable the plugin in sensitive environments. It does not log or persist scripts, prompts or responses; the provider and Claude Code have their own policies.

## What the row means

- **Line 1** is everything the agent is waiting on, as one goal, written by one model request when the agent stops. It reads each task's command, its entry script and its newest output, plus the agent's last message. Until the answer arrives, or if there is none, it shows the agent's own task descriptions. `Waiting` counts from when the agent stopped.
- **Line 2** lists each task with how long it has been running, then when any of them last wrote output.
- **Colour:** a green `●` while output is recent; yellow, with `no output for 3m`, after two quiet minutes (it may be stuck, or just quiet); a grey `○` when nothing is running.
- A finished task drops off at once. Scheduled wakeups (`/loop`, ScheduleWakeup) count as waiting too. The summary is redone at most once a minute while new output appears.

The row reports what the host says is still running and what the output files show. It does not watch CI itself or claim a result; a task's end is shown by Claude Code's own notification.

## Inspection policy

- Reads one entry script per task, under the working directory or an explicitly named `.sh`/`.bash` directly in `/tmp`, using literal `bash`/`sh` invocations only. No globbing, sourcing, `eval` or execution. Hidden paths, traversal, symlinks, special files, oversized and non-text files are skipped.
- Reads at most the last 4 KB of each task's output file, only the one Claude Code itself names for that task.
- Checks placement and metadata before and after reads. This is not an isolation boundary against another process replacing files in a shared directory.

## Options

| Option | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to turn the row and model calls off. |
| `model` | `haiku` | Host-approved alias or model ID. Rejection or timeout leaves the fallback. |
| `language` | `en` | Language tag for the summary; the fixed words are English. |
| `maxScriptBytes` | `65536` | Larger scripts are skipped; hard maximum 262144 bytes. |
| `summaryTimeoutMs` | `10000` | Model deadline, clamped to 100-60000 ms. |
| `redactSecrets` | `true` | Mask likely credentials in commands, scripts and output before the request. |
| `ignorePaths` | empty | Literal file or directory paths, one per line. A matching script, and with rules set any task without one identifiable script, is described by its task description only. |

Raw-script and output logging is deliberately unavailable, including as an opt-in. The plugin only observes: it never intercepts `tool.call` or `tool.run`, which on this host would change Bash background and live-output forwarding.

## Verify

```sh
claude plugin validate . --strict
claude plugin test .
node --test tests/*.test.mjs
```

The native tests exercise the installed mod engine with mocked tools, filesystem, clock and model. The unit tests require Node 22.18+ or 24+ and no dependencies. Neither suite needs credentials or a live model. The [PRD](docs/claude-code-shell-insight-prd.md) describes the MVP and later, optional runtime monitoring.
