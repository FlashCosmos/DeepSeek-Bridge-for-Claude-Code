# Publishing DeepSeek Bridge to the VS Code Marketplace

Everything in the package is publish-ready **except** the two things only you can create:
your **publisher ID** and a **Personal Access Token (PAT)**. This guide walks through both,
then the one-command publish.

Placeholders to replace in `package.json` before publishing:
- `"publisher": "your-publisher-id"`
- the three `your-github-username` URLs (only needed if you make a GitHub repo — optional)

---

## 1. Create a publisher (one time)

1. Go to <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account.
   (If prompted, create a free Azure DevOps organization — any name.)
2. Click **Create publisher**. Choose a **publisher ID** (lowercase letters, numbers, hyphens —
   e.g. `customs808`). This ID is permanent and appears in your extension's URL.
3. Put that exact ID into `package.json` → `"publisher"`.

## 2. Create a Personal Access Token (one time)

1. Go to <https://dev.azure.com> → your organization → click your avatar (top-right) →
   **Personal access tokens**.
2. **New Token**:
   - **Organization:** *All accessible organizations* (important — not just one).
   - **Expiration:** up to 1 year.
   - **Scopes:** click *Show all scopes* → **Marketplace** → check **Manage**.
3. **Create**, then **copy the token** (you won't see it again).

## 3. (Optional) Make a GitHub repo

Recommended so the Marketplace page links back to source/issues:

```sh
cd "C:/Users/Omen/Desktop/temp/deepseek-bridge"
git init && git add . && git commit -m "Initial release"
# create the repo on github.com, then:
git remote add origin https://github.com/<you>/deepseek-bridge.git
git push -u origin main
```

Then replace the three `REPLACE_WITH_YOUR_GITHUB` URLs in `package.json`.
(If you skip this, remove the `repository`/`bugs`/`homepage` fields, or `vsce` will warn.)

> A `.gitignore` excluding `node_modules/`, `out/`, and `*.vsix` is recommended before pushing.

## 4. Log in and publish

From the extension folder:

```sh
# authenticate once (paste the PAT when prompted)
npx vsce login <your-publisher-id>

# publish the current version (1.0.0)
npx vsce publish
```

That's it. The extension appears in the Marketplace within a few minutes, searchable as
**“DeepSeek Bridge”** in VS Code's Extensions view — anyone can install it with one click.

## 5. Publishing updates later

Bump the version and publish in one step:

```sh
npx vsce publish patch   # 1.0.0 -> 1.0.1
npx vsce publish minor   # 1.0.0 -> 1.1.0
npx vsce publish major   # 1.0.0 -> 2.0.0
```

Update `CHANGELOG.md` first — the Marketplace shows it on the extension page.

---

## Optional: also publish to Open VSX

VS Code's Marketplace is **not** available in VSCodium, Cursor, Windsurf, or Gitpod —
those use **Open VSX**. To reach those users too:

1. Create an account at <https://open-vsx.org> and a token.
2. `npx ovsx publish -p <token>` (install with `npm i -D ovsx` first).

---

## Pre-flight checklist

- [ ] `publisher` set to your real publisher ID (no `REPLACE_...`)
- [ ] `version` bumped if re-publishing
- [ ] `CHANGELOG.md` updated
- [ ] GitHub URLs fixed **or** the `repository`/`bugs`/`homepage` fields removed
- [ ] `npx vsce package` runs clean (build the `.vsix` locally to verify before publishing)
