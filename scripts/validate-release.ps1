[CmdletBinding()]
param(
    [switch]$SkipProfile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $projectRoot 'package.json'
$assetsPath = Join-Path $projectRoot 'ASSETS.md'
$readmePath = Join-Path $projectRoot 'README.md'
$checklistPath = Join-Path $projectRoot 'docs/operations/release-checklist.md'
$performanceDocPath = Join-Path $projectRoot 'docs/operations/performance.md'
$screenshotServicePath = Join-Path $projectRoot 'src/main/services/screenshotService.ts'
$fullFlowTestPath = Join-Path $projectRoot 'tests/electron/fullFlow.test.ts'
$evidenceModulePath = Join-Path $projectRoot 'scripts/validate-release-evidence.mjs'
$outputDirectory = Join-Path $projectRoot 'out'

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Contains {
    param(
        [string]$Text,
        [string]$Needle,
        [string]$Message
    )

    Assert-True ($Text.Contains($Needle)) $Message
}

function Invoke-Checked {
    param(
        [string]$Command,
        [string[]]$Arguments
    )

    & $Command @Arguments
    Assert-True ($LASTEXITCODE -eq 0) "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
}

if ($SkipProfile) {
    throw 'Release validation requires fresh performance evidence. -SkipProfile is not permitted.'
}

$requiredFiles = @(
    $packagePath,
    $assetsPath,
    $readmePath,
    $checklistPath,
    $performanceDocPath,
    (Join-Path $projectRoot 'scripts/profile-performance.mjs'),
    (Join-Path $projectRoot 'scripts/provision-live2d-assets.mjs'),
    $evidenceModulePath,
    $screenshotServicePath,
    $fullFlowTestPath
)
foreach ($file in $requiredFiles) {
    Assert-True (Test-Path -LiteralPath $file -PathType Leaf) "Required release file is missing: $file"
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
Assert-Contains $package.scripts.'validate:release' 'validate-release.ps1' 'validate:release script is not wired to validate-release.ps1'
Assert-Contains $package.scripts.'profile:performance' 'profile-performance.mjs' 'profile:performance script is not wired to profile-performance.mjs'
Assert-Contains $package.scripts.'build:windows' 'electron-builder --win' 'build:windows does not invoke electron-builder for Windows'
$nsisTargets = @($package.build.win.target | Where-Object { $_.target -eq 'nsis' })
Assert-True ($nsisTargets.Count -eq 1) 'Windows build must target exactly one NSIS installer'

$assets = Get-Content -LiteralPath $assetsPath -Raw
$readme = Get-Content -LiteralPath $readmePath -Raw
$checklist = Get-Content -LiteralPath $checklistPath -Raw
Assert-Contains $assets 'personal-only' 'ASSETS.md must record the personal-only restriction'
Assert-Contains $readme 'npm run validate:release' 'README.md must document release validation'
Assert-Contains $readme 'npm run build:windows' 'README.md must document Windows packaging'
foreach ($needle in @(
    'Model and License Verification',
    'Dependency and License Review',
    'No API keys or secrets',
    'No screenshots or image buffers persist'
)) {
    Assert-Contains $checklist $needle "Release checklist is missing: $needle"
}

Push-Location $projectRoot
try {
    Invoke-Checked 'node' @('scripts/provision-live2d-assets.mjs', '--verify')
    Invoke-Checked 'npm' @('run', 'profile:performance')

    $profilePath = Join-Path $outputDirectory 'performance-profile.json'
    $queryPath = Join-Path $outputDirectory 'npm-query.json'
    $reviewPath = Join-Path $outputDirectory 'dependency-license-review.json'
    Assert-True (Test-Path -LiteralPath $profilePath -PathType Leaf) 'Performance profile report is missing'
    npm query '*' | Set-Content -LiteralPath $queryPath -Encoding utf8
    Assert-True ($LASTEXITCODE -eq 0) 'npm query * failed'

    Invoke-Checked 'node' @(
        'scripts/validate-release-evidence.mjs',
        '--root', $projectRoot,
        '--query', $queryPath,
        '--review', $reviewPath,
        '--checklist', $checklistPath,
        '--package', $packagePath,
        '--profile', $profilePath
    )

    $screenshotSource = Get-Content -LiteralPath $screenshotServicePath -Raw
    $fullFlowTest = Get-Content -LiteralPath $fullFlowTestPath -Raw
    Assert-True ($screenshotSource -notmatch 'writeFile|createWriteStream') 'Screenshot service must not persist image bytes to disk'
    Assert-Contains $fullFlowTest 'persistedScreenshotFiles' 'Full-flow test must check for persisted screenshots'
    Assert-Contains $fullFlowTest 'leakedProcessIds' 'Full-flow test must check for leaked child processes'
}
finally {
    Pop-Location
}

Write-Host 'Release validation passed.'
Write-Host "Dependency review: $reviewPath"
Write-Host "Performance profile: $profilePath"
