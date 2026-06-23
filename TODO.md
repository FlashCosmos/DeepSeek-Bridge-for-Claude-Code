# TODO

## VS Code Marketplace Release

- [ ] Create a publisher account at https://marketplace.visualstudio.com/manage
- [ ] Update `"publisher": "your-publisher-id"` in `package.json` with your real publisher ID
- [ ] Create an Azure Personal Access Token (Marketplace → Manage scope, All accessible organizations)
- [ ] Run `npx vsce login <your-publisher-id>` and paste the PAT when prompted
- [ ] Run `npx vsce publish` to push v1.0.0 to the Marketplace
- [ ] Verify the extension appears in VS Code's Extensions search ("DeepSeek Bridge")

See `PUBLISHING.md` for the full step-by-step guide.

## Post-Launch

- [ ] Publish to Open VSX (for Cursor, Windsurf, VSCodium users) — see `PUBLISHING.md`
- [ ] Bump version and update `CHANGELOG.md` for future releases
