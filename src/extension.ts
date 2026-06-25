import * as vscode from 'vscode';
import { DeepSeekSidebarProvider } from './sidebar';
import { writeMcpConfig } from './config';
import { isWorkspaceEnabled } from './control';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const provider = new DeepSeekSidebarProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('deepseek-bridge.config', provider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Re-write the MCP config on every activation so the server path stays current after updates.
    const apiKey = await context.secrets.get('deepseek-api-key');
    const model = context.globalState.get<string>('deepseek-model') ?? 'deepseek-v4-flash';
    const posture = context.globalState.get<string>('deepseek-posture') ?? 'edit';
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
