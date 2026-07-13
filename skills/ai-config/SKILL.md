---
name: ai-config
description: Codex と Claude Code の共通指示、スキル、権限、symlink 設定を安全に変更・点検するときに使う。
---

# AI 設定の変更

1. `git status --short` で既存変更を確認する。
2. 共通指示は `AGENTS.md`、再利用可能な手順は `skills/` だけを正典として編集する。
3. `CLAUDE.md` は `@AGENTS.md` の import を維持する。
4. `.agents/skills` と `.claude/skills` の内容を直接編集しない。
5. 権限は最小限に保ち、秘密情報と破壊的・公開操作を自動許可しない。
6. `scripts/sync-ai-symlinks.ps1` でリンクを同期する。
7. `scripts/check-ai-config.ps1` と `git diff --check` を実行する。
8. 失敗した確認、環境依存の制約、残るリスクを報告する。
