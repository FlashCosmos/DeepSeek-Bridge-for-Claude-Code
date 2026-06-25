import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeepSeekSidebarProvider } from './sidebar';
import { writeMcpConfig } from './config';
import { isWorkspaceEnabled } from './control';

const APPROVAL_PORT_FILE = path.join(os.homedir(), '.claude', 'deepseek-bridge-port');

// Commands approved via popup this VSCode session (prefix-keyed, forgotten on restart).
const sessionApproved = new Set<string>();

// Strip flag arguments to get a stable prefix for caching/persisting.
// "php artisan test --filter=Foo" → "php artisan test"
function extractPrefix(command: string): string {
    const idx = command.indexOf(' --');
    return idx >= 0 ? command.slice(0, idx).trim() : command;
}

async function startApprovalServer(context: vscode.ExtensionContext, provider: import('./sidebar').DeepSeekSidebarProvider): Promise<void> {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/approve') {
            res.writeHead(404).end();
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        await new Promise<void>(r => req.on('end', r));

        let command = '';
        try { command = (JSON.parse(body) as { command: string }).command; } catch {}

        const prefix = extractPrefix(command);

        // Session cache hit — no popup needed.
        if (sessionApproved.has(prefix)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: 'allow' }));
            return;
        }

        interface ApprovalItem extends vscode.QuickPickItem { action: 'once' | 'session' | 'always' | 'deny'; }
        const items: ApprovalItem[] = [
            { label: '$(check) Allow once',         description: 'Run this time — ask again next time', action: 'once'    },
            { label: '$(clock) Allow this session', description: 'Auto-approve until VS Code restarts', action: 'session' },
            { label: '$(star-full) Always allow',   description: 'Add to permanent allowlist',          action: 'always'  },
            { label: '$(x) Deny',                   description: 'Block this command',                  action: 'deny'    },
        ];
        const cmdLabel = command.length > 80 ? command.slice(0, 77) + '…' : command;
        const picked = await vscode.window.showQuickPick(items, {
            title:           `DeepSeek: Allow command?`,
            placeHolder:     cmdLabel,
            ignoreFocusOut:  true,
        });

        const action   = picked?.action ?? 'deny';
        const approved = action !== 'deny';

        if (action === 'session' || action === 'always') {
            sessionApproved.add(prefix);
        }

        if (action === 'always') {
            const existing = context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
            if (!existing.includes(prefix)) {
                const updated = [...existing, prefix];
                await context.globalState.update('deepseek-allow-commands', updated);
                const apiKey  = await context.secrets.get('deepseek-api-key');
                const model   = context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
                const posture = context.globalState.get<string>('deepseek-posture') ?? 'edit';
                if (apiKey) writeMcpConfig(context, apiKey, model, posture, updated);
                provider.pushAllowCommands(updated);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: approved ? 'allow' : 'deny' }));
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            try {
                fs.mkdirSync(path.dirname(APPROVAL_PORT_FILE), { recursive: true });
                fs.writeFileSync(APPROVAL_PORT_FILE, String(port), 'utf8');
            } catch { /* non-fatal — allowlist still works without the popup server */ }
            resolve();
        });
        server.on('error', reject);
    });

    context.subscriptions.push({
        dispose: () => {
            server.close();
            try { fs.unlinkSync(APPROVAL_PORT_FILE); } catch {}
        }
    });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const provider = new DeepSeekSidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('deepseek-bridge.config', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    await startApprovalServer(context, provider);

    const apiKey       = await context.secrets.get('deepseek-api-key');
    const model        = context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
    const posture      = context.globalState.get<string>('deepseek-posture') ?? 'edit';
    const allowCommands = context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
    if (apiKey) {
        writeMcpConfig(context, apiKey, model, posture, allowCommands);
    }

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBar.command = 'deepseek-bridge.openSidebar';
    statusBar.show();
    context.subscriptions.push(statusBar);

    const updateStatusBar = (): void => {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const enabledHere = wsPath ? isWorkspaceEnabled(wsPath) : true;
        if (!apiKey) {
            statusBar.text = '$(zap) DeepSeek $(warning)';
            statusBar.tooltip = 'DeepSeek Bridge — API key not set\nClick to configure';
        } else if (!enabledHere) {
            statusBar.text = '$(circle-slash) DeepSeek';
            statusBar.tooltip = 'DeepSeek is OFF for this workspace\nClick to open settings';
        } else {
            statusBar.text = '$(zap) DeepSeek';
            statusBar.tooltip = `DeepSeek active — ${model} (${posture})\nClick to open settings`;
        }
    };
    updateStatusBar();

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-bridge.openSidebar', () => {
            vscode.commands.executeCommand('workbench.view.extension.deepseek-bridge-container');
        }),
        vscode.commands.registerCommand('deepseek-bridge.refreshStatus', updateStatusBar)
    );
}

export function deactivate(): void {}
