# Claude & Codex Status — 要件定義書

- バージョン: v0.1 (ドラフト)
- 作成日: 2026-07-13
- 対象: VSCode拡張機能「Claude & Codex Status(仮)」

## 1. 背景・目的

Claude Code と OpenAI Codex CLI を併用していると、レートリミット(5時間枠・週枠)の残量を確認するためにブラウザや別コマンドを都度開く必要があり、作業のフローが途切れる。VSCodeのステータスバーに両エージェントの残量を常時表示し、確認のための離脱をゼロにすることを目的とする。

### 1.1 既存製品との差別化

| 観点 | 既存(Claude単体系) | 既存(cleocn/ai-usage-status-bar) | 本拡張機能 |
|---|---|---|---|
| 対応エージェント | Claudeのみ | Copilot/ChatGPT/Cursor/Claude(実験的) | **Claude + Codexに特化** |
| Claude対応状況 | 安定 | マーケットプレイス版で無効化・実験的 | 主要機能として安定実装 |
| Codex対応状況 | なし | ローカルログ依存で受動的取得 | 能動的なCLI連携を検討 |
| スコープ | 単一ツール | 4ツール分の広い範囲 | 2ツールに絞り込み、保守しやすく |

## 2. スコープ

### 2.1 対象とするもの(In Scope)

- Claude Code の5時間枠・週枠の利用率とリセット時刻をステータスバーに表示
- Codex CLI の5時間枠・週枠(または相当する枠)の残量率とリセット時刻をステータスバーに表示。5時間枠が一時的に提供されない場合は全体残量として表示
- 設定による表示項目のON/OFF切り替え
- ホバー時の詳細ツールチップ(内訳・リセットまでの残り時間)
- クリックでの即時再取得
- ホバー詳細内のリンクによる Claude / Codex 個別監視の停止・再開
- Windows / macOS / Linux での動作

### 2.2 対象外とするもの(Out of Scope, v1時点)

- GitHub Copilot、Cursorなど他ツールの利用率表示(将来検討)
- コスト($換算)の計算・表示(将来検討、v1では利用率%のみ)
- プロジェクト別・日別の使用量ヒートマップなどの高度な可視化
- チーム/Enterpriseプランにおける組織全体の集計

## 3. データソース

### 3.1 Claude

- 認証情報: `~/.claude/.credentials.json`(Windowsは `%USERPROFILE%\.claude\.credentials.json`)からOAuthアクセストークンを取得
- エンドポイント: `https://api.anthropic.com/api/oauth/usage`(ヘッダ `anthropic-beta: oauth-2025-04-20` が必要)
- **注意**: このエンドポイントは非公式かつ非保証。Claude Codeのバージョンアップで仕様変更・廃止される可能性がある前提で設計する(フェイルソフトな設計必須)

### 3.2 Codex

- 認証情報: `~/.codex/auth.json` からプラン種別・契約情報を取得
- 利用率データ: `~/.codex/auth.json` のアクセストークンを使い、`https://chatgpt.com/backend-api/wham/usage` から取得する。`rate_limit.primary_window` / `secondary_window` を共通形式へ正規化する。Codex CLI の内部 API に依存するため、仕様変更時は修正する前提とする
- **注意**: いずれも非公式手段であり、Codex CLIのバージョンによりログ形式・フィールド名が変わる可能性がある

### 3.3 共通の非機能要件

- 両データソースとも「取得できない/失敗した場合は直近の正常値を保持しつつエラー状態を明示」する設計とする(表示が消えたり例外でクラッシュしない)
- ポーリング間隔は設定可能(デフォルト60秒程度)とし、429エラー回避のため下限値(例: 30秒)を設ける
- 複数ウィンドウ/複数ワークスペースで同時にAPIを叩き過ぎない配慮(将来的にはキャッシュファイル共有も検討)

## 4. 機能要件

### 4.1 ステータスバー表示

- 表示例: `◆ Claude 5h:73% 7d:10%  ⌁ Codex 5h:16% 7d:2%`
- プロバイダごとにON/OFFを設定で切り替え可能
- 利用率に応じた色分け(例: 80%以上で警告色)は将来検討(v1では白黒テキストでも可)

### 4.2 ツールチップ

- ホバー時に以下を表示:
  - 各枠(5時間・週)の利用率
  - 各枠のリセット時刻・リセットまでの残り時間
  - 最終取得時刻
  - クリックでの再取得の案内

### 4.3 コマンド

| コマンドID | 表示名 | 内容 |
|---|---|---|
| `claudeCodexStatus.refresh` | Claude & Codex: 今すぐ更新 | 両プロバイダを即時再取得 |
| `claudeCodexStatus.refreshClaude` | Claude & Codex: Claudeのみ更新 | Claudeのみ再取得 |
| `claudeCodexStatus.refreshCodex` | Claude & Codex: Codexのみ更新 | Codexのみ再取得 |

### 4.4 設定項目(案)

```jsonc
{
  "claudeCodexStatus.pollIntervalSeconds": 60,
  "claudeCodexStatus.providers.claude": true,
  "claudeCodexStatus.providers.codex": true,
  "claudeCodexStatus.claude.credentialsPath": "",
  "claudeCodexStatus.codex.authPath": "",
  "claudeCodexStatus.style": "minimal", // "minimal" | "verbose"
  "claudeCodexStatus.displayMode": "remaining", // "remaining"(残量) | "used"(使用率)。ホバー内リンクでも切替可
  "claudeCodexStatus.warningRemainingPercent": 30, // 残量がこの%未満で該当プロバイダを黄文字+⚠。0で無効
  "claudeCodexStatus.criticalRemainingPercent": 10, // 残量がこの%未満で該当プロバイダを赤文字+エラーアイコン。0で無効
  "claudeCodexStatus.statusBarAlertColors": true // 逼迫時のステータスバー文字色(黄/赤)。ホバー内リンクでも切替可
}
```

### 4.5 エラーハンドリング

- 認証情報が見つからない場合: 「未ログイン」に類する表示+ツールチップで原因を案内
- API呼び出し失敗(ネットワークエラー・429・エンドポイント変更等): 直近の正常値を保持しつつ警告アイコンを付与し、ツールチップにエラー内容を表示
- 両プロバイダとも独立して動作し、片方が失敗してももう片方の表示に影響しない

## 5. 非機能要件

- **パフォーマンス**: VSCode起動時間・エディタ操作のレスポンスに影響を与えない(非同期処理・タイムアウト設定必須)
- **セキュリティ**: 取得したトークンをログ出力・外部送信しない。設定に保存する場合はVSCodeの`SecretStorage`を優先する
- **保守性**: 非公式API/ログ形式への依存を前提に、取得ロジックを抽象化し、仕様変更時に該当箇所のみ改修すれば済む構成にする
- **クロスプラットフォーム**: Windows/macOS/Linuxでパス解決を正しく行う(`os.homedir()`ベース)

## 6. 技術スタック(案)

- TypeScript + VSCode Extension API
- ビルド: `tsc` + `@vscode/vsce`
- テスト: 最低限のユニットテスト(データ取得・パース処理部分)を想定、VSCode API本体のE2Eテストは任意
- CI: GitHub Actions でのビルド確認(将来的にリリース自動化も検討)

## 7. マイルストーン(案)

| フェーズ | 内容 |
|---|---|
| M1 | Claude単体表示(既存プロトタイプの正式リポジトリ移行) |
| M2 | Codex対応追加(使用状況APIの直接取得) |
| M3 | 設定項目の拡充・エラーハンドリング強化 |
| M4 | Marketplace公開判断(公開する場合はpublisher登録・アイコン・README整備) |

## 8. オープンな論点(要議論)

- Codex の使用状況 API 変更時の追従方法
- 複数ウィンドウ間でのAPI呼び出し重複をどう避けるか(v1では許容し将来対応でもよいか)
- Marketplace公開するか、社内/個人利用のみに留めるか
- Copilot/Cursorなど他プロバイダ対応を将来スコープに含めるか
