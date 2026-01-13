# Vayu Build Script for Windows
# Usage: .\build-windows.ps1 [dev|prod]
# 
# This script builds the C++ engine and Electron app for Windows
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as NSIS installer

param(
    [Parameter(Position=0)]
    [ValidateSet('dev', 'prod')]
    [string]$BuildMode = 'prod'
)

# Colors for output
$ErrorColor = 'Red'
$SuccessColor = 'Green'
$InfoColor = 'Cyan'
$WarnColor = 'Yellow'

function Write-Info {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor $InfoColor
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor $SuccessColor
}

function Write-Warn {
    param([string]$Message)
    Write-Host "Warning: $Message" -ForegroundColor $WarnColor
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host "Error: $Message" -ForegroundColor $ErrorColor
    exit 1
}

# Paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$EngineDir = Join-Path $ProjectRoot "engine"
$AppDir = Join-Path $ProjectRoot "app"

# Check if running on Windows
if ($PSVersionTable.Platform -ne 'Win32NT' -and $PSVersionTable.Platform -ne $null) {
    Write-Error-Custom "This script is for Windows only"
}

# Check prerequisites
function Test-Prerequisites {
    Write-Info "Checking prerequisites..."
    
    # Check CMake
    if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
        Write-Error-Custom "cmake not found. Install from: https://cmake.org/download/"
    }
    
    # Check vcpkg
    if (-not (Get-Command vcpkg -ErrorAction SilentlyContinue)) {
        Write-Error-Custom "vcpkg not found. Install from: https://vcpkg.io/en/getting-started.html"
    }
    
    # Check pnpm
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Error-Custom "pnpm not found. Install with: npm install -g pnpm"
    }
    
    # Check Visual Studio
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vsWhere)) {
        Write-Error-Custom "Visual Studio not found. Install Visual Studio 2022 with C++ development tools"
    }
    
    Write-Success "Prerequisites checked"
}

# Build engine
function Build-Engine {
    if ($BuildMode -eq 'dev') {
        Write-Info "Building C++ engine (Debug mode)..."
        $BuildType = 'Debug'
        $BuildDir = Join-Path $EngineDir "build"
    } else {
        Write-Info "Building C++ engine (Release mode)..."
        $BuildType = 'Release'
        $BuildDir = Join-Path $EngineDir "build-release"
    }
    
    # Get vcpkg root
    $VcpkgPath = Get-Command vcpkg | Select-Object -ExpandProperty Source
    $VcpkgRoot = Split-Path -Parent $VcpkgPath
    
    # Detect architecture
    $Arch = $env:PROCESSOR_ARCHITECTURE
    if ($Arch -eq 'AMD64') {
        $Triplet = 'x64-windows'
    } elseif ($Arch -eq 'ARM64') {
        $Triplet = 'arm64-windows'
    } else {
        $Triplet = 'x64-windows'
    }
    
    # Clean and create build directory
    if (Test-Path $BuildDir) {
        Remove-Item -Path $BuildDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    Push-Location $BuildDir
    
    try {
        # Configure CMake
        cmake -G "Visual Studio 17 2022" `
              -DCMAKE_BUILD_TYPE="$BuildType" `
              -DCMAKE_TOOLCHAIN_FILE="$VcpkgRoot/scripts/buildsystems/vcpkg.cmake" `
              -DVCPKG_TARGET_TRIPLET="$Triplet" `
              -DVCPKG_MANIFEST_MODE=OFF `
              -DVAYU_BUILD_TESTS=OFF `
              -DVAYU_BUILD_CLI=OFF `
              -DVAYU_BUILD_ENGINE=ON `
              ..
        
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configuration failed"
        }
        
        # Build
        $Cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
        cmake --build . --config $BuildType -j $Cores
        
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed"
        }
        
        Write-Success "Engine built successfully"
    }
    finally {
        Pop-Location
    }
}

# Build Electron app
function Build-Electron {
    Write-Info "Building Electron app..."
    Push-Location $AppDir
    
    try {
        # Install dependencies
        if (-not (Test-Path "node_modules")) {
            Write-Info "Installing dependencies..."
            pnpm install
        }
        
        if ($BuildMode -eq 'dev') {
            # Development mode - just compile TypeScript
            Write-Info "Compiling TypeScript..."
            pnpm run electron:compile
            Write-Success "Development build ready"
        } else {
            # Production mode - full build with packaging
            Write-Info "Compiling TypeScript..."
            pnpm run electron:compile
            
            Write-Info "Building React app..."
            pnpm run build
            
            # Copy engine binary to resources
            $ResourcesDir = Join-Path $AppDir "resources\bin"
            if (-not (Test-Path $ResourcesDir)) {
                New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
            }
            
            $EngineExe = Join-Path $EngineDir "build-release\Release\vayu-engine.exe"
            Copy-Item $EngineExe -Destination (Join-Path $ResourcesDir "vayu-engine.exe") -Force
            
            Write-Info "Packaging with electron-builder..."
            pnpm run electron:build
            
            Write-Success "Production build complete"
        }
    }
    finally {
        Pop-Location
    }
}

# Main execution
function Main {
    $StartTime = Get-Date
    
    Write-Host ""
    Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║   Vayu Build Script for Windows        ║" -ForegroundColor Cyan
    Write-Host "║   Mode: $($BuildMode.PadRight(30))║" -ForegroundColor Cyan
    Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
    
    Test-Prerequisites
    Build-Engine
    Build-Electron
    
    $EndTime = Get-Date
    $Elapsed = ($EndTime - $StartTime).TotalSeconds
    
    Write-Host ""
    Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "║   Build completed in $([int]$Elapsed)s              ║" -ForegroundColor Green
    Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    
    if ($BuildMode -eq 'dev') {
        Write-Host "🚀 To start the app in development mode:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "   cd app"
        Write-Host "   pnpm run electron:dev"
        Write-Host ""
        Write-Host "This will:"
        Write-Host "  • Start Vite dev server (React app on http://localhost:5173)"
        Write-Host "  • Launch Electron with the app"
        Write-Host "  • Auto-start the C++ engine sidecar"
        Write-Host ""
    } else {
        Write-Host "✅ Production build created:" -ForegroundColor Green
        Write-Host ""
        Write-Host "   app\release\Vayu Desktop Setup *.exe"
        Write-Host ""
        Write-Host "📦 To install:"
        Write-Host "  1. Run the installer"
        Write-Host "  2. Launch Vayu Desktop from the Start menu"
        Write-Host ""
    }
}

# Run main function
Main
