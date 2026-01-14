# Vayu Build Script for Windows
# Usage: .\build-windows.ps1 [dev|prod] [-SkipEngine] [-SkipApp] [-Clean]
# 
# This script builds the C++ engine and Electron app for Windows
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as NSIS installer

param(
    [Parameter(Position=0)]
    [ValidateSet('dev', 'prod')]
    [string]$BuildMode = 'prod',
    
    [switch]$SkipEngine,
    [switch]$SkipApp,
    [switch]$Clean
)

# Stop on first error
$ErrorActionPreference = "Stop"

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
    Write-Host "[OK] $Message" -ForegroundColor $SuccessColor
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[WARN] $Message" -ForegroundColor $WarnColor
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor $ErrorColor
    exit 1
}

# Paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$EngineDir = Join-Path $ProjectRoot "engine"
$AppDir = Join-Path $ProjectRoot "app"

# Find Visual Studio installation
function Find-VisualStudio {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    
    if (-not (Test-Path $vsWhere)) {
        return $null
    }
    
    $vsPath = & $vsWhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    return $vsPath
}

# Find CMake (check PATH first, then Visual Studio)
function Find-CMake {
    # Check if cmake is in PATH
    $cmakeCmd = Get-Command cmake -ErrorAction SilentlyContinue
    if ($cmakeCmd) {
        return $cmakeCmd.Source
    }
    
    # Try to find CMake in Visual Studio installation
    $vsPath = Find-VisualStudio
    if ($vsPath) {
        $vsCMake = Join-Path $vsPath "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
        if (Test-Path $vsCMake) {
            return $vsCMake
        }
    }
    
    # Common installation paths
    $commonPaths = @(
        "C:\Program Files\CMake\bin\cmake.exe",
        "C:\Program Files (x86)\CMake\bin\cmake.exe"
    )
    
    foreach ($path in $commonPaths) {
        if (Test-Path $path) {
            return $path
        }
    }
    
    return $null
}

# Find vcpkg root directory
function Find-VcpkgRoot {
    # Check environment variable first
    if ($env:VCPKG_ROOT -and (Test-Path $env:VCPKG_ROOT)) {
        return $env:VCPKG_ROOT
    }
    
    # Try to find vcpkg in PATH
    $vcpkgCmd = Get-Command vcpkg -ErrorAction SilentlyContinue
    if ($vcpkgCmd) {
        return Split-Path -Parent $vcpkgCmd.Source
    }
    
    # Common installation locations
    $vsPath = Find-VisualStudio
    $commonPaths = @(
        "C:\vcpkg",
        "C:\tools\vcpkg",
        "$env:USERPROFILE\vcpkg",
        "${env:ProgramFiles}\vcpkg"
    )
    
    # Add Visual Studio vcpkg path if VS is found
    if ($vsPath) {
        $commonPaths += Join-Path $vsPath "VC\vcpkg"
    }
    
    foreach ($path in $commonPaths) {
        if (Test-Path (Join-Path $path "vcpkg.exe")) {
            return $path
        }
    }
    
    return $null
}

# Check prerequisites
function Test-Prerequisites {
    Write-Info "Checking prerequisites..."
    
    $missing = @()
    
    # Check CMake
    $script:CMakePath = Find-CMake
    if (-not $CMakePath) {
        $missing += "cmake (https://cmake.org/download/)"
    } else {
        $cmakeVersion = & $CMakePath --version | Select-Object -First 1
        Write-Host "  CMake: $cmakeVersion ($CMakePath)" -ForegroundColor Gray
    }
    
    # Check Visual Studio
    $vsPath = Find-VisualStudio
    if (-not $vsPath) {
        $missing += "Visual Studio 2022 with C++ workload (https://visualstudio.microsoft.com/)"
    } else {
        Write-Host "  Visual Studio: $vsPath" -ForegroundColor Gray
    }
    
    # Check vcpkg
    $script:VcpkgRoot = Find-VcpkgRoot
    if (-not $VcpkgRoot) {
        $missing += "vcpkg (https://vcpkg.io/en/getting-started.html)"
    } else {
        Write-Host "  vcpkg: $VcpkgRoot" -ForegroundColor Gray
        # Fix mismatch warning
        $env:VCPKG_ROOT = $VcpkgRoot
    }
    
    # Check pnpm (only if building app)
    if (-not $SkipApp) {
        $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpmCmd) {
            $missing += "pnpm (npm install -g pnpm)"
        } else {
            $pnpmVersion = & pnpm --version
            Write-Host "  pnpm: $pnpmVersion" -ForegroundColor Gray
        }
    }
    
    if ($missing.Count -gt 0) {
        Write-Host ""
        Write-Host "Missing prerequisites:" -ForegroundColor Red
        foreach ($item in $missing) {
            Write-Host "  - $item" -ForegroundColor Red
        }
        Write-Host ""
        Write-Error-Custom "Please install the missing prerequisites and try again."
    }
    
    Write-Success "All prerequisites found"
}

# Install vcpkg dependencies
function Install-VcpkgDeps {
    Write-Info "Checking vcpkg dependencies..."
    
    $Triplet = "x64-windows"
    $deps = @(
        "curl[ssl]",
        "nlohmann-json",
        "cpp-httplib",
        "sqlite3",
        "sqlite-orm"
    )
    
    Push-Location $VcpkgRoot
    try {
        foreach ($dep in $deps) {
            $installed = & .\vcpkg.exe list "${dep}:${Triplet}" 2>$null
            if (-not $installed) {
                Write-Info "Installing $dep..."
                & .\vcpkg.exe install "${dep}:${Triplet}"
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to install $dep"
                }
            }
        }
        Write-Success "vcpkg dependencies ready"
    }
    finally {
        Pop-Location
    }
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
    
    # Detect architecture
    $Arch = $env:PROCESSOR_ARCHITECTURE
    if ($Arch -eq 'AMD64') {
        $Triplet = 'x64-windows'
        $CMakeArch = 'x64'
    } elseif ($Arch -eq 'ARM64') {
        $Triplet = 'arm64-windows'
        $CMakeArch = 'ARM64'
    } else {
        $Triplet = 'x64-windows'
        $CMakeArch = 'x64'
    }
    
    # Clean build directory if requested
    if ($Clean -and (Test-Path $BuildDir)) {
        Write-Info "Cleaning build directory..."
        Remove-Item -Path $BuildDir -Recurse -Force
    }
    
    # Create build directory
    if (-not (Test-Path $BuildDir)) {
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    }
    
    Push-Location $BuildDir
    
    try {
        # Configure CMake
        Write-Info "Configuring CMake..."
        
        $cmakeArgs = @(
            "-G", "Visual Studio 17 2022",
            "-A", $CMakeArch,
            "-DCMAKE_BUILD_TYPE=$BuildType",
            "-DCMAKE_TOOLCHAIN_FILE=$VcpkgRoot\scripts\buildsystems\vcpkg.cmake",
            "-DVCPKG_TARGET_TRIPLET=$Triplet",
            "-DVCPKG_MANIFEST_MODE=ON",
            "-DVAYU_BUILD_TESTS=OFF",
            "-DVAYU_BUILD_CLI=OFF",
            "-DVAYU_BUILD_ENGINE=ON",
            ".."
        )
        
        & $CMakePath @cmakeArgs
        
        if ($LASTEXITCODE -ne 0) {
            throw "CMake configuration failed with exit code $LASTEXITCODE"
        }
        
        # Build
        Write-Info "Building..."
        $Cores = [Environment]::ProcessorCount
        
        & $CMakePath --build . --config $BuildType --parallel $Cores
        
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed with exit code $LASTEXITCODE"
        }
        
        # Verify the binary was created
        $BinaryPath = Join-Path $BuildDir "$BuildType\vayu-engine.exe"
        if (-not (Test-Path $BinaryPath)) {
            throw "Build succeeded but binary not found at: $BinaryPath"
        }
        
        Write-Success "Engine built successfully: $BinaryPath"
        return $BinaryPath
    }
    finally {
        Pop-Location
    }
}

# Setup application icons
function Setup-Icons {
    Write-Info "Setting up application icons..."
    
    $IconPngDir = Join-Path $ProjectRoot "shared\icon_png"
    $IconIcoDir = Join-Path $ProjectRoot "shared\icon_ico"
    $BuildDir = Join-Path $AppDir "build"
    
    # Ensure build directory exists
    if (-not (Test-Path $BuildDir)) {
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    }
    
    # Copy PNG for Linux (256x256 is standard)
    $pngSource = Join-Path $IconPngDir "vayu_icon_256x256.png"
    if (Test-Path $pngSource) {
        Copy-Item $pngSource -Destination (Join-Path $BuildDir "icon.png") -Force
        Write-Host "    icon.png (Linux)" -ForegroundColor Gray
    }
    
    # For Windows - use the pre-made ICO file (256x256 is best for Windows)
    $icoSource = Join-Path $IconIcoDir "vayu_icon_256x256.ico"
    $icoPath = Join-Path $BuildDir "icon.ico"
    
    if (Test-Path $icoSource) {
        Copy-Item $icoSource -Destination $icoPath -Force
        Write-Host "    icon.ico (Windows)" -ForegroundColor Gray
    } elseif (Test-Path $IconPngDir) {
        # Fallback: create ICO from PNG using .NET
        Write-Host "    Creating icon.ico from PNG..." -ForegroundColor Gray
        $png256 = Join-Path $IconPngDir "vayu_icon_256x256.png"
        if (Test-Path $png256) {
            try {
                Add-Type -AssemblyName System.Drawing
                $png = [System.Drawing.Image]::FromFile($png256)
                $icon = [System.Drawing.Icon]::FromHandle(([System.Drawing.Bitmap]$png).GetHicon())
                $fs = [System.IO.FileStream]::new($icoPath, [System.IO.FileMode]::Create)
                $icon.Save($fs)
                $fs.Close()
                $icon.Dispose()
                $png.Dispose()
                Write-Host "    icon.ico (Windows - from PNG)" -ForegroundColor Gray
            }
            catch {
                Write-Warn "Failed to create .ico file: $_"
            }
        }
    } else {
        Write-Warn "No icon sources found in shared folder"
    }
    
    # For macOS .icns - electron-builder handles this from high-res PNG
    $icnsSource = Join-Path $IconPngDir "vayu_icon_512x512.png"
    if (Test-Path $icnsSource) {
        Copy-Item $icnsSource -Destination (Join-Path $BuildDir "icon.icns.png") -Force
        Write-Host "    icon.icns.png (macOS source)" -ForegroundColor Gray
    }
    
    # Copy all PNG icon sizes for electron-builder's icon set (Linux needs these)
    $iconSetDir = Join-Path $BuildDir "icons"
    if (-not (Test-Path $iconSetDir)) {
        New-Item -ItemType Directory -Path $iconSetDir -Force | Out-Null
    }
    
    if (Test-Path $IconPngDir) {
        Get-ChildItem -Path $IconPngDir -Filter "*.png" | ForEach-Object {
            Copy-Item $_.FullName -Destination $iconSetDir -Force
        }
        Write-Host "    icons/ folder (all PNG sizes)" -ForegroundColor Gray
    }
    
    Write-Success "Icons ready"
}

# Build Electron app
function Build-Electron {
    param([string]$EngineBinary)
    
    Write-Info "Building Electron app..."
    Push-Location $AppDir
    
    try {
        # Install dependencies
        if (-not (Test-Path "node_modules")) {
            Write-Info "Installing npm dependencies..."
            & pnpm install
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install npm dependencies"
            }
        }
        
        # Setup icons from shared folder
        Setup-Icons
        
        if ($BuildMode -eq 'dev') {
            # Development mode - just compile TypeScript
            Write-Info "Compiling TypeScript..."
            & pnpm run electron:compile
            if ($LASTEXITCODE -ne 0) {
                throw "TypeScript compilation failed"
            }
            Write-Success "Development build ready"
        } else {
            # Production mode - full build with packaging
            Write-Info "Compiling TypeScript..."
            & pnpm run electron:compile
            if ($LASTEXITCODE -ne 0) {
                throw "TypeScript compilation failed"
            }
            
            Write-Info "Building React app..."
            & pnpm run build
            if ($LASTEXITCODE -ne 0) {
                throw "React build failed"
            }
            
            # Copy engine binary to build/resources (output folder)
            $ResourcesDir = Join-Path $AppDir "build\resources\bin"
            if (-not (Test-Path $ResourcesDir)) {
                New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
            }
            
            Write-Host "    Engine binary path: $EngineBinary" -ForegroundColor Gray
            Write-Host "    Resources dir: $ResourcesDir" -ForegroundColor Gray
            
            if ($EngineBinary -and (Test-Path $EngineBinary)) {
                Write-Info "Copying engine binary to resources..."
                Copy-Item $EngineBinary -Destination (Join-Path $ResourcesDir "vayu-engine.exe") -Force
                
                # Copy required DLLs from the same directory as the engine binary
                $BinaryDir = Split-Path -Parent $EngineBinary
                $requiredDlls = Get-ChildItem -Path $BinaryDir -Filter "*.dll" -ErrorAction SilentlyContinue
                if ($requiredDlls) {
                    Write-Info "Copying runtime DLLs..."
                    foreach ($dll in $requiredDlls) {
                        Write-Host "    $($dll.Name)" -ForegroundColor Gray
                        Copy-Item $dll.FullName -Destination $ResourcesDir -Force
                    }
                }
                
                # Verify files were copied
                $copiedFiles = Get-ChildItem -Path $ResourcesDir -ErrorAction SilentlyContinue
                if ($copiedFiles) {
                    Write-Host "    Verified $($copiedFiles.Count) files in resources" -ForegroundColor Gray
                } else {
                    Write-Warn "No files found in resources after copy!"
                }
            } else {
                Write-Warn "Engine binary not found at: $EngineBinary, skipping copy"
            }
            
            Write-Info "Packaging with electron-builder..."
            Write-Host "  NOTE: If you see symlink errors, enable Developer Mode in Windows Settings" -ForegroundColor Yellow
            Write-Host "        (Settings -> For Developers -> Developer Mode ON)" -ForegroundColor Yellow
            
            # Use electron:pack which only runs electron-builder (doesn't rebuild)
            & pnpm run electron:pack
            if ($LASTEXITCODE -ne 0) {
                throw "Electron packaging failed"
            }
            
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
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host "         Vayu Build Script for Windows                  " -ForegroundColor Cyan
    Write-Host "         Mode: $($BuildMode.ToUpper())                  " -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host ""
    
    Test-Prerequisites
    
    $EngineBinary = $null
    
    if (-not $SkipEngine) {
        # Install-VcpkgDeps # Rely on manifest mode in CMake
        $EngineBinary = Build-Engine
    } else {
        Write-Warn "Skipping engine build"
        # Try to find existing binary
        if ($BuildMode -eq 'prod') {
            $EngineBinary = Join-Path $EngineDir "build-release\Release\vayu-engine.exe"
        } else {
            $EngineBinary = Join-Path $EngineDir "build\Debug\vayu-engine.exe"
        }
    }
    
    if (-not $SkipApp) {
        Build-Electron -EngineBinary $EngineBinary
    } else {
        Write-Warn "Skipping app build"
    }
    
    $EndTime = Get-Date
    $Elapsed = [math]::Round(($EndTime - $StartTime).TotalSeconds)
    
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host "   Build completed successfully in ${Elapsed}s          " -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
    Write-Host ""
    
    if ($BuildMode -eq 'dev') {
        Write-Host "To start the app in development mode:" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "   cd app"
        Write-Host "   pnpm run electron:dev"
        Write-Host ""
        Write-Host "This will:"
        Write-Host "  - Start Vite dev server (React app on http://localhost:5173)"
        Write-Host "  - Launch Electron with the app"
        Write-Host "  - Auto-start the C++ engine sidecar"
        Write-Host ""
    } else {
        Write-Host "Production build created:" -ForegroundColor Green
        Write-Host ""
        $releaseDir = Join-Path $AppDir "release"
        if (Test-Path $releaseDir) {
            Get-ChildItem $releaseDir -Filter "*.exe" | ForEach-Object {
                Write-Host "   $($_.FullName)" -ForegroundColor White
            }
        }
        Write-Host ""
        Write-Host "To install:"
        Write-Host "  1. Run the installer"
        Write-Host "  2. Launch Vayu Desktop from the Start menu"
        Write-Host ""
    }
}

# Run main function
try {
    Main
}
catch {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host "   Build failed!                                        " -ForegroundColor Red
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Stack trace:" -ForegroundColor Gray
    Write-Host $_.ScriptStackTrace -ForegroundColor Gray
    exit 1
}
