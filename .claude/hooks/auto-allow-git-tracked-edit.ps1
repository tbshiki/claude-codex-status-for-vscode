#Requires -Version 5.1

# PreToolUse hook: Git 管理下(追跡済み)のファイルへの Edit/Write を自動許可する。
# 未追跡・無視対象・リポジトリ外のファイルは判定を返さず、通常の許可フローに委ねる。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $filePath = [string]$payload.tool_input.file_path
    if ([string]::IsNullOrWhiteSpace($filePath)) { exit 0 }

    $root = $env:CLAUDE_PROJECT_DIR
    if ([string]::IsNullOrWhiteSpace($root)) {
        $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $null = & git -C $root ls-files --error-unmatch -- $filePath 2>&1
    $isTracked = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousPreference

    if ($isTracked) {
        @{
            hookSpecificOutput = @{
                hookEventName            = 'PreToolUse'
                permissionDecision       = 'allow'
                permissionDecisionReason = 'Git 管理下のファイルのため自動許可'
            }
        } | ConvertTo-Json -Compress -Depth 4
    }
    exit 0
}
catch {
    exit 0
}
