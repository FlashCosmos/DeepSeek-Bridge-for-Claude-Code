import { describe, it, expect } from 'vitest';
import {
    commandMatchesAllowlist, splitSegments, segmentMatchesEntry,
    globToRegex, matchesWritePath, clampPosture, serverMaxPosture,
    calcCost, cacheSplit, parseArgv, unifiedDiff, workspaceKey,
    upsertManagedBlock, removeManagedBlock, claudeMdBlock,
    GUIDANCE_BEGIN, GUIDANCE_END, isValidResumeId, isScriptableExe,
    DEEPSEEK_PRICING, CLAUDE_PRICING,
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
