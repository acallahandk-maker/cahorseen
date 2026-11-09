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

$requiredFiles = @(
    $packagePath,
    $assetsPath,
    $readmePath,
    $checklistPath,
    $performanceDocPath,
    (Join-Path $projectRoot 'scripts/profile-performance.mjs'),
    (Join-Path $projectRoot 'scripts/provision-live2d-assets.mjs'),
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

    if (-not $SkipProfile) {
        Invoke-Checked 'npm' @('run', 'profile:performance')
    }

    $profilePath = Join-Path $outputDirectory 'performance-profile.json'
    Assert-True (Test-Path -LiteralPath $profilePath -PathType Leaf) 'Performance profile report is missing'
    $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    Assert-True ($profile.evaluation.pass) 'Performance measurements exceed product targets'
    Assert-True ($profile.idleDrift.pass) 'Idle memory drift exceeds the 25 MB target'
    Assert-True ($profile.idleDrift.simulatedHours -eq 8) 'Performance profile must include eight-hour-equivalent drift evidence'
    Assert-True ($profile.idleDrift.sampleCount -gt 0) 'Performance profile has no observed idle memory samples'
    Assert-True ($profile.idleDrift.wallClockDurationMs -gt 0) 'Performance profile has no sampled wall-clock duration'
    Assert-True ($profile.interactionSamples -gt 0) 'Performance profile has no interaction latency samples'
    Assert-True (
        $profile.idleDrift.measurementKind -eq 'accelerated-8-hour-equivalent' -or
        $profile.idleDrift.measurementKind -eq 'real-wall-clock'
    ) 'Idle drift evidence must identify whether it is accelerated or real wall-clock data'

    $queryPath = Join-Path $outputDirectory 'npm-query.json'
    npm query '*' | Set-Content -LiteralPath $queryPath -Encoding utf8
    Assert-True ($LASTEXITCODE -eq 0) 'npm query * failed'
    $parsedPackages = Get-Content -LiteralPath $queryPath -Raw | ConvertFrom-Json
    $packageMap = @{}
    foreach ($dependency in @($parsedPackages)) {
        $key = "$($dependency.name)@$($dependency.version)"
        if (-not $packageMap.ContainsKey($key)) {
            $packageMap[$key] = $dependency
        }
    }
    $thirdParty = @($packageMap.Values | Where-Object {
        $_.name -ne $package.name -or $_.version -ne $package.version
    })
    Assert-True ($thirdParty.Count -gt 0) 'Dependency license review found no third-party packages'
    foreach ($dependency in $thirdParty) {
        $license = [string]$dependency.license
        Assert-True (-not [string]::IsNullOrWhiteSpace($license)) "Dependency has no recorded license: $($dependency.name)@$($dependency.version)"
    }

    $runtimeThirdParty = @($thirdParty | Where-Object { -not $_.dev })
    $copyleftRuntime = @($runtimeThirdParty | Where-Object {
        ([string]$_.license) -match '\b(AGPL|LGPL|GPL|SSPL)\b'
    })
    Assert-True ($copyleftRuntime.Count -eq 0) 'Runtime dependency review found a reciprocal license requiring release review'

    $licenseCounts = @{}
    foreach ($dependency in $thirdParty) {
        $license = [string]$dependency.license
        if (-not $licenseCounts.ContainsKey($license)) {
            $licenseCounts[$license] = 0
        }
        $licenseCounts[$license] += 1
    }
    $licenseReview = [ordered]@{
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        source = "npm query '*'"
        packageCount = $thirdParty.Count
        runtimePackageCount = $runtimeThirdParty.Count
        licenseCounts = [ordered]@{}
        packages = @($thirdParty | Sort-Object name, version | ForEach-Object {
            [ordered]@{
                name = $_.name
                version = $_.version
                license = [string]$_.license
                runtime = -not $_.dev
            }
        })
    }
    foreach ($license in ($licenseCounts.Keys | Sort-Object)) {
        $licenseReview.licenseCounts[$license] = $licenseCounts[$license]
    }
    $licenseReviewPath = Join-Path $outputDirectory 'dependency-license-review.json'
    $licenseReview | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $licenseReviewPath -Encoding utf8

    $filePaths = @(git ls-files --cached --others --exclude-standard)
    Assert-True ($LASTEXITCODE -eq 0) 'git ls-files failed'
    $secretPatterns = @(
        '(?i)\bsk-[A-Za-z0-9_-]{20,}\b',
        '(?i)\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*[''"][^''"]{16,}[''"]'
    )
    $scannedExtensions = @('.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.txt', '.yml', '.yaml')
    foreach ($relativePath in $filePaths) {
        $extension = [System.IO.Path]::GetExtension($relativePath).ToLowerInvariant()
        if ($scannedExtensions -notcontains $extension) {
            continue
        }
        $filePath = Join-Path $projectRoot $relativePath
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            continue
        }
        $content = Get-Content -LiteralPath $filePath -Raw
        foreach ($pattern in $secretPatterns) {
            foreach ($match in [regex]::Matches($content, $pattern)) {
                $value = $match.Value
                if ($value -match '(?i)(placeholder|synthetic|example|test)') {
                    continue
                }
                throw "Potential secret found in $relativePath; value not reported"
            }
        }
    }

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
Write-Host "Dependency review: $(Join-Path $outputDirectory 'dependency-license-review.json')"
Write-Host "Performance profile: $(Join-Path $outputDirectory 'performance-profile.json')"
