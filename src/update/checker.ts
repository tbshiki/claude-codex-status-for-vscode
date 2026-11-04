import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  GitHubRateLimitError,
  GitHubRepository,
  LatestRelease,
  compareVersions,
  downloadVerifiedAsset,
  fetchLatestRelease,
  parseGitHubRepository,
  remainingCooldownMs,
} from './github';

/**
 * 公開からこの時間がたつまで、新しいリリースを案内しない。
 * 作者のアカウントや端末が乗っ取られて悪意ある版が公開されても、作者が気付いて取り下げるまでに
 * 広がらないようにする(2026年5月の Nx Console の件では、悪意ある版は公開から十数分で取り下げられたが、
 * その間に自動更新で入った端末から GitHub の社内リポジトリが持ち出された)。
 */
const RELEASE_COOLDOWN_HOURS = 72;
const RELEASE_COOLDOWN_MS = RELEASE_COOLDOWN_HOURS * 60 * 60 * 1000;

/**
 * 起動直後の処理と重ならないよう、最初の確認を遅らせる。
 * 複数ウィンドウが同時に起動したときに確認の時刻がそろわないよう、ばらつきを加える。
 */
const FIRST_CHECK_DELAY_MS = 15_000;
const FIRST_CHECK_JITTER_MS = 60_000;
/** 「前回から24時間たったか」を見に行く間隔。API を叩くのは原則24時間に1回だけ。 */
const TICK_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * globalState はウィンドウ間で共有されるため、複数ウィンドウでも確認は原則24時間に1回に収まる
 * (他のウィンドウへの反映は非同期なので、同時に確認が走ることはありうる)。
 */
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
  private manualCheck: Promise<void> | undefined;
  private installing = false;
  /**
   * このウィンドウで導入した版。再読み込みするまでは古い版が動き続けるため、
   * 同じ版を再び通知・再導入しないよう覚えておく(再読み込みで消える)。
   */
  private installedVersion: string | undefined;

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
    const delay = FIRST_CHECK_DELAY_MS + Math.floor(Math.random() * FIRST_CHECK_JITTER_MS);
    this.firstTimer = setTimeout(() => this.runScheduled(), delay);
    this.tickTimer = setInterval(() => this.runScheduled(), TICK_INTERVAL_MS);
  }

  /** コマンド「アップデートを確認」。設定・間隔・スキップに関係なく確認し、結果を必ず知らせる。 */
  checkNow(): Promise<void> {
    // 手動の確認が続けて呼ばれたら、実行中のものに相乗りする(API を二重に叩かない)。
    if (!this.manualCheck) {
      this.manualCheck = (async () => {
        // 自動の確認の途中なら終わるのを待つ(自動の確認は「最新です」を知らせないため、相乗りしない)。
        await this.checking;
        await this.runExclusive(() => this.check(true));
      })().finally(() => {
        this.manualCheck = undefined;
      });
    }
    return this.manualCheck;
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
    const elapsed = Date.now() - last;
    // 負なら時計が戻った(前回が未来の時刻)。その場合は待たずに確認する。
    if (elapsed >= 0 && elapsed < CHECK_INTERVAL_MS) {
      return;
    }
    void this.runExclusive(() => this.check(false));
  }

  private runExclusive(task: () => Promise<void>): Promise<void> {
    if (!this.checking) {
      this.checking = task()
        .catch((err) => this.appendLog(`アップデートの確認で想定外のエラー: ${errorMessage(err)}`))
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
          'package.json の repository が GitHub ではないため、アップデートを確認できません。'
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
      this.appendLog(`アップデートの確認に失敗しました: ${message}`);
      if (manual) {
        void vscode.window.showWarningMessage(
          err instanceof GitHubRateLimitError ? message : `アップデートの確認に失敗しました: ${message}`
        );
      }
      return;
    }

    const diff = compareVersions(latest.version, this.currentVersion);
    if (diff === undefined) {
      // 手元のビルドなど、版が X.Y.Z の形でないと比べられない。
      this.appendLog(`版を比較できません(現在 v${this.currentVersion}、最新リリース v${latest.version})`);
      if (manual) {
        void vscode.window.showWarningMessage(
          `現在の版 v${this.currentVersion} と公開中の最新 v${latest.version} を比較できませんでした。`
        );
      }
      return;
    }
    if (diff <= 0) {
      this.appendLog(`最新リリースは v${latest.version}(現在 v${this.currentVersion})`);
      if (manual) {
        void vscode.window.showInformationMessage(
          diff === 0
            ? `Claude & Codex Status は最新です(v${this.currentVersion})。`
            : `Claude & Codex Status は最新です(現在 v${this.currentVersion}、公開中の最新は v${latest.version})。`
        );
      }
      return;
    }

    const installed = this.installedVersion;
    if (installed && (compareVersions(latest.version, installed) ?? 1) <= 0) {
      this.appendLog(`v${installed} はインストール済みで、再読み込みを待っています`);
      if (manual) {
        void this.promptReload(installed).catch((err) =>
          this.appendLog(`再読み込みの案内で想定外のエラー: ${errorMessage(err)}`)
        );
      }
      return;
    }

    const waitMs = remainingCooldownMs(latest.publishedAt, Date.now(), RELEASE_COOLDOWN_MS);
    if (waitMs > 0) {
      const waitHours = Math.ceil(waitMs / (60 * 60 * 1000));
      const reason =
        latest.publishedAt === undefined
          ? '公開日時を確認できない'
          : `公開から ${RELEASE_COOLDOWN_HOURS} 時間たっていない(あと約 ${waitHours} 時間)`;
      this.appendLog(`v${latest.version} は${reason}ため、まだ案内しません`);
      if (manual) {
        void this.notifyCooldown(latest, waitHours).catch((err) =>
          this.appendLog(`アップデートの案内で想定外のエラー: ${errorMessage(err)}`)
        );
      }
      return;
    }

    if (!manual && this.context.globalState.get<string>(SKIPPED_VERSION_KEY) === latest.version) {
      this.appendLog(`v${latest.version} はスキップ済みのため通知しません`);
      return;
    }
    // 通知を待つ間も次の確認を止めないよう、応答は待たない。
    // 通知の先(導入・ブラウザを開く等)の失敗は、ここで受け止めて記録だけにする。
    void this.notify(latest).catch((err) =>
      this.appendLog(`アップデートの通知の処理で想定外のエラー: ${errorMessage(err)}`)
    );
  }

  /** 手動の確認で、公開から間もない版が見つかったときの案内。ここからは導入させない。 */
  private async notifyCooldown(latest: LatestRelease, waitHours: number): Promise<void> {
    const notes = 'リリースノート';
    const detail =
      latest.publishedAt === undefined
        ? '公開日時を確認できないため、ここからのインストールは案内しません。'
        : `安全のため、公開から ${RELEASE_COOLDOWN_HOURS} 時間たつまではここからのインストールを案内しません(あと約 ${waitHours} 時間)。`;
    const choice = await vscode.window.showInformationMessage(
      `Claude & Codex Status の新しいバージョン v${latest.version} が公開されています(現在 v${this.currentVersion})。${detail}`,
      notes
    );
    if (choice === notes) {
      await vscode.env.openExternal(vscode.Uri.parse(latest.pageUrl));
    }
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
    let dir: string | undefined;
    let failure: string | undefined;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Claude & Codex Status v${latest.version} をインストールしています…`,
        },
        async (progress) => {
          progress.report({ message: 'ダウンロード中' });
          const bytes = await downloadVerifiedAsset(asset, this.userAgent);
          // VSCode が .vsix を導入できるのは file: (リモート接続時は vscode-remote:)の場所だけ。
          // globalStorageUri は vscode-userdata: のことがあり "No Servers" で拒否されるため、
          // OS の一時フォルダに毎回新しく作る専用のフォルダへ置く。
          dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-codex-status-'));
          const file = path.join(dir, `${this.assetBaseName}-${latest.version}.vsix`);
          await fs.writeFile(file, bytes);
          progress.report({ message: 'インストール中' });
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            vscode.Uri.file(file)
          );
        }
      );
    } catch (err) {
      failure = errorMessage(err);
    } finally {
      this.installing = false;
      // 導入後(または失敗時)の .vsix は不要。消せなくても一時フォルダなので害はない。
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (failure !== undefined) {
      this.appendLog(`v${latest.version} のインストールに失敗しました: ${failure}`);
      const open = 'リリースページを開く';
      const choice = await vscode.window.showErrorMessage(
        `Claude & Codex Status v${latest.version} のインストールに失敗しました: ${failure}`,
        open
      );
      if (choice === open) {
        await vscode.env.openExternal(vscode.Uri.parse(latest.pageUrl));
      }
      return;
    }

    this.installedVersion = latest.version;
    this.appendLog(`v${latest.version} をインストールしました`);
    await this.promptReload(latest.version);
  }

  private async promptReload(version: string): Promise<void> {
    const reload = '再読み込み';
    const choice = await vscode.window.showInformationMessage(
      `Claude & Codex Status v${version} をインストールしました。ウィンドウを再読み込みすると有効になります。`,
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
