import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createJail } from '../src/jail';
import { compileSecretGlobs } from '../src/pure';

let root: string;
let jail: ReturnType<typeof createJail>;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-jail-'));
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hello');
    jail = createJail(root, { auditLog: path.join(os.tmpdir(), 'ds-jail-audit.log') });
});

afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('jailPath containment', () => {
    it('allows in-workspace relative paths', () => {
        expect(() => jail.jailPath('ok.txt')).not.toThrow();
        expect(() => jail.jailPath('sub/new.txt')).not.toThrow();
    });
    it('rejects parent traversal', () => {
        expect(() => jail.jailPath('../escape.txt')).toThrow();
        expect(() => jail.jailPath('a/../../escape.txt')).toThrow();
    });
    it('rejects drive-letter and UNC/device paths', () => {
        expect(() => jail.jailPath('C:\\Windows\\system32')).toThrow();
        expect(() => jail.jailPath('\\\\server\\share')).toThrow();
        expect(() => jail.jailPath('\\\\.\\C:')).toThrow();
    });
    it('rejects alternate data streams and trailing dot/space', () => {
        expect(() => jail.jailPath('file.txt:stream')).toThrow();
        expect(() => jail.jailPath('name. /x')).toThrow();
    });
    it('rejects empty path', () => {
        expect(() => jail.jailPath('')).toThrow();
    });
});

describe('sensitive-file denylist', () => {
    const blocked = [
        '.env', '.env.production', '.git/config', '.git-credentials', '.npmrc', '.netrc',
        '.ssh/id_rsa', '.aws/credentials', '.kube/config', 'kubeconfig', '.dockercfg',
        '.pgpass', 'terraform.tfstate', 'prod.tfvars', 'wp-config.php', 'auth.json',
        'serviceAccount.json', 'project-1234-key.json', 'credentials', 'credentials.json',
        'secrets.yaml', 'secrets.json', 'id_rsa', 'server.pem', 'cert.key', 'data.sqlite',
        'data.sqlite3', '.claude.json', 'bash_history',
    ];
    for (const rel of blocked) {
        it(`blocks ${rel}`, () => {
            const canonical = path.join(root, rel);
            expect(jail.isSensitive(canonical)).toBe(true);
            expect(() => jail.assertNotSensitive(canonical, 'read')).toThrow();
        });
    }

    const allowed = ['src/index.ts', 'README.md', 'package.json', 'docs/guide.md', 'config.yaml'];
    for (const rel of allowed) {
        it(`allows ${rel}`, () => {
            expect(jail.isSensitive(path.join(root, rel))).toBe(false);
            expect(() => jail.assertNotSensitive(path.join(root, rel), 'read')).not.toThrow();
        });
    }

    it('blocks the audit log itself', () => {
        expect(jail.isSensitive(jail.auditLog)).toBe(true);
    });
});

describe('custom deny patterns + exceptions', () => {
    let denyGlobs: string[] = [];
    let allowGlobs: string[] = [];
    let cjail: ReturnType<typeof createJail>;
    beforeAll(() => {
        cjail = createJail(root, {
            auditLog:  path.join(os.tmpdir(), 'ds-jail-audit2.log'),
            extraDeny: () => compileSecretGlobs(denyGlobs),
            allow:     () => compileSecretGlobs(allowGlobs),
        });
    });

    it('blocks a user-added glob (segment + cross-directory)', () => {
        denyGlobs = ['secrets/**', '**/*.secret', 'config/prod.json'];
        allowGlobs = [];
        expect(cjail.isSensitive(path.join(root, 'secrets', 'db.txt'))).toBe(true);
        expect(cjail.isSensitive(path.join(root, 'a', 'b', 'token.secret'))).toBe(true);
        expect(cjail.isSensitive(path.join(root, 'config', 'prod.json'))).toBe(true);
        expect(() => cjail.assertNotSensitive(path.join(root, 'secrets', 'db.txt'), 'read')).toThrow();
    });

    it('does not block paths outside the user globs', () => {
        denyGlobs = ['secrets/**'];
        allowGlobs = [];
        expect(cjail.isSensitive(path.join(root, 'src', 'index.ts'))).toBe(false);
    });

    it('reads the deny/allow lists live (thunks, not a snapshot)', () => {
        denyGlobs = [];
        expect(cjail.isSensitive(path.join(root, 'vault', 'x'))).toBe(false);
        denyGlobs = ['vault/**'];
        expect(cjail.isSensitive(path.join(root, 'vault', 'x'))).toBe(true);
    });

    it('an exception un-blocks a custom-denied path', () => {
        denyGlobs = ['secrets/**'];
        allowGlobs = ['secrets/public.json'];
        expect(cjail.isSensitive(path.join(root, 'secrets', 'db.txt'))).toBe(true);
        expect(cjail.isSensitive(path.join(root, 'secrets', 'public.json'))).toBe(false);
    });

    it('an exception un-blocks a built-in default', () => {
        denyGlobs = [];
        allowGlobs = ['.env'];
        expect(cjail.isSensitive(path.join(root, '.env'))).toBe(false);
        // a different default stays blocked
        expect(cjail.isSensitive(path.join(root, '.env.production'))).toBe(true);
    });

    it('an exception can never un-block the audit log', () => {
        denyGlobs = [];
        allowGlobs = ['**'];
        expect(cjail.isSensitive(cjail.auditLog)).toBe(true);
    });
});
