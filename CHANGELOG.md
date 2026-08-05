# Changelog

## 1.2.18
- **Content search** — DeepSeek gets a new `search_files` tool (regex across the workspace, returning `path:line: text`, with optional path/glob/case filters). Previously it could only list directories and read whole files, so any "where is X / what uses X" question forced it to enumerate the codebase one file at a time and exhaust its iteration budget before it could answer. Build and vendor directories are skipped; the sensitive-file blocklist still applies.
- **Paged file reads** — `read_file` now takes `offset` and `limit`, and each page reports its own range (`[src/Types.luau — lines 1-183 of 1483]`) plus the exact offset to call next. Files longer than one page were previously cut off at a fixed size with no way to request the rest, leaving the model permanently unable to see past the first few hundred lines.
- **Truncated reads can no longer become truncating writes** — the bridge tracks which line ranges of each file the model has actually been shown, and `write_file` refuses to overwrite a file that was only partly read, naming the lines still missing. Because a write replaces the whole file, a half-read file could previously be written back as a reconstruction of the visible part, silently dropping the rest. Deliberate whole-file replacement is still available via `overwriteUnread: true`; coverage is carried across resumes.
- **Budget-aware steering** — a task that is still exploring at 60% of its iteration budget is told to narrow down, and at 85% is told to stop and summarise. Runs that hit the cap now return a partial report instead of nothing at all. Visible in the Console tab.
- **Retuned delegation policy** — the managed `CLAUDE.md` block and MCP instructions now trigger on the *shape* of the work rather than raw file count: delegate bulk execution against known targets, keep open-ended discovery ("find everything that assumes X") in Claude's own context. Delegating discovery was the case that produced empty, budget-exhausted runs.

## 1.2.17
- Fix repository links in package.json — Marketplace "Project Details" now points to the correct FlashCosmos repo.

## 1.2.16
- **Approval status in the task manifest** — each command in a `run_deepseek_task` manifest's `commandsRun` is now tagged `pre-approved` or `prompted`, so the calling agent can see which commands required a live approval click without guessing.
- **DeepSeek now writes files the reliable way** — the agent system prompt forbids using `run_command` (heredocs, `cat >>`, `sed -i`, `php -r file_put_contents`) to change file content and requires the dedicated `write_file` tool in a single pass per file. Eliminates the write-thrashing/corruption seen when the model fell back to shell heredocs.

## 1.2.15
- **Audit-log approval popup events** — command approval prompts (shown/auto-approved/decided) are now written to the per-workspace audit log alongside tool calls, including the full raw command and every scope option offered. Makes it possible to see after the fact exactly which command triggered a live approval prompt, and to diagnose malformed multi-segment commands (e.g. stray unquoted `;` or backtick characters) that produce nonsense scope options.

## 1.2.14
- **Secret Files list** — manage your own blocked file patterns individually in the sidebar (add, edit, remove), pre-populated with common extras (`**/config.php`, `**/database.yml`, `**/local.settings.json`, `**/appsettings.Production.json`, `**/.htpasswd`) on top of the always-on built-ins. Use `**/` prefix to match a filename at any depth.
- Secret Files section moved above Auto-approved Commands in the sidebar.

## 1.2.11
- Moved repository to [FlashCosmos/DeepSeek-Bridge-for-Claude-Code](https://github.com/FlashCosmos/DeepSeek-Bridge-for-Claude-Code).

## 1.2.10
- **Fix approval scope for all bare executables** — the approval dialog now offers "any \<exe\> command" as a scope option for every command, regardless of whether it's in the Windows PATH. Previously, tools like `wc`, `grep`, `sed` were invisible to `where.exe` so users could only approve the exact command "once" and the dialog kept reappearing. Absolute paths are still excluded (they'd produce useless allowlist entries).

## 1.2.9
- Superseded by 1.2.10.

## 1.2.7
- **Parallel tool execution** — multiple tool calls returned in a single DeepSeek response now run concurrently (`Promise.all`) instead of sequentially, reducing per-iteration latency for file-heavy tasks.
- **Raised context-condensation threshold** from 65% → 80% of the 1M-token window, avoiding unnecessary extra API round-trips on medium-length tasks.

## 1.2.4
- Fixed marketplace badges (shields.io retired its VS Marketplace badges → badgen).

## 1.2.3
- Open-source readiness: `SECURITY.md`, `CONTRIBUTING.md`, issue/PR templates, and a "not affiliated with Anthropic or DeepSeek" disclaimer.

## 1.2.2
- Console log now fills the full height of the Console tab.

## 1.2.1
- Fixed the live console and approval popups going silently dark from a port-file key mismatch: robust endpoint discovery, an open display-only feed, and a distinct error when the UI is unreachable. Copy Diagnostics now reports channel state.

## 1.2.0 — "Seamless & premium" overhaul
- **Automatic delegation** — writes a managed delegation policy into your `CLAUDE.md` (and the MCP server `instructions`), so Claude offloads heavy work on its own; tunable via Delegation Aggressiveness.
- **Reviewable results** — unified diffs and command exit codes in the manifest, plus an optional `selfReview` pass, so Claude verifies without re-reading files.
- **Correctness & cost** — corrected the Claude (Opus/Haiku) and DeepSeek V4-Pro price tables, honest "gross savings" labelling, and `ask_deepseek` now honors model switching.
- **Reliability** — per-window signal files, authenticated local channel, single-in-flight guard, atomic history writes, resume-file GC, graceful API-error recovery, progress heartbeats, and a version-independent server path.
- **Security & privacy** — one-time data-egress consent, expanded secret denylist, a scriptable-tool code-execution warning, and the audit log moved out of the workspace.
- **Polish** — native VS Code settings with hot-reload, a Getting Started walkthrough, full command palette, an accessible approval card, Copy Diagnostics, and tests + CI + a typecheck gate.

## 1.1.22 – 1.1.25
- Cache-aware cost tracking with a per-task cache-hit ratio; corrected 1M context window and condensation trigger.
- Automatic model switching (No / Ask / Yes) with a per-call `model` parameter.
- Roo-style context condensation, manifest deduplication, per-call `maxIterations`, and a version stamp on every response.

## 1.1.16 – 1.1.21
- Run-until-done agent loop with stuck detection and resume handles.
- Per-call posture / `writePaths` / `dryRun`, line-numbered reads, and a structured manifest.
- Expanded secret denylist and a self-healing MCP server path.

## 1.1.0 – 1.1.8
- Live Console tab streaming tool calls, tokens, and cost.
- Stop button (kill-file + `AbortController`).
- Command-approval hardening: PATH-validated scopes, piped-command fix, quoted-argument handling, and audit logging.

## 1.0.x
- Initial release: `ask_deepseek` + `run_deepseek_task`, workspace jail + secret denylist, per-workspace toggle, read-only/edit postures, Flash/Pro models, cost history, an inline approval card, and cross-platform support.
