#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if (-not ('AiWorkspaceSymlink' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AiWorkspaceSymlink {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateSymbolicLinkW(string linkPath, string targetPath, int flags);
}
"@
}

$root = Split-Path -Parent $PSScriptRoot
$skillsPath = Join-Path $root 'skills'

if (-not (Test-Path -LiteralPath $skillsPath -PathType Container)) {
    throw '正典の skills ディレクトリがありません。処理を中止します。'
}

$links = @('.agents\skills', '.claude\skills')
# SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
$flags = 0x1 -bor 0x2

foreach ($relativeLink in $links) {
    $linkPath = Join-Path $root $relativeLink
    $parentPath = Split-Path -Parent $linkPath
    $relativeTarget = '..\skills'

    if (-not (Test-Path -LiteralPath $parentPath -PathType Container)) {
        New-Item -ItemType Directory -Path $parentPath | Out-Null
    }

    $existing = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        $hasLinkType = $existing.PSObject.Properties.Name -contains 'LinkType'
        $isSymbolicLink = $hasLinkType -and $existing.LinkType -eq 'SymbolicLink'
        if (-not $isSymbolicLink) {
            throw "$relativeLink は symlink ではありません。データ保護のため削除せず中止します。"
        }

        $targetValue = [string](@($existing.Target)[0])
        $existingTargetPath = [IO.Path]::GetFullPath((Join-Path $parentPath $targetValue))
        $expectedTargetPath = [IO.Path]::GetFullPath($skillsPath)
        if ($existingTargetPath -eq $expectedTargetPath) {
            Write-Host "[OK] $relativeLink -> $relativeTarget"
            continue
        }

        # reparse point 自体だけを削除し、リンク先は変更しない。
        if ($existing.PSIsContainer) {
            [IO.Directory]::Delete($linkPath, $false)
        }
        else {
            [IO.File]::Delete($linkPath)
        }
    }

    $created = [AiWorkspaceSymlink]::CreateSymbolicLinkW($linkPath, $relativeTarget, $flags)
    if (-not $created) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "$relativeLink の作成に失敗しました (Win32 error $code)。Windows 開発者モードを有効にしてください。"
    }

    Write-Host "[OK] $relativeLink -> $relativeTarget"
}
