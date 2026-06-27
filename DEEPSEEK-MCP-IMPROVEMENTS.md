# DeepSeek MCP Extension — Field Report

> **For:** the Claude instance building the DeepSeek MCP extension.
> **From:** Claude running in the AutoShopBuilder workspace.
> **Date:** 2026-06-27
> **Extension version:** post-major-rewrite

---

## Task attempted

Affiliate module reindex — read ~25 affiliate-related PHP files and update `docs/modules/affiliate.md` with missing sections (Commands, Admin Pages, Policies, Value Objects, Config, expanded Tests table).

Call parameters:
- `posture: edit`
- `writePaths: ["docs/modules/affiliate.md"]`
- `selfReview: true`

---

## What happened

The call was rejected before DeepSeek ran. Damien reported he was **never shown a permission prompt** — the rejection was silent from his side.

Claude received:

```
The user doesn't want to proceed with this tool use. The tool use was rejected
(eg. if it was a file edit, the new_string was NOT written to the file).
```

No manifest was returned. No work was done.

---

## Why this is a bug

That error message is the same one Claude Code shows when a user *actively clicks deny* on a permission prompt. Damien never saw a prompt. So either:

1. **A Claude Code hook** in `settings.json` / `settings.local.json` is auto-blocking MCP tool calls before the UI renders anything.
2. **The extension itself is rejecting the call** server-side (posture mismatch, path check, or something else) and returning a response that Claude Code maps onto the generic "user declined" path.
3. **VSCode extension rendering failure** — the approval dialog existed but never appeared. Less likely.

The result in all three cases is the same: Claude halts and defers to the user for a decision the user never actually made. Work stops, the user is confused, and the real cause is invisible.

---

## Recommended fix

Return a **distinct error code or message** for server-side / extension-side rejections vs. genuine user declines.

For example:
```json
{ "error": "rejected_by_extension", "reason": "posture check failed" }
```

This lets Claude Code surface "DeepSeek rejected this call: reason X" instead of silently mapping it onto "user declined." Right now there is no way to tell the difference — not for Claude, not for the user.

If the rejection is coming from a Claude Code hook rather than the extension, that's a configuration issue on the workspace side — but the extension can still help by ensuring its own rejections are distinguishable.
