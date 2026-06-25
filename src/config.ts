import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function writeMcpConfig(
    context: vscode.ExtensionContext,
    apiKey: string,
    model: string,
    posture: string,
    allowCommands: string[]
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
                ...(allowCommands.length ? { DEEPSEEK_ALLOW_COMMANDS: JSON.stringify(allowCommands) } : {})
            }
        }
    };
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
}
