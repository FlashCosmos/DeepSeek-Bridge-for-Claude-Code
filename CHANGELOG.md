# Changelog

## 1.1.8
- **README**: Clarified that Node.js is not a user requirement — Claude Code already includes it.
- **Icon**: Updated extension icon to new logo.

## 1.1.7
- **Console tab**: New live output tab in the sidebar that auto-switches when a task starts and streams tool calls, token counts, and a cost summary in real time.
- **Live events**: `server.ts` emits `task_start`, `tool_call`, `tool_result`, `response`, `tokens`, `task_end`, and `task_killed` events to the extension host via a new `POST /event` endpoint.
- **Iteration limit raised**: `maxIterations` increased from 30 to 80, allowing complex multi-file tasks to complete without hitting the wall.
- **README**: Comprehensive README written covering architecture, features, security model, pricing, and development guide.
- **Package cleanup**: Dev artifacts excluded from the VSIX via `.vscodeignore`.

## 1.1.5
- **Fix: piped-command allowlist bypass**: `powershell -Command "... | Select-String"` was being split on the `|` inside the quoted argument, generating false scope tokens that never matched the allowlist. Fixed by removing bare `|` from the shell-operator split regex in both `extension.ts` and `server.ts`.
- **Fix: Stop button now responsive**: Previously had to wait for the full DeepSeek API call to finish. Now uses `AbortController` with a 500 ms kill-file poll to abort the in-flight HTTP request immediately.
- **Fix: Stop dismisses approval popup**: Clicking Stop while an approval popup was visible now also dismisses it, unblocking the agent loop so it can exit cleanly.
- **Fix: Stale kill file**: A kill file left over from a previous stop no longer cancels the next task — cleared at the start of every `run_deepseek_task` call.

## 1.1.4
- **Fix: scope extraction for quoted subcommands**: PowerShell pipes inside quoted arguments no longer produce false executable tokens in the approval popup scope list.

## 1.1.3
- **Fix: stale kill file**: Clear any leftover kill file at task start to prevent false stops on the next run.

## 1.1.2
- **PATH validation**: Scope options in the approval popup now only show executables that are actually on the system PATH. Tokens that are not real commands are filtered out.
- **Allowlist audit log**: Command approvals are logged for auditability.

## 1.1.1
- **Fix: Allow button with double-quoted commands**: CSS attribute selector broke when the command contained double-quote characters. Switched to index-based NodeList matching.
- **Pre-select Always**: Scope options already in the allowlist are pre-selected as "Always" with a "✓ already approved" hint.
- **Pencil edit**: Allowed commands can now be edited inline without removing and re-adding.

## 1.1.0
- **Stop button**: Added a Stop button to the sidebar that writes a kill file, aborting the running DeepSeek task mid-loop and returning a clean "Task stopped by user." message to Claude.

## 1.0.x
- **Per-scope duration dropdowns**: Each scope in the approval popup has its own Once / Session / Always dropdown.
- **Full Permissions toggle**: Optional bypass of all command approval prompts (clearly marked with a warning).
- **Cost history tab**: Tracks token usage and cost per task with a Claude vs DeepSeek savings comparison.
- **Allowlist persistence**: Approved commands survive MCP server restarts via `~/.claude/deepseek-allowlist.json`.
- **Alphabetical sorting**: Allowed commands list is kept sorted.
- **Multi-scope approval**: Multiple scopes can be approved in a single popup using checkboxes.
- **Sidebar approval card**: Replaced OS modal dialogs and QuickPick with an inline approval card in the sidebar webview.
- **`create-only` posture**: New permission mode that allows creating new files but not editing existing ones.

## 1.0.0
- Initial release.
- Two MCP tools: `ask_deepseek` (direct Q&A) and `run_deepseek_task` (autonomous file agent).
- Workspace jail: blocks absolute paths, `..` traversal, UNC/device paths, symlink escapes, alternate data streams, and a sensitive-file denylist (`.env`, `.ssh`, `.aws`, credentials, private keys, etc.).
- Per-workspace enable/disable toggle.
- Read-only and Edit postures.
- DeepSeek V4 Flash and V4 Pro model selection.
- Cross-platform (Windows, macOS, Linux).
