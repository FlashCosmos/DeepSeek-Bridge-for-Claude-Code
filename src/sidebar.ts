import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { writeMcpConfig } from './config';
import { isWorkspaceEnabled, setWorkspaceEnabled } from './control';

const MODELS = [
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — Fast & cheap (recommended)' },
    { id: 'deepseek-v4-pro',   label: 'DeepSeek V4 Pro — Advanced reasoning' },
];

export class DeepSeekSidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly context: vscode.ExtensionContext) {}

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        webviewView.webview.options = { enableScripts: true };

        const nonce = crypto.randomBytes(16).toString('hex');
        webviewView.webview.html = this.buildHtml(nonce);

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';

        webviewView.webview.onDidReceiveMessage(async (msg: { type: string; apiKey?: string; model?: string; posture?: string; enabled?: boolean }) => {
            if (msg.type === 'load') {
                const apiKey = await this.context.secrets.get('deepseek-api-key') ?? '';
                const model = this.context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
                const posture = this.context.globalState.get<string>('deepseek-posture') ?? 'edit';
                webviewView.webview.postMessage({
                    type: 'config', apiKey, model, posture,
                    workspaceName,
                    hasWorkspace: !!workspacePath,
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
                const apiKey = (msg.apiKey ?? '').trim();
                const model = msg.model ?? 'deepseek-v4-flash';
                const posture = msg.posture === 'read-only' ? 'read-only' : 'edit';

                if (apiKey) {
                    await this.context.secrets.store('deepseek-api-key', apiKey);
                } else {
                    await this.context.secrets.delete('deepseek-api-key');
                }
                await this.context.globalState.update('deepseek-model', model);
                await this.context.globalState.update('deepseek-posture', posture);

                if (apiKey) {
                    writeMcpConfig(this.context, apiKey, model, posture);
                    const action = await vscode.window.showInformationMessage(
                        `DeepSeek Bridge saved — ${model}, ${posture} posture. Restart Claude Code to activate.`,
                        'OK'
                    );
                    void action;
                } else {
                    vscode.window.showWarningMessage('DeepSeek Bridge: API key removed.');
                }
            }
        }, undefined, this.context.subscriptions);
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

    .status-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 4px;
      margin-bottom: 16px;
      font-size: 12px;
      border: 1px solid transparent;
      transition: background 0.2s, border-color 0.2s;
    }
    .status-bar.unconfigured {
      background: rgba(255, 140, 0, 0.1);
      border-color: rgba(255, 140, 0, 0.35);
    }
    .status-bar.configured {
      background: rgba(35, 134, 54, 0.1);
      border-color: rgba(35, 134, 54, 0.35);
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot.orange { background: #f0883e; }
    .dot.green  { background: #3fb950; }

    .field { margin-bottom: 14px; }

    label {
      display: block;
      margin-bottom: 5px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      opacity: 0.65;
    }

    .input-row {
      display: flex;
      gap: 4px;
    }

    input, select {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px;
      font-family: inherit;
      font-size: inherit;
      outline: none;
      appearance: none;
    }
    input:focus, select:focus {
      border-color: var(--vscode-focusBorder);
    }
    input[type="password"], input[type="text"] {
      font-family: var(--vscode-editor-font-family, monospace);
      letter-spacing: 0.02em;
    }
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24'%3E%3Cpath fill='%23888' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 28px;
      cursor: pointer;
    }

    .icon-btn {
      padding: 6px 9px;
      background: var(--vscode-input-background);
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.35));
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      opacity: 0.7;
      flex-shrink: 0;
      line-height: 1;
    }
    .icon-btn:hover { opacity: 1; }

    .hint {
      margin-top: 5px;
      font-size: 11px;
      opacity: 0.5;
    }
    .hint a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .btn-primary {
      width: 100%;
      padding: 8px 14px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      font-family: inherit;
      font-size: inherit;
      font-weight: 600;
      cursor: pointer;
      margin-top: 4px;
    }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-primary:active { opacity: 0.85; }

    .divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      margin: 16px 0;
    }

    .info {
      font-size: 11px;
      opacity: 0.55;
      line-height: 1.5;
    }

    .ws-toggle {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      margin-bottom: 16px;
      border-radius: 4px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.25));
    }
    .ws-toggle .ws-text { min-width: 0; }
    .ws-toggle .ws-title { font-size: 12px; font-weight: 600; }
    .ws-toggle .ws-sub {
      font-size: 11px; opacity: 0.55;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .switch { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer; inset: 0;
      background: rgba(128,128,128,0.4);
      border-radius: 20px; transition: 0.2s;
    }
    .slider::before {
      content: ""; position: absolute;
      width: 14px; height: 14px; left: 3px; top: 3px;
      background: #fff; border-radius: 50%; transition: 0.2s;
    }
    .switch input:checked + .slider { background: #3fb950; }
    .switch input:checked + .slider::before { transform: translateX(16px); }
    .switch input:disabled + .slider { opacity: 0.4; cursor: not-allowed; }

    .hero { text-align: center; padding: 4px 0 12px; }
    .hero-icon { font-size: 26px; line-height: 1; }
    .hero-title { font-size: 16px; font-weight: 700; margin-top: 6px; }
    .hero-tagline { font-size: 12px; opacity: 0.7; margin-top: 4px; line-height: 1.45; }

    .about { font-size: 12px; line-height: 1.55; opacity: 0.8; margin-bottom: 14px; }

    .features { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
    .feat { display: flex; gap: 9px; font-size: 11.5px; line-height: 1.4; }
    .feat-ico { font-size: 15px; flex-shrink: 0; line-height: 1.3; }
    .feat b { font-weight: 600; }
    .feat span.sub { opacity: 0.6; }

    details.steps {
      margin-bottom: 6px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 4px;
    }
    details.steps summary {
      cursor: pointer; padding: 8px 10px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.6px; opacity: 0.75;
      list-style: none; user-select: none;
    }
    details.steps summary::-webkit-details-marker { display: none; }
    details.steps summary::before { content: "▸ "; opacity: 0.6; }
    details.steps[open] summary::before { content: "▾ "; }
    details.steps ol {
      margin: 0; padding: 2px 12px 10px 28px;
      font-size: 11.5px; line-height: 1.6; opacity: 0.85;
    }
    details.steps li { margin-bottom: 3px; }
    details.steps a { color: var(--vscode-textLink-foreground); text-decoration: none; }

    .section-label {
      font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.7px; opacity: 0.5;
      margin: 4px 0 12px;
    }
  </style>
</head>
<body>

  <div class="hero">
    <div class="hero-icon">⚡</div>
    <div class="hero-title">DeepSeek Bridge</div>
    <div class="hero-tagline">Claude offloads its token-heavy chores to DeepSeek — cheaper work, you stay in control.</div>
  </div>

  <div class="status-bar unconfigured" id="statusBar">
    <span class="dot orange" id="statusDot"></span>
    <span id="statusText">Not configured</span>
  </div>

  <p class="about">
    Claude Code is powerful but pricey. This bridge lets Claude hand off big, file-based
    jobs — refactors, code generation, multi-file edits, and summarizing large file sets —
    to DeepSeek, which costs a fraction to run. Claude plans and reviews; DeepSeek does the grind.
  </p>

  <div class="features">
    <div class="feat">
      <span class="feat-ico">🤖</span>
      <div><b>Claude decides.</b> <span class="sub">It delegates automatically, mid-task — nothing for you to do.</span></div>
    </div>
    <div class="feat">
      <span class="feat-ico">🔒</span>
      <div><b>Sandboxed.</b> <span class="sub">DeepSeek is jailed to this workspace — no shell, no network, secret files blocked.</span></div>
    </div>
    <div class="feat">
      <span class="feat-ico">🎚️</span>
      <div><b>Your switch.</b> <span class="sub">Turn DeepSeek on or off per workspace, live — see the toggle below.</span></div>
    </div>
  </div>

  <details class="steps" open>
    <summary>Getting started</summary>
    <ol>
      <li>Paste your <a href="https://platform.deepseek.com/api_keys">DeepSeek API key</a> below.</li>
      <li>Pick a model — V4 Flash (fast &amp; cheap) or V4 Pro (smarter).</li>
      <li>Choose permissions — Edit (read &amp; write) or Read-only.</li>
      <li>Click <b>Save &amp; Connect</b>, then restart Claude Code.</li>
      <li>Use <b>Use in this workspace</b> to enable/disable per project anytime.</li>
    </ol>
  </details>

  <hr class="divider">

  <div class="section-label">Settings</div>

  <div class="ws-toggle" id="wsToggle">
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
    <select id="model">
      ${modelOptions}
    </select>
  </div>

  <div class="field">
    <label>Permissions</label>
    <select id="posture">
      <option value="edit">Edit — read &amp; write files (recommended)</option>
      <option value="read-only">Read-only — read files only</option>
    </select>
    <p class="hint" id="postureHint"></p>
  </div>

  <button class="btn-primary" id="saveBtn">Save & Connect</button>

  <hr class="divider">

  <p class="info">
    🔒 DeepSeek runs jailed to this workspace — no shell, no network; secret files
    (.env, .ssh, .aws, .claude.json, keys, .git) are blocked, and reads/writes are
    size- and budget-capped.
  </p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  const apiKeyInput  = document.getElementById('apiKey');
  const modelSelect  = document.getElementById('model');
  const postureSelect = document.getElementById('posture');
  const postureHint  = document.getElementById('postureHint');
  const saveBtn      = document.getElementById('saveBtn');
  const toggleKey    = document.getElementById('toggleKey');
  const statusBar    = document.getElementById('statusBar');
  const statusDot    = document.getElementById('statusDot');
  const statusText   = document.getElementById('statusText');
  const wsEnabled    = document.getElementById('wsEnabled');
  const wsName       = document.getElementById('wsName');

  // Request stored config on mount
  vscode.postMessage({ type: 'load' });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'config') {
      if (msg.apiKey)  apiKeyInput.value = msg.apiKey;
      if (msg.model)   modelSelect.value = msg.model;
      if (msg.posture) postureSelect.value = msg.posture;
      updatePostureHint();
      setStatus(!!msg.apiKey, msg.model);

      if (msg.hasWorkspace) {
        wsName.textContent = msg.workspaceName || 'this workspace';
        wsEnabled.checked = !!msg.workspaceEnabled;
        wsEnabled.disabled = false;
      } else {
        wsName.textContent = 'No folder open';
        wsEnabled.checked = false;
        wsEnabled.disabled = true;
      }
    }
  });

  wsEnabled.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleWorkspace', enabled: wsEnabled.checked });
  });

  toggleKey.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
    toggleKey.textContent = apiKeyInput.type === 'password' ? '👁' : '🙈';
  });

  postureSelect.addEventListener('change', updatePostureHint);

  function updatePostureHint() {
    postureHint.textContent = postureSelect.value === 'read-only'
      ? 'DeepSeek can analyze but never modify files.'
      : 'DeepSeek can refactor, generate, and edit files in this workspace.';
  }

  saveBtn.addEventListener('click', () => {
    const apiKey  = apiKeyInput.value.trim();
    const model   = modelSelect.value;
    const posture = postureSelect.value;
    vscode.postMessage({ type: 'save', apiKey, model, posture });
    setStatus(!!apiKey, model);
  });

  // Also save on Enter in the key field
  apiKeyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') saveBtn.click();
  });

  function setStatus(hasKey, model) {
    if (hasKey) {
      statusBar.className = 'status-bar configured';
      statusDot.className = 'dot green';
      const label = model === 'deepseek-v4-pro' ? 'V4 Pro' : 'V4 Flash';
      statusText.textContent = 'Active — DeepSeek ' + label;
    } else {
      statusBar.className = 'status-bar unconfigured';
      statusDot.className = 'dot orange';
      statusText.textContent = 'Not configured';
    }
  }
</script>
</body>
</html>`;
    }
}
