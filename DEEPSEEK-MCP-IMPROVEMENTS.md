# DeepSeek MCP Extension — Improvement Spec

> **For:** the Claude instance building the DeepSeek MCP extension.
> **From:** Claude running in the AutoShopBuilder workspace, after hands-on use of the two tools.
> **Goal:** Make this extension a reliable, safely-scoped "Engine" that an orchestrating Claude can
> delegate file-based chores to (replacing a manual two-AI copy-paste relay).

---

## 1. Current state (what exists today)

Two tools are exposed:

- **`ask_deepseek`** — `{prompt, system?}` → text answer. No file or shell access. Good for knowledge,
  reasoning, snippets, token-heavy offload.
- **`run_deepseek_task`** — `{prompt}` → autonomous file-based work. Can list/read/write files, **confined
  to the workspace root**. **No shell, no network.** Secret files blocked (`.env`, `.ssh`, `.aws`,
  `.claude.json`, keys, `.git`). One **global** posture: `edit`. Returns a prose summary of what it did.

## 2. Evidence from real use (why these recommendations)

A real delegation was run: "read two service/job files, analyze the credit-charge flow, write a markdown
report." Findings when the output was verified against source:

- **Substance was correct.** It found the real bug (a credit is decremented *before* the API call, and a
  3-retry job can burn 3 credits with no successful submission), quoted real code, and reasoned well about
  transactions and transient-vs-permanent errors.
- **Every line-number reference was wrong by ~10–20 lines.** It read the code correctly but approximated
  line refs, forcing the orchestrator to re-verify and burn tokens.
- **It could not run anything** to check its own output (no shell).
- **It could have written anywhere** in the workspace; the task only needed read + one new doc.

Conclusion: the Engine is capable, but today it is (a) over-permissioned for most tasks, (b) unable to
self-verify, and (c) imprecise in a way that makes "Claude must verify" mandatory.

---

## 3. Core architectural change (do this first)

**Move from a single global posture to per-call, server-clamped permissions.**

- The server config defines the **maximum** capability a task may be granted (the clamp).
- Each `run_deepseek_task` call **requests** a scope ≤ the clamp. The server enforces `min(requested, max)`.
- This lets the orchestrating Claude scope every delegation tightly ("this task may only write under
  `tests/`") instead of trusting one global setting.

Everything below becomes far more useful once permissions are per-call.

---

## 4. Gated permissions to add (priority order)

### P1 — Write-path allowlist (per call)  ★ highest safety ROI
Add an optional `writePaths: string[]` (glob list) to `run_deepseek_task`. When present, writes are
restricted to matching paths; anything else is refused. Server clamps to its own configured max paths.
Example: `writePaths: ["tests/**", "database/factories/**"]` so a test-writing chore physically cannot
edit production code.

### P2 — Propose-diff / dry-run mode  ★ highest review ROI
Add `dryRun: boolean` (or `apply: "auto" | "propose"`). In propose mode, DeepSeek returns the **unified
diffs** it *would* write instead of writing them, for the orchestrator to approve. Most valuable for edits
to **existing** files (new-file codegen is lower risk). Pairs naturally with an `apply_proposed` follow-up
call keyed by an id.

### P3 — Gated, allowlisted shell for self-verification  ★ highest capability ROI
The #1 capability gap: DeepSeek can't run the test it just wrote, so all verification bounces back to the
orchestrator. Add an **allowlist-only** exec, **off by default**, e.g. `allowCommands: ["php artisan test",
"vendor/bin/pint", "composer dump-autoload"]`. Match by prefix/allowlist; never permit arbitrary shell.
This lets the Engine iterate to green on its own for well-scoped tasks.

### P4 — Per-call posture: `read` | `create-only` | `edit`
Replace the single global posture with a per-call `posture`:
- `read` — analysis only, no writes (most investigation tasks need this — the verified example didn't need
  write at all).
- `create-only` — may write **new** files, may not modify existing ones (safe codegen).
- `edit` — read + modify existing files (refactors). Server clamps to its configured max.

---

## 5. Two non-permission fixes worth more than another toggle

- **Number the lines in DeepSeek's file reads.** Feed file content to the model in `cat -n` style (line
  number + tab). This alone would fix the consistently-wrong line references and cut re-verification cost.
- **Return a structured manifest**, not just prose: `{ created: string[], modified: string[],
  skipped: string[], commandsRun?: {cmd, exitCode}[] }`. Lets the orchestrator verify programmatically
  instead of re-reading every file. Keep a short prose summary alongside it.

---

## 6. What NOT to do

- Don't add arbitrary shell or default-on network. Keep network off; if ever needed, gate it behind an
  allowlist of hosts, off by default.
- Don't sprawl into dozens of per-file-type flags nobody sets. The four scoped permissions above cover the
  real risk surface.
- **Harden the existing secret blocklist** (not a new toggle): also block `auth.json` (Composer creds),
  `*.pem`/`*.key`, `storage/logs/**` (may contain PII), and `*.sqlite` containing real data. Confirm
  symlink traversal can't escape the workspace root.

---

## 7. Suggested build order

1. Per-call permission plumbing + server clamp (Section 3) — unlocks the rest.
2. P1 `writePaths` + P4 `posture` — cheap, high safety.
3. Structured manifest + line-numbered reads (Section 5) — cheap, high accuracy.
4. P2 dry-run/propose-diff — medium effort, high review value.
5. P3 allowlisted self-verify shell — most effort, biggest capability gain.

**One-line summary:** the win isn't *more* toggles — it's **per-call scoping** (write-paths + posture), a
**propose-before-apply** mode, an **allowlisted self-verify shell**, and **line-numbered reads + a
structured result**. Those map directly to the friction observed in real use.

---

## 8. Live test log & findings (updated 2026-06-26)

Seven real `run_deepseek_task` calls were made against this repo across multiple extension versions.

| # | Task | Posture / writePaths | Outcome |
|---|------|----------------------|---------|
| 1 | Analyze 2 service/job files → write 1 analysis doc | edit / `docs/**` | ✅ Accurate; **line refs off ~10–20** |
| 2 | Bounded slice: 4 named files → 1 partial doc | create-only / `docs/modules/**` | ✅ Complete, accurate, clean manifest |
| 3 | Full module reindex | edit / `docs/modules/**` | ❌ Hit limit, wrote nothing, **no manifest** |
| 4 | Same reindex, extension update v1 | edit / `docs/modules/**` | ⚠️ Hit limit; manifest returned but **probe file written** |
| 5 | Reindex, exact `writePaths`, phase-ordered prompt | edit / exact 2 files | ✅ Complete. 385 lines. No probe file. LedgerService missing 4 methods (Claude patched). |
| 6 | Same + explicit LedgerService method checklist | edit / exact 2 files | ✅ Complete. All 4 methods present. 271 lines. Phase 3 sections left as stubs. |
| 7 | Full reindex, no phase-order workaround, extension update v2 | edit / exact 2 files | ✅ Complete. 359 lines. All sections filled. **affiliate.md written 4× (chunked)**. LedgerService missing 4 methods again. |

---

### What is working well
- **✅ Tasks now complete reliably.** Runs 3 and 4 failed (budget exhausted). Every run since exact
  `writePaths` was set completes. Either the budget increased with updates, or chunked writes (Run 7)
  are the resume mechanism working internally.
- **✅ Manifest always returned.** Run 3 returned nothing on limit-hit; all later runs return a manifest.
- **✅ No more probe files.** Setting `writePaths` to exact files (not a glob) eliminated the probe-file
  problem from Run 4. This is an orchestrator fix, not an extension fix — but it works.
- **✅ Chunked writes (Run 7).** `affiliate.md` appears 4× in the manifest — the engine wrote the file
  in multiple passes, likely filling sections incrementally. This is a good pattern: it means partial
  progress is saved even if something fails mid-run.
- **✅ All 13 sections filled when not phase-ordered (Run 7).** Filament, Jobs, Notifications, Tests all
  populated. Phase-ordered runs (5, 6) left those as stubs because they hit budget limits before Phase 3.

---

### Resume handle — not confirmed working (the main open question)

The extension reportedly implements a resume handle. After 3 post-update runs, **no `resumeId` has ever
been returned** in any response. Two possible explanations:

1. **Budget was increased** (silently) so tasks that previously failed now complete — resume was never
   triggered because the limit was never hit.
2. **Resume is internal and transparent** — the chunked writes in Run 7 (affiliate.md 4×) may be the
   resume mechanism at work, saving state between iterations without exposing a resumeId to the caller.

**What's needed to confirm:** Either (a) expose a `resumeId` in the response when the task hits a limit
mid-way and call again with it to verify continuation, or (b) document that resume is internal/transparent
so the orchestrator knows it doesn't need to handle it. Right now it's a black box.

---

### Persistent accuracy gap — LedgerService method omissions

Across Runs 5, 6, and 7, LedgerService consistently drops the same 4 methods from the output:
`releaseHeldCommission`, `writeAbsorbedReversal`, `forfeit`, `runningBalance`. Run 6 (with an explicit
method checklist in the prompt) was the only run where all 4 appeared. Run 7 (no checklist) dropped them
again and also hallucinated a non-existent `releasePendingCommissions` method.

This is the **single most important accuracy problem** in real use — the methods most likely to be omitted
are the non-obvious ones (not in the happy path), exactly the ones future Claude needs in the index.

Root causes:
- The engine reads LedgerService correctly (substance is right) but when writing the output it prioritises
  the methods it has the most "signal" on and drops tail methods under output pressure.
- Without line-numbered reads, it can't reliably anchor which methods it has and hasn't covered.

**Fix options (priority order):**
1. **Line-numbered file reads** (`cat -n` style in the file reader) — the model can cross-check "have I
   covered line 256 (`releaseHeldCommission`)?" before finishing the section. Most precise fix.
2. **Structured per-method output schema** — force a JSON list of `{name, signature, description}` per
   service before writing prose. Schema validation catches missing entries at generation time.
3. **Orchestrator workaround (current):** explicit method checklist in the prompt. Works (Run 6) but
   requires the orchestrator to know the method list in advance, defeating the purpose of automation.

---

### Other open findings

- **⚠️ Wrong method signatures on LedgerService.** In Run 7: `forceRelease` and `reHold` have wrong
  return types (shown as `CommissionLedger` — real return is `void`). Cause: same as above — no line
  anchoring means signature drift on methods that appear near the end of the file.
- **⚠️ Duplicate entry in manifest.** Run 7 `modified` array lists `affiliate.md` 4 times. Functionally
  fine (chunked writes) but makes programmatic manifest processing harder. Deduplicate or use a
  `{path, writeCount}` structure instead.
- **⚠️ Line-number references off by ~10–20** (every run). Mentioned in Section 5. Still not fixed.
  `cat -n`-style reads would fix both this and the method omission problem.

---

### Net assessment

The engine **reliably completes a full module reindex** and produces solid, useful output. The structural
problem (budget exhaustion killing the task) appears resolved. The remaining gaps are **accuracy problems**,
not completion problems: method omissions and signature drift on large service files. Both trace to the
same root cause — no line anchoring in file reads. **Line-numbered reads is the highest-value remaining
fix.** Resume handle status is unconfirmed — needs a test case that deliberately triggers the limit.
