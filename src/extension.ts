import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { DeepSeekSidebarProvider } from './sidebar';
import {
    writeMcpConfig, readExistingMcpKey, readSettings, getInjectTarget,
    injectGuidance, writePortFile, removePortFile, migrateLegacySettings, seedDefaultDenyPaths, updateSetting,
} from './config';
import { isWorkspaceEnabled, setWorkspaceEnabled } from './control';
import { splitSegments, isScriptableExe, commandMatchesAllowlist, workspaceKey } from './pure';

const CLAUDE_DIR   = path.join(os.homedir(), '.claude');
const AUDIT_DIR    = path.join(CLAUDE_DIR, 'deepseek-audit');

// Same log file + line format as server.ts's audit() — lets copyDiagnostics show
// popup events (shown/auto/decision) interleaved with the tool-call log, so it's
// clear which specific command(s) triggered a live approval prompt.
function auditApproval(name: string, data: Record<string, unknown>): void {
    try {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        const wsKey = workspaceKey(currentWorkspacePath());
        fs.appendFileSync(
            path.join(AUDIT_DIR, `${wsKey}.log`),
            `${new Date().toISOString()}\t${wsKey}\t${name}\t${JSON.stringify(data)}\n`,
            'utf8'
        );
    } catch { /* never let logging break the approval flow */ }
}

function killFilePath(wsKey: string): string {
    return path.join(CLAUDE_DIR, `deepseek-kill-${wsKey}`);
}

function currentWorkspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

// Per-session auth token shared with the MCP server via the per-window port file.
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

// Prefixes approved via popup this VSCode session (forgotten on restart).
const sessionApproved = new Set<string>();

function isSessionApproved(command: string): boolean {
    return commandMatchesAllowlist(command, sessionApproved);
}

function extractExecutable(segment: string): string {
    const tokens = segment.split(/\s+/);
    for (const tok of tokens) {
        if (tok && !tok.includes('=')) return tok;
    }
    return tokens[0] ?? segment;
}

interface ScopeOption { prefix: string; label: string; detail: string; inPath: boolean; dangerous: boolean; }

const SHELL_BUILTINS = new Set([
    'cd', 'pwd', 'pushd', 'popd', 'dirs',
    'echo', 'printf',
    'export', 'set', 'unset', 'declare', 'local', 'typeset', 'readonly', 'let',
    'exit', 'return', 'break', 'continue', 'shift', 'getopts',
    'exec', 'eval', 'wait', 'jobs', 'bg', 'fg', 'kill', 'trap', 'times', 'suspend',
    'alias', 'unalias', 'source', 'type', 'hash', 'command', 'builtin', 'enable',
    'ulimit', 'umask',
    'true', 'false', 'test', 'read', 'readarray', 'mapfile',
    'history', 'fc', 'help', 'logout', 'compgen', 'complete',
]);

const PRIVILEGE_ESCALATORS = new Set(['sudo', 'doas', 'su', 'run', 'env', 'nice', 'ionice', 'nohup', 'xargs']);

function addScopeOption(options: ScopeOption[], seen: Set<string>, exe: string): void {
    // Skip absolute paths — they'd create allowlist entries that never match anything useful.
    if (!exe || seen.has(exe) || exe.includes('/') || exe.includes('\\')) return;
    seen.add(exe);
    options.push({
        prefix: exe,
        label: `$(terminal-bash) ${exe}`,
        detail: isScriptableExe(exe)
            ? `Any ${exe} command — ⚠ grants arbitrary code execution via ${exe}`
            : `Any ${exe} command`,
        inPath: true,
        dangerous: isScriptableExe(exe),
    });
}

function buildScopeOptions(command: string): ScopeOption[] {
    const options: ScopeOption[] = [];
    const seen = new Set<string>();

    const display = command.length > 55 ? command.slice(0, 52) + '…' : command;
    options.push({ prefix: command, label: `$(terminal) ${display}`, detail: 'Exact command only', inPath: true, dangerous: false });

    for (const seg of splitSegments(command)) {
        const exe = extractExecutable(seg);
        if (!exe) continue;

        if (PRIVILEGE_ESCALATORS.has(exe.toLowerCase())) {
            addScopeOption(options, seen, exe);
            const tokens = seg.split(/\s+/).slice(1);
            for (const tok of tokens) {
                if (!tok.startsWith('-') && !tok.includes('=')) {
                    addScopeOption(options, seen, tok);
                    break;
                }
            }
        } else {
            addScopeOption(options, seen, exe);
        }
    }

    return options;
}

async function startApprovalServer(context: vscode.ExtensionContext, provider: DeepSeekSidebarProvider): Promise<void> {
    const server = http.createServer(async (req, res) => {
        // The token gates the security-sensitive endpoint (/approve — raising popups
        // and persisting allow-list entries). /event and /running are display-only
        // (live console + running indicator); leaving them unauthenticated means the
        // UI is never silently dark from a token/key mismatch or an old server still
        // running mid-upgrade. Spoofing them is cosmetic at worst.
        if (req.method === 'POST' && (req.url === '/approve' || req.url === '/approve-path')
            && (req.headers['x-bridge-token'] ?? '') !== SESSION_TOKEN) {
            res.writeHead(403).end();
            return;
        }

        if (req.method === 'POST' && req.url === '/running') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            await new Promise<void>(r => req.on('end', r));
            try {
                const { running } = JSON.parse(body) as { running: boolean };
                provider.postTaskRunning(running);
            } catch {}
            res.writeHead(200).end();
            return;
        }

        if (req.method === 'POST' && req.url === '/event') {
            let body = '';
            req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            await new Promise<void>(r => req.on('end', r));
            try {
                const { eventType, data } = JSON.parse(body) as { eventType: string; data: Record<string, unknown> };
                provider.postConsoleEvent(eventType, data);
            } catch {}
            res.writeHead(200).end();
            return;
        }

        if (req.method === 'POST' && req.url === '/approve-path') {
            let pbody = '';
            req.on('data', (chunk: Buffer) => { pbody += chunk.toString(); });
            await new Promise<void>(r => req.on('end', r));

            let relPath = '';
            let mode: 'read' | 'write' = 'read';
            try {
                const parsed = JSON.parse(pbody) as { path?: string; mode?: string };
                relPath = String(parsed.path ?? '').trim();
                mode    = parsed.mode === 'write' ? 'write' : 'read';
            } catch { /* fall through to deny */ }

            if (!relPath) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ decision: 'deny' }));
                return;
            }

            const decision = await requestPathAccess(relPath, mode);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision }));
            return;
        }

        if (req.method !== 'POST' || req.url !== '/approve') {
            res.writeHead(404).end();
            return;
        }

        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        await new Promise<void>(r => req.on('end', r));

        let command = '';
        try { command = (JSON.parse(body) as { command: string }).command; } catch {}

        if (isSessionApproved(command)) {
            auditApproval('approval_auto', { command, reason: 'session-cache' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: 'allow', approvedPrefixes: [command] }));
            return;
        }

        const scopes = buildScopeOptions(command).map(o => ({ prefix: o.prefix, detail: o.detail, inPath: o.inPath, dangerous: o.dangerous }));
        auditApproval('approval_shown', { command, scopes: scopes.map(s => s.prefix) });
        await vscode.commands.executeCommand('workbench.view.extension.deepseek-bridge-container');
        provider.setBadge(1);

        const result = await provider.requestApproval(command, scopes);

        provider.setBadge(0);

        if (!result || !result.approvals.length) {
            auditApproval('approval_decision', { command, decision: 'deny' });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ decision: 'deny' }));
            return;
        }

        const { approvals } = result;
        auditApproval('approval_decision', { command, decision: 'allow', approvals });
        const allPrefixes = approvals.map(a => a.scope);

        for (const { scope: chosenPrefix, duration: action } of approvals) {
            if (action === 'session' || action === 'always') sessionApproved.add(chosenPrefix);
        }

        const alwaysPrefixes = approvals.filter(a => a.duration === 'always').map(a => a.scope);
        if (alwaysPrefixes.length) {
            const settings = readSettings();
            const existing = settings.allowCommands;
            const toAdd    = alwaysPrefixes.filter(p => !existing.includes(p));
            if (toAdd.length) {
                const updated = [...existing, ...toAdd].sort((a, b) => a.localeCompare(b));
                await updateSetting('allowCommands', updated);
                // onDidChangeConfiguration will rewrite the runtime files; push to UI now.
                provider.pushAllowCommands(updated);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'allow', approvedPrefixes: allPrefixes }));
    });

    await new Promise<void>((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            writePortFile(workspaceKey(currentWorkspacePath()), port, SESSION_TOKEN);
            resolve();
        });
        server.on('error', reject);
    });

    context.subscriptions.push({
        dispose: () => {
            server.close();
            removePortFile(workspaceKey(currentWorkspacePath()));
        }
    });
}

// Raise a modal asking the user to allow DeepSeek access to a blocked secret file.
// "Always allow" persists the path into deepseekBridge.allowSecretPaths (the
// onDidChangeConfiguration handler then rewrites the runtime files + refreshes the UI).
async function requestPathAccess(relPath: string, mode: 'read' | 'write'): Promise<'allow' | 'deny'> {
    const verb       = mode === 'write' ? 'write to' : 'read';
    const ALLOW_ONCE = 'Allow once';
    const ALWAYS     = 'Always allow';
    const choice = await vscode.window.showWarningMessage(
        `Allow DeepSeek to ${verb} "${relPath}"?`,
        {
            modal: true,
            detail: `This file is on the secret-file blocklist because it may contain credentials, so DeepSeek `
                  + `cannot see it by default. "Always allow" adds it to deepseekBridge.allowSecretPaths; `
                  + `"Allow once" grants access only for the current session.`,
        },
        ALLOW_ONCE, ALWAYS
    );
    if (choice === ALWAYS) {
        const existing = readSettings().allowSecretPaths;
        if (!existing.includes(relPath)) {
            const updated = [...existing, relPath].sort((a, b) => a.localeCompare(b));
            await updateSetting('allowSecretPaths', updated);
        }
        return 'allow';
    }
    return choice === ALLOW_ONCE ? 'allow' : 'deny';
}

// Push the full configuration to Claude Code + runtime files + CLAUDE.md guidance.
// Guidance is only written once a key is configured — otherwise it would reference
// tools Claude can't see yet.
function applyConfig(context: vscode.ExtensionContext, apiKey: string | undefined): string {
    const settings = readSettings();
    let error = '';
    if (apiKey) {
        try { writeMcpConfig(context, apiKey, settings); } catch (e) { error = (e as Error).message; }
        try { injectGuidance(currentWorkspacePath(), settings, getInjectTarget()); } catch { /* non-fatal */ }
    }
    return error;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await migrateLegacySettings(context);
    await seedDefaultDenyPaths(context);

    const provider = new DeepSeekSidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('deepseek-bridge.config', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    await startApprovalServer(context, provider);

    let apiKey = await context.secrets.get('deepseek-api-key');
    if (!apiKey) {
        const recovered = readExistingMcpKey();
        if (recovered) {
            try { await context.secrets.store('deepseek-api-key', recovered); } catch { /* ignore */ }
            apiKey = recovered;
        }
    }

    // Always refresh config on activation so the (stable) server path + runtime
    // settings + CLAUDE.md guidance track the installed version.
    applyConfig(context, apiKey);

    // Detect an extension update and proactively prompt to reconnect — Claude Code
    // only reads MCP servers at spawn, so a silent update would otherwise leave a
    // running session on the old server until the user happens to reconnect.
    const version  = (context.extension?.packageJSON as { version?: string })?.version ?? 'dev';
    const prevVer  = context.globalState.get<string>('deepseek-last-version');
    if (apiKey && prevVer && prevVer !== version) {
        void vscode.window.showInformationMessage(
            `DeepSeek Bridge updated to v${version}. Reconnect Claude Code to load the new server.`,
            'Reconnect'
        ).then(choice => { if (choice === 'Reconnect') vscode.commands.executeCommand('deepseek-bridge.reconnect'); });
    }
    await context.globalState.update('deepseek-last-version', version);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBar.command = 'deepseek-bridge.openSidebar';
    statusBar.show();
    context.subscriptions.push(statusBar);

    const updateStatusBar = (): void => {
        // Authoritative on ~/.claude.json so keyless remotes never show a false "not configured".
        const key = readExistingMcpKey();
        const settings = readSettings();
        const wsPath = currentWorkspacePath();
        const enabledHere = wsPath ? isWorkspaceEnabled(wsPath) : true;
        if (!key) {
            statusBar.text = '$(zap) DeepSeek $(warning)';
            statusBar.tooltip = 'DeepSeek Bridge — API key not set\nClick to configure';
        } else if (!enabledHere) {
            statusBar.text = '$(circle-slash) DeepSeek';
            statusBar.tooltip = 'DeepSeek is OFF for this workspace\nClick to open settings';
        } else {
            statusBar.text = '$(zap) DeepSeek';
            statusBar.tooltip = `DeepSeek active — ${settings.model} (${settings.posture})\nClick to open settings`;
        }
    };
    updateStatusBar();

    // React to native Settings UI / settings.json changes — rewrite runtime files.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('deepseekBridge')) {
                const key = await context.secrets.get('deepseek-api-key') ?? readExistingMcpKey();
                applyConfig(context, key);
                provider.pushConfig();
                updateStatusBar();
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('deepseek-bridge.openSidebar', () => {
            vscode.commands.executeCommand('workbench.view.extension.deepseek-bridge-container');
        }),
        vscode.commands.registerCommand('deepseek-bridge.refreshStatus', updateStatusBar),
        vscode.commands.registerCommand('deepseek-bridge.setApiKey', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.deepseek-bridge-container');
            provider.focusApiKey();
        }),
        vscode.commands.registerCommand('deepseek-bridge.openHistory', async () => {
            await vscode.commands.executeCommand('workbench.view.extension.deepseek-bridge-container');
            provider.showHistory();
        }),
        vscode.commands.registerCommand('deepseek-bridge.stopTask', () => {
            try {
                fs.mkdirSync(CLAUDE_DIR, { recursive: true });
                fs.writeFileSync(killFilePath(workspaceKey(currentWorkspacePath())), '1', 'utf8');
                vscode.window.setStatusBarMessage('DeepSeek: stop signal sent.', 3000);
            } catch { /* non-fatal */ }
        }),
        vscode.commands.registerCommand('deepseek-bridge.toggleWorkspace', () => {
            const wsPath = currentWorkspacePath();
            if (!wsPath) { void vscode.window.showWarningMessage('DeepSeek Bridge: no folder open.'); return; }
            const next = !isWorkspaceEnabled(wsPath);
            setWorkspaceEnabled(wsPath, next);
            updateStatusBar();
            provider.pushConfig();
            vscode.window.setStatusBarMessage(`DeepSeek ${next ? 'enabled' : 'disabled'} for this workspace.`, 3000);
        }),
        vscode.commands.registerCommand('deepseek-bridge.reconnect', async () => {
            const choice = await vscode.window.showInformationMessage(
                'Reconnect Claude Code so it loads DeepSeek Bridge changes. Run /mcp in Claude Code, or reload this window.',
                'Reload Window'
            );
            if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
        }),
        vscode.commands.registerCommand('deepseek-bridge.copyDiagnostics', async () => {
            const settings = readSettings();
            const wsPath = currentWorkspacePath();
            const wsKey  = workspaceKey(wsPath);
            let auditTail = '';
            try {
                const log = path.join(AUDIT_DIR, `${wsKey}.log`);
                const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
                auditTail = lines.slice(-20).join('\n');
            } catch { auditTail = '(no audit log)'; }
            // Channel state — the thing that breaks the live console / approvals.
            const portsDir = path.join(CLAUDE_DIR, 'deepseek-ports');
            let portFiles = '(none)'; let activePort = '(none)';
            try { portFiles = fs.readdirSync(portsDir).join(', ') || '(empty)'; } catch { /* ignore */ }
            try { activePort = String((JSON.parse(fs.readFileSync(path.join(portsDir, '_active.json'), 'utf8')) as { port?: number }).port ?? '?'); } catch { /* ignore */ }
            let serverPath = '(unknown)';
            try {
                const cj = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')) as { mcpServers?: { deepseek?: { args?: string[] } } };
                serverPath = cj.mcpServers?.deepseek?.args?.[0] ?? '(not registered)';
            } catch { /* ignore */ }
            const diag = [
                `DeepSeek Bridge diagnostics`,
                `version: ${(context.extension?.packageJSON as { version?: string })?.version ?? 'dev'}`,
                `model: ${settings.model}  posture: ${settings.posture}  modelAuto: ${settings.modelAuto}`,
                `aggressiveness: ${settings.aggressiveness}  baseUrl: ${settings.baseUrl}`,
                `fullPermissions: ${settings.fullPermissions}  allowCommands: ${settings.allowCommands.length}`,
                `workspace configured: ${!!readExistingMcpKey()}  enabled here: ${wsPath ? isWorkspaceEnabled(wsPath) : 'n/a'}`,
                `remote: ${vscode.env.remoteName ?? 'local'}`,
                `workspace key: ${wsKey}`,
                `registered server path: ${serverPath}`,
                `approval channel — port files: [${portFiles}]  active port: ${activePort}`,
                ``,
                `recent audit (last 20):`,
                auditTail,
            ].join('\n');
            await vscode.env.clipboard.writeText(diag);
            void vscode.window.showInformationMessage('DeepSeek Bridge diagnostics copied to clipboard.');
        }),
    );
}

export function deactivate(): void {}
