# ⚡ DeepSeek Bridge for Claude Code

**Offload token-heavy work from Claude to DeepSeek — automatically, sandboxed, and under your control.**

[![Version](https://badgen.net/vs-marketplace/v/FlashCosmos.claude-deepseek-bridge?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=FlashCosmos.claude-deepseek-bridge)
[![Installs](https://badgen.net/vs-marketplace/i/FlashCosmos.claude-deepseek-bridge)](https://marketplace.visualstudio.com/items?itemName=FlashCosmos.claude-deepseek-bridge)
[![Rating](https://badgen.net/vs-marketplace/rating/FlashCosmos.claude-deepseek-bridge)](https://marketplace.visualstudio.com/items?itemName=FlashCosmos.claude-deepseek-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

DeepSeek Bridge connects [Claude Code](https://claude.com/claude-code) to [DeepSeek](https://platform.deepseek.com) over the Model Context Protocol. When Claude hits a heavy chore — a multi-file refactor, code generation, large-file analysis — it hands the work to DeepSeek at a fraction of the cost, then reviews the result.

**The difference from a plain MCP server:** Bridge installs a delegation policy into your `CLAUDE.md`, so Claude offloads the right work on its own — you don't have to say *"use DeepSeek."*

> *Independent project — not affiliated with, endorsed by, or sponsored by Anthropic or DeepSeek.*

## Setup

1. Install from the Marketplace, then open the ⚡ sidebar (a walkthrough appears on first run).
2. Paste your free [DeepSeek API key](https://platform.deepseek.com/api_keys) and accept the one-time data-sharing notice.
3. Pick a model, delegation aggressiveness, and permission posture → **Save & Connect**.
4. Reconnect Claude Code (`/mcp` or reload the window).

Then just ask Claude to do something big. Most settings apply immediately — only an API-key change needs a reconnect.

## Features

- **Automatic delegation** — a managed block in your `CLAUDE.md` tells Claude *when* to offload; tune it Conservative → Aggressive, or turn it off.
- **Review without re-reading** — results come back as unified diffs plus the exit code of any command run, so Claude verifies cheaply and the offload is a real net win.
- **Finds code instead of reading everything** — regex content search across the workspace answers "where is X / what uses X" in one call, so a task spends its budget on the work rather than on enumerating files.
- **Reads long files properly** — files are paged with line numbers and an explicit "continue from line N" marker, and a file that was only partly read can't be overwritten and silently truncated.
- **Runs to completion** — context condensation lets big multi-file tasks finish in a single call, and a task running low on budget is steered to deliver a partial result rather than getting cut off with nothing.
- **Tight scoping** — per-task `read` / `create-only` / `edit` posture, a `writePaths` allow-list, and dry-run.
- **Command approval done right** — approve a command Once / this Session / Always; broad "any `<tool>`" scopes are flagged as arbitrary code execution.
- **Secret file protection** — a built-in blocklist covers `.env`, `.ssh`, `.aws`, keys, `.git`, `*.tfstate`, `*.sqlite`, and more. Add your own patterns (e.g. `**/config.php`, `secrets/**`) individually in the sidebar; pre-populated with common extras like `**/database.yml` and `**/local.settings.json`. Accessing a blocked file prompts you for one-time or permanent permission.
- **Native VS Code settings** (`deepseekBridge.*`), a live **Console** tab, and a **Cost History** tab with a Claude price comparison.
- **Built for scale** — multi-window-safe, auto-reconnect prompt on update, authenticated local channel, and an audit log.

## Security & privacy

DeepSeek runs jailed to your workspace with no network tools of its own. A two-layer blocklist protects sensitive files: always-on built-in patterns (`.env`, `.ssh`, `.aws`, keys, `*.tfstate`, `*.sqlite`, …) plus your own custom glob patterns managed individually in the sidebar.

**Your code leaves your machine.** To perform a task, your file contents and prompts are sent to DeepSeek's API (`api.deepseek.com`, operated by DeepSeek, Hangzhou, PRC). You consent once before anything is transmitted — don't use Bridge on code you can't share with a third party. Point `deepseekBridge.baseUrl` at a self-hosted or proxy endpoint if your policy requires it. Details in [SECURITY.md](SECURITY.md).

## Pricing

DeepSeek V4 Flash is roughly **10–100× cheaper** than a frontier model for the same work (automatic prompt caching makes repeated context nearly free). The **Cost History** tab tracks your real DeepSeek spend against the Claude equivalent. Verify current rates on the [DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing).

## Links

[Report an issue](https://github.com/FlashCosmos/DeepSeek-Bridge-for-Claude-Code/issues) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [DeepSeek API keys](https://platform.deepseek.com/api_keys) · [Claude Code](https://claude.com/claude-code)

---

*MIT licensed. Independent project — not affiliated with or endorsed by Anthropic or DeepSeek. "Claude", "Claude Code", and "DeepSeek" are trademarks of their respective owners. Your code is transmitted to DeepSeek's API to perform tasks.*
