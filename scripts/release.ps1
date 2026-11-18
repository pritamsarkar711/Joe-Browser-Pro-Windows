<#
.SYNOPSIS
    Builds JoeBrowserSetup.exe, verifies it, and optionally publishes it.

.DESCRIPTION
    This is the same sequence the CI workflow runs, for a machine that has Windows and a normal
    network connection. It exists because the packaging step needs the Electron Windows
    distribution, which only a Windows-capable environment can fetch.

    Nothing here publishes unless you pass -Publish. Without it the script stops after the
    installer exists in .\release and prints their sizes.

.EXAMPLE
    .\scripts\release.ps1

.EXAMPLE
    .\scripts\release.ps1 -Publish          # tag comes from package.json
#>
[CmdletBinding()]
param(
    [switch]$Publish,
    [string]$Tag
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($name) { Write-Host "`n== $name" -ForegroundColor Cyan }

Step 'Installing dependencies'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

Step 'Typechecking'
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }

Step 'Running the tests'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }

Step 'Building the bundles'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }

Step 'Packaging the Windows binaries'
npx electron-builder --win --x64 --publish never
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }

Step 'Verifying the binaries'
$setup = Join-Path $root 'release\JoeBrowserSetup.exe'

foreach ($file in @($setup)) {
    if (-not (Test-Path $file)) { throw "Missing $file - the packaging step did not produce it" }
    $sizeMb = [math]::Round((Get-Item $file).Length / 1MB, 1)
    if ($sizeMb -lt 20) { throw "$file is only $sizeMb MB, which is too small to be a real build" }
    Write-Host "  $([System.IO.Path]::GetFileName($file))  $sizeMb MB" -ForegroundColor Green
}

# A Windows binary with no version resource shows up as an unknown publisher in Properties.
$info = (Get-Item $setup).VersionInfo
Write-Host "  Product: $($info.ProductName) $($info.ProductVersion)"
if ([string]::IsNullOrWhiteSpace($info.ProductName)) { throw 'The installer has no product name resource' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "`nVersion $version is packaged and verified." -ForegroundColor Green

if (-not $Publish) {
    Write-Host "Re-run with -Publish -Tag v$version to attach them to a GitHub release."
    return
}

if ([string]::IsNullOrWhiteSpace($Tag)) { $Tag = "v$version" }
if ($Tag -ne "v$version") { throw "Tag $Tag does not match package.json version $version" }

Step "Publishing $Tag"
git tag $Tag
git push origin $Tag

gh release create $Tag $setup `
    --title "Joe Browser $version" `
    --notes "Download JoeBrowserSetup.exe and follow the installation wizard to choose your installation folder and options. Windows 10 or 11, 64-bit. The binaries are not code-signed, so SmartScreen may show 'Windows protected your PC' the first time - choose More info, then Run anyway."

Write-Host "`nPublished: https://github.com/$((gh repo view --json nameWithOwner -q .nameWithOwner))/releases/tag/$Tag" -ForegroundColor Green
