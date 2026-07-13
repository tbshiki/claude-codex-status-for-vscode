#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationRoot,

    [string]$DestinationName = '',

    [switch]$Clean
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-IsChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Candidate,

        [Parameter(Mandatory = $true)]
        [string]$Parent
    )

    return $Candidate.StartsWith("$Parent\", [StringComparison]::OrdinalIgnoreCase)
}

if (-not (Get-Command robocopy.exe -ErrorAction SilentlyContinue)) {
    throw 'robocopy.exe が見つかりません。このスクリプトは Windows 専用です。'
}

$sourceRoot = Get-NormalizedFullPath -Path (Split-Path -Parent $PSScriptRoot)
$destinationRootFull = Get-NormalizedFullPath -Path $DestinationRoot

if ([string]::IsNullOrWhiteSpace($DestinationName)) {
    $DestinationName = Split-Path -Leaf $sourceRoot
}

if ([IO.Path]::IsPathRooted($DestinationName)) {
    throw 'DestinationName には絶対パスを指定できません。'
}

if ([IO.Path]::GetFileName($DestinationName) -ne $DestinationName -or
    $DestinationName -eq '.' -or $DestinationName -eq '..') {
    throw 'DestinationName には直下のディレクトリ名だけを指定してください。'
}

$destinationPath = Get-NormalizedFullPath -Path (Join-Path $destinationRootFull $DestinationName)

if ($destinationPath -ieq $destinationRootFull -or
    -not (Test-IsChildPath -Candidate $destinationPath -Parent $destinationRootFull)) {
    throw 'コピー先は DestinationRoot 直下の子ディレクトリでなければなりません。'
}

if ($destinationPath -ieq $sourceRoot) {
    Write-Host "[OK] コピー元とコピー先が同じため、処理は不要です: $destinationPath"
    exit 0
}

if ((Test-IsChildPath -Candidate $destinationPath -Parent $sourceRoot) -or
    (Test-IsChildPath -Candidate $sourceRoot -Parent $destinationPath)) {
    throw 'コピー元とコピー先を親子関係にすることはできません。再帰コピーを防ぐため中止します。'
}

$excludedDirectories = @(
    '.agents',
    '.claude\skills',
    'node_modules',
    'out',
    'vendor',
    'dist',
    'build',
    'coverage',
    '.vscode-test',
    '.cache',
    '.parcel-cache',
    '.next',
    '.nuxt',
    '.turbo',
    '.pnpm-store',
    '.yarn\cache',
    '.gradle',
    '.venv',
    'venv',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.tox',
    '.wrangler',
    'target',
    'tmp',
    'temp'
)

$excludedFiles = @(
    '.DS_Store',
    'Thumbs.db',
    '*.log',
    '*.tmp',
    '*.temp',
    '*.pyc',
    '*.pyo',
    '.eslintcache',
    'index.lock',
    'config.lock',
    'HEAD.lock',
    'packed-refs.lock',
    'shallow.lock',
    'gc.log'
)

$arguments = @(
    $sourceRoot,
    $destinationPath,
    '/E',
    '/COPY:DAT',
    '/DCOPY:DAT',
    '/R:2',
    '/W:1',
    '/XJ',
    '/FFT',
    '/NP',
    '/NFL',
    '/NDL',
    '/XD'
) + $excludedDirectories + @('/XF') + $excludedFiles

Write-Host "Source:      $sourceRoot"
Write-Host "Destination: $destinationPath"

if ($Clean) {
    Write-Host 'Mode:        clean copy; the destination directory is removed first'

    $existingDestination = Get-Item -LiteralPath $destinationPath -Force -ErrorAction SilentlyContinue
    if ($null -ne $existingDestination) {
        $hasLinkType = $existingDestination.PSObject.Properties.Name -contains 'LinkType'
        $isLink = $hasLinkType -and -not [string]::IsNullOrEmpty([string]$existingDestination.LinkType)
        if ($isLink) {
            throw 'コピー先が symlink または junction のため、クリーン削除を拒否しました。'
        }

        $resolvedDestination = Get-NormalizedFullPath -Path (Resolve-Path -LiteralPath $destinationPath).ProviderPath
        $resolvedDestinationRoot = Get-NormalizedFullPath -Path (Resolve-Path -LiteralPath $destinationRootFull).ProviderPath
        if ($resolvedDestination -ieq $resolvedDestinationRoot -or
            -not (Test-IsChildPath -Candidate $resolvedDestination -Parent $resolvedDestinationRoot)) {
            throw '解決後のコピー先が DestinationRoot の外にあるため、クリーン削除を拒否しました。'
        }

        Write-Host "Removing:    $resolvedDestination"
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
    }
}
else {
    Write-Host 'Mode:        overwrite copy; destination-only files are kept'
}

& robocopy.exe @arguments
$robocopyExitCode = $LASTEXITCODE

# robocopy の 0～7 は成功または差分あり、8 以上は失敗。
if ($robocopyExitCode -ge 8) {
    throw "robocopy.exe が終了コード $robocopyExitCode で失敗しました。"
}

Write-Host "[OK] ワークスペースをコピーしました (robocopy exit code $robocopyExitCode)。"
Write-Warning 'このコピーは世代管理バックアップではありません。重要データには別のバックアップも用意してください。'
