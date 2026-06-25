# ⚡ DeepSeek Bridge for Claude Code

**Offload token-heavy work from Claude to DeepSeek — 10–100× cheaper, sandboxed, and fully under your control.**

DeepSeek Bridge connects [Claude Code](https://claude.com/claude-code) to [DeepSeek](https://platform.deepseek.com) via the Model Context Protocol (MCP). When Claude encounters a heavy chore — refactoring, code generation, multi-file edits, large-file analysis — it can delegate that work to DeepSeek at a fraction of the cost. Claude stays in charge: it plans the work, hands it off to DeepSeek, and reviews the results.

---

## How it works

Claude Code calls one of two MCP tools provided by this extension. The request is handled by a sandboxed DeepSeek agent that can read, write, and list files inside your workspace — nothing outside it. If the agent needs to run a shell command (e.g. to run tests), it pauses and asks for your approval before proceeding. You decide the scope and duration of every permission.

---

## Installation

### Requirements
- [Claude Code](https://claude.com/claude-code) installed and running
- A [DeepSeek API key](https://platform.deepseek.com/api_keys) — free to create at platform.deepseek.com

### Steps

1. **Install the extension** from the VS Code Marketplace — search for **DeepSeek Bridge for Claude Code**, or install directly from this page.

2. **Open the sidebar** — click the ⚡ icon in the Activity Bar.

3. **Enter your DeepSeek API key** — it's stored in VS Code's encrypted SecretStorage, never in plain text.

4. **Choose a model and posture:**

   | Setting | Options |
   |---------|---------|
   | Model | **V4 Flash** — fast and cheap (recommended) · **V4 Pro** — advanced reasoning |
   | Posture | **Edit** — read and write files · **Read-only** — analysis only, no modifications |

5. **Click Save** — the extension configures Claude Code automatically.

6. **Restart Claude Code** (or run `/mcp`) to load the new server.

That's it. Claude will now delegate file-heavy tasks to DeepSeek automatically. Just ask Claude to do something big — *"refactor everything in `src/` to use the new API"* — and it handles the rest.

---

## Features

### Two tools for different jobs

| Tool | What it does |
|------|-------------|
| `ask_deepseek` | Single Q&A call — no file access, no agent loop. Great for explanations, code snippets, or any reasoning you want to offload cheaply. |
| `run_deepseek_task` | Autonomous file agent — reads, writes, and lists files inside your workspace to complete a multi-step task. Returns a summary and a manifest of every file it touched. |

### Command approval popup

When DeepSeek wants to run a shell command, the sidebar shows an approval card before anything executes. You choose:

- **What to approve** — the exact command, or any command from that executable (e.g. approve all `npm` commands)
- **How long** — Once, for this Session, or Always (saved permanently)

Only executables found on your system PATH are offered as scope options — PowerShell sub-commands, script arguments, and keywords are filtered out automatically.

### Auto-approved commands

Commands you've approved with **Always** are listed in the sidebar. You can add, remove, or edit them at any time. Changes take effect immediately — no restart needed.

### Full Permissions toggle

> ⚠️ **Caution: bypasses all command approval prompts.**

When enabled, every command runs without asking. Only use this in trusted environments where you don't need per-command control.

### Stop button

A **Stop** button appears in the sidebar whenever a task is running. Clicking it cancels the task immediately — including aborting any in-flight API call — and returns a clean message to Claude.

### Live Console tab

The sidebar's **Console** tab streams live output as a task runs: which files are being read, what commands are being called, token usage per iteration, and a cost summary when the task finishes.

### Cost History tab

Every task is logged with its token count, cost, and a comparison of what the same work would have cost using Claude. Lifetime totals and savings are shown at the bottom.

### Workspace toggle

Enable or disable DeepSeek per-workspace from the top of the sidebar. Takes effect immediately with no restart.

### Posture modes

| Mode | Read | Create new files | Edit existing files |
|------|------|-----------------|---------------------|
| `read` | ✅ | ❌ | ❌ |
| `create-only` | ✅ | ✅ | ❌ |
| `edit` | ✅ | ✅ | ✅ |

The sidebar posture is the maximum allowed — Claude can request a lower posture per task, but never higher.

---

## Security

DeepSeek runs in a strict sandbox:

- **Workspace jail** — every file path is canonicalized and confirmed to be inside your workspace. UNC paths, drive-letter escapes, symlink traversal, alternate data streams, and `..` tricks are all rejected before any file is touched.
- **Sensitive file denylist** — credentials, private keys, shell history, and config files are blocked even inside the workspace: `.env`, `.ssh/`, `.aws/`, `.npmrc`, `.git-credentials`, `id_rsa`, `.pem`, `.claude/`, and more.
- **No network access** — the agent has no network tools. It can only read/write files and run approved shell commands.
- **Shell operator splitting** — chained commands (`&&`, `||`, `;`) are split and every segment must be individually approved. Approving `node` cannot be used to sneak through `node good && rm -rf /`.
- **Audit log** — every tool call is timestamped and logged to `.deepseek-audit.log` in your workspace root.
- **Iteration cap** — tasks are limited to 80 DeepSeek API round-trips and a 32 MB total data budget to prevent runaway loops.

---

## Pricing

| Model | Input | Output |
|-------|-------|--------|
| DeepSeek V4 Flash | $0.07 / 1M tokens | $0.28 / 1M tokens |
| DeepSeek V4 Pro | $0.55 / 1M tokens | $2.19 / 1M tokens |

**Example:** A task using 100K input + 50K output tokens costs roughly **$0.02** with DeepSeek V4 Flash vs **$1.05** with Claude Sonnet — about 98% cheaper.

---

## Configuration reference

| Setting | Description |
|---------|-------------|
| API Key | Your DeepSeek API key (encrypted, stored in VS Code SecretStorage) |
| Model | V4 Flash (recommended) or V4 Pro |
| Posture | Maximum file access level allowed for tasks |
| Allowed Commands | Shell commands pre-approved without a popup |
| Full Permissions | Bypass all command approval prompts |
| Workspace Enabled | Enable or disable DeepSeek for the current workspace |

---

## Links

- [GitHub repository](https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge)
- [Report an issue](https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge/issues)
- [DeepSeek API keys](https://platform.deepseek.com/api_keys)
- [Claude Code](https://claude.com/claude-code)
