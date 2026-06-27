import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Recover an API key previously written into ~/.claude.json by an earlier
 * install. Used to self-heal when SecretStorage is empty after a publisher/ID
 * change (SecretStorage is keyed by extension ID, so a rename loses the key).
 */
export function readExistingMcpKey(): string | undefined {
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
    const claudeJsonPath = path.join(home, '.claude.json');
    try {
        const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')) as Record<string, unknown>;
        const servers = claudeJson.mcpServers as Record<string, { env?: Record<string, string> }> | undefined;
        const key = servers?.deepseek?.env?.DEEPSEEK_API_KEY;
        return typeof key === 'string' && key.trim() ? key.trim() : undefined;
    } catch { return undefined; }
}

export function writeMcpConfig(
    context: vscode.ExtensionContext,
    apiKey: string,
    model: string,
    posture: string,
    allowCommands: string[],
    fullPermissions?: boolean,
    modelAuto?: string
): void {
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
    const serverPath = path.join(context.extensionUri.fsPath, 'out', 'server.js');

    // ~/.claude.json — the file Claude Code actually reads for user-level MCP servers
    const claudeJsonPath = path.join(home, '.claude.json');
    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
        try { claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8')); } catch { /* ignore */ }
    }
    const existingServers = (claudeJson.mcpServers as Record<string, unknown> | undefined) ?? {};

    // No DEEPSEEK_WORKSPACE here — Claude Code injects CLAUDE_PROJECT_DIR per window,
    // so the server jails to the correct workspace automatically.
    claudeJson.mcpServers = {
        ...existingServers,
        deepseek: {
            command: 'node',
            args: [serverPath],
            env: {
                DEEPSEEK_API_KEY: apiKey,
                DEEPSEEK_MODEL: model,
                DEEPSEEK_POSTURE: posture === 'read-only' ? 'read-only' : 'edit',
                DEEPSEEK_MODEL_AUTO: modelAuto ?? 'no',
                ...(allowCommands.length ? { DEEPSEEK_ALLOW_COMMANDS: JSON.stringify(allowCommands) } : {})
            }
        }
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

    // Also write a dynamic allowlist file so the running MCP server process
    // can re-read it on every call without needing an env-var restart.
    const allowlistPath = path.join(home, '.claude', 'deepseek-allowlist.json');
    try {
        fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
        fs.writeFileSync(allowlistPath, JSON.stringify({ fullPermissions: !!fullPermissions, commands: allowCommands }));
    } catch { /* non-fatal */ }
}
