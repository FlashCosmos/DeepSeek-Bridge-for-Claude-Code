### Choose model & permissions

In the sidebar:

- **Model** — *V4 Flash* (fast & cheap, recommended) or *V4 Pro* (advanced reasoning).
- **Delegation aggressiveness** — how eagerly Claude offloads work:
  *Conservative*, *Balanced* (recommended), or *Aggressive*. This writes a managed
  policy block into your `CLAUDE.md` so Claude knows **when** to delegate — the key
  to seamless, automatic offloading.
- **Permissions** — *Edit* (read & write) or *Read-only* (analysis only).

You can also manage these from the native **Settings** UI under `deepseekBridge.*`.
