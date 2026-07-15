# Claude & Codex Status for VSCode

Claude Code と OpenAI Codex CLI のレートリミット残量（5時間枠・週枠）を VSCode のステータスバーに常時表示する拡張機能です。確認のためにブラウザや別コマンドへ離脱することなく、作業フローを保ったまま残量を把握できます。

- 技術スタック: TypeScript + VSCode Extension API（ビルド `tsc`、パッケージング `@vscode/vsce`）
- 詳細な仕様: [`docs/requirements.md`](docs/requirements.md)

> 取得に使うエンドポイントやログ形式は非公式・非保証です。仕様変更で動作しなくなる前提のフェイルソフト設計を採用します。

## 動作環境と制限

- **開発・動作確認は Windows の VSCode でのみ行っています。** macOS / Linux では未検証のため、動作しない可能性があります。
- ローカルの Claude Code / Codex CLI に **OAuth ログイン済み**（`claude login` / `codex login`）であることが前提です。Claude は `~/.claude/.credentials.json`、Codex は `~/.codex/auth.json` から認証情報を読み取ります。
- Claude 側は OAuth 専用のエンドポイントを使うため、`ANTHROPIC_API_KEY` などの APIキー運用では残量を取得できません。
- macOS の Claude Code は認証情報を Keychain に保存するため `.credentials.json` が存在せず、Claude 側が「未ログイン」と表示される可能性が高いです。ファイルが別の場所にある場合は、設定 `claudeCodexStatus.claude.credentialsPath` / `claudeCodexStatus.codex.authPath` でパスを明示指定できます。
- 表示される残量は一定間隔（既定300秒、設定 `claudeCodexStatus.pollIntervalSeconds` で変更可）で取得した時点の値のため、実際の使用量と時間差がある場合があります。ステータスバーのクリックや「今すぐ更新」コマンドで手動更新できます。
- Marketplace には公開していません。`npm run package` で `dist/` に生成される `.vsix` を手動でインストールしてください。

## 開発

```powershell
npm install       # 依存関係の取得(初回のみ)
npm run compile   # tsc で out/ へビルド
npm run watch     # 変更を監視してビルド
npm run package   # vsce で dist/ へ .vsix を生成(直近3件のみ保持)
```

VS Code で `F5`（拡張機能のデバッグ実行）を押すと、拡張機能ホストが起動しステータスバーに残量が表示されます。

### 構成

```text
src/
  extension.ts          # activate/deactivate、コマンド・設定変更の配線
  statusBar.ts          # ステータスバーへの統合表示とポーリング
  providers/
    types.ts            # プロバイダ共通の型と例外
    claude.ts           # Claude の残量取得(実装済み)
    codex.ts            # Codex のローカル認証情報から残量を取得
docs/requirements.md    # 要件定義書
```

Claude と Codex の両方を表示できます（マイルストーン M2）。Codex は `~/.codex/auth.json` の認証情報を使い、使用状況 API から直接取得します。パーセントは Claude / Codex 共通の基準で表示され、既定は残量（あと何%使えるか）です。設定 `claudeCodexStatus.displayMode` またはホバー詳細内の切替リンクで、残量表示と使用率表示をいつでも切り替えられます。枠の残量が既定で30%を下回ると該当プロバイダのステータスバー表示が黄色の文字色+該当枠に ⚠、10%を下回ると赤の文字色+エラーアイコンになり、ホバー内の該当行も同じ色で表示されます(しきい値は `claudeCodexStatus.warningRemainingPercent` / `criticalRemainingPercent` で変更可、色はテーマのチャート色に準拠)。ステータスバーの項目は Claude / Codex で独立しているため、逼迫していない側の色は変わりません。色が不要な場合はホバー内のリンクまたは設定 `claudeCodexStatus.statusBarAlertColors` で無効化できます。Codex の5時間枠がない場合は `全体` と表示します。

### 監視の停止と再開

ホバー詳細内のリンクから Claude / Codex を個別に停止・再開できます。**停止したプロバイダはステータスバーから消えます。**

- 片方だけ停止した場合は、もう片方のホバー詳細に停止中のプロバイダも載っているので、そこから再開できます。
- 両方を停止した場合は、一時停止アイコン（⏸）だけの最小表示に畳まれます。クリックすると両方の監視を再開します。ホバーすれば停止時点の残量も確認できます。
- 停止状態はウィンドウを開いている間だけ保持されます（VSCode を再起動すると監視状態に戻ります）。恒久的に非表示にする場合は設定 `claudeCodexStatus.providers.claude` / `providers.codex` を `false` にしてください。この場合はアイコンも表示されません。

### 取得できないときの表示

取得に失敗した場合は原因ごとに表示を切り分け、ホバーに原因と対処方法を出します。Claude / Codex で同じ基準です。

| ステータスバー | 状況 | 対処 |
|---|---|---|
| `未ログイン` | 認証情報ファイルが無い、または OAuth トークンの項目が無い（APIキー運用など） | `claude login` / `codex login` を実行 |
| `要再ログイン` 🔑 | トークンが API に拒否された（HTTP 401/403 = 失効・剥奪） | `claude login` / `codex login` で再認証 |
| `認証情報エラー` ⚠ | 認証情報ファイルが壊れている、または権限で読めない | ファイルの権限を確認、またはログインし直して再作成 |
| `接続不可` ☁ | ネットワーク到達不能（DNS・接続拒否・TLS・タイムアウト） | 接続やプロキシ設定を確認。復帰すれば自動で戻る |
| `待機中` 🕐 | レート制限（HTTP 429） | 自動でバックオフ再取得。「更新」で即時再試行も可 |
| `取得失敗` ⚠ | 上記以外（HTTP エラー、レスポンス解析失敗＝API 仕様変更の疑い） | 直近値を保持して継続 |

`接続不可` `待機中` `取得失敗` は一時的な失敗とみなし、直近の正常値を残したまま末尾にアイコンだけを添えます（例: `Claude 5h : 62% ☁`）。認証系は利用者の操作が必要なため、古い値は表示しません。

### AI エージェントでの開発

このリポジトリでの AI エージェント（Codex / Claude Code）を使った開発体制（共通指示・スキル・セットアップ手順）は [`docs/ai-development.md`](docs/ai-development.md) を参照してください。

## コントリビューション

バグ報告・改善要望・修正は [Issue](https://github.com/tbshiki/claude-codex-status-for-vscode/issues) / Pull Request で歓迎します。

## ライセンス

[MIT License](LICENSE) — 自由に利用・改変・再配布できます。
