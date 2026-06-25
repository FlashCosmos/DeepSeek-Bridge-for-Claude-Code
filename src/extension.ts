import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DeepSeekSidebarProvider } from './sidebar';
import { writeMcpConfig } from './config';
import { isWorkspaceEnabled } from './control';

const APPROVAL_PORT_FILE = path.join(os.homedir(), '.claude', 'deepseek-bridge-port');

// Prefixes approved via popup this VSCode session (forgotten on restart).
// A prefix like "node" matches "node --version", "node script.js", etc.
const sessionApproved = new Set<string>();

function commandMatchesPrefix(command: string, prefix: string): boolean {
    return command === prefix || command.startsWith(prefix + ' ');
}

function isSessionApproved(command: string): boolean {
    for (const prefix of sessionApproved) {
        if (commandMatchesPrefix(command, prefix)) return true;
    }
    return false;
}

// Split a shell command string on operators into individual segments.
// "git add . && git commit -m 'msg'" → ["git add .", "git commit -m 'msg'"]
function parseSegments(command: string): string[] {
    return command.split(/\s*(?:&&|\|\||;|\|)\s*/).map(s => s.trim()).filter(Boolean);
}

// Extract the executable name from a command segment (skip env-var prefixes like KEY=val).
function extractExecutable(segment: string): string {
    const tokens = segment.split(/\s+/);
    for (const tok of tokens) {
        if (tok && !tok.includes('=')) return tok;
    }
    return tokens[0] ?? segment;
}

interface ScopeOption { prefix: string; label: string; detail: string; }

// Build the list of scope options: exact full command + deduplicated executables.
function buildScopeOptions(command: string): ScopeOption[] {
    const options: ScopeOption[] = [];
    const seen = new Set<string>();

    const display = command.length > 55 ? command.slice(0, 52) + '…' : command;
    options.push({ prefix: command, label: `$(terminal) ${display}`, detail: 'Exact command only' });

    for (const seg of parseSegments(command)) {
        const exe = extractExecutable(seg);
        if (exe && !seen.has(exe)) {
            seen.add(exe);
            options.push({ prefix: exe, label: `$(terminal-bash) ${exe}`, detail: `Any ${exe} command` });
        }
    }

    return options;
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

        // Session cache hit — no popup needed.
        if (isSessionApproved(command)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: 'allow', approvedPrefix: command }));
            return;
        }

        // ── Step 1: what scope to allow ────────────────────────────────────────
        const cmdLabel = command.length > 55 ? command.slice(0, 52) + '…' : command;
        interface ScopeItem extends vscode.QuickPickItem { prefix: string | null; }
        const scopeItems: ScopeItem[] = [
            ...buildScopeOptions(command).map(o => ({
                label:  o.label,
                detail: o.detail,
                prefix: o.prefix,
            })),
            { label: '$(x) Deny', detail: 'Block this command', prefix: null },
        ];

        const scopePicked = await vscode.window.showQuickPick(scopeItems, {
            title:          `DeepSeek wants to run: ${cmdLabel}`,
            placeHolder:    'What should be allowed?',
            ignoreFocusOut: true,
        });

        if (!scopePicked || scopePicked.prefix === null) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: 'deny' }));
            return;
        }

        const chosenPrefix = scopePicked.prefix;

        // ── Step 2: for how long ────────────────────────────────────────────────
        interface DurationItem extends vscode.QuickPickItem { action: 'once' | 'session' | 'always'; }
        const durationItems: DurationItem[] = [
            { label: '$(check) Just once',    description: 'Ask again next time',              action: 'once'    },
            { label: '$(clock) This session', description: 'Auto-approve until VS Code restarts', action: 'session' },
            { label: '$(star-full) Always',   description: 'Add to permanent allowlist',        action: 'always'  },
        ];
        const shortPrefix = chosenPrefix.length > 40 ? chosenPrefix.slice(0, 37) + '…' : chosenPrefix;
        const durationPicked = await vscode.window.showQuickPick(durationItems, {
            title:          `Allow "${shortPrefix}" for how long?`,
            placeHolder:    'Choose duration…',
            ignoreFocusOut: true,
        });

        const action = durationPicked?.action ?? 'once';

        if (action === 'session' || action === 'always') {
            sessionApproved.add(chosenPrefix);
        }

        if (action === 'always') {
            const existing = context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
            if (!existing.includes(chosenPrefix)) {
                const updated = [...existing, chosenPrefix];
                await context.globalState.update('deepseek-allow-commands', updated);
                const apiKey  = await context.secrets.get('deepseek-api-key');
                const model   = context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
                const posture = context.globalState.get<string>('deepseek-posture') ?? 'edit';
                if (apiKey) writeMcpConfig(context, apiKey, model, posture, updated);
                provider.pushAllowCommands(updated);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'allow', approvedPrefix: chosenPrefix }));
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
