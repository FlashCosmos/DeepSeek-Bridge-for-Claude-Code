# ⚡ DeepSeek Bridge

**Claude Code extension that bridges to DeepSeek AI — save expensive Claude tokens on heavy file-based tasks while keeping a security sandbox and full user control.**

DeepSeek Bridge connects [Claude Code](https://claude.com/claude-code) to [DeepSeek](https://platform.deepseek.com) via the Model Context Protocol (MCP). When Claude encounters a token-heavy chore — refactoring, code generation, multi-file edits, large-file analysis — it can offload that work to DeepSeek, which costs **10–100× less** than Claude per token. Claude stays in the driver's seat: it plans the work, delegates to DeepSeek, and reviews the results. DeepSeek runs inside a strict workspace jail with no network access, no free-form shell, and a sensitive-file denylist that blocks credentials and private keys.

---

## How it works

### Data flow in detail

1. **Claude Code** decides to offload work and calls one of the two MCP tools (`ask_deepseek` or `run_deepseek_task`).
2. The call is sent via stdin/stdout to **server.ts** (the MCP server process, spawned by Claude from the config in `~/.claude.json`).
3. `ask_deepseek` sends a single prompt to the DeepSeek API and returns the answer.
4. `run_deepseek_task` starts an **agent loop** — DeepSeek autonomously calls file tools (list, read, write) to complete the chore. If it needs to run a command for self-verification (e.g. tests, lint), it sends an approval request via HTTP to the extension host.
5. The **extension host** runs a lightweight HTTP server (`127.0.0.1:<dynamic-port>`) that receives command-approval requests, shows them in the **sidebar webview**, and returns the user's decision (Once / Session / Always).
6. The **sidebar webview** provides the configuration UI (API key, model, posture), the command approval card with scope options, the cost history tab, and the stop button.
7. The **kill file** (`~/.claude/deepseek-kill`) is a file-based signal. When the user clicks Stop, the extension writes this file, and the agent loop polls for it every 500ms during API calls (plus checks before each iteration).
8. On completion, the agent loop returns a structured manifest (`created`/`modified`/`skipped`/`proposed` files) plus a prose summary.

### Key files on disk

| File | Purpose |
|------|---------|
| `~/.claude.json` | MCP server config (written by the extension, read by Claude Code) |
| `~/.claude/deepseek-bridge-port` | Dynamic HTTP port for the approval server (extension ↔ server.ts) |
| `~/.claude/deepseek-allowlist.json` | Dynamic allowlist (re-read every call, no env-var restart needed) |
| `~/.claude/deepseek-kill` | Kill signal file (Stop button) |
| `~/.claude/deepseek-history.json` | Cost history log (max 1000 entries) |
| `~/.claude/deepseek-bridge-control.json` | Per-workspace enable/disable state |
| `<workspace>/.deepseek-audit.log` | Every tool call audited with timestamp |

---

## Installation

### Prerequisites
- [Claude Code](https://claude.com/claude-code) extension for VS Code
- A [DeepSeek API key](https://platform.deepseek.com/api_keys) — sign up at platform.deepseek.com, go to **API Keys**, and create a key
- Node.js on your `PATH` (the bundled MCP server runs via `node`)

### Steps

1. **Install the VSIX.**  
   Download the latest `.vsix` from the [releases page](https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge/releases) or build it yourself (see [Development](#development)).  
   In VS Code: *Extensions → ⋮ → Install from VSIX...* → select the file.

2. **Open the DeepSeek Bridge sidebar.**  
   Click the ⚡ DeepSeek Bridge icon in the Activity Bar (left sidebar). The Configuration panel opens.

3. **Enter your API key.**  
   Paste your DeepSeek API key into the field. The key is stored in VS Code's **SecretStorage** (encrypted, per-machine).

4. **Choose a model and posture.**

   | Setting | Options |
   |---------|---------|
   | Model | **V4 Flash** (fast & cheap, recommended) or **V4 Pro** (advanced reasoning) |
   | Posture | **Edit** (read + write) or **Read-only** (analysis only, never modifies files) |

5. **Click Save.**  
   This writes the MCP server config to `~/.claude.json`.

6. **Restart Claude Code** (or run `/mcp` in Claude Code) so it picks up the new server.

That's it. From now on, Claude will automatically delegate file-heavy chores to DeepSeek. Just ask Claude to do something big — *"refactor everything in `src/` to use the new API"* — and it will offload the grind.

---

## Features

### Two MCP tools

| Tool | What it does | Parameters |
|------|-------------|------------|
| `ask_deepseek` | Single-turn Q&A. No file or shell access. Use for knowledge questions, explanations, code snippets, or token-heavy reasoning you want to offload. | `prompt` (required), `system` (optional system prompt) |
| `run_deepseek_task` | Autonomous file agent. DeepSeek lists, reads, writes files, and runs self-verification commands inside the workspace jail. Returns a structured manifest + summary. | `prompt` (required), `posture` (`read`/`create-only`/`edit`), `writePaths` (glob allowlist), `dryRun` (boolean) |

**Key difference:** `ask_deepseek` is a single API call — no file access, no agent loop, no cost tracking for tool usage. `run_deepseek_task` runs a full agent loop with file tools and command execution (subject to approval).

### Workspace jail

Every path is canonicalized and confined to the current workspace via `jail.ts`. The jail rejects:

- **UNC / device paths** (`\\server\share`, `\\.\C:`)
- **Drive-letter paths** (`C:\`, `D:foo`)
- **Alternate data streams** (any `:` in path segments)
- **Trailing dot/space** in path segments (Windows filter-bypass trick)
- **Lexical escapes** (`..` traversal outside workspace root)
- **Symlink / junction escapes** (realpath canonicalization of existing ancestors)
- **8.3 short-name bypasses** (realpath expands these)

### Sensitive file denylist

Even **inside** the workspace, these patterns are blocked from both read and write:

| Pattern | What it blocks |
|---------|---------------|
| `.env` / `.env.*` | Environment variable files (secrets) |
| `.git/` | Git repository data |
| `.git-credentials` | Stored Git credentials |
| `.ssh/` | SSH keys and config |
| `.aws/` | AWS credentials and config |
| `.azure/` | Azure credentials |
| `.npmrc` | NPM registry tokens |
| `.claude/` / `.claude.json` | Claude/DeepSeek Bridge config |
| `_history` | Shell history files |
| `id_*` (e.g. `id_rsa`, `id_ed25519`) | SSH private keys |
| `.pem`, `.key`, `.pfx`, `.p12`, `.kdbx`, `.ppk` | Certificate and key files |
| `Startup/` | Windows Startup folder (persistence) |
| `Microsoft.PowerShell_profile.ps1` | PowerShell profile (persistence) |
| `auth.json` | Composer/npm authentication |
| `storage/logs/` | May contain PII |
| `*.sqlite*` | SQLite databases |

The denylist is tested against the **canonical realpath** (defeats 8.3 short-names, symlinks, junctions) — both relative and absolute path forms.

### Command approval popup

When DeepSeek calls `run_command`, the MCP server sends an approval request to the extension host's HTTP server. The sidebar shows:

- The full command string
- **Scope options** with smart granularity:
  - **Exact command** — approve this command verbatim
  - **Any `<executable>`** — approve all commands starting with that executable (e.g. `node`, `npm`, `python`)
  - Only executables actually found on `PATH` are offered — non-PATH tokens (PowerShell sub-commands, script args, keywords) are filtered out
- **Duration choices** for each selected scope:
  - **Once** — approve for this one invocation
  - **Session** — auto-approve for the rest of this VS Code session (forgotten on restart)
  - **Always** — persist to the allowlist permanently

### Auto-approved commands list

Commands approved with **Always** duration are stored in VS Code's global state and written to both:
- `~/.claude.json` (as `DEEPSEEK_ALLOW_COMMANDS` env var — picked up when the MCP server starts)
- `~/.claude/deepseek-allowlist.json` (read dynamically on every call — no restart needed)

The list is displayed in the sidebar's **Allowed Commands** section, alphabetically sorted. You can:
- **Add** commands manually (typed in)
- **Remove** commands (delete button)
- **Edit** commands inline (click to rename)
- **Validate** commands against system `PATH` (checks via `where`/`which`)

### Full Permissions toggle

> **⚠️ CAUTION: This bypasses ALL command approval prompts.**

When enabled, the dynamic allowlist returns `['*']` (wildcard), so every command is automatically approved. DeepSeek can run **any** command without asking. Use only in trusted environments (e.g. CI, personal dev box with no sensitive data). The toggle is a checkbox in the sidebar labeled *Full Permissions (no approval prompts)*.

### Stop button

While a `run_deepseek_task` is running, the sidebar shows a **Stop** button. Clicking it:
1. Writes to the kill file (`~/.claude/deepseek-kill`)
2. The agent loop checks for this file before each DeepSeek API call
3. During an API call, a 500ms interval poll detects the file and **aborts the HTTP request** via `AbortController`
4. The task returns `"Task stopped by user."` with whatever partial results were collected

### Cost history tab

The sidebar has two tabs: **Configuration** and **History**. The History tab shows:
- Every `ask_deepseek` and `run_deepseek_task` call with timestamp, tool type, and summary
- Per-entry cost breakdown: what DeepSeek cost vs what Claude **would have** cost (selectable tier)
- **Lifetime totals** — total DeepSeek spend, equivalent Claude spend, and savings (dollars and percentage)
- Claude pricing tiers for comparison: **Haiku 4.5**, **Sonnet 4.6**, **Opus 4.8**
- Refresh button and a tier selector to compare against different Claude models

### Workspace enable/disable toggle

At the top of the sidebar, a **"Use in this workspace"** toggle controls whether DeepSeek is available for the current project. The state is:
- **Live** — no restart needed, takes effect on the next MCP tool call
- **Persistent** — stored in `~/.claude/deepseek-bridge-control.json`
- **Opt-out by default** — every workspace is enabled until explicitly disabled

When disabled, Claude receives an error message: *"DeepSeek is disabled for this workspace. Enable it in the DeepSeek Bridge sidebar."*

### Session byte budget and iteration limits

From `server.ts`, the agent loop enforces hard caps:

| Limit | Value | Purpose |
|-------|-------|---------|
| `maxReadBytes` | 1 MB | Per-file read size cap |
| `maxWriteBytes` | 1 MB | Per-file write size cap |
| `maxResultChars` | 8,000 | Tool result truncation (with `...[truncated]` suffix) |
| `sessionByteBudget` | **32 MB** | Total bytes returned across all tool calls in one task |
| `maxIterations` | **30** | Maximum DeepSeek API round-trips per task |

These prevent runaway loops, cost blowouts, and context-window overflow.

### Posture modes

Each `run_deepseek_task` call accepts an optional `posture` parameter. The server's configured maximum posture (from the sidebar) clamps the requested value:

| Mode | Can read | Can create files | Can modify existing files |
|------|----------|-----------------|---------------------------|
| `read` | ✅ | ❌ | ❌ |
| `create-only` | ✅ | ✅ | ❌ |
| `edit` | ✅ | ✅ | ✅ |

The server-side clamp enforces: if the sidebar posture is **Read-only**, all tasks are forced to `read` regardless of what Claude requests.

### PATH validation for scope options

The approval popup dynamically checks each executable against the system `PATH` using `where` (Windows) or `which` (macOS/Linux). Tokens that aren't real PATH executables — such as:
- PowerShell sub-commands (`Select-String`, `Where-Object`)
- Keywords (`const`, `interface`)
- Script arguments or file paths

…are **filtered out** of the scope options. Only genuine, findable executables are offered as `any <exe>` scope tokens.

---

## Security model

### Defense in depth

1. **Workspace jail** (`jail.ts`) — every file path is canonicalized, checked for containment, and tested against symlink/junction escapes using `fs.realpathSync.native`. UNC paths, drive letters, ADS, and trailing dot/space tricks are syntactically rejected before path resolution.

2. **Sensitive file denylist** — 19 regex patterns block credentials, private keys, persistence locations, databases, shell history, and authentication configs. Tested against both relative and absolute canonical paths.

3. **No network access** — DeepSeek has no network tools. The agent loop only provides `list_directory`, `read_file`, `write_file`, and `run_command`.

4. **Shell operator splitting** — Before checking the allowlist, chained commands are split on `&&`, `||`, and `;`. **Every** segment must match an allowlist entry. This prevents `"node good && rm -rf /"` from being approved via a `node` prefix.

   ```javascript
   // Bare | is excluded — it appears inside quoted arguments
   // (e.g. powershell -Command "... | Select-String") and does
   // not introduce a new top-level command the way && or ; does.
   const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
   ```

5. **Dynamic allowlist file vs env var baking** — The extension writes both:
   - `DEEPSEEK_ALLOW_COMMANDS` env var in `~/.claude.json` (used on MCP server startup)
   - `~/.claude/deepseek-allowlist.json` (re-read on every tool call via `getDynamicAllowlist()`)
   
   This means "Always allow" approvals take effect **immediately** without restarting Claude Code.

6. **Full Permissions toggle** — When active, the dynamic allowlist returns `['*']`. This is an intentional bypass — use with extreme caution.

7. **`shell: false`** — `run_command` uses `spawnSync` with `shell: false` and manual `parseArgv` quoting. No command injection through shell expansion.

8. **Audit log** — Every tool call is timestamped and logged to `.deepseek-audit.log` in the workspace root.

9. **Per-call posture clamping** — Even if Claude requests `edit` posture, the server clamps it to the sidebar-configured maximum.

10. **Repeated-call suppression** — The same tool+arguments called more than 3 times in a row is rejected as a possible loop.

---

## Configuration reference

All settings are configured through the sidebar webview (Configuration tab) and saved to VS Code's SecretStorage / globalState.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| API Key | `string` | (empty) | DeepSeek API key, stored in VS Code SecretStorage (encrypted) |
| Model | `enum` | `deepseek-v4-flash` | `deepseek-v4-flash` (V4 Flash) or `deepseek-v4-pro` (V4 Pro) |
| Posture | `enum` | `edit` | `edit` (read + write files) or `read-only` (analysis only, no writes) |
| Allowed Commands | `string[]` | `[]` | Shell command prefixes auto-approved without popup (alphabetically sorted) |
| Full Permissions | `boolean` | `false` | When enabled, bypasses ALL command approval prompts (returns wildcard `['*']`) |
| Workspace Enabled | `boolean` | `true` | Per-workspace toggle; live, no restart needed |

### Where settings are stored

| Setting | Storage location |
|---------|-----------------|
| API Key | VS Code SecretStorage (`secrets.get('deepseek-api-key')`) |
| Model | VS Code globalState (`deepseek-model`) |
| Posture | VS Code globalState (`deepseek-posture`) |
| Allowed Commands | VS Code globalState + `~/.claude.json` (env var) + `~/.claude/deepseek-allowlist.json` |
| Full Permissions | VS Code globalState (`deepseek-full-permissions`) |
| Workspace state | `~/.claude/deepseek-bridge-control.json` |

---

## DeepSeek pricing

Pricing is hardcoded in `server.ts` (prices per 1M tokens in USD):

| Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------|---------------------|----------------------|
| **deepseek-v4-flash** | $0.07 | $0.28 |
| **deepseek-v4-pro** | $0.55 | $2.19 |

### Compared to Claude (for reference, from sidebar.ts)

| Claude Model | Input ($/1M tokens) | Output ($/1M tokens) |
|-------------|---------------------|----------------------|
| Haiku 4.5 | $0.80 | $4.00 |
| Sonnet 4.6 | $3.00 | $15.00 |
| Opus 4.8 | $15.00 | $75.00 |

**Savings example:** Running a task with 100K input + 50K output tokens:

| Provider | Cost |
|----------|------|
| DeepSeek V4 Flash | ($0.07 × 0.1) + ($0.28 × 0.05) = **$0.021** |
| Claude Sonnet 4.6 | ($3.00 × 0.1) + ($15.00 × 0.05) = **$1.05** |
| **Savings** | **~98%** |

---

## Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
# Clone the repository
git clone https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge.git
cd Claude-to-DeepSeek-Bridge

# Install dependencies
npm install
```

### Build

```bash
# Bundle both the extension and the MCP server
npm run bundle

# This runs:
#   esbuild src/extension.ts → out/extension.js
#   esbuild src/server.ts    → out/server.js
```

### Package (VSIX)

```bash
# Bundle then create the .vsix package
npm run package

# This runs:
#   npm run bundle
#   vsce package --no-dependencies
#
# Output: deepseek-bridge-<version>.vsix
```

### Watch mode

```bash
npm run watch
# Continuously rebuilds on file changes (both extension.ts and server.ts)
```

### Reinstall in VS Code

1. *Extensions → ⋮ → Install from VSIX...* → select the built `.vsix`
2. Reload the VS Code window
3. Open the DeepSeek Bridge sidebar and re-enter your API key (secrets are per-machine and lost on reinstall)
4. Restart Claude Code (or run `/mcp`) to pick up the new MCP server config

### Project structure

```
src/
├── extension.ts    # VS Code extension entry: HTTP approval server, sidebar activation
├── server.ts       # MCP server: DeepSeek agent loop, file tools, command approval
├── sidebar.ts      # Webview provider: config UI, history tab, approval card
├── config.ts       # Writes ~/.claude.json and allowlist file
├── control.ts      # Per-workspace enable/disable state management
└── jail.ts         # Path jail: canonicalization, containment checks, denylist
```

### Scripts reference

| Script | Description |
|--------|-------------|
| `npm run bundle:ext` | Bundle `extension.ts` only |
| `npm run bundle:server` | Bundle `server.ts` only |
| `npm run bundle` | Bundle both |
| `npm run watch` | Watch mode for both |
| `npm run package` | Bundle + create `.vsix` |
| `npm run vscode:prepublish` | Pre-publish hook (runs `bundle`) |
