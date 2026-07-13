import * as vscode from 'vscode';
import { StatusBarManager } from './statusBar';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';

let manager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const claude = new ClaudeProvider();
  manager = new StatusBarManager([claude, new CodexProvider()]);
  const status = manager;

  const diagnostics = vscode.window.createOutputChannel('Claude & Codex Status');

  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('claudeCodexStatus.refresh', () =>
      status.refresh()
    ),
    vscode.commands.registerCommand('claudeCodexStatus.refreshClaude', () =>
      status.refresh('claude')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.refreshCodex', () =>
      status.refresh('codex')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleMonitoring', () =>
      status.toggleMonitoring()
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleClaudeMonitoring', () =>
      status.toggleProviderMonitoring('claude')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleCodexMonitoring', () =>
      status.toggleProviderMonitoring('codex')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.showRawUsage', () =>
      showRawUsage(claude, diagnostics)
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

/**
 * 使用状況エンドポイントの生レスポンスを Output パネルへ整形表示する診断コマンド。
 * どのウィンドウ(5h/7d/モデル別)やフィールド(トークン残量など)が実際に返るかを
 * 確認するために使う。レスポンス本体にトークンは含まれない。
 */
async function showRawUsage(
  claude: ClaudeProvider,
  channel: vscode.OutputChannel
): Promise<void> {
  channel.clear();
  channel.show(true);
  channel.appendLine(`[${new Date().toLocaleString()}] Claude usage を取得中…`);
  try {
    const raw = await claude.fetchRaw();
    channel.appendLine('--- /api/oauth/usage レスポンス ---');
    channel.appendLine(JSON.stringify(raw, null, 2));
  } catch (err) {
    channel.appendLine(`取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  }
}
