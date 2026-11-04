# セキュリティポリシー

## 脆弱性の報告

脆弱性を見つけた場合は、公開の Issue や Pull Request には書かず、GitHub の非公開の報告から知らせてください。

- 報告の窓口: <https://github.com/tbshiki/claude-codex-status-for-vscode/security/advisories/new>

報告には、影響を受けるバージョン（またはコミット）、再現の手順、想定される影響を書いてください。個人で保守しているため、返信と修正の時期は約束できませんが、確認したら報告の画面で連絡します。修正を公開するまでは、内容を公開しないようお願いします。

## 対象

- 対象は `main` の最新のコードと、そこから作った最新の `.vsix` です。古いバージョンには修正を出しません。
- Claude Code、Codex CLI、それぞれの API の脆弱性は対象外です。各提供元に報告してください。

## 拡張機能が扱う認証情報

この拡張機能は、ローカルの Claude Code と Codex CLI がログイン時に保存した認証情報を読み取ります。

| 対象 | 既定の場所 | 使う項目 |
|---|---|---|
| Claude | `~/.claude/.credentials.json` | `claudeAiOauth.accessToken`、`claudeAiOauth.expiresAt` |
| Codex | `~/.codex/auth.json` | アクセストークン、アカウント ID |

- 場所は設定 `claudeCodexStatus.claude.credentialsPath` と `claudeCodexStatus.codex.authPath` で変えられます。どちらも `machine` スコープで、信頼されていないワークスペースではユーザー設定の値だけを使います（ワークスペースの設定で別のファイルを読ませることはできません）。
- 認証情報のファイルには書き込みません。トークンの更新（refresh）もしません。
- トークンを VSCode の設定、`SecretStorage`、ファイルなどに保存しません。

## 通信先

読み取ったトークンは、次の 2 か所にだけ送ります。どちらも残量（利用率）を取得するための非公式のエンドポイントです。

| 対象 | 通信先 | 送る情報 |
|---|---|---|
| Claude | `https://api.anthropic.com/api/oauth/usage` | Claude のアクセストークン（`Authorization` ヘッダ） |
| Codex | `https://chatgpt.com/backend-api/wham/usage` | Codex のアクセストークン（`Authorization` ヘッダ）、アカウント ID（`ChatGPT-Account-Id` ヘッダ） |

- 上記のほかに通信はしません。テレメトリも送りません。
- 診断コマンド「生の使用状況を表示」は、Claude の応答の本文を出力パネルに表示します。応答にトークンは含まれず、トークンを表示やログに出すこともしません。
- 実行時に使う外部のパッケージはありません（`package.json` の `dependencies` は空です）。`devDependencies` はビルドとパッケージングにだけ使い、`.vsix` には含めません。
