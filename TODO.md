# TODO

## Open-source readiness (done)

- [x] MIT `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, issue/PR templates
- [x] "Not affiliated" disclaimer (README + SECURITY)
- [x] Git history verified clean of secrets / audit log
- [x] CI (typecheck + tests + bundle) on PRs

Before flipping the GitHub repo to public: confirm the `FlashCosmos` publisher is the
intended public identity.

## VS Code Marketplace release

- [ ] Create / confirm the publisher at https://marketplace.visualstudio.com/manage
      (package.json publisher is `FlashCosmos`)
- [ ] Create an Azure Personal Access Token (Marketplace → Manage scope, all orgs)
- [ ] `npx vsce login FlashCosmos` and paste the PAT
- [ ] `npm run package` then `npx vsce publish`
- [ ] Verify it appears in VS Code Extensions search ("DeepSeek Bridge")

See `PUBLISHING.md` for the full guide.

## Future (not now)

- [ ] Open VSX (Cursor / Windsurf / VSCodium) — deferred; not maintaining for now.
- [ ] Bump version + `changelog.md` entry on every release.
