import * as vscode from 'vscode';
import { StatusBarManager } from './statusBar';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';

let manager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  manager = new StatusBarManager([new ClaudeProvider(), new CodexProvider()]);
  const status = manager;

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodexStatus.refresh', () =>
      status.refresh()
    ),
    vscode.commands.registerCommand('claudeCodexStatus.refreshClaude', () =>
      status.refresh('claude')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.refreshCodex', () =>
      status.refresh('codex')
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodexStatus')) {
        status.restartPolling();
      }
    })
  );

  status.start();
}

export function deactivate(): void {
  manager?.dispose();
  manager = undefined;
}
