#Requires -Version 5.1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:Failed = $false
$root = Split-Path -Parent $PSScriptRoot

function Write-CheckResult {
    param([bool]$Success, [string]$Message)
    if ($Success) {
        Write-Host "[OK] $Message"
    }
    else {
        Write-Host "[FAIL] $Message" -ForegroundColor Red
        $script:Failed = $true
    }
}

$agentsPath = Join-Path $root 'AGENTS.md'
Write-CheckResult (Test-Path -LiteralPath $agentsPath -PathType Leaf) 'AGENTS.md が存在する'

$claudePath = Join-Path $root 'CLAUDE.md'
$importsAgents = $false
if (Test-Path -LiteralPath $claudePath -PathType Leaf) {
    $importsAgents = [bool](Select-String -LiteralPath $claudePath -Pattern '^\s*@AGENTS\.md\s*$' -Quiet)
}
Write-CheckResult $importsAgents 'CLAUDE.md が @AGENTS.md を import している'

$settingsPath = Join-Path $root '.claude\settings.json'
$validJson = $false
$settings = $null
try {
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        $validJson = $true
    }
}
catch { }
Write-CheckResult $validJson '.claude/settings.json が正しい JSON である'

if ($validJson) {
    $permissions = $settings.permissions
    Write-CheckResult ($permissions.disableBypassPermissionsMode -eq 'disable') 'Claude Code の権限バイパスが無効である'

    $requiredAskRules = @(
        'PowerShell(git commit:*)',
        'PowerShell(git tag:*)',
        'PowerShell(git push:*)',
        'Bash(git commit:*)',
        'Bash(git tag:*)',
        'Bash(git push:*)'
    )
    foreach ($rule in $requiredAskRules) {
        Write-CheckResult ($permissions.ask -contains $rule) "Claude Code が $rule を確認対象にしている"
    }

    $requiredDenyRules = @(
        'Read(.env)',
        'Read(.env.*)',
        'Read(**/*.key)',
        'Read(**/*.pem)',
        'Read(**/secrets.*)'
    )
    foreach ($rule in $requiredDenyRules) {
        Write-CheckResult ($permissions.deny -contains $rule) "Claude Code が $rule を拒否している"
    }
}

$skillsPath = Join-Path $root 'skills'
$skillsItem = Get-Item -LiteralPath $skillsPath -Force -ErrorAction SilentlyContinue
$skillsHasLinkType = $null -ne $skillsItem -and $skillsItem.PSObject.Properties.Name -contains 'LinkType'
$skillsIsLink = $skillsHasLinkType -and -not [string]::IsNullOrEmpty([string]$skillsItem.LinkType)
$skillsIsRealDirectory = $null -ne $skillsItem -and $skillsItem.PSIsContainer -and -not $skillsIsLink
Write-CheckResult $skillsIsRealDirectory 'skills が実ディレクトリである'

foreach ($skillName in @('ai-config', 'dev-workflow', 'qa')) {
    $skillFile = Join-Path $skillsPath "$skillName\SKILL.md"
    Write-CheckResult (Test-Path -LiteralPath $skillFile -PathType Leaf) "skills/$skillName/SKILL.md が存在する"
}

$expectedSkillsPath = [IO.Path]::GetFullPath($skillsPath)
foreach ($relativeLink in @('.agents\skills', '.claude\skills')) {
    $linkPath = Join-Path $root $relativeLink
    $linkItem = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
    $hasLinkType = $null -ne $linkItem -and $linkItem.PSObject.Properties.Name -contains 'LinkType'
    $isLink = $hasLinkType -and $linkItem.LinkType -eq 'SymbolicLink'
    $pointsToSkills = $false
    if ($isLink) {
        $targetValue = [string](@($linkItem.Target)[0])
        $linkParent = Split-Path -Parent $linkPath
        $actualTargetPath = [IO.Path]::GetFullPath((Join-Path $linkParent $targetValue))
        $pointsToSkills = $actualTargetPath -eq $expectedSkillsPath
    }
    Write-CheckResult $pointsToSkills "$($relativeLink.Replace('\', '/')) が skills を指す symlink である"
}

$trackedSecrets = @(& git -C $root ls-files -- '.env' '.env.*' '*.key' '*.pem' 'secrets.*' '**/*.key' '**/*.pem' '**/secrets.*')
$gitSucceeded = $LASTEXITCODE -eq 0
Write-CheckResult $gitSucceeded 'Git 管理対象を検査できる'
Write-CheckResult ($gitSucceeded -and $trackedSecrets.Count -eq 0) '.env、鍵、秘密情報が Git 管理対象に含まれない'

if ($gitSucceeded) {
    $ignoredLocalSettings = @(& git -C $root check-ignore --no-index -- 'CLAUDE.local.md' '.claude/settings.local.json')
    $ignoreCheckSucceeded = $LASTEXITCODE -eq 0
    Write-CheckResult ($ignoreCheckSucceeded -and $ignoredLocalSettings.Count -eq 2) 'Claude Code のローカル専用設定が Git 除外されている'
}

Write-CheckResult (Test-Path -LiteralPath (Join-Path $root '.gitattributes') -PathType Leaf) '.gitattributes が存在する'

if ($script:Failed) { exit 1 }
exit 0
