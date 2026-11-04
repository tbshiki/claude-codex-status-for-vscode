# AI 開発ガイドライン

このファイルは、このリポジトリで作業する AI への共通指示の正典です。

## プロジェクト概要

- VSCode 拡張機能「Claude & Codex Status」。Claude Code と OpenAI Codex CLI のレートリミット残量をステータスバーに常時表示する。
- 技術スタック: TypeScript + VSCode Extension API。ビルドは `tsc`、パッケージングは `@vscode/vsce`。
- 詳細な仕様は `docs/requirements.md` を参照する。
- 非公式 API・ログ形式へ依存するため、取得ロジックは抽象化し、フェイルソフト（取得失敗時も直近値を保持しクラッシュしない）を必須とする。

## コミュニケーション

- ユーザーへの応答、進捗、検証結果は日本語で記述する。
- 不明点が軽微なら安全な仮定を明示して進め、結果に影響する判断だけを確認する。

## 作業規約

- 作業開始時に `git status --short` を確認し、既存の未コミット変更を保持する。
- ファイル探索には `rg` と `rg --files` を優先する。
- `~/.claude/.credentials.json`、`~/.codex/auth.json`、`.env`、鍵、トークンなどの秘密情報を読み取ったり、表示したり、コミットしたりしない。
- 取得したアクセストークンをログ出力・外部送信しない。設定へ保存する場合は VSCode の `SecretStorage` を優先する。
- ビルド成果物（`out/`、`dist/`、`*.vsix`）、生成コード、依存関係などの生成物を直接編集しない。正典となる入力を変更して再生成する。
- 既存の設計と設定を尊重し、タスクに無関係な変更を混ぜない。

## Git 運用

- このリポジトリの Git 運用（ブランチ作成、コミット、マージ）は AI が主体的に行ってよい。
- 機能変更やバージョン・設定などのアップデートがある場合は、影響範囲に応じた検証と拡張機能のビルド（通常は `npm run package`）まで AI が実施する。
- 基本の流れは「（必要なら作業用ブランチを作成）→ 日本語でコミット」まで。タスクが完了しても、その場では `main` へマージしない。
- コミットメッセージは Conventional Commits 形式（`type: short description`）を使う。主な type は `feat`（機能追加）、`fix`（修正）、`docs`（文書）、`chore`（雑務・設定）、`refactor`（リファクタリング）、`test`（テスト）、`build`（ビルド）とする。
- 例: `feat: 自動監視トグルを追加`、`fix: Codex残量の表示を修正`、`chore: AI開発ガイドラインを更新`
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` を付ける。
- コミット後は、ユーザーから別途止める指示がない限り、作業ブランチをリモートへプッシュする。外部公開操作のため、実行環境の承認が必要な場合はその承認を求める。
- `main` へのマージは、これまでと異なるタスクを開始するタイミングで行う。次の依頼が現在の作業ブランチと無関係な場合、AI は現在の変更をコミット済みか確認し、作業ブランチを `main` へ `--no-ff` でマージしてから、新しい作業ブランチを作成して次の作業とコミットを行う。関連する続きの場合は、マージせず現在のブランチで継続する。
- マージ済みの作業用ブランチは削除してよい。
- tag の作成・プッシュは、通常のブランチプッシュとは別にユーザーへ確認する。
- 秘密情報や生成物を誤ってコミットしないよう、コミット前に `git status --short` と対象ファイルを確認する。

## リリース

- リリースは `.github/workflows/release.yml` で作る。手元で作った `.vsix` をリリースに上げない（端末や `node_modules` が汚染されていても配布物に混ざらないようにするため）。
- 手順:
  1. `package.json` の版を上げた変更を `main` へ取り込む。
  2. ユーザーの確認を得てから、`main` のマージコミットに軽量タグ `vX.Y.Z` を付けて push する。
  3. workflow が `.vsix` をビルドし、ビルドの証明（build provenance）を付けて下書きのリリースに添付する。タグのコミットが `main` の履歴にない場合と、タグと `package.json` の版が違う場合は失敗する。
  4. リリースノート（日本語、前の版からの変更点とインストール方法）を書き、`gh release edit vX.Y.Z --notes-file <file> --draft=false` で公開する。
  5. `gh attestation verify` で添付の `.vsix` の証明を確かめる。
- immutable releases を有効にしているため、公開後は添付ファイルとタグを変えられない。誤りは次の版で直す。
- 拡張機能は、公開から 72 時間たつまで新しい版を利用者に案内しない（乗っ取りへの備え）。急ぎの修正でも、この待ち時間は変えない。

## GitHub の設定

- このリポジトリは公開している。実在のパス、user 名、メールアドレスをファイルやコミットメッセージに書かない。
- GitHub の設定を変えるときは、変える内容を先にユーザーへ示し、承認を得てから行う。
- `main` は 2 つの ruleset で守る。
  - 削除と force push を禁止する。bypass は認めない（admin も例外にしない）。
  - Pull Request と CI の `build` の成功を必須にする（承認は 0 件、マージ方法はマージコミットだけ）。こちらはリポジトリの admin だけが bypass できるので、ローカルで `--no-ff` マージして push する運用はそのまま使える。
- `.github/workflows/build.yml` のジョブ名 `build` は ruleset の必須チェックになっている。変えるときは ruleset も直す。
- マージ方法はマージコミットだけにし、マージ後のブランチは自動で削除する。
- 脆弱性は非公開の報告（private vulnerability reporting）で受け付ける。窓口と、拡張機能が扱う認証情報・通信先は `SECURITY.md` に書く。
- CodeQL は default setup で動かす。secret scanning と push protection を有効にする。
- Dependabot はアラートと security updates を有効にし、`.github/dependabot.yml` で npm と github-actions を毎週更新する（cooldown 7 日）。
- Actions は GitHub 製の action だけを許可し、SHA での固定を必須にする。`GITHUB_TOKEN` の既定の権限は read にする。fork から来た Pull Request は、外部のコントリビューターすべてについて承認してから動かす。
- Wiki と Projects は使わない（無効にする）。
- リリースは immutable releases（公開後のリリースの添付ファイルとタグを変更できなくする）を有効にする。
- workflow の書き方:
  - action は `uses: owner/repo@<コミットの SHA> # vX.Y.Z` の形で書き、tag だけで指定しない。SHA は `gh api` で調べ、tag が注釈付きなら指しているコミットまでたどる。
  - `permissions:` を明記して最小にする（通常は `contents: read`）。`actions/checkout` には `persist-credentials: false` を付け、ジョブに `timeout-minutes` を付ける。
  - 書き込みの権限や `id-token: write` を持つジョブでは、依存パッケージ（npm）のコードを動かさない。ビルドは読み取りだけのジョブで行い、成果物を受け渡す（`release.yml` の build と release の分け方）。リリースのビルドではキャッシュと install script を使わない。
  - step の `shell:` に `${{ matrix.* }}` を書かない。workflow 全体が無効になり、ジョブが 1 つも動かない。
  - push 後は `gh run list` で、workflow が実際に動いたかを確かめる。

## 実装と検証

- 複数ファイルや大きな変更では `skills/dev-workflow/SKILL.md` を利用する。
- 変更後は影響範囲に応じ、軽量な確認からテスト、静的解析、ビルドへ段階的に検証する。
- 利用可能な QA コマンド（`npm run compile`、`tsc --noEmit`、`npm test`、lint など）が不明な場合は `skills/qa/SKILL.md` に従って調査する。
- AI 設定を変更した後は `scripts/check-ai-config.ps1` を実行する。
- 最終報告には変更内容、実施した検証、検証できなかった項目と残るリスクを含める。
