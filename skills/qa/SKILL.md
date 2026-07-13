---
name: qa
description: プロジェクト固有の QA 方法が未確定なリポジトリで、利用可能な検証コマンドを調査し段階的に実行するときに使う。
---

# QA の調査と実行

1. `README*`、`package.json`（`scripts` フィールド）、`tsconfig.json`、`.eslintrc*`、`.vscode/tasks.json`、CI 設定などを `rg --files` で探す。
2. ドキュメントと設定に明記された lint、format check、typecheck、test、build コマンドを抽出する。VSCode 拡張機能では `npm run compile` / `tsc --noEmit`（型検査）、`npm run lint`、`npm test`、`vsce package`（パッケージング）が典型。
3. 存在しないスクリプト、ツール、オプションを推測で実行しない。`package.json` の `scripts` に定義されたものだけを使う。
4. 構文や型検査から始め、対象テスト、静的解析、全体テスト、ビルド／パッケージングの順に影響範囲に応じて実行する。
5. 自動修正コマンド（`eslint --fix`、`prettier --write` など）は意図しない差分を生むため、必要性を確認してから使う。
6. 実行したコマンドと結果、実行できなかった検証と理由、残るリスクを報告する。
