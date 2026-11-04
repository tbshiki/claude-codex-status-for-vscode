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

- 上記と、次の「アップデートの確認」のほかに通信はしません。テレメトリも送りません。
- 診断コマンド「生の使用状況を表示」は、Claude の応答の本文を出力パネルに表示します。応答にトークンは含まれず、トークンを表示やログに出すこともしません。
- 実行時に使う外部のパッケージはありません（`package.json` の `dependencies` は空です）。`devDependencies` はビルドとパッケージングにだけ使い、`.vsix` には含めません。

### アップデートの確認

新しいバージョンを知らせるため、GitHub Releases を確認します。トークンや認証情報、利用者を特定する情報は送りません（通信の性質上、接続元の IP アドレスは GitHub に届きます）。

| 用途 | 通信先 | 送るヘッダ |
|---|---|---|
| 最新版の確認（起動後と 24 時間ごと、および手動の「アップデートを確認」） | `https://api.github.com/repos/tbshiki/claude-codex-status-for-vscode/releases/latest` | `User-Agent`（`claude-codex-status/<版>`）、`Accept`、`X-GitHub-Api-Version` |
| `.vsix` の取得（通知の「インストール」を押したときだけ） | `https://github.com/tbshiki/claude-codex-status-for-vscode/releases/download/...`（GitHub の配信用のホストへリダイレクトされます） | `User-Agent`（`claude-codex-status/<版>`）、`Accept` |

- `.vsix` は、リリースに添付された `claude-codex-status-<版>.vsix`（名前が完全に一致するもの）だけを使い、GitHub の API が示す SHA-256 と一致した場合だけ VSCode に導入します。一致しなければ導入しません。利用者が「インストール」を押さない限り、ダウンロードも導入もしません。
- SHA-256 の照合で防げるのは、転送中や配信中の破損・差し替えです。リリースそのものが本物かどうかは、このリポジトリと保守者の GitHub アカウントが守られていることに依存します（署名はしていません）。
- ダウンロードした `.vsix` は、OS の一時フォルダの中に毎回新しく作る専用のフォルダへ置き、導入が終わったら（失敗しても）フォルダごと消します。
- リリースの本文は表示しません。通知に出すのは、形式を確かめた版の番号だけです。
- 自動の確認は設定 `claudeCodexStatus.updateCheck.enabled` を `false` にすると止められます。
