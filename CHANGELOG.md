# Changelog

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
