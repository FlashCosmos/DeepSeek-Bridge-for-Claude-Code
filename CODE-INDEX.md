# Code Index — `src/`

A quick-reference map of every TypeScript source file, its purpose, and all significant
exports, constants, and internal functions. Read in ~2 minutes to know exactly where to
look for any concern.

---

## Table of Contents

1. [src/extension.ts](#srcextensionts) — VS Code extension activation & approval popup server
2. [src/server.ts](#srcserverts) — MCP server (the DeepSeek API proxy run by Claude Code)
3. [src/sidebar.ts](#srcsidebarts) — Sidebar webview provider (UI for config & approvals)
4. [src/config.ts](#srcconfigts) — Writes `~/.claude.json` MCP config + dynamic allowlist
5. [src/jail.ts](#srcjailts) — Workspace jail (path confinement & sensitive-path blocking)
6. [src/control.ts](#srccontrolts) — Per-workspace enable/disable toggle persistence

---

## `src/extension.ts`

**Purpose:** VS Code extension entry point — activates the extension, starts the approval
HTTP server, registers the sidebar, and manages the session-level allow-command cache.

### Exports

| Symbol | Kind | Description |
|---|---|---|
| `activate` | `async function` | Extension entry point — creates sidebar provider, starts approval server, writes MCP config, sets up status bar |

### Module-level constants

| Name | Value / Type | Description |
|---|---|---|
| `APPROVAL_PORT_FILE` | `string` | Path to `~/.claude/deepseek-bridge-port` — the port file the MCP server reads to find the popup server |
| `HISTORY_FILE` | `string` | Path to `~/.claude/deepseek-history.json` — shared history with the MCP server |

### Key internal functions

| Function | Description |
|---|---|
| `readHistory()` | Reads + parses the shared history file; returns `{ version, entries }` or an empty default |
| `segmentMatchesPrefix(segment, prefix)` | Checks if a shell segment equals a prefix or starts with `prefix + ' '` |
| `isSessionApproved(command)` | Splits on `&&`, `\|\|`, `;`, `\|` and checks every segment against session-approved prefixes |
| `parseSegments(command)` | Splits a shell command by operators into individual command segments |
| `extractExecutable(segment)` | Extracts the executable name from a segment (skips `KEY=val` prefixes) |
| `buildScopeOptions(command)` | Builds a deduplicated list of scope choices: full command + each unique executable |
| `startApprovalServer(context, provider)` | Creates a localhost HTTP server on a random port; handles `/approve` POST requests; consults `sessionApproved` cache; if miss, shows sidebar approval card; on "always allow" persists to globalState and rewrites MCP config |

### Module-level variables

| Name | Type | Description |
|---|---|---|
| `sessionApproved` | `Set<string>` | Set of command prefixes approved during this VS Code session (cleared on restart) |

---

## `src/server.ts`

**Purpose:** The MCP (Model Context Protocol) server that Claude Code launches as a
subprocess — proxies tool calls to DeepSeek, enforces posture/permissions, jails file
access, tracks cost, and requests user approval for shell commands.

### Exports

| Symbol | Kind | Description |
|---|---|---|
| *(none — runs as a script via `main()`)* | | The file has no exports; it executes as a standalone process |

### Module-level constants

| Name | Value / Type | Description |
|---|---|---|
| `API_KEY` | `string \| undefined` | From `DEEPSEEK_API_KEY` env var; process exits if unset |
| `MODEL` | `string` | From `DEEPSEEK_MODEL` env var (default `'deepseek-v4-flash'`) |
| `RAW_POSTURE` | `string` | Lowercased `DEEPSEEK_POSTURE` env var (default `'edit'`) |
| `ALLOW_COMMANDS` | `string[]` | Parsed from `DEEPSEEK_ALLOW_COMMANDS` JSON env var |
| `APPROVAL_PORT_FILE` | `string` | Path to `~/.claude/deepseek-bridge-port` (shared with extension) |
| `HISTORY_FILE` | `string` | Path to `~/.claude/deepseek-history.json` (shared with extension) |
| `ALLOWLIST_FILE` | `string` | Path to `~/.claude/deepseek-allowlist.json` (dynamic allowlist) |
| `DEEPSEEK_PRICING` | `Record<string, {input, output}>` | Per-model cost per million tokens |
| `WORKSPACE_RAW` | `string` | Resolved from `CLAUDE_PROJECT_DIR`, `DEEPSEEK_WORKSPACE`, or `cwd()` |
| `client` | `OpenAI` | DeepSeek API client instance |
| `ROOT` | `string` | Jail workspace root (canonical) |
| `AUDIT_LOG` | `string` | Path to jail audit log inside workspace |

### Key internal functions

| Function | Description |
|---|---|
| `getDynamicAllowlist()` | Re-reads `deepseek-allowlist.json` on every call so "always allow" approvals take effect without restart |
| `calcCost(model, inputTok, outputTok)` | Calculates USD cost from token counts using `DEEPSEEK_PRICING` |
| `appendHistory(entry)` | Appends a cost/history entry to the shared JSON history file (caps at 1000 entries) |
| `segmentMatchesEntry(segment, entry)` | Checks if a command segment matches an allowlist entry (exact or prefix+space) |
| `commandMatchesAllowlist(command, list)` | Splits chained commands on shell operators and requires every segment to match the allowlist (prevents chain exploitation) |
| `requestCommandApproval(command)` | Contacts the extension's approval HTTP server via the port file; caches approved prefixes in `sessionApproved`; 5-minute timeout |
| `serverMaxPosture()` | Returns the max posture allowed by the configured `RAW_POSTURE` |
| `clampPosture(requested)` | Clamps a requested posture to the server's max posture |
| `callDeepSeek(messages, ...)` | Calls the DeepSeek API with tool-definition support, returns structured response |
| `getWorkspaceState()` | Returns `{ files, folders }` listing inside the jailed workspace |
| `readFile(path)` | Reads a file through the jail (with sensitive-path check) |
| `writeFile(path, content)` | Writes a file through the jail (with posture & sensitive-path checks) |
| `editFile(path, oldStr, newStr)` | Patches a file through the jail (uses `replace-in-file` internally) |
| `executeCommand(command)` | Executes a shell command only if allowlisted or approved; writes audit log |
| `handleToolCall(name, args)` | Router that dispatches to the correct handler (read, write, edit, execute, search, etc.) |
| `main()` | Self-contained entry: creates MCP server, registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers, starts stdio transport |

### Module-level variables

| Name | Type | Description |
|---|---|---|
| `sessionApproved` | `Set<string>` | Prefixes approved during this MCP session (mirrors extension's cache) |

---

## `src/sidebar.ts`

**Purpose:** Implements `DeepSeekSidebarProvider`, a VS Code `WebviewViewProvider` that
renders the configuration panel (API key, model, posture, allow-commands) and the
interactive command-approval card in the sidebar.

### Exports

| Symbol | Kind | Description |
|---|---|---|
| `DeepSeekSidebarProvider` | `class` | Webview provider that manages the sidebar UI and approval workflow |
| `ApprovalResult` | `type` | `{ scopes: string[], duration: 'once' \| 'session' \| 'always' }` |

### `DeepSeekSidebarProvider` — public methods

| Method | Description |
|---|---|
| `pushAllowCommands(commands)` | Pushes a live update of the allowed-commands list to the webview |
| `requestApproval(command, scopes)` | Sends an approval card to the webview; returns a Promise that resolves when the user responds |
| `setBadge(count)` | Sets/clears the activity-bar badge number (pending approvals) |
| `resolveWebviewView(webviewView)` | Lifecycle hook — builds the webview HTML, registers message handlers for `load`, `save`, `toggleWorkspace`, `addCommand`, `removeCommand`, `approvalResponse`, `loadHistory`, `approvalDeny` |

### `DeepSeekSidebarProvider` — private methods

| Method | Description |
|---|---|
| `saveAllowCommands(commands)` | Persists allow-command list to `globalState`, rewrites MCP config, and pushes update to webview |
| `buildHtml(nonce)` | Generates the full webview HTML with inline CSS/JS (React-less, vanilla HTML + script) |

### Module-level constants

| Name | Value / Type | Description |
|---|---|---|
| `HISTORY_FILE` | `string` | Path to `~/.claude/deepseek-history.json` |
| `MODELS` | `{ id, label }[]` | Two model options: `deepseek-v4-flash` and `deepseek-v4-pro` |

### Private fields

| Field | Type | Description |
|---|---|---|
| `webviewView` | `WebviewView \| null` | Reference to the current webview view instance |
| `pendingApproval` | `((r: ApprovalResult \| null) => void) \| null` | Resolver for the pending approval promise |
| `context` | `ExtensionContext` | Injected via constructor |

---

## `src/config.ts`

**Purpose:** Single-purpose module that writes the DeepSeek MCP server entry into
`~/.claude.json` and maintains a dynamic allowlist file for the running server.

### Exports

| Symbol | Kind | Description |
|---|---|---|
| `writeMcpConfig(context, apiKey, model, posture, allowCommands)` | `function` | Writes the `deepseek` MCP server block into `~/.claude.json` with env vars; also writes `deepseek-allowlist.json` for live reads |

### What `writeMcpConfig` does (in detail)

1. Reads the existing `~/.claude.json` (or starts with `{}`)
2. Merges a `mcpServers.deepseek` entry with:
   - `command: 'node'`
   - `args: [path to out/server.js]`
   - `env.DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_POSTURE`
   - `env.DEEPSEEK_ALLOW_COMMANDS` (JSON-stringified, only if non-empty)
3. Writes the merged JSON back to `~/.claude.json`
4. Writes a plain JSON array to `~/.claude/deepseek-allowlist.json` so the running server can re-read it dynamically

---

## `src/jail.ts`

**Purpose:** Workspace jail — canonicalizes and confines all file paths to the project
directory, and blocks access to sensitive paths (credentials, SSH keys, git secrets,
databases, etc.).

### Exports

| Symbol | Kind | Description |
|---|---|---|
| `DEFAULT_DENY` | `RegExp[]` | Array of regex patterns matching blocked sensitive paths (`.env*`, `.git`, `.ssh`, `.aws`, `.azure`, `*.pem`, `*.key`, etc.) |
| `Jail` | `interface` | `{ root, auditLog, jailPath, assertNotSensitive, isSensitive }` |
| `createJail(rootRaw, opts?)` | `function` | Factory — creates a `Jail` instance given a workspace root path |

### `Jail` interface members

| Member | Kind | Description |
|---|---|---|
| `root` | `string` | Canonical workspace root path |
| `auditLog` | `string` | Path to the audit log (inside the workspace) |
| `jailPath(p)` | `method` | Canonicalizes a path and enforces containment; throws on escape, UNC paths, drive letters, alternate data streams, trailing dot/space segments, or symlink escape |
| `assertNotSensitive(canonical, mode)` | `method` | Throws if the canonical path matches any `DENY` pattern or is the audit log |
| `isSensitive(canonical)` | `method` | Non-throwing predicate — returns `true` if path is sensitive or is the audit log |

### Module-level constants

| Name | Value / Type | Description |
|---|---|---|
| `DEFAULT_DENY` | `RegExp[]` | 17 regex patterns blocking common secret/persistence paths |

### What `createJail` does internally

1. Resolves and realpath-canonicalizes the workspace root (`ROOT`)
2. Creates `jailPath()` that:
   - Rejects UNC, device paths, drive letters, alternate data streams (`:`), trailing dot/space
   - Checks lexical containment via `path.relative`
   - Finds deepest existing ancestor, realpath-canonicalizes it (defeats symlink/junction escape & 8.3 short names)
   - Rebuilds path for non-existent tail (new files) and re-verifies containment
3. Creates `isSensitive()` and `assertNotSensitive()` using `DEFAULT_DENY` regexes against both relative and absolute forms

---

## `src/control.ts`

**Purpose:** Per-workspace enable/disable toggle — persists a JSON file mapping disabled
workspaces so DeepSeek can be turned off for individual projects without affecting global
config.

### Exports

| Symbol | Kind | Description |
|---|---|---|
| `norm(p)` | `function` | Normalizes a path: resolved, forward-slash → backslash, trailing-slash stripped, lowercased (Windows-friendly) |
| `isWorkspaceEnabled(wsPath)` | `function` | Returns `true` unless the workspace is explicitly listed in the disabled set (default: enabled) |
| `setWorkspaceEnabled(wsPath, enabled)` | `function` | Adds or removes a workspace from the disabled list and persists to disk |

### Module-level constants

| Name | Value / Type | Description |
|---|---|---|
| `CONTROL_FILE` | `string` | Path to `~/.claude/deepseek-bridge-control.json` |

### Key internal functions

| Function | Description |
|---|---|
| `read()` | Reads and parses the control JSON file; returns `{ disabledWorkspaces: string[] }` or empty default |
| `write(c)` | Writes the control object to `CONTROL_FILE`, creating `~/.claude/` if needed |

### Data format

```json
{
  "disabledWorkspaces": [
    "c:\\users\\me\\projects\\some-project",
    "d:\\work\\other-project"
  ]
}
```

Paths are normalized (lowercased, backslashes, no trailing slash) for cross-platform
case-insensitive comparison on Windows.
