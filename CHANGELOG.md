# Changelog

## 1.2.4
- **Fixed the marketplace/README badges.** shields.io retired its Visual Studio Marketplace badge family, so the Version/Installs/Rating badges rendered as "retired badge." Switched those three to badgen.net's live `vs-marketplace` endpoints. No runtime changes.

## 1.2.3
- **Open-source readiness.** Added `SECURITY.md` (threat model + private vulnerability reporting), `CONTRIBUTING.md`, GitHub issue/PR templates, and a clear "not affiliated with Anthropic or DeepSeek" disclaimer in the README. No runtime changes.

## 1.2.2
- **Console fills the tab.** The live-output log now expands to the full height of the Console tab instead of a fixed 520px box, removing the dead space below it.

## 1.2.1 — Channel resilience (hotfix)
- **Fix: the live console and approval popups could go silently dark.** The v1.2.0 per-window port-file keying had no fallback, so if the server's `CLAUDE_PROJECT_DIR`-derived workspace key didn't normalize to the extension's workspace path (or an old pre-1.2 server was still running mid-upgrade), the local UI channel resolved to nothing and every console event + approval request was dropped without a trace — tasks looked hung.
- Robust endpoint discovery (exact per-window key → most-recently-active window → lone port file); a global `_active.json` pointer + a legacy port file for old servers mid-upgrade.
- The per-session token now gates only the approve action; the display-only console/status feed is open, so the UI is never silently dark from a key/token mismatch.
- Unreachable-UI failures now return a distinct error ("NOT a user denial") instead of looking like a user decline, plus a one-time MCP-log warning.
- **Copy Diagnostics** now reports the workspace key, registered server path, and approval-channel port files to make this class of issue debuggable.

## 1.2.0 — The "seamless & premium" overhaul

### Seamless delegation (the headline)
- **Automatic offloading.** Bridge now writes a managed, fenced delegation-policy block into your `CLAUDE.md` and sets the MCP server's `instructions`, so Claude offloads heavy file work to DeepSeek **on its own** — you no longer have to say "use DeepSeek." New **Delegation Aggressiveness** setting (Conservative / Balanced / Aggressive) tunes the thresholds; `deepseekBridge.injectGuidance` controls where (or whether) the block is written.
- **Sharpened, comparative tool descriptions** that tell the planner to prefer delegation over doing the work itself.

### Trustworthy results (so the round-trip actually saves tokens)
- **Unified diffs in the manifest.** Applied edits return a per-file unified diff; `dryRun` returns diffs for existing files (full content only for new files). Claude reviews changes without re-reading whole files.
- **Command trust signal.** `run_command` exit codes are surfaced in the manifest (`commandsRun`), so a passing test/lint is visible to Claude.
- **Optional `selfReview` pass** re-checks completeness before finishing — aimed at the enumeration/indexing tasks that previously dropped methods.

### Correctness & cost
- **Fixed Claude comparison pricing** (Opus 4.8 $5/$25, Haiku 4.5 $1/$5; Sonnet unchanged) — previous Opus baseline was ~3× too high.
- **Fixed DeepSeek V4 Pro pricing** to the current permanent rate ($0.003625 / $0.435 / $0.87 per 1M); Flash unchanged. Pricing is now stamped with an "as-of" date.
- **Honest savings.** The History "Saved" figure is labelled as a gross delta and notes it excludes Claude's review overhead.
- **`ask_deepseek` now honors model auto-switching** and attributes cost to the model actually used.
- **Cache ratio shows "unknown"** instead of a misleading 0% when DeepSeek omits cache fields.

### Reliability at scale
- **Per-window signal files** — Stop in one window can no longer kill another window's task, and approval popups/console events route to the correct window.
- **Authenticated local channel** — the approval/event server requires a per-session token.
- **Single-in-flight task guard**, **atomic cost-history writes**, **resume-file garbage collection**, **graceful API-error recovery** (preserves partial work + a resume handle instead of throwing), and **clear feedback on malformed tool-call arguments**.
- **MCP progress heartbeats** on long tasks so the client keeps the request alive.
- **Version-independent server path** — an extension auto-update can no longer silently strand the bridge; Bridge also prompts you to reconnect after an update.

### Security & privacy
- **Data-egress disclosure + one-time consent** before any code is sent to DeepSeek; the misleading "no network" wording is corrected.
- **Expanded secret denylist** (`.netrc`, `.pgpass`, `kubeconfig`/`.kube`, `*.tfstate`/`*.tfvars`, `serviceAccount*.json`, `wp-config.php`, and more).
- **Approval card warns** when a broad scope grants arbitrary code execution via a scriptable tool.
- **Audit log relocated** out of the workspace (to `~/.claude/deepseek-audit/`) so it can't be committed.

### Premium polish
- **Native VS Code Settings** (`deepseekBridge.*`) — discoverable, searchable, Settings-Sync-able, per-workspace overridable.
- **Hot-reload** — model/posture/aggressiveness/allow-list changes apply immediately; only an API-key change needs a reconnect.
- **Getting Started walkthrough**, a full **command palette** surface, **accessible approval card** (role/focus/Escape + aria labels), and a **Copy Diagnostics** command.
- **Tests + CI** — unit suite for the jail, command allow-list, glob, posture clamp, cost math, diff, and guidance injection; GitHub Actions runs typecheck + tests + bundle, and `vsce package` now gates on `tsc --noEmit`.

## 1.1.25
- **Cache-aware cost tracking**. DeepSeek caches prompt prefixes automatically and bills cache hits at ~1/50 of the miss rate. The extension now reads `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` from each response and prices them separately, so the Cost History tab reflects true DeepSeek cost instead of pricing all input at the full rate. The append-only agent loop keeps the prefix stable, so multi-step tasks run mostly on cache hits.
- **Cache-hit ratio** is now shown per task in the Cost History tab.
- **Updated pricing table** to V4 cache-hit / cache-miss / output rates. *These are estimates based on our current knowledge of DeepSeek V4 pricing and may change — verify against api-docs.deepseek.com/quick_start/pricing.*
- No action needed for caching itself: DeepSeek caching is automatic and server-side (unlike Anthropic, there are no `cache_control` markers to set).

## 1.1.24
- **Correct context window: 1M tokens**. DeepSeek V4 Flash and Pro both ship a 1,048,576-token window by default (the V4 floor, not a premium tier). The extension was hardcoded to 64K/128K, causing context condensation to fire at ~5% of real capacity.
- **Fix: condensation trigger now measures the *current* context**, not a cumulative sum of every iteration's prompt tokens. The old logic summed `prompt_tokens` across iterations — but each call re-sends the whole history, so the sum over-counted real context several-fold and triggered condensation far too early. Cumulative tokens are still tracked separately for accurate cost/billing.
- Net effect: condensation is now a true last-resort safety net near ~681K tokens. Ordinary tasks run start-to-finish on a single uncondensed context, preserving full fidelity.
- Console/`tokens` events now report live `contextTokens` vs `contextWindow`.

## 1.1.23
- **Automatic model switching**: New sidebar setting — **No** (fixed), **Ask** (approval popup before switching), or **Yes** (Claude picks Flash vs Pro freely per task). The model used is shown in every response header.
- `run_deepseek_task` now accepts a `model: "flash" | "pro"` parameter. In **Ask** mode this triggers the same approval popup used for shell commands, showing the cost implication. In **No** mode the parameter is silently ignored.
- Cost tracking and history now reflect the actual model used per call, not the server default.

## 1.1.22
- **Context condensation (Roo-style)**: When the context window reaches ~65% capacity mid-task, the agent writes a compact progress summary, replaces its message history with it, and continues — no stop, no resume required. Tasks that previously exhausted the context now complete in a single call.
- **Manifest deduplication**: Files written in multiple passes (chunked writes) now appear exactly once in the manifest instead of once per write.
- **Version stamp**: Every tool response now begins with `[DeepSeek Bridge vX.Y.Z | model: ...]` so test logs and orchestrators can always confirm which build and model ran.
- **Per-call `maxIterations`**: Claude can pass a custom iteration cap per task (default: 500, the runaway guard). Rarely needed now that condensation handles longevity.
- Tool description updated to clarify that `resumeId` only appears if the 500-iteration runaway guard fires, which does not happen under normal conditions.

## 1.1.21 *(merged into 1.1.22)*
- Per-call `maxIterations` parameter added to `run_deepseek_task`.
- Limit-hit message now includes iterations used and suggests the exact resume call with a doubled cap.

## 1.1.20
- Fix: protective comment that reintroduced the same webview crash from 1.1.19.

## 1.1.19
- Fix: sidebar webview script crash caused by a bare `/\n/g` regex inside a template literal (backslash must be doubled in template strings).

## 1.1.18
- Decouple from VS Code SecretStorage for headless/remote environments. API key is now written directly to `~/.claude.json` as the authoritative source; SecretStorage is used as a best-effort cache only. The sidebar "Not configured" state on remote-SSH is cosmetic — the extension still functions.

## 1.1.16 – 1.1.17
- **Run-until-done loop**: Agent now exits naturally when DeepSeek signals completion (`finish_reason: stop`) rather than being cut off at a fixed iteration count.
- **Stuck detection**: If the model repeats the same tool call 4 times in a row without progress, the loop exits gracefully with a resume handle.
- **Per-call posture / writePaths / dryRun**: Claude can scope each task tightly — restricting writes to specific glob patterns, requesting read-only analysis, or getting a dry-run diff before committing changes.
- **Line-numbered reads**: All file content is delivered with 1-based line numbers (`N\tcontent`) so the agent can anchor references to exact lines.
- **Structured manifest**: Every `run_deepseek_task` response includes `{ created, modified, skipped }` so the orchestrator can verify programmatically.
- **Resume handle**: Tasks that hit the iteration cap save their full conversation state and return a `resumeId`. Calling again with that ID continues exactly where it stopped.
- **Secret denylist expanded**: Added `auth.json` (Composer credentials), `*.pem` / `*.key`, `storage/logs/` (may contain PII), and `*.sqlite` databases.
- Self-heal MCP server path after publisher/version change.

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
