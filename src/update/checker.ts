import * as vscode from 'vscode';
import {
  GitHubRateLimitError,
  GitHubRepository,
  LatestRelease,
  compareVersions,
  downloadVerifiedAsset,
  fetchLatestRelease,
  parseGitHubRepository,
} from './github';

/** 起動直後の処理と重ならないよう、最初の確認を遅らせる。 */
const FIRST_CHECK_DELAY_MS = 15_000;
/** 「前回から24時間たったか」を見に行く間隔。API を叩くのは24時間に1回だけ。 */
const TICK_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** globalState はウィンドウ間で共有されるため、複数ウィンドウでも確認は24時間に1回に収まる。 */
const LAST_CHECKED_KEY = 'updateCheck.lastCheckedAt';
const SKIPPED_VERSION_KEY = 'updateCheck.skippedVersion';

const ENABLED_SETTING = 'updateCheck.enabled';

/**
 * GitHub Releases に新しいバージョンがあれば通知し、利用者が選んだときだけ .vsix を導入する。
 * 失敗しても残量の表示には影響させない(自動の確認は黙って次回に回す)。
 */
export class UpdateChecker implements vscode.Disposable {
  private readonly repository: GitHubRepository | undefined;
  private readonly currentVersion: string;
  private readonly assetBaseName: string;
  private readonly userAgent: string;
  private firstTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private checking: Promise<void> | undefined;
  private installing = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    const pkg = context.extension.packageJSON ?? {};
    this.repository = parseGitHubRepository(pkg.repository);
    this.currentVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    this.assetBaseName = typeof pkg.name === 'string' ? pkg.name : 'claude-codex-status';
    this.userAgent = `claude-codex-status/${this.currentVersion}`;
  }

  start(): void {
    if (!this.repository) {
      return;
    }
    this.firstTimer = setTimeout(() => this.runScheduled(), FIRST_CHECK_DELAY_MS);
    this.tickTimer = setInterval(() => this.runScheduled(), TICK_INTERVAL_MS);
  }

  /** コマンド「更新を確認」。設定・間隔・スキップに関係なく確認し、結果を必ず知らせる。 */
  async checkNow(): Promise<void> {
    // 自動の確認の途中なら終わるのを待つ(自動の確認は「最新です」を知らせないため、相乗りしない)。
    await this.checking;
    return this.runExclusive(() => this.check(true));
  }

  dispose(): void {
    if (this.firstTimer) {
      clearTimeout(this.firstTimer);
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
  }

  private runScheduled(): void {
    const enabled = vscode.workspace
      .getConfiguration('claudeCodexStatus')
      .get<boolean>(ENABLED_SETTING, true);
    if (!enabled) {
      return;
    }
    const last = this.context.globalState.get<number>(LAST_CHECKED_KEY, 0);
    if (Date.now() - last < CHECK_INTERVAL_MS) {
      return;
    }
    void this.runExclusive(() => this.check(false));
  }

  private runExclusive(task: () => Promise<void>): Promise<void> {
    if (!this.checking) {
      this.checking = task()
        .catch((err) => this.appendLog(`更新の確認で想定外のエラー: ${errorMessage(err)}`))
        .finally(() => {
          this.checking = undefined;
        });
    }
    return this.checking;
  }

  private async check(manual: boolean): Promise<void> {
    if (!this.repository) {
      if (manual) {
        void vscode.window.showWarningMessage(
          'package.json の repository が GitHub ではないため、更新を確認できません。'
        );
      }
      return;
    }
    // 失敗しても次の確認は24時間後にする(ネットワーク不調時に何度も叩かない)。
    await this.context.globalState.update(LAST_CHECKED_KEY, Date.now());

    let latest: LatestRelease;
    try {
      latest = await fetchLatestRelease(this.repository, this.assetBaseName, this.userAgent);
    } catch (err) {
      const message = errorMessage(err);
      this.appendLog(`更新の確認に失敗しました: ${message}`);
      if (manual) {
        void vscode.window.showWarningMessage(
          err instanceof GitHubRateLimitError ? message : `更新の確認に失敗しました: ${message}`
        );
      }
      return;
    }

    const diff = compareVersions(latest.version, this.currentVersion);
    if (diff === undefined || diff <= 0) {
      this.appendLog(`最新リリースは v${latest.version}(現在 v${this.currentVersion})`);
      if (manual) {
        void vscode.window.showInformationMessage(
          diff === undefined || diff === 0
            ? `Claude & Codex Status は最新です(v${this.currentVersion})。`
            : `Claude & Codex Status は最新です(現在 v${this.currentVersion}、公開中の最新は v${latest.version})。`
        );
      }
      return;
    }

    if (!manual && this.context.globalState.get<string>(SKIPPED_VERSION_KEY) === latest.version) {
      this.appendLog(`v${latest.version} はスキップ済みのため通知しません`);
      return;
    }
    // 通知を待つ間も次の確認を止めないよう、応答は待たない。
    void this.notify(latest);
  }

  private async notify(latest: LatestRelease): Promise<void> {
    const install = 'インストール';
    const notes = 'リリースノート';
    const skip = 'このバージョンをスキップ';
    const actions = latest.vsix ? [install, notes, skip] : [notes, skip];
    const choice = await vscode.window.showInformationMessage(
      `Claude & Codex Status の新しいバージョン v${latest.version} が公開されています(現在 v${this.currentVersion})。`,
      ...actions
    );
    if (choice === install) {
      await this.install(latest);
    } else if (choice === notes) {
      await vscode.env.openExternal(vscode.Uri.parse(latest.pageUrl));
    } else if (choice === skip) {
      await this.context.globalState.update(SKIPPED_VERSION_KEY, latest.version);
    }
  }

  private async install(latest: LatestRelease): Promise<void> {
    const asset = latest.vsix;
    if (!asset || this.installing) {
      return;
    }
    this.installing = true;
    const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'updates');
    const file = vscode.Uri.joinPath(dir, asset.name);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Claude & Codex Status v${latest.version} をインストールしています…`,
        },
        async (progress) => {
          progress.report({ message: 'ダウンロード中' });
          const bytes = await downloadVerifiedAsset(asset, this.userAgent);
          await vscode.workspace.fs.createDirectory(dir);
          await vscode.workspace.fs.writeFile(file, bytes);
          progress.report({ message: 'インストール中' });
          await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
        }
      );
    } catch (err) {
      const message = errorMessage(err);
      this.appendLog(`v${latest.version} のインストールに失敗しました: ${message}`);
      const open = 'リリースページを開く';
      const choice = await vscode.window.showErrorMessage(
        `Claude & Codex Status v${latest.version} のインストールに失敗しました: ${message}`,
        open
      );
      if (choice === open) {
        await vscode.env.openExternal(vscode.Uri.parse(latest.pageUrl));
      }
      return;
    } finally {
      this.installing = false;
      // 導入後(または失敗時)の .vsix は不要。消せなくても次回の上書きで済む。
      await Promise.resolve(vscode.workspace.fs.delete(file, { useTrash: false })).catch(() => undefined);
    }

    this.appendLog(`v${latest.version} をインストールしました`);
    const reload = '再読み込み';
    const choice = await vscode.window.showInformationMessage(
      `Claude & Codex Status v${latest.version} をインストールしました。ウィンドウを再読み込みすると有効になります。`,
      reload
    );
    if (choice === reload) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  private appendLog(message: string): void {
    this.log.appendLine(`[${new Date().toLocaleString()}] ${message}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
