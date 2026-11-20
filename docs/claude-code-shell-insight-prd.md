# Requirements Document: Shell Insight for Claude Code

**Document type:** Product Requirements Document (PRD) / development handoff  
**Working name:** Shell Insight  
**Version:** 1.0 (draft)  
**Date:** 2026-11-20  
**Target:** Claude Code CLI; other surfaces where mod UI is supported

## 1. Problem

Claude Code frequently invokes shell commands that reveal only a temporary script path, for example:

```bash
bash /tmp/claude-8472.sh
```

The visible command gives the user almost no information about what the script contains. The user cannot readily tell whether Claude is building a project, running tests, waiting for CI, or doing something else. This is especially confusing when a command runs for several minutes or stops without a clear outcome.

**Core requirement:** Automatically inspect the **actual script contents**, use an **LLM** to explain their purpose, and show the user a **single concise line** inside the Claude Code interface while the shell command is active.

## 2. Goal and scope

### Primary goal (MVP)

When Claude Code invokes an opaque shell script, provide a human-readable, one-line summary of **what that script is intended to do**, without requiring the user to open the file or ask Claude for an explanation.

### Secondary goals

- Distinguish command lifecycle states: analyzing, pending/executing when observable, finished, failed, interrupted, or unknown.
- Show command elapsed time and final exit status when available.
- Make the explanation and command lifecycle visible without cluttering the transcript.
- Work automatically across projects and sessions.

### Non-goals for MVP

- Proving which individual shell statement is executing right now.
- Automatically repairing scripts, rerunning failed commands, or resuming Claude.
- Full CI/CD monitoring or claiming a remote workflow has completed.
- Replacing Claude Code's permission system, Bash execution, or shell process management.

**Important semantic rule:** Script inspection shows *intent*, not runtime position. The UI must not say “Waiting for CI” merely because `gh run watch` appears near the end of a script. That requires runtime evidence.

## 3. User stories

1. As a developer, when Claude runs `/tmp/xxxx.sh`, I want to immediately understand its purpose in one line.
2. As a developer, when a script runs for a long time, I want to see its summary and duration rather than only its temporary filename.
3. As a developer, when execution finishes or fails, I want the status to update accurately so I know the shell is no longer running.
4. As a developer, I want the explanation to come from an LLM analyzing the script's contents, not a hard-coded guess based on `/tmp` filenames.
5. As a developer using a custom model gateway, I want to choose a compatible summarization model and constrain its usage.

## 4. Functional requirements

### FR-01 — Detect shell executions [MUST, P0]

- Observe Bash tool calls automatically; do not require manual activation per command.
- Inspect the complete `command` argument, not only Claude's optional description field.
- Support at minimum `bash /tmp/x.sh`, `sh /tmp/x.sh`, `/bin/bash /tmp/x.sh`, and direct executable script paths.
- Also support ordinary inline Bash commands with a short explanation, while prioritizing opaque script invocations.
- Handle quotes, spaces, relative paths, working-directory context, and options safely.
- If multiple scripts are referenced, identify the entry script and report that analysis may be partial.
- Never execute a script for the purpose of inspecting it.

### FR-02 — Read the real script [MUST, P0]

- Resolve an identifiable local script path and read its contents as text, read-only.
- Do not infer content from the filename alone.
- Bound file size, number of files, path traversal, symlinks, and recursion.
- Default to the entry script; do not recursively read all sourced files unless explicitly enabled.
- If the script cannot be read (missing, deleted, permission denied, dynamically generated), explain the original command instead and clearly mark lower confidence.
- If the command creates a script and then runs it within the same shell invocation, parse the available inline construction where practical; otherwise use a safe fallback. Do not delay or change the command to wait for the new file.

### FR-03 — Generate one-line LLM explanation [MUST, P0]

- Send the sanitized command and available script content to a configurable LLM.
- Return **one plain-English sentence**, ideally 8–18 words, with an informative verb and the most important steps.
- Include high-signal operations, e.g. `builds frontend`, `runs unit tests`, `generates artifacts`, `uploads release`, `polls GitHub Actions`.
- Prefer precise descriptions over generic labels such as “Running a shell script.”
- Explain only supported actions; do not hallucinate completion, progress, success, or external state.
- Treat script text as untrusted data; instructions embedded inside it must not override the summarization prompt.
- Normalize or reject multiline, excessively long, or malformed model output before display.
- Use a deterministic fallback summary on model timeout, denial, or failure.

### FR-04 — Show status unobtrusively [MUST, P0]

- Show exactly **one persistent, updated line** in Claude Code while the relevant shell call is active.
- Initial fallback must appear promptly (e.g. `Analyzing /tmp/xxxx.sh…`); replace it with the LLM summary when available.
- Include a compact state label and elapsed time where reliable.
- Avoid flooding the transcript with a new message every refresh.
- Never replace Claude Code's permission dialogs or hide the original command/output.
- On terminal-width changes, truncate or adapt the line gracefully.
- Prefer a mod-owned UI status line; an enhanced tool-row or pane is optional.

### FR-05 — Lifecycle and race handling [MUST, P0]

- Track each relevant tool call independently, using available session/agent/tool identifiers and a local correlation ID if necessary.
- Immediately clear or replace a stale status when a newer command becomes active.
- On normal completion, show `Finished` and the known outcome; on tool failure, show `Failed` with an available exit code.
- On interruption, permission denial, or lost observation, use an accurate `Interrupted`, `Not started`, or `Unknown` state rather than reporting success.
- If a summary arrives *after* its tool has ended, do not overwrite the status of a newer running command.
- Support multiple concurrent shell calls and subagents without attributing one script's summary to another.
- A Claude turn ending is **not** proof that CI finished or that the user's overall work is complete.

### FR-06 — Zero interference [MUST, P0]

- Observation must not modify command arguments, shell scripts, environment variables, permissions, or process outcomes.
- Start the shell without waiting for the LLM summary. Perform expensive explanation work asynchronously.
- Use bounded local file inspection; avoid blocking shell startup on slow network or model calls.
- Plugin failures must fail open for observation only: normal Claude Code execution and approval checks continue unchanged.

### FR-07 — Configuration [SHOULD, P0]

Provide configurable settings with safe defaults:

| Setting | Suggested default | Purpose |
|---|---|---|
| `enabled` | `true` | Enable automatic summaries |
| `model` | `haiku` (or another supported cheap model) | Model for `model.complete` |
| `language` | `en` | Explanation language |
| `maxScriptBytes` | `65536` | Bound script text supplied for analysis |
| `maxOutputChars` | `110` | Keep status to one concise line |
| `summaryTimeoutMs` | `10000` | Bound the model wait |
| `maxConcurrentSummaries` | `2` | Limit overhead and spending |
| `redactSecrets` | `true` | Redact common credentials before LLM calls |
| `includeInlineCommands` | `true` | Summarize normal commands too |
| `logRawScript` | `false` | Never persist raw scripts by default |

These keys are a **proposed plugin-specific configuration schema**, not built-in Claude Code options. The model selection must support the user's custom gateway when it exposes a model accepted by Claude Code's mod model API. Do not assume arbitrary model IDs always work.

### FR-08 — Security and privacy [MUST, P0]

- Read files solely for the requested explanation; never execute, source, or eval them.
- Sanitize likely secrets (tokens, credentials, private keys, `.env` values) before sending content to the LLM. Since automatic redaction is imperfect, document that a third-party/custom model endpoint may receive script text.
- Limit inspected paths and content; do not scan unrelated private files by default.
- Never log script bodies or model prompts by default. If diagnostic logging is enabled, redact sensitive material.
- Treat model output as display-only text; it must not be executed as a command.
- Provide an off switch and optional per-path ignore list.

## 5. Desired UI

**Example A — script being analyzed**

```text
◌ Shell Insight · Analyzing /tmp/claude-8472.sh…
```

**Example B — static intent established**

```text
◐ Shell Insight · Builds frontend, runs unit tests, then checks CI · 01:42
```

**Example C — tool finished**

```text
✓ Shell Insight · Finished (exit 0): frontend build and unit tests
```

**Example D — tool failed**

```text
✕ Shell Insight · Failed (exit 1): frontend unit tests
```

**Example E — cannot read the script**

```text
? Shell Insight · Executing /tmp/claude-8472.sh (contents unavailable)
```

Labels such as `Running`, `Waiting for permission`, or `Waiting for CI` may be shown **only when supported by observed lifecycle/output/external-status evidence**. The LLM's static reading alone is never evidence of the current step.

## 6. Recommended technical approach

Build a **native Claude Code mod**, distributed as a Claude Code plugin. In current Claude Code, mods can observe tool calls, read files, invoke a model independently, and draw status text in the interface.

Suggested component flow:

```text
Claude Code Bash tool.call
   -> detect opaque script invocation
   -> bounded read-only file inspection
   -> sanitized script + command -> model.complete (async)
   -> validate/shorten one-line summary
   -> ui.status / optional ui.render update
   -> tool result or interruption -> final status
```

Implementation hints (verify against the installed Claude Code version):

- `on('tool.call', { tool: 'Bash' }, ...)` to observe the command; preserve `next(e)` semantics.
- `e.command` for the tool command; `$.fs.read(path)` for the referenced file.
- `$.model.complete({ model, prompt, maxTokens, timeoutMs })` for independent LLM summarization. It uses session credentials but **may incur additional usage/cost**.
- `$.ui.status(text)` for a persistent one-line display, or `ui.render` with `ToolProgress`/`Spinner` for more integrated placement.
- `$.clock.after` / session state for asynchronous work and `next.signal` for cancellation-aware behavior.
- A tool hook that `await`s `next(e)` can observe completion, but must not await the LLM *before* calling `next(e)`.
- Use unique tool correlation IDs, cancellation, and freshness checks to prevent late LLM responses from overwriting the current status.

**Runtime observation limitation:** The mod tool-call API supports before/after observation; do not assume it exposes streaming stdout for arbitrary running Bash calls. True step-by-step monitoring needs an independently verified output/log mechanism and belongs in a later phase.

## 7. Acceptance criteria (MVP)

- **AC-01:** Given `bash /tmp/build.sh` containing `npm run build` and `npm test`, the UI explains **building and testing**, not merely “running a script.”
- **AC-02:** The script executes unchanged even when the model takes 10 seconds or fails entirely.
- **AC-03:** The UI shows one updated status line instead of one transcript message per refresh.
- **AC-04:** The status changes after a finished, failed, denied, or interrupted tool call, without inventing success.
- **AC-05:** A late summary from tool A cannot overwrite the status for tool B.
- **AC-06:** Missing, unreadable, oversized, or dynamically generated scripts do not crash the plugin or stop Claude Code.
- **AC-07:** Script-embedded instructions such as “ignore previous instructions” are treated as data and do not change the output policy.
- **AC-08:** Redaction is applied before any model request; raw script text is not persisted by default.
- **AC-09:** Concurrent sessions/subagents do not mix script summaries or lifecycle states.
- **AC-10:** When no runtime evidence exists, the UI describes script *intent* and does **not** assert a particular stage is currently running.

## 8. Test scenarios

Test direct Bash/sh execution, quoted/relative paths, inline commands, a script with `gh run watch`, a script that writes another script before executing it, a deleted file, a symlink, a large file, an unreadable file, secret-bearing content, malicious prompt-injection comments, model timeout, model rejection, permission denial, user interruption, very short scripts, long-running scripts, concurrent Bash calls, subagents, and session switching.

Success means the description is useful, the lifecycle is accurate, and **execution behavior is identical with the plugin enabled or disabled**.

## 9. Delivery plan

**P0 — MVP (required):** Script detection and read-only inspection; LLM one-line explanation; status UI; completion/failure handling; async execution; privacy limits; tests; installation instructions.

**P1 — enhanced runtime status (optional):** Observe live output or a supported progress/log source to classify build/test/CI stages. Add an evidence flag (`intent-only` vs `observed-current`), useful elapsed-time and stalled-output indicators, and a small history viewer. Do not instrument or wrap running commands without explicit opt-in.

**P2 — external CI awareness (optional):** With explicit user permission, correlate a detected `gh`/`glab` workflow with actual GitHub/GitLab status. Distinguish “Claude finished locally, CI still pending” from “Claude still executing.”

## 10. Definition of done

The MVP is done when it can be installed as a Claude Code plugin, automatically summarize the **contents** of a real `/tmp/*.sh` script in one line while allowing the command to continue normally, report the observed final shell outcome, and pass the acceptance tests above.

## 11. Official technical references

- [Claude Code mods overview](https://code.claude.com/docs/en/mods)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [React to tool events](https://code.claude.com/docs/en/plugins/mods/events)
- [Mod API: model, files, UI status, background work](https://code.claude.com/docs/en/plugins/mods/api)
- [Mods reference: limits and render sites](https://code.claude.com/docs/en/plugins/mods/reference)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
