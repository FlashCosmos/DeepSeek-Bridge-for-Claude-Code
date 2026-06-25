import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { writeMcpConfig } from './config';
import { isWorkspaceEnabled, setWorkspaceEnabled } from './control';

const MODELS = [
    { id: 'deepseek-v4-flash', label: 'V4 Flash — Fast & cheap (recommended)' },
    { id: 'deepseek-v4-pro',   label: 'V4 Pro — Advanced reasoning' },
];

type ApprovalResult = { scope: string; duration: 'once' | 'session' | 'always' };

export class DeepSeekSidebarProvider implements vscode.WebviewViewProvider {
    private webviewView: vscode.WebviewView | null = null;
    private pendingApproval: ((r: ApprovalResult | null) => void) | null = null;

    constructor(private readonly context: vscode.ExtensionContext) {}

    /** Push a live update to the allowed-commands list. */
    pushAllowCommands(commands: string[]): void {
        this.webviewView?.webview.postMessage({ type: 'allowCommandsUpdate', commands });
    }

    /** Show the approval card in the sidebar. Resolves when user responds. */
    async requestApproval(
        command: string,
        scopes: { prefix: string; detail: string }[]
    ): Promise<ApprovalResult | null> {
        if (!this.webviewView) return null;
        return new Promise(resolve => {
            this.pendingApproval = resolve;
            this.webviewView!.webview.postMessage({ type: 'approvalRequest', command, scopes });
        });
    }

    /** Set or clear the activity-bar badge (pending approval count). */
    setBadge(count: number): void {
        if (!this.webviewView) return;
        this.webviewView.badge = count > 0
            ? { value: count, tooltip: `${count} command awaiting approval` }
            : undefined;
    }

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        this.webviewView = webviewView;
        webviewView.webview.options = { enableScripts: true };

        const nonce = crypto.randomBytes(16).toString('hex');
        webviewView.webview.html = this.buildHtml(nonce);

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';

        webviewView.webview.onDidReceiveMessage(async (msg: {
            type: string;
            apiKey?: string;
            model?: string;
            posture?: string;
            command?: string;
            enabled?: boolean;
            scope?: string;
            duration?: string;
        }) => {
            if (msg.type === 'load') {
                const apiKey        = await this.context.secrets.get('deepseek-api-key') ?? '';
                const model         = this.context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
                const posture       = this.context.globalState.get<string>('deepseek-posture') ?? 'edit';
                const allowCommands = this.context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
                webviewView.webview.postMessage({
                    type: 'config', apiKey, model, posture, allowCommands,
                    workspaceName,
                    hasWorkspace:     !!workspacePath,
                    workspaceEnabled: workspacePath ? isWorkspaceEnabled(workspacePath) : true
                });
            }

            if (msg.type === 'toggleWorkspace') {
                if (!workspacePath) return;
                setWorkspaceEnabled(workspacePath, !!msg.enabled);
                vscode.commands.executeCommand('deepseek-bridge.refreshStatus');
                vscode.window.setStatusBarMessage(
                    `DeepSeek ${msg.enabled ? 'enabled' : 'disabled'} for ${workspaceName}`,
                    3000
                );
            }

            if (msg.type === 'save') {
                const apiKey  = (msg.apiKey ?? '').trim();
                const model   = msg.model ?? 'deepseek-v4-flash';
                const posture = msg.posture === 'read-only' ? 'read-only' : 'edit';

                if (apiKey) {
                    await this.context.secrets.store('deepseek-api-key', apiKey);
                } else {
                    await this.context.secrets.delete('deepseek-api-key');
                }
                await this.context.globalState.update('deepseek-model', model);
                await this.context.globalState.update('deepseek-posture', posture);

                if (apiKey) {
                    const allowCommands = this.context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
                    writeMcpConfig(this.context, apiKey, model, posture, allowCommands);
                    const action = await vscode.window.showInformationMessage(
                        'DeepSeek Bridge saved. Restart Claude Code to apply changes.',
                        'OK'
                    );
                    void action;
                } else {
                    vscode.window.showWarningMessage('DeepSeek Bridge: API key removed.');
                }
            }

            if (msg.type === 'addCommand') {
                const cmd = (msg.command ?? '').trim();
                if (!cmd) return;
                const existing = this.context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
                if (existing.includes(cmd)) return;
                const updated = [...existing, cmd];
                await this.saveAllowCommands(updated);
                webviewView.webview.postMessage({ type: 'allowCommandsUpdate', commands: updated });
            }

            if (msg.type === 'removeCommand') {
                const cmd = (msg.command ?? '').trim();
                const existing = this.context.globalState.get<string[]>('deepseek-allow-commands') ?? [];
                const updated  = existing.filter(c => c !== cmd);
                await this.saveAllowCommands(updated);
                webviewView.webview.postMessage({ type: 'allowCommandsUpdate', commands: updated });
            }

            if (msg.type === 'approvalResponse') {
                if (this.pendingApproval) {
                    this.pendingApproval({
                        scope:    msg.scope    ?? '',
                        duration: (msg.duration ?? 'once') as ApprovalResult['duration'],
                    });
                    this.pendingApproval = null;
                }
            }

            if (msg.type === 'approvalDeny') {
                if (this.pendingApproval) {
                    this.pendingApproval(null);
                    this.pendingApproval = null;
                }
            }
        }, undefined, this.context.subscriptions);
    }

    private async saveAllowCommands(commands: string[]): Promise<void> {
        await this.context.globalState.update('deepseek-allow-commands', commands);
        const apiKey  = await this.context.secrets.get('deepseek-api-key');
        const model   = this.context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
        const posture = this.context.globalState.get<string>('deepseek-posture') ?? 'edit';
        if (apiKey) writeMcpConfig(this.context, apiKey, model, posture, commands);
    }

    private buildHtml(nonce: string): string {
        const modelOptions = MODELS
            .map(m => `<option value="${m.id}">${m.label}</option>`)
            .join('\n        ');

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
    .scope-row {
      display: flex; align-items: center; gap: 8px;
    }
    .scope-option input[type="radio"] { flex-shrink: 0; accent-color: var(--vscode-focusBorder, #007acc); margin: 0; }
    .scope-prefix {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11.5px; word-break: break-all;
      color: var(--vscode-foreground);
    }
    .scope-detail { font-size: 10.5px; opacity: 0.55; padding-left: 20px; margin-top: 2px; color: var(--vscode-foreground); }

    .dur-row { display: flex; gap: 4px; padding: 4px 10px 10px; }
    .dur-btn {
      flex: 1; padding: 5px 0;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px; font-family: inherit; font-size: 11.5px;
      cursor: pointer; transition: background 0.1s;
    }
    .dur-btn:hover { background: var(--vscode-list-hoverBackground); }
    .dur-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

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

    input, select {
      width: 100%; padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px; font-family: inherit; font-size: inherit;
      outline: none; appearance: none;
    }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); }
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

    /* ── Allowed commands list (ZooCode style) ─────────────── */
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
    .cmd-del {
      background: none; border: none; cursor: pointer;
      opacity: 0.35; font-size: 12px; padding: 0 2px;
      color: inherit; flex-shrink: 0; line-height: 1;
    }
    .cmd-del:hover { opacity: 1; color: #f14c4c; }

    .cmd-empty { font-size: 11px; opacity: 0.4; padding: 4px 0 6px; }

    .info { font-size: 11px; opacity: 0.55; line-height: 1.5; }
  </style>
</head>
<body>

  <!-- Approval card (shown when DeepSeek needs permission) -->
  <div id="approvalOverlay">
    <div class="ap-header">
      <span class="ap-pulse"></span>
      <span>Approval Required</span>
    </div>
    <pre id="approvalCmd" class="ap-cmd"></pre>
    <p class="ap-section">Allow which scope?</p>
    <div id="approvalScopes"></div>
    <p class="ap-section">For how long?</p>
    <div class="dur-row" id="durationRow">
      <button class="dur-btn active" data-dur="once">Once</button>
      <button class="dur-btn" data-dur="session">Session</button>
      <button class="dur-btn" data-dur="always">Always</button>
    </div>
    <div class="ap-actions">
      <button class="btn-allow" id="allowBtn">Allow</button>
      <button class="btn-deny"  id="denyBtn">Deny</button>
    </div>
  </div>

  <!-- Config panel -->
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
        <input type="checkbox" id="wsEnabled" />
        <span class="slider"></span>
      </label>
    </div>

    <div class="field">
      <label>API Key</label>
      <div class="input-row">
        <input type="password" id="apiKey" placeholder="sk-…" autocomplete="off" spellcheck="false" />
        <button class="icon-btn" id="toggleKey" title="Show / hide key">👁</button>
      </div>
      <p class="hint">Get yours at <a href="https://platform.deepseek.com/api_keys">platform.deepseek.com</a></p>
    </div>

    <div class="field">
      <label>Model</label>
      <select id="model">${modelOptions}</select>
    </div>

    <div class="field">
      <label>Permissions</label>
      <select id="posture">
        <option value="edit">Edit — read &amp; write files (recommended)</option>
        <option value="read-only">Read-only — read files only</option>
      </select>
      <p class="hint" id="postureHint"></p>
    </div>

    <button class="btn-primary" id="saveBtn">Save &amp; Connect</button>

    <hr class="divider">

    <div class="field">
      <label>Auto-approved Commands</label>
      <ul class="cmd-list" id="cmdList">
        <li><p class="cmd-empty">No commands — DeepSeek will prompt for each.</p></li>
      </ul>
      <div class="input-row">
        <input type="text" id="addCmdInput" placeholder="e.g. node, git, npm test" spellcheck="false" />
        <button class="icon-btn" id="addCmdBtn" title="Add command">＋</button>
      </div>
      <p class="hint">Prefix approved — "node" allows all node commands.</p>
    </div>

    <hr class="divider">

    <p class="info">
      DeepSeek is jailed to this workspace — no network; secret files
      (.env, .ssh, .aws, auth.json, keys, .git, SQLite) are blocked.
    </p>

  </div>

<script nonce="${nonce}">
  const vscode        = acquireVsCodeApi();
  const apiKeyInput   = document.getElementById('apiKey');
  const modelSelect   = document.getElementById('model');
  const postureSelect = document.getElementById('posture');
  const postureHint   = document.getElementById('postureHint');
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

  const approvalOverlay = document.getElementById('approvalOverlay');
  const approvalCmd     = document.getElementById('approvalCmd');
  const approvalScopes  = document.getElementById('approvalScopes');
  const durationRow     = document.getElementById('durationRow');
  const allowBtn        = document.getElementById('allowBtn');
  const denyBtn         = document.getElementById('denyBtn');

  let selectedScope    = null;
  let selectedDuration = 'once';

  vscode.postMessage({ type: 'load' });

  // ── Approval card ──────────────────────────────────────────────────────────

  function showApproval(command, scopes) {
    selectedScope    = scopes[0]?.prefix ?? null;
    selectedDuration = 'once';

    approvalCmd.textContent = command;

    approvalScopes.innerHTML = scopes.map((s, i) => {
      const safe   = esc(s.prefix);
      const detail = esc(s.detail);
      return \`<label class="scope-option\${i === 0 ? ' selected' : ''}">
        <div class="scope-row">
          <input type="radio" name="scope" value="\${safe}" \${i === 0 ? 'checked' : ''}>
          <span class="scope-prefix">\${safe}</span>
        </div>
        <div class="scope-detail">\${detail}</div>
      </label>\`;
    }).join('');

    approvalScopes.querySelectorAll('input[name="scope"]').forEach(radio => {
      radio.addEventListener('change', () => {
        selectedScope = radio.value;
        approvalScopes.querySelectorAll('.scope-option').forEach(o => o.classList.remove('selected'));
        radio.closest('.scope-option').classList.add('selected');
      });
    });

    durationRow.querySelectorAll('.dur-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.dur === 'once');
    });

    approvalOverlay.style.display = 'block';
  }

  function hideApproval() {
    approvalOverlay.style.display = 'none';
    selectedScope = null;
  }

  durationRow.querySelectorAll('.dur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedDuration = btn.dataset.dur;
      durationRow.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  allowBtn.addEventListener('click', () => {
    if (!selectedScope) return;
    vscode.postMessage({ type: 'approvalResponse', scope: selectedScope, duration: selectedDuration });
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
      if (msg.apiKey)  apiKeyInput.value   = msg.apiKey;
      if (msg.model)   modelSelect.value   = msg.model;
      if (msg.posture) postureSelect.value = msg.posture;
      updatePostureHint();
      setStatus(!!msg.apiKey, msg.model);
      renderCommands(msg.allowCommands || []);

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

    if (msg.type === 'allowCommandsUpdate') {
      renderCommands(msg.commands || []);
    }

    if (msg.type === 'approvalRequest') {
      showApproval(msg.command, msg.scopes);
    }
  });

  // ── Allowed commands (ZooCode style) ──────────────────────────────────────

  function renderCommands(commands) {
    if (!commands.length) {
      cmdList.innerHTML = '<li><p class="cmd-empty">No commands — DeepSeek will prompt for each.</p></li>';
      return;
    }
    cmdList.innerHTML = commands.map(cmd => {
      const safe = esc(cmd);
      return \`<li class="cmd-item">
        <span class="cmd-check">✓</span>
        <span class="cmd-text" title="\${safe}">\${safe}</span>
        <button class="cmd-del" data-cmd="\${safe}" title="Remove">✕</button>
      </li>\`;
    }).join('');
    cmdList.querySelectorAll('.cmd-del').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'removeCommand', command: btn.dataset.cmd });
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

  // ── Config controls ────────────────────────────────────────────────────────

  wsEnabled.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleWorkspace', enabled: wsEnabled.checked });
  });

  toggleKey.addEventListener('click', () => {
    apiKeyInput.type      = apiKeyInput.type === 'password' ? 'text' : 'password';
    toggleKey.textContent = apiKeyInput.type === 'password' ? '👁' : '🙈';
  });

  postureSelect.addEventListener('change', updatePostureHint);

  function updatePostureHint() {
    postureHint.textContent = postureSelect.value === 'read-only'
      ? 'DeepSeek can analyze but never modify files.'
      : 'DeepSeek can refactor, generate, and edit files in this workspace.';
  }

  saveBtn.addEventListener('click', () => {
    vscode.postMessage({
      type:    'save',
      apiKey:  apiKeyInput.value.trim(),
      model:   modelSelect.value,
      posture: postureSelect.value,
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
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
    }
}
