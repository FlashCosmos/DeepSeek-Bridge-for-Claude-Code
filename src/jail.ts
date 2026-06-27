import * as fs from 'fs';
import * as path from 'path';

// Secret-bearing / persistence-relevant paths blocked even INSIDE the workspace.
// Tested against the CANONICAL realpath (defeats 8.3 short-names) — both rel and abs forms.
// NOTE: a path denylist is necessarily non-exhaustive; the UI/README must say so.
export const DEFAULT_DENY: RegExp[] = [
    // Environment / package / VCS secrets
    /(^|[\\/])\.env(\.[^\\/]+)?$/i,
    /(^|[\\/])\.git([\\/]|$)/i,
    /\.git-credentials$/i,
    /\.npmrc$/i,
    /(^|[\\/])\.netrc$/i,
    // SSH / cloud provider credentials
    /(^|[\\/])\.ssh([\\/]|$)/i,
    /(^|[\\/])\.aws([\\/]|$)/i,
    /(^|[\\/])\.azure([\\/]|$)/i,
    /(^|[\\/])\.gcloud([\\/]|$)/i,
    /(^|[\\/])\.kube([\\/]|$)/i,
    /(^|[\\/])kubeconfig$/i,
    /(^|[\\/])\.docker([\\/]|$)/i,
    /(^|[\\/])\.dockercfg$/i,
    /(^|[\\/])serviceaccount[^\\/]*\.json$/i,   // GCP service account
    /-key\.json$/i,                              // GCP / generic key material
    /(^|[\\/])credentials(\.json)?$/i,           // bare credentials file / credentials.json
    /(^|[\\/])secrets\.(ya?ml|json|env)$/i,
    // Database / state / app secrets
    /(^|[\\/])\.pgpass$/i,
    /\.tfstate(\.backup)?$/i,                     // Terraform state (often holds secrets)
    /\.tfvars$/i,
    /(^|[\\/])wp-config\.php$/i,                  // WordPress DB credentials
    /(^|[\\/])auth\.json$/i,                      // Composer credentials
    /\.sqlite\d*$/i,                              // SQLite databases
    // Keys, history, persistence
    /(^|[\\/])\.claude(\.json)?([\\/]|$)/i,
    /_history$/i,
    /(^|[\\/])id_[a-z0-9]+$/i,
    /\.(pem|key|pfx|p12|kdbx|ppk)$/i,
    /(^|[\\/])Startup([\\/]|$)/i,
    /Microsoft\.PowerShell_profile\.ps1$/i,
    /(^|[\\/])storage[\\/]logs([\\/]|$)/i,        // may contain PII
];

export interface Jail {
    root: string;
    auditLog: string;
    /** Canonicalize and confine a path to the workspace, or throw. */
    jailPath(p: string): string;
    /** Throw if the canonical path is a blocked secret/persistence location. */
    assertNotSensitive(canonical: string, mode: 'read' | 'write'): void;
    /** Non-throwing predicate used to filter directory listings. */
    isSensitive(canonical: string): boolean;
}

export function createJail(rootRaw: string, opts?: { deny?: RegExp[]; auditLog?: string }): Jail {
    let ROOT: string;
    try { ROOT = fs.realpathSync.native(path.resolve(rootRaw)); }
    catch { ROOT = path.resolve(rootRaw); }

    const DENY = opts?.deny ?? DEFAULT_DENY;
    const AUDIT_LOG = opts?.auditLog ?? path.join(ROOT, '.deepseek-audit.log');

    function jailPath(p: string): string {
        if (typeof p !== 'string' || p.length === 0) throw new Error('empty path');

        // 1. Reject syntactic Windows escape forms before path.resolve collapses them.
        if (/^[\\/]{2}/.test(p) || /^\\\\[?.]\\/.test(p)) throw new Error('UNC/device paths are not allowed');
        if (/[A-Za-z]:/.test(p)) throw new Error('drive-letter paths are not allowed'); // C:\, D:\, and C:foo

        // 2. Reject alternate data streams and trailing dot/space per segment.
        //    '.' and '..' navigation segments are exempt — they're handled by the
        //    containment check below; only real names with a trailing dot/space (a
        //    Windows filter-bypass trick) are rejected.
        for (const seg of p.split(/[\\/]/)) {
            if (seg === '' || seg === '.' || seg === '..') continue;
            if (seg.includes(':')) throw new Error('alternate data streams are not allowed');
            if (/[ .]$/.test(seg)) throw new Error('trailing dot/space in a path segment is not allowed');
        }

        // 3. Lexical containment.
        const full = path.resolve(ROOT, p);
        let rel = path.relative(ROOT, full);
        if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
            throw new Error('path escapes workspace');
        }

        // 4. Realpath the deepest EXISTING ancestor to defeat symlink/junction escape,
        //    then rebuild the canonical path (this also expands 8.3 short names).
        let probe = full;
        while (!fs.existsSync(probe) && path.relative(ROOT, probe) !== '') probe = path.dirname(probe);
        let realProbe: string;
        try { realProbe = fs.realpathSync.native(probe); }
        catch { realProbe = probe; }

        rel = path.relative(ROOT, realProbe);
        if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
            throw new Error('symlink escapes workspace');
        }

        const remainder = path.relative(probe, full); // non-existent tail (for new files)
        const canonical = remainder ? path.join(realProbe, remainder) : realProbe;

        // Re-verify the fully-assembled canonical path is still contained.
        const relCanon = path.relative(ROOT, canonical);
        if (relCanon !== '' && (relCanon.startsWith('..') || path.isAbsolute(relCanon))) {
            throw new Error('path escapes workspace');
        }
        return canonical;
    }

    function isSensitive(canonical: string): boolean {
        if (canonical === AUDIT_LOG) return true;
        const rel = path.relative(ROOT, canonical);
        return DENY.some(r => r.test(rel) || r.test(canonical));
    }

    function assertNotSensitive(canonical: string, mode: 'read' | 'write'): void {
        if (canonical === AUDIT_LOG) throw new Error('access to the audit log is blocked');
        const rel = path.relative(ROOT, canonical);
        for (const r of DENY) {
            if (r.test(rel) || r.test(canonical)) throw new Error(`blocked sensitive path (${mode})`);
        }
    }

    return { root: ROOT, auditLog: AUDIT_LOG, jailPath, assertNotSensitive, isSensitive };
}
