import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    writeMcpConfig, readExistingMcpKey, readSettings, updateSetting,
    injectGuidance, getInjectTarget,
} from './config';
import { isWorkspaceEnabled, setWorkspaceEnabled } from './control';
import { CLAUDE_PRICING, workspaceKey } from './pure';

const HISTORY_FILE = path.join(os.homedir(), '.claude', 'deepseek-history.json');

const MODELS = [
    { id: 'deepseek-v4-flash', label: 'V4 Flash — Fast & cheap (recommended)' },
    { id: 'deepseek-v4-pro',   label: 'V4 Pro — Advanced reasoning' },
];

type ApprovalResult = { approvals: { scope: string; duration: 'once' | 'session' | 'always' }[] };
type Scope = { prefix: string; detail: string; inPath: boolean; dangerous: boolean };

export class DeepSeekSidebarProvider implements vscode.WebviewViewProvider {
    private webviewView: vscode.WebviewView | null = null;
    private pendingApproval: ((r: ApprovalResult | null) => void) | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {}

    pushAllowCommands(commands: string[]): void {
        this.webviewView?.webview.postMessage({ type: 'allowCommandsUpdate', commands });
    }

    /** Re-send the custom secret-file deny list + exception list to the webview. */
    pushSecretPaths(): void {
        const settings = readSettings();
        this.webviewView?.webview.postMessage({
            type: 'secretPathsUpdate',
            denyPaths: settings.denyPaths,
            allowSecretPaths: settings.allowSecretPaths,
        });
    }

    postTaskRunning(running: boolean): void {
        this.webviewView?.webview.postMessage({ type: 'taskRunning', running });
    }

    postConsoleEvent(eventType: string, data: Record<string, unknown>): void {
        this.webviewView?.webview.postMessage({ type: 'consoleEvent', eventType, data });
    }

    /** Re-send current config so the webview reflects external (Settings UI) changes. */
    pushConfig(): void {
        if (this.webviewView) this.sendConfig();
    }

    focusApiKey(): void {
        this.webviewView?.webview.postMessage({ type: 'focusApiKey' });
    }

    showHistory(): void {
        this.webviewView?.webview.postMessage({ type: 'showHistory' });
    }

    async requestApproval(command: string, scopes: Scope[]): Promise<ApprovalResult | null> {
        if (!this.webviewView) return null;
        return new Promise(resolve => {
            this.pendingApproval = resolve;
            this.webviewView!.webview.postMessage({ type: 'approvalRequest', command, scopes });
        });
    }

    setBadge(count: number): void {
        if (!this.webviewView) return;
        this.webviewView.badge = count > 0
            ? { value: count, tooltip: `${count} command awaiting approval` }
            : undefined;
    }

    private async getEffectiveKey(): Promise<string> {
        let apiKey = '';
        try { apiKey = await this.context.secrets.get('deepseek-api-key') ?? ''; } catch { apiKey = ''; }
        if (!apiKey) apiKey = readExistingMcpKey() ?? '';
        return apiKey;
    }

    /** Push the current configuration to the webview. */
    private async sendConfig(): Promise<void> {
        if (!this.webviewView) return;
        const apiKey   = await this.getEffectiveKey();
        const settings = readSettings();
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
        this.webviewView.webview.postMessage({
            type: 'config',
            apiKey,
            model:            settings.model,
            posture:          settings.posture,
            modelAuto:        settings.modelAuto,
            aggressiveness:   settings.aggressiveness,
            allowCommands:    settings.allowCommands,
            fullPermissions:  settings.fullPermissions,
            denyPaths:        settings.denyPaths,
            allowSecretPaths: settings.allowSecretPaths,
            injectGuidance:   getInjectTarget(),
            workspaceName,
            hasWorkspace:     !!workspacePath,
            workspaceEnabled: workspacePath ? isWorkspaceEnabled(workspacePath) : true,
        });
    }

    /** Write MCP config + runtime files + CLAUDE.md guidance with the current key. */
    private async persist(): Promise<string> {
        const apiKey = await this.getEffectiveKey();
        const settings = readSettings();
        let error = '';
        if (apiKey) {
            try { writeMcpConfig(this.context, apiKey, settings); } catch (e) { error = (e as Error).message; }
            const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            try { injectGuidance(wsPath, settings, getInjectTarget()); } catch { /* non-fatal */ }
        }
        return error;
    }

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this.webviewView = webviewView;
        webviewView.webview.options = { enableScripts: true };

        const nonce = crypto.randomBytes(16).toString('hex');
        webviewView.webview.html = this.buildHtml(nonce);

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        webviewView.webview.onDidReceiveMessage(async (msg: {
            type: string;
            apiKey?: string;
            model?: string;
            modelAuto?: string;
            posture?: string;
            aggressiveness?: string;
            command?: string;
            path?: string;
            enabled?: boolean;
        }) => {
            if (msg.type === 'load') {
                await this.sendConfig();
            }

            if (msg.type === 'toggleWorkspace') {
                if (!workspacePath) return;
                setWorkspaceEnabled(workspacePath, !!msg.enabled);
                vscode.commands.executeCommand('deepseek-bridge.refreshStatus');
                vscode.window.setStatusBarMessage(
                    `DeepSeek ${msg.enabled ? 'enabled' : 'disabled'} for this workspace`, 3000
                );
            }

            if (msg.type === 'save') {
                const apiKey         = (msg.apiKey ?? '').trim();
                const model          = msg.model ?? 'deepseek-v4-flash';
                const posture        = msg.posture === 'read-only' ? 'read-only' : 'edit';
                const modelAuto      = ['yes', 'no', 'ask'].includes(msg.modelAuto ?? '') ? (msg.modelAuto as string) : 'no';
                const aggressiveness = ['conservative', 'balanced', 'aggressive'].includes(msg.aggressiveness ?? '')
                    ? (msg.aggressiveness as string) : 'balanced';

                // One-time data-egress consent before any code can be transmitted.
                if (apiKey && !this.context.globalState.get<boolean>('deepseek-consented')) {
                    const ok = await vscode.window.showWarningMessage(
                        'DeepSeek Bridge sends your workspace file contents and prompts to DeepSeek’s API ' +
                        '(api.deepseek.com, operated by DeepSeek, Hangzhou, PRC) to perform delegated tasks. ' +
                        'Do not use it on code you cannot share with a third-party service.',
                        { modal: true },
                        'I Understand & Continue'
                    );
                    if (ok !== 'I Understand & Continue') {
                        webviewView.webview.postMessage({ type: 'saved', ok: false, apiKey, model });
                        return;
                    }
                    await this.context.globalState.update('deepseek-consented', true);
                }

                try {
                    if (apiKey) await this.context.secrets.store('deepseek-api-key', apiKey);
                    else        await this.context.secrets.delete('deepseek-api-key');
                } catch { /* no keyring backend — config write below is authoritative */ }

                await updateSetting('model', model);
                await updateSetting('posture', posture);
                await updateSetting('modelAuto', modelAuto);
                await updateSetting('delegationAggressiveness', aggressiveness);

                if (apiKey) {
                    const saveError = await this.persist();
                    webviewView.webview.postMessage({ type: 'saved', ok: !saveError, apiKey, model });
                    vscode.commands.executeCommand('deepseek-bridge.refreshStatus');
                    if (saveError) {
                        vscode.window.showErrorMessage(`DeepSeek Bridge: could not write config — ${saveError}`);
                    } else {
                        void vscode.window.showInformationMessage(
                            'DeepSeek Bridge saved. Model & permission changes apply immediately; an API-key change needs a one-time reconnect.',
                            'Reconnect Claude Code'
                        ).then(c => { if (c === 'Reconnect Claude Code') vscode.commands.executeCommand('deepseek-bridge.reconnect'); });
                    }
                } else {
                    webviewView.webview.postMessage({ type: 'saved', ok: false, apiKey: '', model });
                    vscode.window.showWarningMessage('DeepSeek Bridge: API key removed.');
                }
            }

            if (msg.type === 'addCommand') {
                const cmd = (msg.command ?? '').trim();
                if (!cmd) return;
                const existing = readSettings().allowCommands;
                if (existing.includes(cmd)) return;
                const updated = [...existing, cmd].sort((a, b) => a.localeCompare(b));
                await updateSetting('allowCommands', updated);
                await this.persist();
                webviewView.webview.postMessage({ type: 'allowCommandsUpdate', commands: updated });
            }

            if (msg.type === 'removeCommand') {
                const cmd = (msg.command ?? '').trim();
                const updated = readSettings().allowCommands.filter(c => c !== cmd);
                await updateSetting('allowCommands', updated);
                await this.persist();
                webviewView.webview.postMessage({ type: 'allowCommandsUpdate', commands: updated });
            }

            if (msg.type === 'editCommand') {
                const oldCmd = ((msg as unknown as Record<string, string>)['oldCommand'] ?? '').trim();
                const newCmd = ((msg as unknown as Record<string, string>)['newCommand'] ?? '').trim();
                if (!newCmd || oldCmd === newCmd) return;
                const updated = [...readSettings().allowCommands.filter(c => c !== oldCmd), newCmd].sort((a, b) => a.localeCompare(b));
                await updateSetting('allowCommands', updated);
                await this.persist();
                webviewView.webview.postMessage({ type: 'allowCommandsUpdate', commands: updated });
            }

            if (msg.type === 'addDenyPath') {
                const p = (msg.path ?? '').trim();
                if (!p) return;
                const existing = readSettings().denyPaths;
                if (existing.includes(p)) return;
                const updated = [...existing, p].sort((a, b) => a.localeCompare(b));
                await updateSetting('denyPaths', updated);
                await this.persist();
                this.pushSecretPaths();
            }

            if (msg.type === 'removeDenyPath') {
                const p = (msg.path ?? '').trim();
                const updated = readSettings().denyPaths.filter(x => x !== p);
                await updateSetting('denyPaths', updated);
                await this.persist();
                this.pushSecretPaths();
            }

            if (msg.type === 'editDenyPath') {
                const oldP = ((msg as unknown as Record<string, string>)['oldPath'] ?? '').trim();
                const newP = ((msg as unknown as Record<string, string>)['newPath'] ?? '').trim();
                if (!newP || oldP === newP) return;
                const updated = [...readSettings().denyPaths.filter(x => x !== oldP), newP].sort((a, b) => a.localeCompare(b));
                await updateSetting('denyPaths', updated);
                await this.persist();
                this.pushSecretPaths();
            }

            if (msg.type === 'removeAllowSecretPath') {
                const p = (msg.path ?? '').trim();
                const updated = readSettings().allowSecretPaths.filter(x => x !== p);
                await updateSetting('allowSecretPaths', updated);
                await this.persist();
                this.pushSecretPaths();
            }

            if (msg.type === 'approvalResponse') {
                if (this.pendingApproval) {
                    this.pendingApproval({
                        approvals: (msg as unknown as { approvals?: { scope: string; duration: string }[] }).approvals as ApprovalResult['approvals'] ?? [],
                    });
                    this.pendingApproval = null;
                }
            }

            if (msg.type === 'toggleFullPerms') {
                await updateSetting('fullPermissions', !!msg.enabled);
                await this.persist();
            }

            if (msg.type === 'loadHistory') {
                let data: { version: number; entries: unknown[] } = { version: 1, entries: [] };
                try { data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { /* no history yet */ }
                webviewView.webview.postMessage({ type: 'historyData', entries: data.entries ?? [] });
            }

            if (msg.type === 'approvalDeny') {
                if (this.pendingApproval) {
                    this.pendingApproval(null);
                    this.pendingApproval = null;
                }
            }

            if (msg.type === 'stopTask') {
                try {
                    const killFile = path.join(os.homedir(), '.claude', `deepseek-kill-${workspaceKey(workspacePath)}`);
                    fs.mkdirSync(path.dirname(killFile), { recursive: true });
                    fs.writeFileSync(killFile, '1', 'utf8');
                } catch { /* non-fatal */ }
            }

            if (msg.type === 'validateCommands') {
                const cmds = readSettings().allowCommands;
                const { execSync: execSyncV } = await import('child_process');
                const results = cmds.map(cmd => {
                    const exe = cmd.split(/\s+/)[0] ?? cmd;
                    try {
                        const check = process.platform === 'win32' ? `where "${exe}"` : `which "${exe}"`;
                        execSyncV(check, { stdio: 'pipe', timeout: 2000 });
                        return { cmd, inPath: true };
                    } catch { return { cmd, inPath: false }; }
                });
                webviewView.webview.postMessage({ type: 'validateResults', results });
            }
        }, undefined, this.context.subscriptions);
    }

    private buildHtml(nonce: string): string {
        const modelOptions = MODELS
            .map(m => `<option value="${m.id}">${m.label}</option>`)
            .join('\n        ');
        const claudePricingJson = JSON.stringify(CLAUDE_PRICING);

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      padding: 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      line-height: 1.4;
    }

    /* ── Approval overlay ──────────────────────────────────── */
    #approvalOverlay {
      display: none;
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 5px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .ap-header {
      display: flex; align-items: center; gap: 7px;
      padding: 9px 12px;
      background: rgba(0, 122, 204, 0.12);
      font-weight: 600; font-size: 12px;
    }
    .ap-pulse {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--vscode-focusBorder, #007acc);
      animation: pulse 1.4s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.7); }
    }
    .ap-cmd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px;
      padding: 9px 12px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      word-break: break-all; white-space: pre-wrap;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .ap-section {
      padding: 10px 12px 4px;
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.6px; opacity: 0.5;
    }
    #approvalScopes { padding: 4px 10px 8px; display: flex; flex-direction: column; gap: 2px; }
    .scope-option {
      display: block;
      padding: 6px 8px; border-radius: 4px; cursor: pointer;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      transition: background 0.1s;
    }
    .scope-option:hover { background: var(--vscode-list-hoverBackground); }
    .scope-option.selected {
      background: rgba(0, 122, 204, 0.10);
      border-color: rgba(0, 122, 204, 0.35);
    }
    .scope-row { display: flex; align-items: center; gap: 8px; }
    .scope-dur {
      width: auto; padding: 2px 18px 2px 5px; font-size: 10.5px;
      flex-shrink: 0; margin-left: auto;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px; font-family: inherit; appearance: none; cursor: pointer;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24'%3E%3Cpath fill='%23888' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 4px center;
    }
    .scope-option input[type="checkbox"] { flex-shrink: 0; accent-color: var(--vscode-focusBorder, #007acc); margin: 0; }
    .scope-prefix {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px; word-break: break-all;
      color: var(--vscode-foreground);
    }
    .scope-detail { font-size: 10.5px; opacity: 0.55; padding-left: 20px; margin-top: 2px; color: var(--vscode-foreground); }
    .scope-detail.danger { color: #e2a730; opacity: 0.95; }
    .ap-actions {
      display: flex; gap: 6px; padding: 8px 10px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      background: var(--vscode-input-background);
    }
    .btn-allow {
      flex: 1; padding: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 3px;
      font-family: inherit; font-size: inherit; font-weight: 600;
      cursor: pointer;
    }
    .btn-allow:hover { background: var(--vscode-button-hoverBackground); }
    .btn-deny {
      flex: 1; padding: 6px;
      background: none;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px;
      font-family: inherit; font-size: inherit;
      cursor: pointer; opacity: 0.7;
    }
    .btn-deny:hover { opacity: 1; border-color: #f14c4c; color: #f14c4c; }

    /* ── Tabs ─────────────────────────────────────────────── */
    .tab-bar {
      display: flex; gap: 2px; margin-bottom: 14px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .tab-btn {
      padding: 5px 14px; border: none; background: none;
      color: var(--vscode-foreground); font-family: inherit; font-size: inherit;
      cursor: pointer; opacity: 0.55; border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab-btn:hover { opacity: 0.85; }
    .tab-btn.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #007acc); font-weight: 600; }

    /* ── History tab ───────────────────────────────────────── */
    .history-entry {
      padding: 9px 10px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 4px; margin-bottom: 6px;
      background: var(--vscode-input-background);
    }
    .history-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
    .history-date { font-size: 10.5px; opacity: 0.5; }
    .history-tool { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.4; }
    .history-summary {
      font-size: 11.5px; margin-bottom: 8px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--vscode-foreground);
    }
    .history-costs { display: flex; flex-direction: column; gap: 2px; }
    .cost-row { display: flex; justify-content: space-between; font-size: 11px; }
    .cost-label { opacity: 0.6; }
    .cost-ds  { color: #3fb950; font-variant-numeric: tabular-nums; }
    .cost-claude { opacity: 0.7; font-variant-numeric: tabular-nums; }
    .cost-saved { color: #3fb950; font-weight: 600; font-variant-numeric: tabular-nums; }
    .cost-cache { color: #58a6ff; font-variant-numeric: tabular-nums; }
    .history-totals {
      margin-top: 10px; padding: 10px;
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 4px; background: rgba(0,122,204,0.07);
    }
    .totals-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6; margin-bottom: 6px; }
    .totals-row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 3px; }
    .totals-saved { color: #3fb950; font-weight: 700; font-size: 13px; }
    .totals-note { font-size: 10px; opacity: 0.5; margin-top: 6px; line-height: 1.4; }
    .history-empty { font-size: 11px; opacity: 0.4; padding: 8px 0; }
    .btn-refresh {
      background: none; border: none; cursor: pointer; opacity: 0.5;
      color: var(--vscode-foreground); font-size: 13px; padding: 2px 4px;
    }
    .btn-refresh:hover { opacity: 1; }

    /* ── Console tab ──────────────────────────────────────── */
    .console-log {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; line-height: 1.6;
      overflow-y: auto;
      flex: 1 1 auto; min-height: 120px;
      height: calc(100vh - 120px);
      background: var(--vscode-terminal-background, rgba(0,0,0,0.15));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 3px; padding: 8px 10px;
    }
    #consolePanel { display: flex; flex-direction: column; min-height: 0; }
    .ce { margin-bottom: 1px; word-break: break-all; }
    .ce-ts { opacity: 0.35; font-size: 10px; margin-right: 5px; user-select: none; }
    .ce.task-start { color: #3fb950; font-weight: 600; }
    .ce.tool-call  { color: #79c0ff; }
    .ce.tool-result { color: #8b949e; font-size: 10.5px; padding-left: 12px; }
    .ce.response   { color: var(--vscode-foreground); opacity: 0.8; }
    .ce.tokens     { color: #d2a8ff; font-size: 10px; opacity: 0.55; }
    .ce.condensing { color: #e2a730; font-size: 10.5px; }
    .ce.steering   { color: #e2a730; font-size: 10.5px; font-weight: 600; }
    .ce.stalled    { color: #e2a730; font-size: 10.5px; }
    .ce.task-end   { color: #3fb950; font-weight: 600; border-top: 1px solid rgba(63,185,80,0.25); margin-top: 4px; padding-top: 4px; }
    .ce.task-killed { color: #f14c4c; font-weight: 600; }
    .session-count { font-size: 10.5px; opacity: 0.6; }

    .btn-stop {
      margin-left: auto; padding: 3px 9px;
      background: rgba(241,76,76,0.10);
      color: #f14c4c;
      border: 1px solid rgba(241,76,76,0.25);
      border-radius: 3px; font-family: inherit; font-size: 11px;
      cursor: pointer; opacity: 0.4; transition: opacity 0.15s, background 0.15s;
      align-self: center; margin-bottom: 2px; flex-shrink: 0;
    }
    .btn-stop.running { opacity: 1; background: rgba(241,76,76,0.18); border-color: rgba(241,76,76,0.5); }
    .btn-stop:hover { opacity: 1; }

    /* ── Config panel ──────────────────────────────────────── */
    .status-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 4px; margin-bottom: 16px;
      font-size: 12px; border: 1px solid transparent;
    }
    .status-bar.unconfigured { background: rgba(255,140,0,.1); border-color: rgba(255,140,0,.35); }
    .status-bar.configured   { background: rgba(35,134,54,.1);  border-color: rgba(35,134,54,.35); }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .dot.orange { background: #f0883e; }
    .dot.green  { background: #3fb950; }

    .field { margin-bottom: 14px; }
    label {
      display: block; margin-bottom: 5px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px; opacity: 0.65;
    }
    .input-row { display: flex; gap: 4px; }
    input[type="text"], input[type="password"], select {
      width: 100%; padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px; font-family: inherit; font-size: inherit;
      outline: none; appearance: none;
    }
    input[type="text"]:focus, input[type="password"]:focus, select:focus { border-color: var(--vscode-focusBorder); }
    input[type="checkbox"] { width: auto; padding: 0; flex-shrink: 0; }
    input[type="password"], input[type="text"] {
      font-family: var(--vscode-editor-font-family, monospace);
      letter-spacing: 0.02em;
    }
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%23888' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 8px center;
      padding-right: 28px; cursor: pointer;
    }
    .icon-btn {
      padding: 6px 9px;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px; cursor: pointer; font-size: 13px;
      opacity: 0.7; flex-shrink: 0; line-height: 1;
    }
    .icon-btn:hover { opacity: 1; }
    .hint { margin-top: 5px; font-size: 11px; opacity: 0.5; }
    .hint a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .btn-primary {
      width: 100%; padding: 8px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 3px;
      font-family: inherit; font-size: inherit; font-weight: 600;
      cursor: pointer; margin-top: 4px;
    }
    .btn-primary:hover  { background: var(--vscode-button-hoverBackground); }
    .btn-primary:active { opacity: 0.85; }
    .divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      margin: 16px 0;
    }
    .ws-toggle {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 10px 12px; margin-bottom: 16px;
      border-radius: 4px; background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
    }
    .ws-toggle .ws-text  { min-width: 0; }
    .ws-toggle .ws-title { font-size: 12px; font-weight: 600; }
    .ws-toggle .ws-sub   { font-size: 11px; opacity: 0.55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: rgba(128,128,128,.4); border-radius: 20px; transition: .2s; }
    .slider::before { content: ""; position: absolute; width: 14px; height: 14px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
    .switch input:checked  + .slider         { background: #3fb950; }
    .switch input:checked  + .slider::before { transform: translateX(16px); }
    .switch input:disabled + .slider         { opacity: .4; cursor: not-allowed; }
    .full-perms-toggle .slider { background: rgba(241,76,76,0.4); }
    .full-perms-toggle input:checked + .slider { background: #f14c4c; }
    .cmd-list { list-style: none; display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
    .cmd-item {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 6px 5px 8px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.2));
      border-radius: 3px;
    }
    .cmd-check { color: #3fb950; font-size: 12px; flex-shrink: 0; line-height: 1; }
    .cmd-text {
      flex: 1; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cmd-edit, .cmd-del {
      background: none; border: none; cursor: pointer;
      opacity: 0.35; font-size: 12px; padding: 0 2px;
      color: inherit; flex-shrink: 0; line-height: 1;
    }
    .cmd-edit:hover { opacity: 0.9; }
    .cmd-del:hover { opacity: 1; color: #f14c4c; }
    .cmd-edit-input {
      flex: 1; font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; padding: 1px 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-focusBorder, #007acc);
      border-radius: 2px; outline: none; width: 100%; min-width: 0;
    }
    .cmd-empty { font-size: 11px; opacity: 0.4; padding: 4px 0 6px; }
    .info { font-size: 11px; opacity: 0.55; line-height: 1.5; }
    .privacy { font-size: 10.5px; opacity: 0.5; line-height: 1.5; margin-top: 8px; }
    .privacy a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  </style>
</head>
<body>

  <div class="tab-bar">
    <button class="tab-btn active" data-tab="config">Config</button>
    <button class="tab-btn" data-tab="history">History</button>
    <button class="tab-btn" data-tab="console">Console</button>
    <button class="btn-stop" id="stopBtn" title="No task running" aria-label="Stop running task">⬛ Stop</button>
  </div>

  <div id="approvalOverlay" role="alertdialog" aria-modal="true" aria-labelledby="apTitle">
    <div class="ap-header">
      <span class="ap-pulse" aria-hidden="true"></span>
      <span id="apTitle">Approval Required</span>
    </div>
    <pre id="approvalCmd" class="ap-cmd"></pre>
    <p class="ap-section">Allow which scope?</p>
    <div id="approvalScopes"></div>
    <div class="ap-actions">
      <button class="btn-allow" id="allowBtn">Allow</button>
      <button class="btn-deny"  id="denyBtn">Deny</button>
    </div>
  </div>

  <div id="configPanel">
    <div class="status-bar unconfigured" id="statusBar">
      <span class="dot orange" id="statusDot"></span>
      <span id="statusText">Not configured</span>
    </div>

    <div class="ws-toggle">
      <div class="ws-text">
        <div class="ws-title">Use in this workspace</div>
        <div class="ws-sub" id="wsName">No folder open</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="wsEnabled" aria-label="Enable DeepSeek for this workspace" />
        <span class="slider"></span>
      </label>
    </div>

    <div class="field">
      <label for="apiKey">API Key</label>
      <div class="input-row">
        <input type="password" id="apiKey" placeholder="sk-…" autocomplete="off" spellcheck="false" />
        <button class="icon-btn" id="toggleKey" title="Show / hide key" aria-label="Show or hide API key">👁</button>
      </div>
      <p class="hint">Get yours at <a href="https://platform.deepseek.com/api_keys">platform.deepseek.com</a></p>
    </div>

    <div class="field">
      <label for="model">Model</label>
      <select id="model">${modelOptions}</select>
    </div>

    <div class="field">
      <label for="aggressiveness">Delegation Aggressiveness</label>
      <select id="aggressiveness">
        <option value="conservative">Conservative — only large, clearly heavy chores</option>
        <option value="balanced">Balanced — multi-file / large-file work (recommended)</option>
        <option value="aggressive">Aggressive — offload eagerly, keep Claude lean</option>
      </select>
      <p class="hint" id="aggressivenessHint"></p>
    </div>

    <div class="field">
      <label for="modelAuto">Automatic Model Switching</label>
      <select id="modelAuto">
        <option value="no">No — always use selected model</option>
        <option value="ask">Ask — prompt me when Claude wants to switch</option>
        <option value="yes">Yes — Claude chooses freely</option>
      </select>
      <p class="hint" id="modelAutoHint"></p>
    </div>

    <div class="field">
      <label for="posture">Permissions</label>
      <select id="posture">
        <option value="edit">Edit — read &amp; write files (recommended)</option>
        <option value="read-only">Read-only — read files only</option>
      </select>
      <p class="hint" id="postureHint"></p>
    </div>

    <button class="btn-primary" id="saveBtn">Save &amp; Connect</button>

    <hr class="divider">

    <div class="ws-toggle full-perms-toggle" style="margin-bottom:12px">
      <div class="ws-text">
        <div class="ws-title">Full Permissions <span style="color:#f14c4c;font-size:10px;font-weight:700;margin-left:4px">CAUTION</span></div>
        <div class="ws-sub">Auto-approve all commands — trusted environments only</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="fullPerms" aria-label="Enable full permissions (auto-approve all commands)" />
        <span class="slider"></span>
      </label>
    </div>

    <div class="field">
      <label>Secret Files <span class="ws-sub" style="font-weight:400">— never shared with DeepSeek</span></label>
      <div class="input-row" style="margin-bottom:6px">
        <input type="text" id="addDenyInput" placeholder="e.g. secrets/**, **/*.secret, config/prod.json" spellcheck="false" aria-label="Add secret file pattern" />
        <button class="icon-btn" id="addDenyBtn" title="Add secret pattern" aria-label="Add secret pattern">＋</button>
      </div>
      <ul class="cmd-list" id="denyList">
        <li><p class="cmd-empty">No custom patterns — only the built-in defaults are blocked.</p></li>
      </ul>
      <p class="hint" style="margin:4px 0 0">
        Blocked on top of the always-on built-ins (.env, .ssh, .aws, keys, .git,
        *.tfstate, *.sqlite — not exhaustive). Workspace-relative globs: <code>*</code>
        stays in one folder, <code>**</code> spans folders. Reading or writing a blocked
        file prompts you for permission.
      </p>
      <div id="allowSecretWrap" style="display:none;margin-top:8px">
        <label style="font-size:11px;opacity:0.8">Allowed exceptions <span class="ws-sub" style="font-weight:400">— granted via "Always allow"</span></label>
        <ul class="cmd-list" id="allowSecretList"></ul>
      </div>
    </div>

    <div class="field">
      <label>Auto-approved Commands</label>
      <div class="input-row" style="margin-bottom:6px">
        <input type="text" id="addCmdInput" placeholder="e.g. node, git, npm test" spellcheck="false" aria-label="Add auto-approved command" />
        <button class="icon-btn" id="addCmdBtn" title="Add command" aria-label="Add command">＋</button>
      </div>
      <ul class="cmd-list" id="cmdList">
        <li><p class="cmd-empty">No commands — DeepSeek will prompt for each.</p></li>
      </ul>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px">
        <p class="hint" style="margin:0">Prefix approved — "node" allows all node commands.</p>
        <button class="btn-refresh" id="validateCmdsBtn" title="Check which commands are not found in PATH" aria-label="Validate commands against PATH">⚑ Validate</button>
      </div>
    </div>

    <hr class="divider">

    <p class="info">
      DeepSeek is jailed to this workspace: the agent has no network tools of its
      own, and a denylist blocks common secret files (plus any you add above).
    </p>
    <p class="privacy">
      <strong>Privacy:</strong> to do its work, your file contents and prompts are
      sent to DeepSeek's API (api.deepseek.com, operated by DeepSeek, Hangzhou PRC).
      Don't use it on code you can't share with a third party.
      <a href="https://platform.deepseek.com/downloads/DeepSeek%20Privacy%20Policy.html">Privacy policy</a>
    </p>
  </div>

  <div id="historyPanel" style="display:none">
    <div class="field" style="margin-bottom:10px">
      <label for="claudeTier">Compare to Claude</label>
      <select id="claudeTier">
        <option value="haiku">Haiku 4.5 — $1.00 / $5.00 per M tokens</option>
        <option value="sonnet" selected>Sonnet 4.6 — $3.00 / $15.00 per M tokens</option>
        <option value="opus">Opus 4.8 — $5.00 / $25.00 per M tokens</option>
      </select>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <label style="margin:0">Sessions</label>
      <button class="btn-refresh" id="refreshHistory" title="Refresh" aria-label="Refresh history">↺</button>
    </div>

    <div id="historyList">
      <p class="history-empty">No history yet — run a DeepSeek task to start tracking costs.</p>
    </div>

    <div id="historyTotals" style="display:none" class="history-totals">
      <div class="totals-title">Lifetime</div>
      <div class="totals-row"><span>DeepSeek spent</span><span id="totDs" class="cost-ds"></span></div>
      <div class="totals-row"><span id="totClaudeLabel">Sonnet 4.6 would cost</span><span id="totClaude" class="cost-claude"></span></div>
      <div class="totals-row"><span>Total saved</span><span id="totSaved" class="totals-saved"></span></div>
      <div class="totals-note">Gross token-cost delta vs the same tokens at Claude's rate. Excludes Claude's own orchestration/verification overhead, so net savings are somewhat lower.</div>
    </div>
  </div>

  <div id="consolePanel" style="display:none">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <label style="margin:0">Live Output</label>
      <span class="session-count" id="sessionCount"></span>
      <button class="btn-refresh" id="clearConsole" title="Clear log" aria-label="Clear console">✕ Clear</button>
    </div>
    <div id="consoleLog" class="console-log">
      <p class="history-empty">No task running — output will appear here.</p>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode        = acquireVsCodeApi();
  const CLAUDE_PRICING = ${claudePricingJson};
  const apiKeyInput   = document.getElementById('apiKey');
  const modelSelect      = document.getElementById('model');
  const modelAutoSelect  = document.getElementById('modelAuto');
  const modelAutoHint    = document.getElementById('modelAutoHint');
  const aggrSelect       = document.getElementById('aggressiveness');
  const aggrHint         = document.getElementById('aggressivenessHint');
  const postureSelect    = document.getElementById('posture');
  const postureHint      = document.getElementById('postureHint');
  const saveBtn       = document.getElementById('saveBtn');
  const toggleKey     = document.getElementById('toggleKey');
  const statusBar     = document.getElementById('statusBar');
  const statusDot     = document.getElementById('statusDot');
  const statusText    = document.getElementById('statusText');
  const wsEnabled     = document.getElementById('wsEnabled');
  const wsName        = document.getElementById('wsName');
  const cmdList       = document.getElementById('cmdList');
  const addCmdInput   = document.getElementById('addCmdInput');
  const addCmdBtn     = document.getElementById('addCmdBtn');
  const denyList        = document.getElementById('denyList');
  const addDenyInput    = document.getElementById('addDenyInput');
  const addDenyBtn      = document.getElementById('addDenyBtn');
  const allowSecretList = document.getElementById('allowSecretList');
  const allowSecretWrap = document.getElementById('allowSecretWrap');

  const approvalOverlay = document.getElementById('approvalOverlay');
  const approvalCmd     = document.getElementById('approvalCmd');
  const approvalScopes  = document.getElementById('approvalScopes');
  const allowBtn        = document.getElementById('allowBtn');
  const denyBtn         = document.getElementById('denyBtn');
  const stopBtn         = document.getElementById('stopBtn');

  let lastFocused = null;

  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stopTask' });
    if (approvalOverlay.style.display !== 'none') {
      vscode.postMessage({ type: 'approvalDeny' });
      hideApproval();
    }
  });

  const consolePanel  = document.getElementById('consolePanel');
  const consoleLogEl  = document.getElementById('consoleLog');
  const clearConsoleB = document.getElementById('clearConsole');
  const sessionCountEl = document.getElementById('sessionCount');
  let sessionTaskCount = 0;

  clearConsoleB.addEventListener('click', () => {
    consoleLogEl.innerHTML = '<p class="history-empty">Log cleared.</p>';
  });

  function appendConsole(eventType, data) {
    if (consoleLogEl.querySelector('.history-empty')) consoleLogEl.innerHTML = '';
    const entry = document.createElement('div');
    entry.className = 'ce ' + eventType.replace(/_/g, '-');
    const now = new Date();
    const ts  = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // NOTE: this runs INSIDE buildHtml's template literal — regex backslashes must
    // be doubled (/\\n/g) or the script dies with a syntax error.
    let text = '';
    switch (eventType) {
      case 'task_start':
        text = '▶ ' + String(data.prompt || '').slice(0, 100) + (String(data.prompt || '').length > 100 ? '…' : '');
        break;
      case 'tool_call': {
        const argsStr = JSON.stringify(data.args || {});
        text = '⚙ ' + String(data.name) + '  ' + argsStr.slice(0, 120) + (argsStr.length > 120 ? '…' : '');
        break;
      }
      case 'tool_result':
        text = '↳ ' + String(data.result || '').replace(/\\n/g, ' ').slice(0, 140) + (String(data.result || '').length > 140 ? '…' : '');
        break;
      case 'response':
        text = '💬 ' + String(data.content || '').replace(/\\n/g, ' ').slice(0, 140);
        break;
      case 'tokens':
        text = '⬡ iter ' + data.iteration + '  in=' + data.input + '  out=' + data.output
             + (data.contextTokens ? '  ctx=' + Math.round(data.contextTokens/1000) + 'k' : '');
        break;
      case 'condensing':
        text = '↻ condensing context (' + Math.round((data.contextTokens||0)/1000) + 'k)…';
        break;
      case 'stalled':
        text = '↺ empty turn — nudging agent to continue (' + data.nudge + '/3)';
        break;
      case 'steering':
        text = (data.level === 'critical' ? '⚠ budget critical' : '⏳ budget check')
             + ' — iteration ' + data.iteration + '/' + data.iterationCap
             + (data.level === 'critical' ? ': wrap up now' : ': narrowing scope');
        break;
      case 'task_end':
        text = '✓ ' + String(data.summary || '').slice(0, 140) + '  ($' + Number(data.costUsd || 0).toFixed(5) + ')';
        break;
      case 'task_killed':
        text = '⬛ Stopped by user';
        break;
      default:
        text = JSON.stringify(data).slice(0, 160);
    }
    entry.innerHTML = '<span class="ce-ts">' + ts + '</span>' + esc(text);
    consoleLogEl.appendChild(entry);
    consoleLogEl.scrollTop = consoleLogEl.scrollHeight;
  }

  let currentAllowCommands = [];
  let currentDenyPaths = [];
  let currentAllowSecretPaths = [];

  vscode.postMessage({ type: 'load' });

  // ── Approval card ──────────────────────────────────────────────────────────
  function showApproval(command, scopes) {
    lastFocused = document.activeElement;
    approvalCmd.textContent = command;
    approvalScopes.innerHTML = scopes.map((s, i) => {
      const safe      = esc(s.prefix);
      const detail    = esc(s.detail);
      const alreadyOk = currentAllowCommands.includes(s.prefix);
      const checked   = i === 0;   // default to the exact command, never a broad scope
      const danger    = s.dangerous ? ' danger' : '';
      const extraNote = alreadyOk ? ' <span style="color:#3fb950;font-size:10px">✓ already approved</span>' : '';
      return \`<label class="scope-option\${checked ? ' selected' : ''}">
  <div class="scope-row">
    <input type="checkbox" name="scope" value="\${safe}" \${checked ? 'checked' : ''} aria-label="Approve scope \${safe}">
    <span class="scope-prefix">\${safe}</span>
    <select class="scope-dur" data-idx="\${i}" aria-label="Approval duration for \${safe}">
      <option value="once"\${alreadyOk ? '' : ' selected'}>Once</option>
      <option value="session">Session</option>
      <option value="always"\${alreadyOk ? ' selected' : ''}>Always</option>
    </select>
  </div>
  <div class="scope-detail\${danger}">\${detail}\${extraNote}</div>
</label>\`;
    }).join('');

    approvalScopes.querySelectorAll('input[name="scope"]').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.closest('.scope-option').classList.toggle('selected', cb.checked);
      });
    });

    approvalOverlay.style.display = 'block';
    document.addEventListener('keydown', approvalKeyHandler);
    allowBtn.focus();
  }

  function approvalKeyHandler(e) {
    if (e.key === 'Escape') {
      vscode.postMessage({ type: 'approvalDeny' });
      hideApproval();
    }
  }

  function hideApproval() {
    approvalOverlay.style.display = 'none';
    document.removeEventListener('keydown', approvalKeyHandler);
    if (lastFocused && lastFocused.focus) { try { lastFocused.focus(); } catch (e) {} }
  }

  allowBtn.addEventListener('click', () => {
    const approvals = [];
    const checkboxes = approvalScopes.querySelectorAll('input[name="scope"]');
    const selects    = approvalScopes.querySelectorAll('select.scope-dur');
    checkboxes.forEach((cb, idx) => {
      if (cb.checked) {
        const dur = selects[idx];
        approvals.push({ scope: cb.value, duration: dur ? dur.value : 'once' });
      }
    });
    if (!approvals.length) return;
    vscode.postMessage({ type: 'approvalResponse', approvals });
    hideApproval();
  });

  denyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'approvalDeny' });
    hideApproval();
  });

  // ── Extension messages ─────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;

    if (msg.type === 'config') {
      if (msg.apiKey)         apiKeyInput.value     = msg.apiKey;
      if (msg.model)          modelSelect.value     = msg.model;
      if (msg.posture)        postureSelect.value   = msg.posture;
      if (msg.modelAuto)      modelAutoSelect.value = msg.modelAuto;
      if (msg.aggressiveness) aggrSelect.value      = msg.aggressiveness;
      updatePostureHint();
      updateModelAutoHint();
      updateAggrHint();
      setStatus(!!msg.apiKey, msg.model);
      currentAllowCommands = msg.allowCommands || [];
      renderCommands(currentAllowCommands);
      currentDenyPaths = msg.denyPaths || [];
      currentAllowSecretPaths = msg.allowSecretPaths || [];
      renderDenyPaths(currentDenyPaths);
      renderAllowSecret(currentAllowSecretPaths);
      fullPermsToggle.checked = !!msg.fullPermissions;
      if (msg.hasWorkspace) {
        wsName.textContent = msg.workspaceName || 'this workspace';
        wsEnabled.checked  = !!msg.workspaceEnabled;
        wsEnabled.disabled = false;
      } else {
        wsName.textContent = 'No folder open';
        wsEnabled.checked  = false;
        wsEnabled.disabled = true;
      }
    }

    if (msg.type === 'saved') {
      if (msg.apiKey) apiKeyInput.value = msg.apiKey;
      setStatus(msg.ok && !!msg.apiKey, msg.model);
    }

    if (msg.type === 'allowCommandsUpdate') {
      currentAllowCommands = msg.commands || [];
      renderCommands(currentAllowCommands);
    }

    if (msg.type === 'secretPathsUpdate') {
      currentDenyPaths = msg.denyPaths || [];
      currentAllowSecretPaths = msg.allowSecretPaths || [];
      renderDenyPaths(currentDenyPaths);
      renderAllowSecret(currentAllowSecretPaths);
    }

    if (msg.type === 'approvalRequest') showApproval(msg.command, msg.scopes);

    if (msg.type === 'historyData') { historyEntries = msg.entries || []; renderHistory(); }

    if (msg.type === 'taskRunning') {
      stopBtn.classList.toggle('running', !!msg.running);
      stopBtn.title = msg.running ? 'Stop running DeepSeek task' : 'No task running';
    }

    if (msg.type === 'focusApiKey') {
      switchTab('config');
      apiKeyInput.focus();
    }

    if (msg.type === 'showHistory') switchTab('history');

    if (msg.type === 'consoleEvent') {
      appendConsole(msg.eventType, msg.data || {});
      if (msg.eventType === 'task_start') {
        sessionTaskCount++;
        sessionCountEl.textContent = 'Delegated this session: ' + sessionTaskCount;
        switchTab('console');
      }
    }

    if (msg.type === 'validateResults') {
      validateCmdsBtn.textContent = '⚑ Validate';
      validationResults = {};
      (msg.results || []).forEach(r => { validationResults[r.cmd] = r.inPath; });
      renderCommands(currentAllowCommands);
    }
  });

  // ── Allowed commands ──────────────────────────────────────────────────────
  function renderCommands(commands) {
    if (!commands.length) {
      cmdList.innerHTML = '<li><p class="cmd-empty">No commands — DeepSeek will prompt for each.</p></li>';
      return;
    }
    cmdList.innerHTML = commands.map(cmd => {
      const safe    = esc(cmd);
      const inPath  = validationResults ? validationResults[cmd] : null;
      const warnBadge = inPath === false
        ? '<span style="color:#e2a730;font-size:10px;margin-left:3px" title="Not found in PATH">⚠</span>'
        : '';
      return \`<li class="cmd-item" data-cmd="\${safe}">
        <span class="cmd-check">✓</span>
        <span class="cmd-text" title="\${safe}"\${inPath === false ? ' style="opacity:0.55"' : ''}>\${safe}</span>
        \${warnBadge}
        <button class="cmd-edit" title="Edit" aria-label="Edit command">✏</button>
        <button class="cmd-del" title="Remove" aria-label="Remove command">✕</button>
      </li>\`;
    }).join('');

    cmdList.querySelectorAll('.cmd-del').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeCommand', command: btn.closest('li').dataset.cmd });
      });
    });

    cmdList.querySelectorAll('.cmd-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const li      = btn.closest('li');
        const oldCmd  = li.dataset.cmd;
        const textEl  = li.querySelector('.cmd-text');
        const input   = document.createElement('input');
        input.type = 'text'; input.className = 'cmd-edit-input'; input.value = oldCmd;
        textEl.replaceWith(input);
        input.focus(); input.select();
        btn.style.display = 'none';
        function commit() {
          const newCmd = input.value.trim();
          if (newCmd && newCmd !== oldCmd) {
            vscode.postMessage({ type: 'editCommand', oldCommand: oldCmd, newCommand: newCmd });
          } else {
            const span = document.createElement('span');
            span.className = 'cmd-text'; span.title = esc(oldCmd); span.textContent = oldCmd;
            input.replaceWith(span); btn.style.display = '';
          }
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { input.blur(); }
          if (e.key === 'Escape') {
            input.removeEventListener('blur', commit);
            const span = document.createElement('span');
            span.className = 'cmd-text'; span.title = esc(oldCmd); span.textContent = oldCmd;
            input.replaceWith(span); btn.style.display = '';
          }
        });
      });
    });
  }

  function addCommand() {
    const cmd = addCmdInput.value.trim();
    if (!cmd) return;
    vscode.postMessage({ type: 'addCommand', command: cmd });
    addCmdInput.value = '';
  }
  addCmdBtn.addEventListener('click', addCommand);
  addCmdInput.addEventListener('keydown', e => { if (e.key === 'Enter') addCommand(); });

  // ── Secret-file patterns ───────────────────────────────────────────────────
  function renderDenyPaths(paths) {
    if (!paths.length) {
      denyList.innerHTML = '<li><p class="cmd-empty">No custom patterns — only the built-in defaults below are blocked.</p></li>';
      return;
    }
    denyList.innerHTML = paths.map(p => {
      const safe = esc(p);
      return \`<li class="cmd-item" data-cmd="\${safe}">
        <span class="cmd-check">🔒</span>
        <span class="cmd-text" title="\${safe}">\${safe}</span>
        <button class="cmd-edit" title="Edit" aria-label="Edit pattern">✏</button>
        <button class="cmd-del" title="Remove" aria-label="Remove pattern">✕</button>
      </li>\`;
    }).join('');

    denyList.querySelectorAll('.cmd-del').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeDenyPath', path: btn.closest('li').dataset.cmd });
      });
    });

    denyList.querySelectorAll('.cmd-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const li     = btn.closest('li');
        const oldP   = li.dataset.cmd;
        const textEl = li.querySelector('.cmd-text');
        const input  = document.createElement('input');
        input.type = 'text'; input.className = 'cmd-edit-input'; input.value = oldP;
        textEl.replaceWith(input);
        input.focus(); input.select();
        btn.style.display = 'none';
        function commit() {
          const newP = input.value.trim();
          if (newP && newP !== oldP) {
            vscode.postMessage({ type: 'editDenyPath', oldPath: oldP, newPath: newP });
          } else {
            const span = document.createElement('span');
            span.className = 'cmd-text'; span.title = esc(oldP); span.textContent = oldP;
            input.replaceWith(span); btn.style.display = '';
          }
        }
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter')  { input.blur(); }
          if (e.key === 'Escape') {
            input.removeEventListener('blur', commit);
            const span = document.createElement('span');
            span.className = 'cmd-text'; span.title = esc(oldP); span.textContent = oldP;
            input.replaceWith(span); btn.style.display = '';
          }
        });
      });
    });
  }

  function renderAllowSecret(paths) {
    if (!paths.length) {
      allowSecretWrap.style.display = 'none';
      allowSecretList.innerHTML = '';
      return;
    }
    allowSecretWrap.style.display = '';
    allowSecretList.innerHTML = paths.map(p => {
      const safe = esc(p);
      return \`<li class="cmd-item" data-cmd="\${safe}">
        <span class="cmd-check">🔓</span>
        <span class="cmd-text" title="\${safe}">\${safe}</span>
        <button class="cmd-del" title="Remove exception (re-block this file)" aria-label="Remove exception">✕</button>
      </li>\`;
    }).join('');
    allowSecretList.querySelectorAll('.cmd-del').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeAllowSecretPath', path: btn.closest('li').dataset.cmd });
      });
    });
  }

  function addDenyPath() {
    const p = addDenyInput.value.trim();
    if (!p) return;
    vscode.postMessage({ type: 'addDenyPath', path: p });
    addDenyInput.value = '';
  }
  addDenyBtn.addEventListener('click', addDenyPath);
  addDenyInput.addEventListener('keydown', e => { if (e.key === 'Enter') addDenyPath(); });

  const validateCmdsBtn = document.getElementById('validateCmdsBtn');
  let validationResults = null;
  validateCmdsBtn.addEventListener('click', () => {
    validateCmdsBtn.textContent = '…';
    vscode.postMessage({ type: 'validateCommands' });
  });

  const fullPermsToggle = document.getElementById('fullPerms');
  fullPermsToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleFullPerms', enabled: fullPermsToggle.checked });
  });

  // ── Config controls ────────────────────────────────────────────────────────
  wsEnabled.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleWorkspace', enabled: wsEnabled.checked });
  });
  toggleKey.addEventListener('click', () => {
    apiKeyInput.type      = apiKeyInput.type === 'password' ? 'text' : 'password';
    toggleKey.textContent = apiKeyInput.type === 'password' ? '👁' : '🙈';
  });
  postureSelect.addEventListener('change', updatePostureHint);
  modelAutoSelect.addEventListener('change', updateModelAutoHint);
  aggrSelect.addEventListener('change', updateAggrHint);

  function updateModelAutoHint() {
    const v = modelAutoSelect.value;
    modelAutoHint.textContent =
      v === 'yes' ? 'Claude switches between Flash and Pro freely based on task complexity.' :
      v === 'ask' ? 'Claude will prompt you before switching models — you decide each time.' :
                    'Model stays on whatever is selected above.';
  }
  function updateAggrHint() {
    const v = aggrSelect.value;
    aggrHint.textContent =
      v === 'aggressive'   ? 'Claude offloads most file work (2+ files / 150+ lines) to DeepSeek.' :
      v === 'conservative' ? 'Claude offloads only large chores (5+ files / 800+ lines).' :
                             'Claude offloads multi-file or large-file work (3+ files / 400+ lines).';
  }
  function updatePostureHint() {
    postureHint.textContent = postureSelect.value === 'read-only'
      ? 'DeepSeek can analyze but never modify files.'
      : 'DeepSeek can refactor, generate, and edit files in this workspace.';
  }
  updateModelAutoHint(); updateAggrHint(); updatePostureHint();

  saveBtn.addEventListener('click', () => {
    vscode.postMessage({
      type:      'save',
      apiKey:    apiKeyInput.value.trim(),
      model:     modelSelect.value,
      posture:   postureSelect.value,
      modelAuto: modelAutoSelect.value,
      aggressiveness: aggrSelect.value,
    });
    setStatus(!!apiKeyInput.value.trim(), modelSelect.value);
  });
  apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); });

  function setStatus(hasKey, model) {
    if (hasKey) {
      statusBar.className    = 'status-bar configured';
      statusDot.className    = 'dot green';
      statusText.textContent = 'Active — DeepSeek ' + (model === 'deepseek-v4-pro' ? 'V4 Pro' : 'V4 Flash');
    } else {
      statusBar.className    = 'status-bar unconfigured';
      statusDot.className    = 'dot orange';
      statusText.textContent = 'Not configured';
    }
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────
  const configPanel  = document.getElementById('configPanel');
  const historyPanel = document.getElementById('historyPanel');

  function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    configPanel.style.display  = tab === 'config'  ? '' : 'none';
    historyPanel.style.display = tab === 'history' ? '' : 'none';
    consolePanel.style.display = tab === 'console' ? '' : 'none';
    if (tab === 'history') vscode.postMessage({ type: 'loadHistory' });
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.tab) switchTab(btn.dataset.tab); });
  });

  // ── History rendering ──────────────────────────────────────────────────────
  const CLAUDE_LABEL = { haiku: 'Haiku 4.5', sonnet: 'Sonnet 4.6', opus: 'Opus 4.8' };
  let historyEntries = [];
  const claudeTierSelect  = document.getElementById('claudeTier');
  const historyListEl     = document.getElementById('historyList');
  const historyTotalsEl   = document.getElementById('historyTotals');
  const totDsEl           = document.getElementById('totDs');
  const totClaudeEl       = document.getElementById('totClaude');
  const totClaudeLabelEl  = document.getElementById('totClaudeLabel');
  const totSavedEl        = document.getElementById('totSaved');

  function fmt(usd) {
    if (usd < 0.0001) return '<$0.0001';
    if (usd < 0.01)   return '$' + usd.toFixed(4);
    if (usd < 1)      return '$' + usd.toFixed(3);
    return '$' + usd.toFixed(2);
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      + '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function renderHistory() {
    const tier    = claudeTierSelect.value;
    const pricing = CLAUDE_PRICING[tier];
    const label   = CLAUDE_LABEL[tier];
    if (!historyEntries.length) {
      historyListEl.innerHTML = '<p class="history-empty">No history yet — run a DeepSeek task to start tracking costs.</p>';
      historyTotalsEl.style.display = 'none';
      return;
    }
    let lifeDsCost = 0, lifeClaudeCost = 0;
    historyListEl.innerHTML = [...historyEntries].reverse().map(e => {
      const claudeCost = (e.inputTokens / 1000000) * pricing.input + (e.outputTokens / 1000000) * pricing.output;
      const saved      = claudeCost - e.deepseekCostUsd;
      const pct        = claudeCost > 0 ? Math.round((saved / claudeCost) * 100) : 0;
      lifeDsCost     += e.deepseekCostUsd;
      lifeClaudeCost += claudeCost;
      const cacheTot  = (e.cacheHitTokens || 0) + (e.cacheMissTokens || 0);
      let cacheRow = '';
      if (e.cacheReported === false) {
        cacheRow = '<div class="cost-row"><span class="cost-label">Cache hit</span><span class="cost-cache">unknown</span></div>';
      } else if (cacheTot > 0) {
        const cachePct = Math.round(((e.cacheHitTokens || 0) / cacheTot) * 100);
        cacheRow = '<div class="cost-row"><span class="cost-label">Cache hit</span><span class="cost-cache">' + cachePct + '%</span></div>';
      }
      return \`<div class="history-entry">
        <div class="history-meta">
          <span class="history-date">\${esc(fmtDate(e.timestamp))}</span>
          <span class="history-tool">\${esc(e.tool === 'run_deepseek_task' ? 'task' : 'ask')}</span>
        </div>
        <div class="history-summary" title="\${esc(e.summary)}">\${esc(e.summary)}</div>
        <div class="history-costs">
          <div class="cost-row"><span class="cost-label">DeepSeek</span><span class="cost-ds">\${fmt(e.deepseekCostUsd)}</span></div>
          <div class="cost-row"><span class="cost-label">\${esc(label)}</span><span class="cost-claude">\${fmt(claudeCost)}</span></div>
          <div class="cost-row"><span class="cost-label">Saved (gross)</span><span class="cost-saved">\${fmt(saved)} (\${pct}%)</span></div>
          \${cacheRow}
        </div>
      </div>\`;
    }).join('');

    const lifeSaved = lifeClaudeCost - lifeDsCost;
    const lifePct   = lifeClaudeCost > 0 ? Math.round((lifeSaved / lifeClaudeCost) * 100) : 0;
    totClaudeLabelEl.textContent = label + ' would cost';
    totDsEl.textContent          = fmt(lifeDsCost);
    totClaudeEl.textContent      = fmt(lifeClaudeCost);
    totSavedEl.textContent       = fmt(lifeSaved) + ' (' + lifePct + '%)';
    historyTotalsEl.style.display = '';
  }

  claudeTierSelect.addEventListener('change', renderHistory);
  document.getElementById('refreshHistory').addEventListener('click', () => {
    vscode.postMessage({ type: 'loadHistory' });
  });
</script>
</body>
</html>`;
    }
}
