# ⚡ DeepSeek Bridge for Claude Code

**Offload token-heavy work from Claude to DeepSeek — 10–100× cheaper, sandboxed, and fully under your control.**

DeepSeek Bridge connects [Claude Code](https://claude.com/claude-code) to [DeepSeek](https://platform.deepseek.com) via the Model Context Protocol (MCP). When Claude encounters a heavy chore — refactoring, code generation, multi-file edits, large-file analysis — it can delegate that work to DeepSeek at a fraction of the cost. Claude stays in charge: it plans the work, hands it off to DeepSeek, and reviews the results.

---

## How it works

Claude Code calls one of two MCP tools provided by this extension. The request is handled by a sandboxed DeepSeek agent that can read, write, and list files inside your workspace — nothing outside it. The agent runs until the task is done: when the context window fills up, it automatically summarises its own progress and keeps going without stopping or asking you to resume. If the agent needs to run a shell command (e.g. to run tests), it pauses and asks for your approval before proceeding.

---

## Installation

### Requirements
- [Claude Code](https://claude.com/claude-code) installed and running
- A [DeepSeek API key](https://platform.deepseek.com/api_keys) — free to create at platform.deepseek.com

### Steps

1. **Install the extension** from the VS Code Marketplace — search for **DeepSeek Bridge for Claude Code**, or install directly from this page.

2. **Open the sidebar** — click the ⚡ icon in the Activity Bar.

3. **Enter your DeepSeek API key** — stored in VS Code's encrypted SecretStorage, never in plain text.

4. **Configure your settings:**

   | Setting | Options |
   |---------|---------|
   | Model | **V4 Flash** — fast and cheap (recommended) · **V4 Pro** — advanced reasoning |
   | Automatic Model Switching | **No** · **Ask** · **Yes** — see below |
   | Permissions | **Edit** — read and write files · **Read-only** — analysis only |

5. **Click Save & Connect** — the extension writes your configuration to Claude Code automatically.

6. **Restart Claude Code** (or run `/mcp`) to load the new server.

That's it. Claude will now delegate file-heavy tasks to DeepSeek automatically. Just ask Claude to do something big — *"refactor everything in `src/` to use the new API"* — and it handles the rest.

---

## Features

### Two tools for different jobs

| Tool | What it does |
|------|-------------|
| `ask_deepseek` | Single Q&A call — no file access, no agent loop. Great for explanations, code snippets, or any reasoning you want to offload cheaply. |
| `run_deepseek_task` | Autonomous file agent — reads, writes, and lists files inside your workspace to complete a multi-step task. Returns a structured manifest of every file it touched, plus a prose summary. |

---

### Context condensation — tasks run to completion

When the agent's context window fills up mid-task (around 65% of the model's limit), it doesn't stop. Instead, it automatically:

1. Writes a compact summary of what it has done and what remains
2. Replaces the conversation history with that summary
3. Continues from where it left off

This means a task that reads 30 files and rewrites a 40 KB document will complete in a single call — no manual resume steps, no orchestrator decomposition required. This is the same approach used by Roo Code.

---

### Automatic model switching

Control whether DeepSeek can switch between Flash and Pro based on task complexity:

| Mode | Behaviour |
|------|-----------|
| **No** *(default)* | Always use the model selected in the sidebar. The `model` parameter in tool calls is ignored. |
| **Ask** | When Claude requests a model switch, an approval popup appears — the same popup used for shell commands — showing the cost implication. You decide each time. |
| **Yes** | Claude picks Flash or Pro freely. It uses Flash for routine work and Pro for tasks where accuracy matters more than cost. |

The model used for each call is shown in every response header: `[DeepSeek Bridge v1.1.23 | model: deepseek-v4-flash]`

---

### Per-call permission scoping

Claude can scope each task tightly, independent of the server default:

| Parameter | Description |
|-----------|-------------|
| `posture` | `read`, `create-only`, or `edit` — clamped to the server maximum set in the sidebar |
| `writePaths` | Glob allowlist restricting which paths may be written, e.g. `["tests/**", "docs/*.md"]` |
| `dryRun` | Return proposed file writes as diffs without applying them |

Example: Claude can run a refactor task with `posture: "edit"` and `writePaths: ["src/utils/**"]` — DeepSeek physically cannot write outside `src/utils/` no matter what the prompt says.

---

### Structured result manifest

Every `run_deepseek_task` call returns a structured manifest alongside the prose summary:

```json
{
  "created":  ["docs/affiliate.md"],
  "modified": ["docs/INDEX.md"],
  "skipped":  ["src/readonly-file.ts"]
}
```

Each path appears exactly once, even when the agent writes a file in multiple passes (chunked writes). Claude can verify programmatically without re-reading every file.

---

### Line-numbered file reads

Every file is delivered to the DeepSeek agent with 1-based line numbers (`N\tcontent`), the same format as `cat -n`. This lets the agent anchor method and symbol references to exact lines, reducing the drift in cross-references that occurs when working with large service files.

---

### Resume handle

If a task somehow reaches the hard 500-iteration runaway guard (rare with context condensation active), it saves its full conversation state and returns a `resumeId`. Call `run_deepseek_task` again with that ID to continue exactly where it stopped — same context, same partial manifest, no re-reading files.

Under normal operation you will never see a `resumeId`. Context condensation completes the task transparently.

---

### Command approval popup

When DeepSeek wants to run a shell command, the sidebar shows an approval card before anything executes. You choose:

- **What to approve** — the exact command, or any command from that executable (e.g. approve all `npm` commands)
- **How long** — Once, for this Session, or Always (saved permanently)

Only executables found on your system PATH are offered as scope options — PowerShell sub-commands, script arguments, and keywords are filtered out automatically. Chained commands (`&&`, `||`, `;`) are split and every segment must match the allowlist independently.

---

### Auto-approved commands

Commands you've approved with **Always** are listed in the sidebar. Add, remove, or edit them at any time. Changes take effect immediately — no restart needed.

---

### Full Permissions toggle

> ⚠️ **Caution: bypasses all command approval prompts.**

When enabled, every command runs without asking. Only use this in trusted environments where you don't need per-command control.

---

### Stop button

A **Stop** button appears in the sidebar whenever a task is running. Clicking it cancels the task immediately — including aborting any in-flight API call — and returns a clean message to Claude.

---

### Live Console tab

The sidebar's **Console** tab streams live output as a task runs: which files are being read, what commands are being called, token usage per iteration, context condensation events, and a cost summary when the task finishes.

---

### Cost History tab

Every task is logged with its token count, cost, and a comparison of what the same work would have cost using Claude. Lifetime totals and savings are shown at the bottom.

---

### Workspace toggle

Enable or disable DeepSeek per-workspace from the top of the sidebar. Takes effect immediately with no restart.

---

## Security

DeepSeek runs in a strict sandbox:

- **Workspace jail** — every file path is canonicalized and confirmed to be inside your workspace. UNC paths, drive-letter escapes, symlink traversal, alternate data streams, and `..` tricks are all rejected before any file is touched.
- **Sensitive file denylist** — credentials, private keys, shell history, and config files are blocked even inside the workspace: `.env`, `.ssh/`, `.aws/`, `.npmrc`, `.git-credentials`, `auth.json`, `id_rsa`, `.pem`, `.key`, `storage/logs/`, `*.sqlite`, `.claude/`, and more.
- **No network access** — the agent has no network tools. It can only read/write files and run approved shell commands.
- **Per-call write allowlist** — Claude can restrict writes to specific glob patterns per task; anything outside is refused at the filesystem level regardless of what the prompt says.
- **Shell operator splitting** — chained commands (`&&`, `||`, `;`) are split and every segment must be individually approved. Approving `node` cannot be used to sneak through `node good && rm -rf /`.
- **Audit log** — every tool call is timestamped and logged to `.deepseek-audit.log` in your workspace root.
- **Runaway guard** — a 500-iteration hard cap exists only to catch genuine infinite loops. Normal tasks complete via context condensation long before reaching it.

---

## Pricing

DeepSeek caches prompt prefixes automatically — no configuration, no cache-write fee. Because the agent loop keeps the system prompt and task description identical across iterations, most of the input on a multi-step task bills at the much cheaper **cache-hit** rate. The Cost History tab shows the cache-hit ratio per task.

| Model | Input (cache hit) | Input (cache miss) | Output |
|-------|-------------------|--------------------|--------|
| DeepSeek V4 Flash | $0.0028 / 1M | $0.14 / 1M | $0.28 / 1M |
| DeepSeek V4 Pro | $0.0145 / 1M | $1.74 / 1M | $3.48 / 1M |

> **Note:** These figures are estimates based on our current knowledge of DeepSeek V4 pricing and may change. Always verify against the official [DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing). The extension's cost calculations use these same estimates.

**Example:** A multi-step task using ~100K input (mostly cache hits) + 50K output on V4 Flash costs roughly **$0.02**, versus around **$1.05** with a frontier Claude model — about 98% cheaper.

---

## Configuration reference

| Setting | Description |
|---------|-------------|
| API Key | Your DeepSeek API key (encrypted, stored in VS Code SecretStorage) |
| Model | V4 Flash (recommended) or V4 Pro — the default model for all tasks |
| Automatic Model Switching | No / Ask / Yes — controls whether Claude can request a model switch per task |
| Permissions | Maximum file access level: Read-only or Edit |
| Allowed Commands | Shell commands pre-approved without a popup |
| Full Permissions | Bypass all command approval prompts (caution) |
| Workspace Enabled | Enable or disable DeepSeek for the current workspace |

### Advanced per-call parameters (used by Claude, not set in the sidebar)

| Parameter | Type | Description |
|-----------|------|-------------|
| `posture` | `read` \| `create-only` \| `edit` | Override the permission level for this task (clamped to server max) |
| `writePaths` | `string[]` | Glob allowlist of writable paths for this task |
| `dryRun` | `boolean` | Return proposed writes without applying them |
| `model` | `flash` \| `pro` | Request a specific model (subject to Automatic Model Switching setting) |
| `maxIterations` | `number` | Hard cap on iterations (default: 500; lower to stop early deliberately) |
| `resumeId` | `string` | Resume a paused task from exactly where it stopped |

---

## Links

- [GitHub repository](https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge)
- [Report an issue](https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge/issues)
- [DeepSeek API keys](https://platform.deepseek.com/api_keys)
- [Claude Code](https://claude.com/claude-code)
