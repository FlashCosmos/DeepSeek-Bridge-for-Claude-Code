import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    BridgeSettings,
    DEFAULT_SETTINGS,
    Aggressiveness,
    ModelAuto,
    ServerPosture,
    claudeMdBlock,
    upsertManagedBlock,
    removeManagedBlock,
} from './pure';

export type InjectTarget = 'workspace' | 'user' | 'off';

// ── Settings: VS Code configuration is the source of truth (Settings Sync,
//    per-workspace overrides, settings search all work for free). The API key
//    stays in SecretStorage — never in settings.json. ──────────────────────────

export function readSettings(): BridgeSettings {
    const c = vscode.workspace.getConfiguration('deepseekBridge');
    return {
        model:           c.get<string>('model', DEFAULT_SETTINGS.model),
        posture:         (c.get<string>('posture', DEFAULT_SETTINGS.posture) === 'read-only' ? 'read-only' : 'edit') as ServerPosture,
        modelAuto:       c.get<ModelAuto>('modelAuto', DEFAULT_SETTINGS.modelAuto),
        aggressiveness:  c.get<Aggressiveness>('delegationAggressiveness', DEFAULT_SETTINGS.aggressiveness),
        baseUrl:         c.get<string>('baseUrl', DEFAULT_SETTINGS.baseUrl) || DEFAULT_SETTINGS.baseUrl,
        allowCommands:   c.get<string[]>('allowCommands', []),
        fullPermissions: c.get<boolean>('fullPermissions', false),
    };
}

export function getInjectTarget(): InjectTarget {
    return vscode.workspace.getConfiguration('deepseekBridge').get<InjectTarget>('injectGuidance', 'workspace');
}

export async function updateSetting(key: string, value: unknown): Promise<void> {
    await vscode.workspace.getConfiguration('deepseekBridge').update(key, value, vscode.ConfigurationTarget.Global);
}

// One-time migration of pre-1.2 globalState values into native configuration so
// existing users keep their settings after upgrading.
export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
    if (context.globalState.get<boolean>('deepseek-migrated-1.2')) return;
    const c = vscode.workspace.getConfiguration('deepseekBridge');
    const moves: Array<[string, string]> = [
        ['deepseek-model', 'model'],
        ['deepseek-posture', 'posture'],
        ['deepseek-model-auto', 'modelAuto'],
    ];
    for (const [oldKey, newKey] of moves) {
        const v = context.globalState.get<string>(oldKey);
        if (v !== undefined && c.get(newKey) === c.inspect(newKey)?.defaultValue) {
            try { await c.update(newKey, v, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
        }
    }
    const allow = context.globalState.get<string[]>('deepseek-allow-commands');
    if (Array.isArray(allow) && allow.length) {
        try { await c.update('allowCommands', allow, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
    }
    const fp = context.globalState.get<boolean>('deepseek-full-permissions');
    if (fp) { try { await c.update('fullPermissions', true, vscode.ConfigurationTarget.Global); } catch { /* ignore */ } }
    await context.globalState.update('deepseek-migrated-1.2', true);
}

function home(): string {
    return process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
}

function claudeDir(): string {
    return path.join(home(), '.claude');
}

/**
 * Recover an API key previously written into ~/.claude.json by an earlier
 * install. Used to self-heal when SecretStorage is empty after a publisher/ID
 * change (SecretStorage is keyed by extension ID, so a rename loses the key).
 */
export function readExistingMcpKey(): string | undefined {
    const claudeJsonPath = path.join(home(), '.claude.json');
    try {
        const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>;
        const servers = claudeJson.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
        const key = servers?.deepseek?.env?.DEEPSEEK_API_KEY;
        return typeof key === 'string' && key.trim() ? key.trim() : undefined;
    } catch { return undefined; }
}

function extVersion(context: vscode.ExtensionContext): string {
    const v = (context.extension?.packageJSON as { version?: string } | undefined)?.version;
    return typeof v === 'string' && v ? v : 'dev';
}

/**
 * Copy the bundled MCP server to a STABLE, version-namespaced path under
 * ~/.claude/deepseek-bridge/ and return it. The extension install dir changes on
 * every auto-update, which would silently strand the path baked into ~/.claude.json
 * (Claude Code only reads it at spawn). Pointing the config at a path we own and
 * that never disappears means an extension auto-update can never break a running
 * bridge — at worst it runs the previous server build until the next reconnect.
 */
export function ensureStableServerPath(context: vscode.ExtensionContext): string {
    const version   = extVersion(context);
    const stableDir = path.join(claudeDir(), 'deepseek-bridge');
    const src       = path.join(context.extensionUri.fsPath, 'out', 'server.js');
    const dest      = path.join(stableDir, `server-${version}.js`);
    try {
        fs.mkdirSync(stableDir, { recursive: true });
        // Refresh the stable copy when the bundle changed (newer mtime). Copy via a
        // temp file + atomic rename so we never truncate a file a running server has
        // open: on POSIX the running process keeps the old inode; on Windows the
        // rename-over fails cleanly and the old (working) copy is kept.
        let needsCopy = true;
        try {
            const [s, d] = [fs.statSync(src), fs.statSync(dest)];
            needsCopy = s.mtimeMs > d.mtimeMs;
        } catch { needsCopy = true; } // dest missing
        if (needsCopy) {
            const tmp = `${dest}.${process.pid}.tmp`;
            try {
                fs.copyFileSync(src, tmp);
                fs.renameSync(tmp, dest);
            } catch {
                try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
        }
        // Best-effort sweep of stale versioned copies (skip ones still locked/in-use).
        for (const f of fs.readdirSync(stableDir)) {
            if (/^server-.*\.js$/.test(f) && f !== `server-${version}.js`) {
                try { fs.unlinkSync(path.join(stableDir, f)); } catch { /* in use — leave it */ }
            }
        }
        return fs.existsSync(dest) ? dest : src;
    } catch {
        // Fall back to the in-place path if the stable copy can't be created.
        return src;
    }
}

/**
 * Write the dynamic runtime settings the MCP server re-reads on EVERY call, so
 * model / posture / model-auto / aggressiveness / base URL / allow-commands changes
 * take effect WITHOUT restarting Claude Code. Only the API key remains spawn-time.
 */
export function writeRuntimeSettings(settings: BridgeSettings, fullPermissions: boolean): void {
    const dir = claudeDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'deepseek-settings.json'),
            JSON.stringify({ ...settings, fullPermissions }, null, 2),
            'utf8'
        );
        // Back-compat: older server builds read this allowlist file directly.
        fs.writeFileSync(
            path.join(dir, 'deepseek-allowlist.json'),
            JSON.stringify({ fullPermissions, commands: settings.allowCommands }),
            'utf8'
        );
    } catch { /* non-fatal */ }
}

/**
 * Write the per-window approval-server coordinates (port + auth token) keyed by
 * workspace, so the MCP server talks to the RIGHT window's UI even with several
 * windows open, and so every /approve, /event, /running request can be authenticated.
 * Also writes the legacy single port file for backward compatibility.
 */
export function writePortFile(wsKey: string, port: number, token: string): void {
    const dir = claudeDir();
    try {
        fs.mkdirSync(path.join(dir, 'deepseek-ports'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'deepseek-ports', `${wsKey}.json`),
            JSON.stringify({ port, token }),
            'utf8'
        );
        // Legacy global file (last-writer-wins) — only carries the port.
        fs.writeFileSync(path.join(dir, 'deepseek-bridge-port'), String(port), 'utf8');
    } catch { /* non-fatal — allowlist still works without the popup server */ }
}

export function removePortFile(wsKey: string): void {
    try { fs.unlinkSync(path.join(claudeDir(), 'deepseek-ports', `${wsKey}.json`)); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(claudeDir(), 'deepseek-bridge-port')); } catch { /* ignore */ }
}

export function writeMcpConfig(
    context: vscode.ExtensionContext,
    apiKey: string,
    settings: BridgeSettings
): void {
    const serverPath = ensureStableServerPath(context);
    const claudeJsonPath = path.join(home(), '.claude.json');

    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
        try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { /* ignore */ }
    }
    const existingServers = (claudeJson.mcpServers as Record<string, unknown> | undefined) ?? {};

    // No DEEPSEEK_WORKSPACE here — Claude Code injects CLAUDE_PROJECT_DIR per window,
    // so the server jails to the correct workspace automatically. Most settings are
    // now read live from deepseek-settings.json; env values remain as spawn-time
    // fallback for older server builds.
    claudeJson.mcpServers = {
        ...existingServers,
        deepseek: {
            command: 'node',
            args: [serverPath],
            env: {
                DEEPSEEK_API_KEY:    apiKey,
                DEEPSEEK_BASE_URL:   settings.baseUrl,
                DEEPSEEK_MODEL:      settings.model,
                DEEPSEEK_POSTURE:    settings.posture === 'read-only' ? 'read-only' : 'edit',
                DEEPSEEK_MODEL_AUTO: settings.modelAuto,
                ...(settings.allowCommands.length ? { DEEPSEEK_ALLOW_COMMANDS: JSON.stringify(settings.allowCommands) } : {}),
            },
        },
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

    writeRuntimeSettings(settings, settings.fullPermissions);
}

// ── Delegation guidance injection (the seamlessness engine) ─────────────────────

function upsertGuidanceFile(filePath: string, block: string): void {
    let existing = '';
    try { existing = fs.readFileSync(filePath, 'utf8'); } catch { /* new file */ }
    const next = upsertManagedBlock(existing, block);
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, next, 'utf8');
    } catch { /* non-fatal */ }
}

function stripGuidanceFile(filePath: string): void {
    let existing = '';
    try { existing = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    const next = removeManagedBlock(existing);
    if (next !== existing) {
        try { fs.writeFileSync(filePath, next, 'utf8'); } catch { /* non-fatal */ }
    }
}

/**
 * Write (or remove) the managed delegation-policy block that tells Claude WHEN to
 * offload. This is what turns "two tools exist" into "offloading happens
 * automatically." Target is controlled by deepseekBridge.injectGuidance.
 */
export function injectGuidance(
    workspacePath: string | undefined,
    settings: BridgeSettings,
    target: 'workspace' | 'user' | 'off'
): void {
    const wsFile   = workspacePath ? path.join(workspacePath, 'CLAUDE.md') : undefined;
    const userFile = path.join(claudeDir(), 'CLAUDE.md');
    const block    = claudeMdBlock(settings.aggressiveness);

    if (target === 'off') {
        if (wsFile) stripGuidanceFile(wsFile);
        stripGuidanceFile(userFile);
        return;
    }
    if (target === 'user') {
        if (wsFile) stripGuidanceFile(wsFile);   // avoid duplication
        upsertGuidanceFile(userFile, block);
        return;
    }
    // 'workspace' (default)
    if (wsFile) {
        upsertGuidanceFile(wsFile, block);
    } else {
        // No folder open — fall back to user-level so guidance still applies.
        upsertGuidanceFile(userFile, block);
    }
}
