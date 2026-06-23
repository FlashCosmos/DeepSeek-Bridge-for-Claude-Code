# Changelog

## 1.0.0

Initial release.

- Two MCP tools for Claude Code: `ask_deepseek` (direct Q&A) and `run_deepseek_task` (autonomous file agent).
- **Hardened security**: workspace jail (blocks absolute/`..`/UNC/drive-relative/ADS/symlink-junction escapes), secret-file denylist, size/budget/iteration caps, audit log. No shell, no network.
- **Per-workspace on/off toggle** — live, no restart.
- **Read-only** and **Edit** permission postures.
- DeepSeek **V4 Flash** / **V4 Pro** model selection.
- Cross-platform (Windows, macOS, Linux).
