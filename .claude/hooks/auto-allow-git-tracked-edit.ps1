#Requires -Version 5.1

# PreToolUse hook: Git 管理下(追跡済み)のファイルへの Edit/Write を自動許可する。
# 未追跡・無視対象・リポジトリ外のファイルは判定を返さず、通常の許可フローに委ねる。
# .claude/ と .github/ の下は、追跡済みでも自動許可しない。AI の権限(この hook 自身や deny の設定)と
# CI を決めるファイルなので、確認なしで書き換えさせない。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    # Claude Code は UTF-8 で送る。[Console]::In はコンソールのコードページで読み、日本語のパスが化けるので、
    # バイト列を UTF-8 として読む
    $stdin = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($stdin)
    $payload = [System.Text.Encoding]::UTF8.GetString($stdin.ToArray()).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $filePath = [string]$payload.tool_input.file_path
    if ([string]::IsNullOrWhiteSpace($filePath)) { exit 0 }

    $root = $env:CLAUDE_PROJECT_DIR
    if ([string]::IsNullOrWhiteSpace($root)) {
        $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    # --literal-pathspecs: [ ] * ? をワイルドカードとして扱わない(未追跡の [a]b.ps1 が追跡済みの ab.ps1 に一致しないように)
    # --full-name -z: リポジトリの root からの相対パスを、引用符で囲まずに返す
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $listed = & git -C $root --literal-pathspecs ls-files --error-unmatch --full-name -z -- $filePath 2>$null
    $isTracked = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousPreference
    if (-not $isTracked) { exit 0 }

    foreach ($relative in ([string]($listed -join '')).Split([char]0)) {
        if ($relative -imatch '^\.(claude|github)/') { exit 0 }
    }

    @{
        hookSpecificOutput = @{
            hookEventName            = 'PreToolUse'
            permissionDecision       = 'allow'
            permissionDecisionReason = 'Git 管理下のファイルのため自動許可'
        }
    } | ConvertTo-Json -Compress -Depth 4
    exit 0
}
catch {
    exit 0
}
