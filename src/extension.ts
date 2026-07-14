import * as vscode from 'vscode';
import { StatusBarManager } from './statusBar';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';

let manager: StatusBarManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // User-Agent を実バージョンへ追随させる(package.json を正とする)。
  const extensionVersion: string =
    context.extension.packageJSON?.version ?? '0.0.0';
  const claude = new ClaudeProvider();
  manager = new StatusBarManager([claude, new CodexProvider(extensionVersion)]);
  const status = manager;

  const diagnostics = vscode.window.createOutputChannel('Claude & Codex Status');
  let configRestartTimer: NodeJS.Timeout | undefined;

  context.subscriptions.push(
    diagnostics,
    vscode.commands.registerCommand('claudeCodexStatus.refresh', () =>
      status.refresh(undefined, { manual: true })
    ),
    vscode.commands.registerCommand('claudeCodexStatus.refreshClaude', () =>
      status.refresh('claude', { manual: true })
    ),
    vscode.commands.registerCommand('claudeCodexStatus.refreshCodex', () =>
      status.refresh('codex', { manual: true })
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleClaudeMonitoring', () =>
      status.toggleProviderMonitoring('claude')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleCodexMonitoring', () =>
      status.toggleProviderMonitoring('codex')
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleDisplayMode', () =>
      status.toggleDisplayMode()
    ),
    vscode.commands.registerCommand('claudeCodexStatus.toggleAlertColors', () =>
      status.toggleAlertColors()
    ),
    vscode.commands.registerCommand('claudeCodexStatus.showRawUsage', () =>
      showRawUsage(claude, diagnostics)
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeCodexStatus')) {
        return;
      }
      // 取得動作に影響する設定だけポーリングを再始動する(即時取得を伴うため)。
      // 表示のみの設定(displayMode / style)は API を叩かず再描画で済ませる。
      const needsRestart = [
        'claudeCodexStatus.pollIntervalSeconds',
        'claudeCodexStatus.providers.claude',
        'claudeCodexStatus.providers.codex',
        'claudeCodexStatus.claude.credentialsPath',
        'claudeCodexStatus.codex.authPath',
      ].some((key) => e.affectsConfiguration(key));
      if (needsRestart) {
        // 設定編集中はイベントが連続しうるため、少し待ってから1回だけ再始動する
        // (restartPolling は即時取得を伴うので、連打で API を叩かない)。
        if (configRestartTimer) {
          clearTimeout(configRestartTimer);
        }
        configRestartTimer = setTimeout(() => status.restartPolling(), 500);
      } else if (e.affectsConfiguration('claudeCodexStatus.displayMode')) {
        // settings.json の直接編集にも追随できるよう、設定値を正として同期する。
        status.syncDisplayModeFromConfig();
      } else if (e.affectsConfiguration('claudeCodexStatus.statusBarAlertColors')) {
        status.syncAlertColorsFromConfig();
      } else {
        status.rerender();
      }
    }),
    { dispose: () => configRestartTimer && clearTimeout(configRestartTimer) }
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
