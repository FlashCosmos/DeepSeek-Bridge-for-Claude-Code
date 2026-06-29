// ─────────────────────────────────────────────────────────────────────────────
// pure.ts — side-effect-free logic shared between the MCP server (server.ts) and
// the VS Code extension host (extension.ts / config.ts).
//
// CRITICAL: this module must NEVER import 'vscode', start a transport, read env,
// or call process.exit. It is imported by unit tests directly, so importing it
// must do nothing but define functions/constants.
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from 'crypto';

// ── Settings shared via the runtime settings file ───────────────────────────────

export type Aggressiveness = 'conservative' | 'balanced' | 'aggressive';
export type Posture = 'read' | 'create-only' | 'edit';
export type ServerPosture = 'edit' | 'read-only';
export type ModelAuto = 'no' | 'ask' | 'yes';

export interface BridgeSettings {
    model:          string;
    posture:        ServerPosture;
    modelAuto:      ModelAuto;
    aggressiveness: Aggressiveness;
    baseUrl:        string;
    allowCommands:  string[];
    fullPermissions: boolean;
}

export const DEFAULT_SETTINGS: BridgeSettings = {
    model:           'deepseek-v4-flash',
    posture:         'edit',
    modelAuto:       'no',
    aggressiveness:  'balanced',
    baseUrl:         'https://api.deepseek.com',
    allowCommands:   [],
    fullPermissions: false,
};

// ── Pricing (per 1M tokens, USD) ────────────────────────────────────────────────
// DeepSeek caches prompt prefixes automatically; a cache hit bills at a fraction
// of the miss rate. NOTE: verify against https://api-docs.deepseek.com/quick_start/pricing.
// Pricing as of 2026-06-27.
export const PRICING_AS_OF = '2026-06-27';

export const DEEPSEEK_PRICING: Record<string, { cacheHit: number; cacheMiss: number; output: number }> = {
    'deepseek-v4-flash': { cacheHit: 0.0028,   cacheMiss: 0.14,  output: 0.28 },
    'deepseek-v4-pro':   { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
};

// Current Claude rate card (per 1M tokens, USD) for the savings comparison.
export const CLAUDE_PRICING: Record<string, { input: number; output: number }> = {
    haiku:  { input: 1.00,  output: 5.00  },
    sonnet: { input: 3.00,  output: 15.00 },
    opus:   { input: 5.00,  output: 25.00 },
};

export function calcCost(
    pricing: Record<string, { cacheHit: number; cacheMiss: number; output: number }>,
    model: string,
    cacheHitTok: number,
    cacheMissTok: number,
    outputTok: number
): number {
    const p = pricing[model] ?? pricing['deepseek-v4-flash'] ?? DEEPSEEK_PRICING['deepseek-v4-flash'];
    return (cacheHitTok  / 1_000_000) * p.cacheHit
         + (cacheMissTok / 1_000_000) * p.cacheMiss
         + (outputTok    / 1_000_000) * p.output;
}

export interface DeepSeekUsage {
    prompt_tokens:             number;
    completion_tokens:         number;
    prompt_cache_hit_tokens?:  number;
    prompt_cache_miss_tokens?: number;
}

// Split usage into {hit, miss}. `reported` is false when the API omitted the cache
// fields entirely — callers should render the cache ratio as "unknown" rather than 0%.
export function cacheSplit(u: DeepSeekUsage | undefined): { hit: number; miss: number; reported: boolean } {
    if (!u) return { hit: 0, miss: 0, reported: false };
    const reported = u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
    const hit  = u.prompt_cache_hit_tokens ?? 0;
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - hit);
    return { hit, miss, reported };
}

// ── Posture clamping ────────────────────────────────────────────────────────────

export const POSTURE_RANK: Record<Posture, number> = { read: 0, 'create-only': 1, edit: 2 };

export function serverMaxPosture(rawPosture: string): Posture {
    return rawPosture === 'read-only' || rawPosture === 'read' ? 'read' : 'edit';
}

export function clampPosture(requested: unknown, max: Posture): Posture {
    if (typeof requested !== 'string' || !(requested in POSTURE_RANK)) return max;
    const r = requested as Posture;
    return POSTURE_RANK[r] <= POSTURE_RANK[max] ? r : max;
}

// ── Command allowlist matching ──────────────────────────────────────────────────

export function segmentMatchesEntry(segment: string, entry: string): boolean {
    return segment === entry || segment.startsWith(entry + ' ');
}

// Split a chained command on unambiguous shell operators that appear OUTSIDE of
// quoted strings. Bare | is excluded — it appears inside quoted args. Semicolons
// inside single- or double-quoted strings (e.g. php -r '$a=1; $b=2;') are NOT
// treated as separators, preventing false-negative allowlist mismatches.
export function splitSegments(command: string): string[] {
    const segments: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < command.length; i++) {
        const ch = command[i];

        if (ch === "'" && !inDouble) { inSingle = !inSingle; current += ch; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; current += ch; continue; }
        if (ch === '\\' && !inSingle && i + 1 < command.length) {
            current += ch + command[++i]; continue;
        }

        if (!inSingle && !inDouble) {
            if ((ch === '&' && command[i + 1] === '&') || (ch === '|' && command[i + 1] === '|')) {
                const seg = current.trim(); if (seg) segments.push(seg); current = ''; i++; continue;
            }
            if (ch === ';') {
                const seg = current.trim(); if (seg) segments.push(seg); current = ''; continue;
            }
        }

        current += ch;
    }

    const last = current.trim(); if (last) segments.push(last);
    return segments;
}

// Every chained segment must match an allowlist entry. Prevents "node good && rm -rf /"
// being approved via a "node" prefix.
export function commandMatchesAllowlist(command: string, list: Iterable<string>): boolean {
    const entries = [...list];
    if (!entries.length) return false;
    const segments = splitSegments(command);
    if (!segments.length) return false;
    return segments.every(seg => entries.some(entry => segmentMatchesEntry(seg, entry)));
}

// Executables whose own facilities allow arbitrary code execution. A broad
// "Any <exe>" approval of these is effectively full execution rights.
export const SCRIPTABLE_EXES = new Set([
    'git', 'npm', 'npx', 'yarn', 'pnpm', 'node', 'deno', 'bun',
    'python', 'python3', 'ruby', 'perl', 'php',
    'env', 'sh', 'bash', 'zsh', 'pwsh', 'powershell', 'cmd',
    'make', 'docker', 'ssh', 'find', 'awk', 'xargs', 'eval',
]);

export function isScriptableExe(exe: string): boolean {
    return SCRIPTABLE_EXES.has(exe.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase());
}

// ── writePaths glob matching ────────────────────────────────────────────────────

export function globToRegex(pattern: string): RegExp {
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexStr = esc
        .replace(/\*\*/g, '\x00')   // placeholder for **
        .replace(/\*/g, '[^/]*')    // * matches within a segment
        .replace(/\x00/g, '.*');    // ** matches across segments
    return new RegExp(`^${regexStr}(/.*)?$`);
}

export function matchesWritePath(relPath: string, patterns: string[]): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    return patterns.some(p => globToRegex(p).test(normalized));
}

// ── Argv parsing for shell:false spawn ──────────────────────────────────────────

export function parseArgv(cmd: string): string[] {
    const argv: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (const ch of cmd) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === ' ') {
            if (current) { argv.push(current); current = ''; }
        } else {
            current += ch;
        }
    }
    if (current) argv.push(current);
    return argv;
}

// ── Per-window key (must match on both extension + server side) ──────────────────

export function workspaceKey(rawPath: string | undefined | null): string {
    const norm = (rawPath ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    return crypto.createHash('sha1').update(norm || 'no-workspace').digest('hex').slice(0, 16);
}

// ── Unified diff (small, dependency-free) ───────────────────────────────────────
// Produces a git-style unified diff with 3 lines of context. Used so applied edits
// and dry-run proposals can be reviewed without re-reading whole files.

export function unifiedDiff(oldStr: string, newStr: string, filePath: string, context = 3): string {
    if (oldStr === newStr) return '';
    const a = oldStr.length ? oldStr.split('\n') : [];
    const b = newStr.length ? newStr.split('\n') : [];

    // Guard: LCS is O(n*m); fall back for very large files.
    if (a.length > 4000 || b.length > 4000) {
        return `--- a/${filePath}\n+++ b/${filePath}\n@@ file too large for inline diff (${a.length} -> ${b.length} lines) @@`;
    }

    // LCS table.
    const m = a.length, n = b.length;
    const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }

    // Build edit script: each op is ' ' (equal), '-' (del), '+' (add).
    type Op = { t: ' ' | '-' | '+'; line: string };
    const ops: Op[] = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
        else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
        else { ops.push({ t: '+', line: b[j] }); j++; }
    }
    while (i < m) { ops.push({ t: '-', line: a[i] }); i++; }
    while (j < n) { ops.push({ t: '+', line: b[j] }); j++; }

    // Group into hunks with `context` lines around changes.
    const hunks: Op[][] = [];
    let cur: Op[] = [];
    let sinceChange = Infinity;
    for (let k = 0; k < ops.length; k++) {
        const op = ops[k];
        if (op.t !== ' ') {
            // back-fill leading context if starting a new hunk
            if (!cur.length) {
                for (let c = Math.max(0, k - context); c < k; c++) cur.push(ops[c]);
            }
            cur.push(op);
            sinceChange = 0;
        } else {
            sinceChange++;
            if (cur.length) {
                if (sinceChange <= context) cur.push(op);
                else { hunks.push(cur); cur = []; sinceChange = Infinity; }
            }
        }
    }
    if (cur.length) hunks.push(cur);
    if (!hunks.length) return '';

    // Emit.
    const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];
    let aPos = 0, bPos = 0, opIdx = 0;
    for (const hunk of hunks) {
        // Find this hunk's start position in ops to compute line numbers.
        // Recompute aStart/bStart by walking ops up to the hunk's first element.
        const first = hunk[0];
        while (opIdx < ops.length && ops[opIdx] !== first) {
            if (ops[opIdx].t !== '+') aPos++;
            if (ops[opIdx].t !== '-') bPos++;
            opIdx++;
        }
        const aStart = aPos, bStart = bPos;
        let aCount = 0, bCount = 0;
        for (const op of hunk) {
            if (op.t !== '+') aCount++;
            if (op.t !== '-') bCount++;
        }
        out.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
        for (const op of hunk) out.push(op.t + op.line);
        // advance positions past the hunk
        for (const op of hunk) {
            if (op.t !== '+') aPos++;
            if (op.t !== '-') bPos++;
            opIdx++;
        }
    }
    return out.join('\n');
}

// ── Delegation guidance (the "seamlessness" engine) ─────────────────────────────

export const GUIDANCE_BEGIN = '<!-- BEGIN DEEPSEEK-BRIDGE (managed — do not edit) -->';
export const GUIDANCE_END   = '<!-- END DEEPSEEK-BRIDGE -->';

interface AggProfile { fileThreshold: number; lineThreshold: number; verb: string; }

const AGG_PROFILES: Record<Aggressiveness, AggProfile> = {
    conservative: { fileThreshold: 5, lineThreshold: 800, verb: 'Consider delegating' },
    balanced:     { fileThreshold: 3, lineThreshold: 400, verb: 'Prefer delegating' },
    aggressive:   { fileThreshold: 2, lineThreshold: 150, verb: 'Delegate by default' },
};

// The policy paragraph Claude reads. Identical wording is used for the MCP server
// `instructions` field and the managed CLAUDE.md block, so they can never drift.
export function delegationPolicy(agg: Aggressiveness): string {
    const p = AGG_PROFILES[agg] ?? AGG_PROFILES.balanced;
    return [
        `You have a DeepSeek Bridge available via the \`run_deepseek_task\` and \`ask_deepseek\` MCP tools. ` +
        `DeepSeek runs token-heavy work on a far cheaper model so you spend fewer of your own tokens.`,
        ``,
        `${p.verb} to \`run_deepseek_task\` instead of doing the work yourself whenever a chore involves:`,
        `- reading or editing ${p.fileThreshold}+ files, or any file over ~${p.lineThreshold} lines;`,
        `- multi-file refactors, large code generation, or mechanical edits across a codebase;`,
        `- summarizing, analyzing, or indexing large files or many files at once.`,
        ``,
        `Use \`ask_deepseek\` for self-contained, token-heavy reasoning or explanations where no file access is needed.`,
        `Keep small, surgical, single-file edits and final review/verification in your own context.`,
        `When you delegate, scope the task with \`posture\` and \`writePaths\`, then review the returned diff/manifest rather than re-reading whole files.`,
    ].join('\n');
}

// One-line directive for the MCP server-level `instructions` field.
export function mcpInstructions(agg: Aggressiveness): string {
    const p = AGG_PROFILES[agg] ?? AGG_PROFILES.balanced;
    return `This server bridges heavy work to DeepSeek to conserve your tokens. ${p.verb} ` +
        `to run_deepseek_task for chores touching ${p.fileThreshold}+ files, files over ~${p.lineThreshold} lines, ` +
        `multi-file refactors, large codegen, or large-file analysis — instead of reading/editing those files yourself. ` +
        `Use ask_deepseek for self-contained token-heavy reasoning. Keep small single-file edits and final review in your own context.`;
}

// The full managed block written into CLAUDE.md (idempotent via markers).
export function claudeMdBlock(agg: Aggressiveness): string {
    return [
        GUIDANCE_BEGIN,
        '## DeepSeek delegation policy',
        '',
        delegationPolicy(agg),
        GUIDANCE_END,
    ].join('\n');
}

// Replace an existing managed block in `content`, or append one. Preserves all
// user content outside the markers.
export function upsertManagedBlock(content: string, block: string): string {
    const begin = content.indexOf(GUIDANCE_BEGIN);
    const end   = content.indexOf(GUIDANCE_END);
    if (begin !== -1 && end !== -1 && end > begin) {
        const before = content.slice(0, begin);
        const after  = content.slice(end + GUIDANCE_END.length);
        return (before.replace(/\s*$/, '') + '\n\n' + block + after.replace(/^\s*/, '\n')).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }
    const base = content.trimEnd();
    return (base ? base + '\n\n' : '') + block + '\n';
}

export function removeManagedBlock(content: string): string {
    const begin = content.indexOf(GUIDANCE_BEGIN);
    const end   = content.indexOf(GUIDANCE_END);
    if (begin !== -1 && end !== -1 && end > begin) {
        return (content.slice(0, begin).replace(/\s*$/, '') + '\n' + content.slice(end + GUIDANCE_END.length).replace(/^\s*/, '')).trimEnd() + '\n';
    }
    return content;
}

// ── resumeId validation ─────────────────────────────────────────────────────────

export function isValidResumeId(id: string): boolean {
    return /^ds-resume-[a-z0-9]+-[a-z0-9]+$/.test(id);
}
