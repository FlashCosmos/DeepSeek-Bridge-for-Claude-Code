import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createJail } from '../src/jail';

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
