#Requires -Version 5.1

# PreToolUse hook: シェルコマンド(Bash / PowerShell)が秘密情報ファイル
# (.env、*.key、*.pem、secrets.*、.credentials.json、.codex/auth.json)を
# 参照している場合にブロックする。
# .env.example は除外する。process.env のようなプロパティ参照は誤検知しない
# (直前が単語文字の ".env" はパスと見なさない)。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Deny([string]$reason) {
    @{
        hookSpecificOutput = @{
            hookEventName            = 'PreToolUse'
            permissionDecision       = 'deny'
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json -Compress -Depth 4
    exit 0
}

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $command = [string]$payload.tool_input.command
    if ([string]::IsNullOrWhiteSpace($command)) { exit 0 }

    # 許可対象の .env.example を除去してから判定する
    $scrubbed = $command -ireplace '\.env\.example', ''

    if ($scrubbed -imatch '(^|[^\w-])\.env(\.|\b)') {
        Deny '.env ファイルへのアクセスは禁止されています(AGENTS.md の秘密情報保護ルール)'
    }
    if ($scrubbed -imatch '\.(key|pem)(\b|$)') {
        Deny '鍵ファイル(*.key / *.pem)へのアクセスは禁止されています(AGENTS.md の秘密情報保護ルール)'
    }
    if ($scrubbed -imatch '(^|[^\w-])secrets\.\w') {
        Deny 'secrets.* ファイルへのアクセスは禁止されています(AGENTS.md の秘密情報保護ルール)'
    }
    if ($scrubbed -imatch '\.credentials\.json\b') {
        Deny '認証情報ファイル(.credentials.json)へのアクセスは禁止されています(AGENTS.md の秘密情報保護ルール)'
    }
    if ($scrubbed -imatch '\.codex[\\/]auth\.json\b') {
        Deny 'Codex 認証情報ファイル(.codex/auth.json)へのアクセスは禁止されています(AGENTS.md の秘密情報保護ルール)'
    }
    exit 0
}
catch {
    exit 0
}
