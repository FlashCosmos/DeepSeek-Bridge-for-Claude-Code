import { describe, it, expect } from 'vitest';
import {
    commandMatchesAllowlist, splitSegments, segmentMatchesEntry,
    globToRegex, matchesWritePath, clampPosture, serverMaxPosture,
    calcCost, cacheSplit, parseArgv, unifiedDiff, workspaceKey,
    upsertManagedBlock, removeManagedBlock, claudeMdBlock,
    GUIDANCE_BEGIN, GUIDANCE_END, isValidResumeId, isScriptableExe,
    DEEPSEEK_PRICING, CLAUDE_PRICING,
    mergeRange, isFullyCovered, planPage, splitLines, ReadCoverage,
} from '../src/pure';

describe('command allowlist', () => {
    it('matches exact and prefix', () => {
        expect(commandMatchesAllowlist('node', ['node'])).toBe(true);
        expect(commandMatchesAllowlist('node script.js', ['node'])).toBe(true);
        expect(commandMatchesAllowlist('nodemon', ['node'])).toBe(false); // prefix requires a space
    });

    it('requires EVERY chained segment to match (blocks rm injection)', () => {
        expect(commandMatchesAllowlist('node good && rm -rf /', ['node'])).toBe(false);
        expect(commandMatchesAllowlist('npm test; npm run build', ['npm'])).toBe(true);
        expect(commandMatchesAllowlist('git status || curl evil', ['git'])).toBe(false);
    });

    it('does NOT split on bare pipe (quoted-arg safety)', () => {
        // bare | is intentionally not a segment separator
        expect(splitSegments('powershell -Command "x | Select-String"')).toHaveLength(1);
    });

    it('empty allowlist or empty command never matches', () => {
        expect(commandMatchesAllowlist('node', [])).toBe(false);
        expect(commandMatchesAllowlist('', ['node'])).toBe(false);
    });

    it('segmentMatchesEntry', () => {
        expect(segmentMatchesEntry('git', 'git')).toBe(true);
        expect(segmentMatchesEntry('github', 'git')).toBe(false);
    });

    it('flags scriptable executables', () => {
        expect(isScriptableExe('git')).toBe(true);
        expect(isScriptableExe('node.exe')).toBe(true);
        expect(isScriptableExe('ls')).toBe(false);
    });
});

describe('glob writePaths', () => {
    it('* matches within a segment, ** across segments', () => {
        expect(matchesWritePath('tests/a.ts', ['tests/**'])).toBe(true);
        expect(matchesWritePath('tests/sub/a.ts', ['tests/**'])).toBe(true);
        expect(matchesWritePath('docs/x.md', ['docs/*.md'])).toBe(true);
        expect(matchesWritePath('docs/sub/x.md', ['docs/*.md'])).toBe(false);
        expect(matchesWritePath('src/x.ts', ['tests/**'])).toBe(false);
    });
    it('normalizes backslashes', () => {
        expect(matchesWritePath('tests\\a.ts', ['tests/**'])).toBe(true);
    });
    it('globToRegex anchors fully', () => {
        expect(globToRegex('src/*.ts').test('src/a.ts')).toBe(true);
        expect(globToRegex('src/*.ts').test('other/src/a.ts')).toBe(false);
    });
});

describe('posture clamping', () => {
    it('serverMaxPosture maps config', () => {
        expect(serverMaxPosture('read-only')).toBe('read');
        expect(serverMaxPosture('edit')).toBe('edit');
    });
    it('clamps requested down to max, never up', () => {
        expect(clampPosture('edit', 'read')).toBe('read');
        expect(clampPosture('read', 'edit')).toBe('read');
        expect(clampPosture('create-only', 'edit')).toBe('create-only');
        expect(clampPosture(undefined, 'edit')).toBe('edit');
        expect(clampPosture('garbage', 'create-only')).toBe('create-only');
    });
});

describe('cost math', () => {
    it('cacheSplit reports presence of cache fields', () => {
        expect(cacheSplit(undefined)).toEqual({ hit: 0, miss: 0, reported: false });
        expect(cacheSplit({ prompt_tokens: 100, completion_tokens: 10 })).toEqual({ hit: 0, miss: 100, reported: false });
        expect(cacheSplit({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 }))
            .toEqual({ hit: 80, miss: 20, reported: true });
    });
    it('calcCost uses per-rate components', () => {
        const c = calcCost(DEEPSEEK_PRICING, 'deepseek-v4-flash', 1_000_000, 1_000_000, 1_000_000);
        expect(c).toBeCloseTo(0.0028 + 0.14 + 0.28, 6);
    });
    it('unknown model falls back to flash pricing', () => {
        expect(calcCost(DEEPSEEK_PRICING, 'nope', 0, 1_000_000, 0)).toBeCloseTo(0.14, 6);
    });
    it('corrected V4-Pro and Claude rates are present', () => {
        expect(DEEPSEEK_PRICING['deepseek-v4-pro'].output).toBeCloseTo(0.87, 6);
        expect(CLAUDE_PRICING.opus).toEqual({ input: 5.0, output: 25.0 });
        expect(CLAUDE_PRICING.haiku).toEqual({ input: 1.0, output: 5.0 });
    });
});

describe('parseArgv', () => {
    it('splits respecting quotes', () => {
        expect(parseArgv('node script.js')).toEqual(['node', 'script.js']);
        expect(parseArgv('echo "a b" c')).toEqual(['echo', 'a b', 'c']);
        expect(parseArgv("git commit -m 'hello world'")).toEqual(['git', 'commit', '-m', 'hello world']);
    });
});

describe('unifiedDiff', () => {
    it('empty when identical', () => {
        expect(unifiedDiff('a\nb', 'a\nb', 'f.txt')).toBe('');
    });
    it('shows changed lines with +/- markers', () => {
        const d = unifiedDiff('a\nb\nc', 'a\nB\nc', 'f.txt');
        expect(d).toContain('--- a/f.txt');
        expect(d).toContain('+++ b/f.txt');
        expect(d).toContain('-b');
        expect(d).toContain('+B');
        expect(d).toContain(' a'); // context preserved
    });
});

describe('workspaceKey', () => {
    it('is stable and case/separator-insensitive', () => {
        const a = workspaceKey('D:\\Projects\\Foo');
        const b = workspaceKey('d:/projects/foo');
        const c = workspaceKey('d:/projects/foo/');
        expect(a).toBe(b);
        expect(a).toBe(c);
        expect(a).toHaveLength(16);
    });
    it('differs for different paths', () => {
        expect(workspaceKey('/a')).not.toBe(workspaceKey('/b'));
    });
});

describe('managed CLAUDE.md block', () => {
    it('appends when absent and is idempotent', () => {
        const block = claudeMdBlock('balanced');
        const once = upsertManagedBlock('# My Project\n\nNotes.', block);
        expect(once).toContain(GUIDANCE_BEGIN);
        expect(once).toContain(GUIDANCE_END);
        expect(once).toContain('# My Project');
        const twice = upsertManagedBlock(once, block);
        // exactly one managed block after re-applying
        expect(twice.split(GUIDANCE_BEGIN).length - 1).toBe(1);
    });
    it('replaces an existing block in place', () => {
        const a = upsertManagedBlock('top', claudeMdBlock('conservative'));
        const b = upsertManagedBlock(a, claudeMdBlock('aggressive'));
        expect(b.split(GUIDANCE_BEGIN).length - 1).toBe(1);
        expect(b).toContain('top');
    });
    it('removeManagedBlock strips it and preserves user content', () => {
        const withBlock = upsertManagedBlock('# Keep me', claudeMdBlock('balanced'));
        const stripped = removeManagedBlock(withBlock);
        expect(stripped).toContain('# Keep me');
        expect(stripped).not.toContain(GUIDANCE_BEGIN);
    });
});

describe('resumeId validation', () => {
    it('accepts generated shape, rejects traversal', () => {
        expect(isValidResumeId('ds-resume-abc123-x9y8z')).toBe(true);
        expect(isValidResumeId('../etc/passwd')).toBe(false);
        expect(isValidResumeId('ds-resume-../../x')).toBe(false);
        expect(isValidResumeId('random')).toBe(false);
    });
});

// ── Paged reads & read coverage ─────────────────────────────────────────────────

const cov = (totalLines: number, ranges: Array<[number, number]> = []): ReadCoverage =>
    ({ totalLines, ranges });

describe('read coverage', () => {
    it('merges overlapping and adjacent ranges', () => {
        expect(mergeRange(cov(100, [[1, 50]]), 51, 100).ranges).toEqual([[1, 100]]);
        expect(mergeRange(cov(100, [[1, 50]]), 40, 80).ranges).toEqual([[1, 80]]);
        expect(mergeRange(cov(100, [[1, 50]]), 60, 80).ranges).toEqual([[1, 50], [60, 80]]);
    });

    it('handles out-of-order paging', () => {
        let c = cov(90);
        c = mergeRange(c, 61, 90);
        c = mergeRange(c, 1, 30);
        expect(isFullyCovered(c)).toBe(false);
        c = mergeRange(c, 31, 60);
        expect(c.ranges).toEqual([[1, 90]]);
        expect(isFullyCovered(c)).toBe(true);
    });

    it('only reports full coverage from line 1 to the end', () => {
        expect(isFullyCovered(undefined)).toBe(false);
        expect(isFullyCovered(cov(100))).toBe(false);
        expect(isFullyCovered(cov(100, [[1, 99]]))).toBe(false);   // tail unread
        expect(isFullyCovered(cov(100, [[2, 100]]))).toBe(false);  // head unread
        expect(isFullyCovered(cov(100, [[1, 100]]))).toBe(true);
    });

    it('a stale range does not cover a file that grew', () => {
        // File was read fully at 50 lines, then rewritten longer: must not count.
        const grown = { ...cov(120, [[1, 50]]) };
        expect(isFullyCovered(grown)).toBe(false);
    });
});

describe('planPage', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

    it('numbers lines 1-based and reports the range', () => {
        const p = planPage(lines, 1, Infinity, 10_000);
        expect(p.from).toBe(1);
        expect(p.to).toBe(10);
        expect(p.body.split('\n')[0]).toBe('1\tline 1');
        expect(p.body.split('\n')[9]).toBe('10\tline 10');
    });

    it('respects an explicit limit', () => {
        const p = planPage(lines, 3, 2, 10_000);
        expect([p.from, p.to]).toEqual([3, 4]);
        expect(p.body).toBe('3\tline 3\n4\tline 4');
    });

    it('stops at the char budget so the page is never blind-truncated', () => {
        const p = planPage(lines, 1, Infinity, 20);
        expect(p.to).toBeLessThan(10);
        expect(p.body.length).toBeLessThanOrEqual(20);
    });

    it('always emits at least one line, even an oversized one', () => {
        const p = planPage(['x'.repeat(500)], 1, Infinity, 10);
        expect(p.to).toBe(1);
        expect(p.body).toContain('x');
    });

    it('clamps an out-of-range offset instead of returning nothing', () => {
        expect(planPage(lines, 99, Infinity, 10_000).from).toBe(10);
        expect(planPage(lines, 0, Infinity, 10_000).from).toBe(1);
        expect(planPage(lines, -5, Infinity, 10_000).from).toBe(1);
    });

    it('paging start-to-end covers every line exactly once', () => {
        const big = Array.from({ length: 200 }, (_, i) => `content of line ${i + 1}`);
        let c = cov(big.length);
        let next = 1;
        for (let guard = 0; guard < 50 && next <= big.length; guard++) {
            const p = planPage(big, next, Infinity, 200);
            c = mergeRange(c, p.from, p.to);
            next = p.to + 1;
        }
        expect(isFullyCovered(c)).toBe(true);
    });

    it('handles an empty file', () => {
        expect(planPage([], 1, Infinity, 100)).toEqual({ from: 1, to: 0, body: '' });
    });
});

describe('splitLines', () => {
    it('drops only the phantom line from a trailing newline', () => {
        expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
        expect(splitLines('a\nb')).toEqual(['a', 'b']);
        expect(splitLines('a\n\n')).toEqual(['a', '']);
        expect(splitLines('')).toEqual(['']);
    });
});
