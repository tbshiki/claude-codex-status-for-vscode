# AI 開発基盤

このリポジトリは Codex と Claude Code の両方で使える AI 開発基盤を備えています。

- AI への共通指示は [`AGENTS.md`](../AGENTS.md) が唯一の正典です。Claude Code は [`CLAUDE.md`](../CLAUDE.md) から `@AGENTS.md` を読み込みます。
- 再利用可能なスキルはルートの [`skills/`](../skills/) が正典です（`ai-config` / `dev-workflow` / `qa`）。
- Codex の `.agents/skills` と Claude Code の `.claude/skills` は `skills/` への相対 symlink としてローカルで生成します。symlink 自体は Git 管理せず、内容のコピーも作りません。
- Claude Code の許可設定は読み取り中心です。commit / tag / push、破壊的操作、外部公開は自動許可しません。認証情報（`.credentials.json`、`.codex/auth.json`）や `.env`、鍵は読み取りを拒否します。

## クローン直後のセットアップ

Windows では、管理者権限なしで symlink を作れるように「設定 > システム > 開発者向け」で開発者モードを有効にしてください。PowerShell でリポジトリのルートから実行します。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-ai-symlinks.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-ai-config.ps1
```

VS Code でフォルダを開くと `AI: Sync skill symlinks` タスクが自動実行されます。PowerShell 7 を使う場合は `powershell.exe` を `pwsh` に置き換えられます。symlink 作成に失敗しても、実ディレクトリのコピーや junction には置き換えません。

## ヘルスチェック

`scripts/check-ai-config.ps1` は、正典ファイル、Claude Code 設定の JSON、各スキル、symlink のリンク先、Git 管理対象に秘密情報らしいファイルがないことを検証します。失敗時は `[FAIL]` と理由を表示し、終了コード 1 を返します。
