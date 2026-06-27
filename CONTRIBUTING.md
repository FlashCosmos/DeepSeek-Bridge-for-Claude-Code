# Contributing to DeepSeek Bridge

Thanks for your interest! This is a small, focused extension and contributions are
welcome — bug fixes, reliability hardening, and security improvements especially.

## Development setup

Requires Node.js 20+.

```bash
git clone https://github.com/DamienTheOmen/Claude-to-DeepSeek-Bridge.git
cd Claude-to-DeepSeek-Bridge
npm install
```

### Common commands

| Command | What it does |
|---------|--------------|
| `npm run typecheck` | `tsc --noEmit` — the type gate (esbuild does **not** type-check) |
| `npm test` | Run the vitest unit suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run bundle` | Build `out/extension.js` + `out/server.js` with esbuild |
| `npm run watch` | Rebuild both on change |
| `npm run package` | Typecheck → bundle → produce the `.vsix` |

To try it live: build, press `F5` (Run Extension), open the DeepSeek Bridge sidebar,
add a key, and reconnect Claude Code.

## Project layout

```
src/
├── extension.ts  # VS Code activation: approval HTTP server, status bar, commands
├── server.ts     # MCP server: agent loop, file tools, cost tracking, condensation
├── sidebar.ts    # Webview: config / history / console tabs + approval card
├── config.ts     # Writes ~/.claude.json, runtime settings, CLAUDE.md guidance
├── jail.ts       # Workspace path jail + sensitive-file denylist
├── control.ts    # Per-workspace enable/disable
└── pure.ts       # Side-effect-free shared logic (UNIT-TESTED — keep it pure)
test/             # vitest suites
```

## Ground rules

- **Keep `src/pure.ts` side-effect-free** — no `vscode`, no `process.exit`, no I/O at
  import time. It's imported directly by tests and by both processes.
- **Add/extend tests** for anything in the security perimeter: the jail, the command
  allow-list, glob matching, posture clamping, and cost math all have coverage in
  `test/` — keep it green.
- **`npm run typecheck` and `npm test` must pass.** CI runs both on every PR.
- **Bump `version` in `package.json`** (and `EXTENSION_VERSION` in `server.ts`) for any
  change that affects the packaged extension, and add a `changelog.md` entry. VS Code
  skips reinstalling a matching version, so the bump is what makes a rebuild take.
- **Match the surrounding style** — no formatter is enforced; mirror the existing code.

## Security issues

Please **do not** file public issues for vulnerabilities — see [SECURITY.md](SECURITY.md)
for private reporting.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
