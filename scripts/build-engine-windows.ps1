#!/usr/bin/env pwsh
<#
Vayu Engine Build Script for Windows (PowerShell)
This script builds the vayu-engine binary for bundling with the Electron app.
It intentionally targets native Windows and will error out on WSL/Linux.

Usage:
    pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-engine-windows.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    Write-Error "This script must be run on native Windows (PowerShell). WSL is not supported by this script."
    exit 1
}

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "Warning: $m" -ForegroundColor Yellow }
function ErrorExit($m){ Write-Host "Error: $m" -ForegroundColor Red; exit 1 }
function Success($m){ Write-Host "✓ $m" -ForegroundColor Green }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent $ScriptDir
$EngineDir = Join-Path $ProjectRoot 'engine'
$BuildDir = Join-Path $EngineDir 'build-release'
$OutputDir = Join-Path $ProjectRoot 'app\resources\bin'

Info "Vayu Engine - Windows Production Build (PowerShell)"
Info "Script dir: $ScriptDir"

# Check for vcpkg
$vcpkgCmd = Get-Command vcpkg -ErrorAction SilentlyContinue
if (-not $vcpkgCmd) { ErrorExit "vcpkg not found. Install: https://vcpkg.io/en/getting-started.html" }
$VCPKG_ROOT = Split-Path -Parent $vcpkgCmd.Path
Info "Using vcpkg: $VCPKG_ROOT"

# Detect architecture
$arch = $env:PROCESSOR_ARCHITECTURE
switch -Regex ($arch) {
    'AMD64' { $TRIPLET = 'x64-windows' }
    'ARM64' { $TRIPLET = 'arm64-windows' }
    default { $TRIPLET = 'x64-windows' }
}
Info "Building for: $TRIPLET"

# Install dependencies from vcpkg.json if present
if (-Not (Test-Path (Join-Path $EngineDir 'vcpkg.json'))) {
    Warn "$($EngineDir)\vcpkg.json not found, skipping dependency installation"
} else {
    Info "Checking vcpkg dependencies..."
    try {
        $json = Get-Content -Raw -Path (Join-Path $EngineDir 'vcpkg.json') | ConvertFrom-Json
    } catch {
        Warn "Failed to parse vcpkg.json; skipping dependency check"
        $json = $null
    }
    $deps = @()
    if ($json -and $json.dependencies) {
        foreach ($d in $json.dependencies) {
            if ($d -is [string]) { $deps += $d } elseif ($d.name) { $deps += $d.name }
        }
    }

    if ($deps.Count -gt 0) {
        $installed = (& vcpkg list) -join "`n"
        $missing = @()
        foreach ($dep in $deps) {
            $pattern = "^" + [regex]::Escape($dep) + ":" + [regex]::Escape($TRIPLET)
            if ($installed -notmatch $pattern) { $missing += "$dep:$TRIPLET" }
        }
        if ($missing.Count -gt 0) {
            Info "Installing $($missing.Count) missing dependencies via vcpkg..."
            & vcpkg install $missing
        } else { Success "Dependencies ready" }
    } else { Info "No dependencies listed in vcpkg.json" }
}

# Build engine
Info "Building vayu-engine for production..."
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
Push-Location $BuildDir

$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) { ErrorExit "cmake not found. Install CMake and ensure it's in PATH." }

$cmakeArgs = @(
    '-G', 'Visual Studio 17 2022',
    '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT\scripts\buildsystems\vcpkg.cmake",
    "-DVCPKG_TARGET_TRIPLET=$TRIPLET",
    '-DVCPKG_MANIFEST_MODE=OFF',
    '-DVAYU_BUILD_TESTS=OFF',
    '-DVAYU_BUILD_CLI=OFF',
    '-DVAYU_BUILD_ENGINE=ON',
    '..'
)

& cmake @cmakeArgs

$cores = [Environment]::ProcessorCount
Info "Building with $cores parallel workers"
& cmake --build . --config Release -- /m:$cores

Pop-Location
Success "Engine built successfully"

# Package binary
Info "Packaging binary for Electron app..."
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$src = Join-Path $BuildDir 'Release\vayu-engine.exe'
if (-not (Test-Path $src)) { ErrorExit "Built binary not found: $src" }
$dest = Join-Path $OutputDir 'vayu-engine.exe'
Copy-Item -Force -Path $src -Destination $dest
$size = (Get-Item $dest).Length
Info "Binary size: $([Math]::Round($size / 1MB, 2)) MB"
Success "Binary packaged at: $dest"

Write-Host ""
Success "Build completed."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. cd app"
Write-Host "  2. pnpm run electron:build"
