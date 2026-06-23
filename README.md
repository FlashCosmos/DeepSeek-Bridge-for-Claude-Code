# ⚡ DeepSeek Bridge

**Claude offloads its token-heavy chores to DeepSeek — cheaper work, you stay in control.**

DeepSeek Bridge connects [Claude Code](https://claude.com/claude-code) to [DeepSeek](https://platform.deepseek.com). Claude Code is powerful but expensive; DeepSeek is far cheaper to run. This extension lets Claude hand off the big, file-heavy jobs — refactors, code generation, multi-file edits, and summarizing large file sets — to DeepSeek, so you burn fewer Claude tokens on grunt work.

Claude stays in the driver's seat: it plans, decides what to delegate, and reviews the results. DeepSeek does the grinding inside a strict security sandbox.

---

## Why use it

- **Save Claude tokens.** The token-expensive part of most tasks is reading lots of files and generating lots of code. That work moves to DeepSeek, which costs a fraction.
- **Claude orchestrates — no babysitting.** Claude decides when to delegate, mid-flow. You don't have to do anything during a task.
- **You hold the switch.** A live per-workspace toggle lets you turn DeepSeek on or off for any project, instantly.

---

## How it works

```
You ──▶ Claude Code ──▶ run_deepseek_task ──▶ DeepSeek (sandboxed file agent)
              ▲                                        │
              └──────────── result / summary ◀─────────┘
```

When Claude hits a token-heavy, file-bound chore, it calls the bridge's MCP tool. DeepSeek autonomously lists, reads, and writes files to complete the chore, then reports back. Claude verifies the result and continues. For anything needing a shell (builds, tests), Claude runs that itself — DeepSeek never gets a shell.

The bridge exposes two tools to Claude:

| Tool | What it does |
|------|--------------|
| `ask_deepseek` | A direct question to DeepSeek. No file access. For knowledge, explanations, or quick snippets. |
| `run_deepseek_task` | An autonomous **file agent** — DeepSeek lists, reads, and writes files (jailed to the workspace) to finish a chore on its own. |

---

## 🔒 Security

DeepSeek is a remote model, so it is treated as untrusted and confined hard. It gets **no shell and no network access** — only file tools, and those run inside a workspace jail:

- **Workspace jail.** Every path is canonicalized and confined to the current workspace. Absolute paths, `..` traversal, UNC/network paths, drive-relative paths, alternate data streams, and symlink/junction escapes are all rejected.
- **Secret-file denylist.** `.env`, `.ssh`, `.aws`, `.azure`, `.claude.json`, `.git`, `.npmrc`, private keys, history files, and shell-startup/persistence locations are blocked — even inside the workspace.
- **Caps.** Per-file read/write limits, a per-task byte budget, output truncation, an iteration ceiling, and a repeated-call breaker prevent runaway loops and cost blowouts.
- **Audit log.** Every tool call is recorded to `.deepseek-audit.log` in the workspace.

> **Why no command execution?** Giving a remote model a shell — even an "allowlisted" one — is equivalent to remote code execution: it can write a script and then run it. Command execution was deliberately left out so the file jail can't be bypassed. This also removes the exfiltration, persistence, and race-condition risks that all depend on spawning a process.

The jail is verified by an automated exploit test suite (path escapes, secret reads, junction escapes, 8.3 short-name tricks).

---

## Getting started

1. Install the extension (`.vsix`), then open the **⚡ DeepSeek Bridge** view from the Activity Bar.
2. Paste your **DeepSeek API key** (get one at [platform.deepseek.com](https://platform.deepseek.com/api_keys)).
3. Pick a **model**:
   - **V4 Flash** — fast and cheap (recommended for bulk chores).
   - **V4 Pro** — smarter, for chores that need more judgment.
4. Choose **permissions**:
   - **Edit** — DeepSeek can read *and* write files in the workspace (default).
   - **Read-only** — DeepSeek can only read/analyze; it can never modify files.
5. Click **Save & Connect**, then **restart Claude Code** (or run `/mcp`) so it picks up the server.

That's it. From then on, Claude will delegate file-heavy chores to DeepSeek automatically. Just ask Claude to do something big — *"refactor everything in `src/` to use the new API"* — and it will offload the grind.

---

## Per-workspace on/off

The **Use in this workspace** toggle at the top of the sidebar turns DeepSeek on or off for the current project. It's **live** — no restart needed. When off, Claude is refused access to DeepSeek in that workspace and simply does the work itself.

State is stored in `~/.claude/deepseek-bridge-control.json` (a list of disabled workspaces; everything is enabled by default).

---

## Multi-window / multi-machine

- Each VS Code window automatically jails DeepSeek to **its own** workspace — the server reads `CLAUDE_PROJECT_DIR`, which Claude Code injects per window.
- Moving to another machine: install the `.vsix`, paste your key, pick your posture. The per-workspace toggle works independently in each window.

---

## Requirements

- [Claude Code](https://claude.com/claude-code) (VS Code extension).
- A [DeepSeek API key](https://platform.deepseek.com/api_keys).
- Node.js on your `PATH` (used to run the bundled MCP server).

---

## How your key is stored

Your API key is saved in VS Code **SecretStorage** (encrypted, per-machine). The bridge writes the MCP server entry (with the key) into `~/.claude.json` so Claude Code can launch it — the same place Claude Code stores its other MCP servers.
