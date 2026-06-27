# Security Policy

DeepSeek Bridge is a security-sensitive tool: it sends workspace file contents to a
third-party API, can run shell commands, and writes a managed block into your
`CLAUDE.md`. We take that seriously and try to be transparent about exactly what it
does and where the limits are.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
**Repo → Security tab → "Report a vulnerability"**
(https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge/security/advisories/new)

Please include: affected version, a description, reproduction steps, and the impact
you believe it has. We aim to acknowledge within a few days and to ship a fix or a
mitigation as quickly as is practical. Coordinated disclosure is appreciated — we'll
credit you in the changelog unless you prefer otherwise.

## Supported versions

Only the latest published `1.2.x` release receives security fixes. Please upgrade
before reporting.

## What the extension does (threat model)

By design, when you delegate a task:

- **Your file contents and prompts are sent to DeepSeek's API** (`api.deepseek.com`,
  or whatever `deepseekBridge.baseUrl` points to). This is the core function, gated
  behind a one-time consent prompt. Do not use it on code you cannot share with a
  third party.
- **`run_command` is real code execution.** Approving a command — especially a broad
  "any `<tool>`" scope for a scriptable tool (`git`, `node`, `npm`, `python`, …) —
  grants arbitrary code execution via that tool. The approval card warns on broad
  scopes; prefer "Exact command only". **Full Permissions** disables the prompt
  entirely and should only be used in trusted environments.
- **The extension writes a managed, fenced block to your `CLAUDE.md`** (controlled by
  `deepseekBridge.injectGuidance`, set to `off` to disable). It only touches content
  between its own markers.

## Protections in place

- **Workspace jail** — file paths are canonicalized and confined to the workspace;
  `..` traversal, drive-letter/UNC/device paths, symlink/junction escapes, alternate
  data streams, and trailing dot/space tricks are rejected.
- **Secret-file denylist** — common credential files are blocked from the file tools
  even inside the workspace (see README). This list is **not exhaustive**.
- **Approval channel** — bound to `127.0.0.1`; the approve action requires a
  per-session token.
- **Audit log** — every tool call is recorded (with full args) under
  `~/.claude/deepseek-audit/`, outside your repository.

## Known limitations (by design / out of scope)

These are deliberate trade-offs, documented so you can judge the risk:

- **The denylist is path-based and non-exhaustive.** Content-based secret scanning is
  not performed, to avoid false-positives that would block legitimate reads. Review
  what is in your workspace before delegating.
- **`run_command` is not jailed.** Once you approve a command, the spawned process
  runs with your privileges and is *not* constrained by the file denylist — an
  approved scriptable tool can read files the denylist otherwise protects.
- **Control files in `~/.claude/`** (settings, allow-list, kill, port files) are
  trusted and protected only by your OS user account. A process running as you can
  influence them; this is the same trust boundary as your shell.
- **Pricing/cost figures are estimates** and may drift from DeepSeek's live rates.

## Not affiliated

This is an independent, community project. It is **not affiliated with, endorsed by,
or sponsored by Anthropic or DeepSeek.** "Claude", "Claude Code", and "DeepSeek" are
trademarks of their respective owners and are used here only descriptively.
