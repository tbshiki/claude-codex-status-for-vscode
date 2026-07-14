# Claude & Codex Status for VSCode

Claude Code と OpenAI Codex CLI のレートリミット残量（5時間枠・週枠）を VSCode のステータスバーに常時表示する拡張機能です。確認のためにブラウザや別コマンドへ離脱することなく、作業フローを保ったまま残量を把握できます。

- 技術スタック: TypeScript + VSCode Extension API（ビルド `tsc`、パッケージング `@vscode/vsce`）
- 詳細な仕様: [`docs/requirements.md`](docs/requirements.md)

> 取得に使うエンドポイントやログ形式は非公式・非保証です。仕様変更で動作しなくなる前提のフェイルソフト設計を採用します。

## 動作環境と制限

- **開発・動作確認は Windows の VSCode でのみ行っています。** macOS / Linux では未検証のため、動作しない可能性があります。
- ローカルの Claude Code / Codex CLI にログイン済みであることが前提です。Claude は `~/.claude/.credentials.json`、Codex は `~/.codex/auth.json` から認証情報を読み取ります。
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

Claude と Codex の両方を表示できます（マイルストーン M2）。Codex は `~/.codex/auth.json` の認証情報を使い、使用状況 API から直接取得します。Codex は使用済み率を残量率（`100 - used_percent`）へ変換して表示し、5時間枠がない場合は `全体` と表示します。ホバー詳細内のリンクから Claude / Codex を個別に停止・再開できます。API 変更や認証期限切れなどで取得できない場合は、直近値を保持します。

### AI エージェントでの開発

このリポジトリでの AI エージェント（Codex / Claude Code）を使った開発体制（共通指示・スキル・セットアップ手順）は [`docs/ai-development.md`](docs/ai-development.md) を参照してください。

## コントリビューション

バグ報告・改善要望・修正は [Issue](https://github.com/tbshiki/claude-codex-status-for-vscode/issues) / Pull Request で歓迎します。

## ライセンス

[MIT License](LICENSE) — 自由に利用・改変・再配布できます。
