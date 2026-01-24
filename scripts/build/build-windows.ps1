# Vayu Build Script for Windows
# Usage: .\build-windows.ps1 [dev|prod] [-Engine|-App] [-Clean]
# 
# This script builds the C++ engine and Electron app for Windows
# - dev:  Development build with debug symbols
# - prod: Production build optimized and packaged as NSIS installer
#
# Quick aliases:
#   .\build-windows.ps1 -e         # Build only engine (prod)
#   .\build-windows.ps1 -a         # Build only app (prod)
#   .\build-windows.ps1 dev -e     # Build only engine (dev)
#   .\build-windows.ps1 dev -a     # Build only app (dev)

param(
    [Parameter(Position = 0)]
    [ValidateSet('dev', 'prod')]
    [string]$BuildMode = 'prod',
    
    # Component selection aliases
    [Alias('e', 'EngineOnly')]
    [switch]$Engine,
    
    [Alias('a', 'AppOnly')]
    [switch]$App,
    
    # Skip flags (for backwards compatibility)
    [switch]$SkipEngine,
    [switch]$SkipApp,
    
    [Alias('c')]
    [switch]$Clean,
    
    [Alias('t')]
    [switch]$WithTests,
    
    [Alias('v')]
    [switch]$VerboseOutput,

    [Alias('h')]
    [switch]$Help,

    # CI/override parameters
    [string]$CMakePathParam,
    [string]$VcpkgRootParam,
    [string]$EngineDirParam,
    [string]$AppDirParam,
    [string]$ArtifactsDirParam,
    [string]$GeneratorParam = 'Visual Studio 17 2022'
)

# Stop on first error
$ErrorActionPreference = 'Stop'

# Print help/usage if requested
if ($Help) {
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Vayu Build Script for Windows' -ForegroundColor Cyan
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Usage: .\build-windows.ps1 [dev|prod] [-Engine|-App] [OPTIONS]' -ForegroundColor White
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Build Mode:' -ForegroundColor Cyan
    Write-Host '  dev                 Development build (Debug mode)' -ForegroundColor White
    Write-Host '  prod                Production build (Release mode, default)' -ForegroundColor White
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Component Selection:' -ForegroundColor Cyan
    Write-Host '  -Engine, -e         Build only the C++ engine' -ForegroundColor White
    Write-Host '  -App, -a            Build only the Electron app' -ForegroundColor White
    Write-Host '  (no flag)           Build both engine and app' -ForegroundColor White
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Other Options:' -ForegroundColor Cyan
    Write-Host '  -Clean, -c          Clean build directories before building' -ForegroundColor White
    Write-Host '  -WithTests, -t      Build and run unit tests (for CI)' -ForegroundColor White
    Write-Host '  -VerboseOutput, -v  Show detailed output when build fails' -ForegroundColor White
    Write-Host '  -Help, -h           Show this help message' -ForegroundColor White
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'CI/Advanced Options:' -ForegroundColor Cyan
    Write-Host '  -VcpkgRootParam <path>     Override vcpkg root directory' -ForegroundColor White
    Write-Host '  -ArtifactsDirParam <path>  Copy build artifacts to this directory' -ForegroundColor White
    Write-Host '  -CMakePathParam <path>     Override CMake executable path' -ForegroundColor White
    Write-Host '  -EngineDirParam <path>     Override engine directory' -ForegroundColor White
    Write-Host '  -AppDirParam <path>        Override app directory' -ForegroundColor White
    Write-Host '  -GeneratorParam <name>     Override CMake generator (default: Visual Studio 17 2022)' -ForegroundColor White
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Legacy flags (still supported):' -ForegroundColor Gray
    Write-Host '  -SkipEngine         Same as -App (build app only)' -ForegroundColor Gray
    Write-Host '  -SkipApp            Same as -Engine (build engine only)' -ForegroundColor Gray
    Write-Host '' -ForegroundColor Cyan
    Write-Host 'Examples:' -ForegroundColor Yellow
    Write-Host '  .\build-windows.ps1                        # Build all (prod)' -ForegroundColor White
    Write-Host '  .\build-windows.ps1 dev                    # Build all (dev)' -ForegroundColor White
    Write-Host '  .\build-windows.ps1 -e                     # Build engine only (prod)' -ForegroundColor White
    Write-Host '  .\build-windows.ps1 dev -e                 # Build engine only (dev)' -ForegroundColor White
    Write-Host '  .\build-windows.ps1 -a                     # Build app only (prod)' -ForegroundColor White
    Write-Host '  .\build-windows.ps1 -e -t                  # Build engine + run tests' -ForegroundColor White
    Write-Host '  .\build-windows.ps1 -a -c                  # Build app only, clean first' -ForegroundColor White
    Write-Host '' -ForegroundColor Cyan
    exit 0
}

# Handle component selection aliases
# -Engine/-e means build engine only (skip app)
# -App/-a means build app only (skip engine)
if ($Engine) {
    $SkipApp = $true
}
if ($App) {
    $SkipEngine = $true
}

# Colors for output
$ErrorColor = 'Red'
$SuccessColor = 'Green'
$InfoColor = 'Cyan'
$WarnColor = 'Yellow'
$DetailColor = 'DarkGray'

# Step counter for progress tracking
$script:CurrentStep = 0
$script:TotalSteps = 0

function Write-Info {
    param([string]$Message)
    Write-Host '  ' -NoNewline
    Write-Host '>' -ForegroundColor $InfoColor -NoNewline
    Write-Host " $Message"
}

function Write-Detail {
    param([string]$Message)
    Write-Host "    $Message" -ForegroundColor $DetailColor
}

function Write-Success {
    param([string]$Message)
    Write-Host '  ' -NoNewline
    Write-Host '+' -ForegroundColor $SuccessColor -NoNewline
    Write-Host " $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Host '  ' -NoNewline
    Write-Host '!' -ForegroundColor $WarnColor -NoNewline
    Write-Host " $Message" -ForegroundColor $WarnColor
}

function Write-Error-Custom {
    param([string]$Message)
    Write-Host '  ' -NoNewline
    Write-Host 'X' -ForegroundColor $ErrorColor -NoNewline
    Write-Host " $Message" -ForegroundColor $ErrorColor
    exit 1
}

function Write-Step {
    param([string]$Message)
    $script:CurrentStep++
    Write-Host ''
    Write-Host "[$script:CurrentStep/$script:TotalSteps] " -ForegroundColor $InfoColor -NoNewline
    Write-Host $Message -ForegroundColor White
    Write-Host ('-' * 60) -ForegroundColor $DetailColor
}

# Paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$EngineDir = Join-Path $ProjectRoot 'engine'
$AppDir = Join-Path $ProjectRoot 'app'

# Override paths if provided (useful for CI)
if ($EngineDirParam) {
    $EngineDir = $EngineDirParam
    Write-Host "Using overridden EngineDir: $EngineDir" -ForegroundColor Gray
}
if ($AppDirParam) {
    $AppDir = $AppDirParam
    Write-Host "Using overridden AppDir: $AppDir" -ForegroundColor Gray
}

# Find Visual Studio installation
function Find-VisualStudio {
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    
    if (-not (Test-Path $vsWhere)) {
        return $null
    }
    
    # Check specifically for VC++ tools
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
        $vsCMake = Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
        if (Test-Path $vsCMake) {
            return $vsCMake
        }
    }
    
    # Common installation paths
    $commonPaths = @(
        'C:\Program Files\CMake\bin\cmake.exe',
        'C:\Program Files (x86)\CMake\bin\cmake.exe'
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
        'C:\vcpkg',
        'C:\tools\vcpkg',
        "$env:USERPROFILE\vcpkg",
        "${env:ProgramFiles}\vcpkg"
    )
    
    # Add Visual Studio vcpkg path if VS is found
    if ($vsPath) {
        $commonPaths += Join-Path $vsPath 'VC\vcpkg'
    }
    
    foreach ($path in $commonPaths) {
        if (Test-Path (Join-Path $path 'vcpkg.exe')) {
            return $path
        }
    }
    
    return $null
}

# Check prerequisites
function Test-Prerequisites {
    $missing = @()
    
    # Check CMake - allow override from parameter
    if ($CMakePathParam) {
        $script:CMakePath = $CMakePathParam
        Write-Detail "CMake: $script:CMakePath (override)"
    }
    else {
        $script:CMakePath = Find-CMake
    }
    if (-not $CMakePath) {
        $missing += 'cmake (https://cmake.org/download/)'
    }
    else {
        $cmakeVersion = & $CMakePath --version | Select-Object -First 1
        Write-Detail "CMake: $cmakeVersion"
    }
    
    # Check Visual Studio
    $vsPath = Find-VisualStudio
    if (-not $vsPath) {
        $missing += 'Visual Studio 2022 with C++ workload (https://visualstudio.microsoft.com/)'
    }
    else {
        Write-Detail "Visual Studio: $vsPath"
    }
    
    # Check vcpkg - allow override from parameter
    if ($VcpkgRootParam) {
        $script:VcpkgRoot = $VcpkgRootParam
        Write-Detail "vcpkg: $script:VcpkgRoot (override)"
    }
    else {
        $script:VcpkgRoot = Find-VcpkgRoot
    }
    if (-not $VcpkgRoot) {
        $missing += 'vcpkg (https://vcpkg.io/en/getting-started.html)'
    }
    else {
        Write-Detail "vcpkg: $VcpkgRoot"
        # Fix mismatch warning by ensuring environment var is set for the session
        $env:VCPKG_ROOT = $VcpkgRoot
    }
    
    # Check pnpm (only if building app)
    if (-not $SkipApp) {
        $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
        if (-not $pnpmCmd) {
            $missing += 'pnpm (npm install -g pnpm)'
        }
        else {
            $pnpmVersion = & pnpm --version
            Write-Detail "pnpm: $pnpmVersion"
        }
    }
    
    if ($missing.Count -gt 0) {
        Write-Host ''
        foreach ($item in $missing) {
            Write-Host '    ' -NoNewline
            Write-Host 'X' -ForegroundColor Red -NoNewline
            Write-Host " Missing: $item" -ForegroundColor Red
        }
        Write-Error-Custom 'Please install missing prerequisites and try again.'
    }
    
    Write-Success 'All prerequisites found'
}

# Build engine
function Build-Engine {
    if ($BuildMode -eq 'dev') {
        Write-Detail 'Build type: Debug'
        $BuildType = 'Debug'
        $BuildDir = Join-Path $EngineDir 'build'
    }
    else {
        Write-Detail 'Build type: Release'
        $BuildType = 'Release'
        $BuildDir = Join-Path $EngineDir 'build-release'
    }
    
    # Detect architecture
    $Arch = $env:PROCESSOR_ARCHITECTURE
    if ($Arch -eq 'AMD64') {
        $Triplet = 'x64-windows'
        $CMakeArch = 'x64'
    }
    elseif ($Arch -eq 'ARM64') {
        $Triplet = 'arm64-windows'
        $CMakeArch = 'ARM64'
    }
    else {
        $Triplet = 'x64-windows'
        $CMakeArch = 'x64'
    }
    
    # Clean build directory if requested
    if ($Clean -and (Test-Path $BuildDir)) {
        Write-Info 'Cleaning build directory...'
        Remove-Item -Path $BuildDir -Recurse -Force
    }
    
    # Create build directory
    if (-not (Test-Path $BuildDir)) {
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    }
    
    Push-Location $BuildDir
    
    try {
        # Configure CMake
        Write-Info "Configuring CMake (Generator: $GeneratorParam)..."
        
        # Determine test flag
        $TestsFlag = if ($WithTests) { 'ON' } else { 'OFF' }
        
        $cmakeArgs = @(
            '-G', $GeneratorParam,
            '-A', $CMakeArch,
            "-DCMAKE_BUILD_TYPE=$BuildType",
            "-DCMAKE_TOOLCHAIN_FILE=$VcpkgRoot\scripts\buildsystems\vcpkg.cmake",
            "-DVCPKG_TARGET_TRIPLET=$Triplet",
            '-DVCPKG_MANIFEST_MODE=ON',
            "-DVAYU_BUILD_TESTS=$TestsFlag",
            '-DVAYU_BUILD_CLI=OFF',
            '-DVAYU_BUILD_ENGINE=ON',
            $EngineDir
        )
        
        if ($VerboseOutput) {
            # In verbose mode, show all output
            $cmakeOutput = & $CMakePath @cmakeArgs 2>&1 | Tee-Object -Variable cmakeOutputVar
        }
        else {
            # In normal mode, capture output silently
            $cmakeOutputVar = & $CMakePath @cmakeArgs 2>&1
        }
        
        if ($LASTEXITCODE -ne 0) {
            if ($VerboseOutput) {
                Write-Host ''
                Write-Host '========================================================' -ForegroundColor Red
                Write-Host '   CMake Configuration Failed!                         ' -ForegroundColor Red
                Write-Host '========================================================' -ForegroundColor Red
                Write-Host ''
                Write-Host 'CMake output:' -ForegroundColor Yellow
                Write-Host $cmakeOutputVar -ForegroundColor Red
                Write-Host ''
            }
            throw "CMake configuration failed with exit code $LASTEXITCODE"
        }
        
        # Build
        Write-Info 'Building...'
        $Cores = [Environment]::ProcessorCount
        
        # Capture build output
        $buildOutputVar = @()
        if ($VerboseOutput) {
            # In verbose mode, show output in real-time and capture it
            & $CMakePath --build . --config $BuildType --parallel $Cores 2>&1 | ForEach-Object {
                # Display output in real-time
                Write-Host $_
                # Capture for error analysis
                $buildOutputVar += $_
            }
        }
        else {
            # In normal mode, capture silently
            $buildOutputVar = & $CMakePath --build . --config $BuildType --parallel $Cores 2>&1
        }
        
        if ($LASTEXITCODE -ne 0) {
            if ($VerboseOutput) {
                Write-Host ''
                Write-Host '========================================================' -ForegroundColor Red
                Write-Host '   Build Failed!                                      ' -ForegroundColor Red
                Write-Host '========================================================' -ForegroundColor Red
                Write-Host ''
                
                # Extract and highlight error lines
                $errorLines = $buildOutputVar | Where-Object { 
                    $_ -match 'error|Error|ERROR|failed|Failed|FAILED' 
                }
                
                if ($errorLines.Count -gt 0) {
                    Write-Host "Error summary (lines containing 'error' or 'failed'):" -ForegroundColor Yellow
                    Write-Host ''
                    foreach ($line in $errorLines) {
                        Write-Host $line -ForegroundColor Red
                    }
                    Write-Host ''
                }
                
                # Show last 50 lines for context
                Write-Host 'Last 50 lines of build output:' -ForegroundColor Yellow
                Write-Host ''
                $lastLines = $buildOutputVar | Select-Object -Last 50
                foreach ($line in $lastLines) {
                    if ($line -match 'error|Error|ERROR|failed|Failed|FAILED') {
                        Write-Host $line -ForegroundColor Red
                    }
                    else {
                        Write-Host $line -ForegroundColor Gray
                    }
                }
                Write-Host ''
            }
            throw "Build failed with exit code $LASTEXITCODE"
        }
        
        # Verify the binary was created
        $BinaryPath = Join-Path $BuildDir "$BuildType\vayu-engine.exe"
        if (-not (Test-Path $BinaryPath)) {
            throw "Build succeeded but binary not found at: $BinaryPath"
        }
        
        Write-Success "Engine built successfully: $BinaryPath"
        
        # Run tests if enabled
        if ($WithTests) {
            Write-Info 'Running unit tests...'
            $ctestOutput = & ctest --test-dir $BuildDir --build-config $BuildType --output-on-failure 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Host $ctestOutput -ForegroundColor Red
                throw "Unit tests failed with exit code $LASTEXITCODE"
            }
            Write-Success 'All unit tests passed'
        }
        
        return $BinaryPath
    }
    finally {
        Pop-Location
    }
}

# Setup application icons
function Setup-Icons {
    Write-Info 'Setting up application icons...'
    
    $IconPngDir = Join-Path $ProjectRoot 'shared\icon_png'
    $IconIcoDir = Join-Path $ProjectRoot 'shared\icon_ico'
    $BuildDir = Join-Path $AppDir 'build'
    
    # Ensure build directory exists
    if (-not (Test-Path $BuildDir)) {
        New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    }
    
    # Copy PNG for Linux (256x256 is standard)
    $pngSource = Join-Path $IconPngDir 'vayu_icon_256x256.png'
    if (Test-Path $pngSource) {
        Copy-Item $pngSource -Destination (Join-Path $BuildDir 'icon.png') -Force
        Write-Host '    icon.png (Linux)' -ForegroundColor Gray
    }
    
    # For Windows - use the pre-made ICO file (256x256 is best for Windows)
    $icoSource = Join-Path $IconIcoDir 'vayu_icon_256x256.ico'
    $icoPath = Join-Path $BuildDir 'icon.ico'
    
    if (Test-Path $icoSource) {
        Copy-Item $icoSource -Destination $icoPath -Force
        Write-Host '    icon.ico (Windows)' -ForegroundColor Gray
    }
    elseif (Test-Path $IconPngDir) {
        # Fallback: create ICO from PNG using .NET
        Write-Host '    Creating icon.ico from PNG...' -ForegroundColor Gray
        $png256 = Join-Path $IconPngDir 'vayu_icon_256x256.png'
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
                Write-Host '    icon.ico (Windows - from PNG)' -ForegroundColor Gray
            }
            catch {
                Write-Warn "Failed to create .ico file: $_"
            }
        }
    }
    else {
        Write-Warn 'No icon sources found in shared folder'
    }
    
    # For macOS .icns - electron-builder handles this from high-res PNG
    $icnsSource = Join-Path $IconPngDir 'vayu_icon_512x512.png'
    if (Test-Path $icnsSource) {
        Copy-Item $icnsSource -Destination (Join-Path $BuildDir 'icon.icns.png') -Force
        Write-Host '    icon.icns.png (macOS source)' -ForegroundColor Gray
    }
    
    # Copy all PNG icon sizes for electron-builder's icon set (Linux needs these)
    $iconSetDir = Join-Path $BuildDir 'icons'
    if (-not (Test-Path $iconSetDir)) {
        New-Item -ItemType Directory -Path $iconSetDir -Force | Out-Null
    }
    
    if (Test-Path $IconPngDir) {
        Get-ChildItem -Path $IconPngDir -Filter '*.png' | ForEach-Object {
            Copy-Item $_.FullName -Destination $iconSetDir -Force
        }
        Write-Host '    icons/ folder (all PNG sizes)' -ForegroundColor Gray
    }
    
    Write-Success 'Icons ready'
}

# Build Electron app
function Build-Electron {
    param([string]$EngineBinary)
    
    Write-Info 'Building Electron app...'
    Push-Location $AppDir
    
    try {
        # Install dependencies
        if (-not (Test-Path 'node_modules')) {
            Write-Info 'Installing npm dependencies...'
            & pnpm install
            if ($LASTEXITCODE -ne 0) {
                throw 'Failed to install npm dependencies'
            }
        }
        
        # Setup icons from shared folder
        Setup-Icons
        
        if ($BuildMode -eq 'dev') {
            # Development mode - just compile TypeScript
            Write-Info 'Compiling TypeScript...'
            & pnpm run electron:compile
            if ($LASTEXITCODE -ne 0) {
                throw 'TypeScript compilation failed'
            }
            Write-Success 'Development build ready'
        }
        else {
            # Production mode - full build with packaging
            Write-Info 'Compiling TypeScript...'
            & pnpm run electron:compile
            if ($LASTEXITCODE -ne 0) {
                throw 'TypeScript compilation failed'
            }
            
            Write-Info 'Building React app...'
            & pnpm run build
            if ($LASTEXITCODE -ne 0) {
                throw 'React build failed'
            }
            
            # Copy engine binary to build/resources (output folder)
            $ResourcesDir = Join-Path $AppDir 'build\resources\bin'
            if (-not (Test-Path $ResourcesDir)) {
                New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null
            }
            
            Write-Host "    Engine binary path: $EngineBinary" -ForegroundColor Gray
            Write-Host "    Resources dir: $ResourcesDir" -ForegroundColor Gray
            
            if ($EngineBinary -and (Test-Path $EngineBinary)) {
                Write-Info 'Copying engine binary to resources...'
                Copy-Item $EngineBinary -Destination (Join-Path $ResourcesDir 'vayu-engine.exe') -Force
                
                # Copy required DLLs from the same directory as the engine binary
                $BinaryDir = Split-Path -Parent $EngineBinary
                $requiredDlls = Get-ChildItem -Path $BinaryDir -Filter '*.dll' -ErrorAction SilentlyContinue
                if ($requiredDlls) {
                    Write-Info 'Copying runtime DLLs...'
                    foreach ($dll in $requiredDlls) {
                        Write-Host "    $($dll.Name)" -ForegroundColor Gray
                        Copy-Item $dll.FullName -Destination $ResourcesDir -Force
                    }
                }
                
                # Verify files were copied
                $copiedFiles = Get-ChildItem -Path $ResourcesDir -ErrorAction SilentlyContinue
                if ($copiedFiles) {
                    Write-Host "    Verified $($copiedFiles.Count) files in resources" -ForegroundColor Gray
                }
                else {
                    Write-Warn 'No files found in resources after copy!'
                }
            }
            else {
                Write-Warn "Engine binary not found at: $EngineBinary, skipping copy"
            }
            
            Write-Info 'Packaging with electron-builder...'
            Write-Host '  NOTE: If you see symlink errors, enable Developer Mode in Windows Settings' -ForegroundColor Yellow
            
            # Use electron:pack which only runs electron-builder (doesn't rebuild)
            & pnpm run electron:pack
            if ($LASTEXITCODE -ne 0) {
                throw 'Electron packaging failed'
            }

            # If artifacts dir provided, copy installers there for CI
            if ($ArtifactsDirParam) {
                $releaseDir = Join-Path $AppDir 'release'
                if (Test-Path $releaseDir) {
                    if (-not (Test-Path $ArtifactsDirParam)) {
                        New-Item -ItemType Directory -Path $ArtifactsDirParam -Force | Out-Null
                    }
                    Write-Info "Copying installer artifacts to: $ArtifactsDirParam"
                    Get-ChildItem -Path $releaseDir -Filter '*.*' | ForEach-Object {
                        Copy-Item $_.FullName -Destination $ArtifactsDirParam -Force
                    }
                }
                else {
                    Write-Warn "Release directory not found: $releaseDir"
                }
            }
            
            Write-Success 'Production build complete'
        }
    }
    finally {
        Pop-Location
    }
}

# Main execution
function Main {
    $StartTime = Get-Date
    
    # Determine what we're building and set total steps
    $BuildComponents = @()
    $script:TotalSteps = 1  # Prerequisites always counted
    if (-not $SkipEngine) {
        $BuildComponents += 'Engine'
        $script:TotalSteps++
    }
    if (-not $SkipApp) {
        $BuildComponents += 'App'
        $script:TotalSteps++
    }
    $ComponentsStr = $BuildComponents -join ' + '
    if ($BuildComponents.Count -eq 0) {
        Write-Host 'Nothing to build! Use -h for help.' -ForegroundColor Red
        exit 1
    }
    
    Write-Host ''
    Write-Host ('  ' + ('=' * 38)) -ForegroundColor Cyan
    Write-Host '  =  VAYU BUILD SCRIPT             =' -ForegroundColor Cyan
    Write-Host '  =  Platform: Windows             =' -ForegroundColor Cyan
    Write-Host ('  ' + ('=' * 38)) -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Mode: ' -ForegroundColor DarkGray -NoNewline
    Write-Host $BuildMode.ToUpper() -ForegroundColor White -NoNewline
    Write-Host '  |  ' -ForegroundColor DarkGray -NoNewline
    Write-Host 'Components: ' -ForegroundColor DarkGray -NoNewline
    Write-Host $ComponentsStr -ForegroundColor White
    
    # Step 1: Prerequisites
    Write-Step 'Checking Prerequisites'
    Test-Prerequisites
    
    $EngineBinary = $null
    
    if (-not $SkipEngine) {
        Write-Step 'Building C++ Engine'
        $EngineBinary = Build-Engine
    }
    else {
        Write-Warn 'Skipping engine build'
        # Try to find existing binary
        if ($BuildMode -eq 'prod') {
            $EngineBinary = Join-Path $EngineDir 'build-release\Release\vayu-engine.exe'
        }
        else {
            $EngineBinary = Join-Path $EngineDir 'build\Debug\vayu-engine.exe'
        }
        if (Test-Path $EngineBinary) {
            Write-Info "Using existing engine binary: $EngineBinary"
        }
    }
    
    if (-not $SkipApp) {
        Write-Step 'Building Electron App'
        Build-Electron -EngineBinary $EngineBinary
    }
    else {
        Write-Warn 'Skipping app build'
    }
    
    $EndTime = Get-Date
    $Elapsed = [math]::Round(($EndTime - $StartTime).TotalSeconds)
    
    Write-Host ''
    Write-Host ('  ' + ('=' * 38)) -ForegroundColor Green
    Write-Host '  =  BUILD SUCCESSFUL              =' -ForegroundColor Green
    Write-Host ('  ' + ('=' * 38)) -ForegroundColor Green
    Write-Host ''
    Write-Host '  Total time: ' -ForegroundColor DarkGray -NoNewline
    Write-Host "${Elapsed}s" -ForegroundColor White
    Write-Host ''
    
    if ($BuildMode -eq 'dev') {
        # Calculate relative path to app dir from current location for easy copy-paste
        $RelativeAppPath = Resolve-Path -Path $AppDir -Relative
        
        Write-Host '  Next Steps:' -ForegroundColor White
        Write-Host ('  ' + ('-' * 38)) -ForegroundColor DarkGray
        Write-Host '  To start the Electron app in development mode:'
        Write-Host ''
        Write-Host "  cd $RelativeAppPath; pnpm run electron:dev" -ForegroundColor Cyan
        Write-Host ''
    }
    else {
        Write-Host '  Build Artifacts:' -ForegroundColor White
        Write-Host ('  ' + ('-' * 38)) -ForegroundColor DarkGray
        $releaseDir = Join-Path $AppDir 'release'
        $installerPaths = @()
        if (Test-Path $releaseDir) {
            $installers = Get-ChildItem $releaseDir -Filter '*.exe'
            foreach ($installer in $installers) {
                Write-Host '  ' -NoNewline
                Write-Host '+' -ForegroundColor Green -NoNewline
                Write-Host " $($installer.FullName)"
                $installerPaths += $installer.FullName
            }
        }
        Write-Host ''
        Write-Host '  Installation:' -ForegroundColor White
        Write-Host ('  ' + ('-' * 38)) -ForegroundColor DarkGray
        if ($installerPaths.Count -gt 0) {
            Write-Host '  1. Run the installer:'
            foreach ($path in $installerPaths) {
                Write-Host '     ' -NoNewline
                Write-Host "'$path'" -ForegroundColor Cyan
            }
        }
        else {
            Write-Host '  1. Run the generated installer in the release directory.'
        }
        Write-Host '  2. Launch ' -NoNewline
        Write-Host 'Vayu' -ForegroundColor White -NoNewline
        Write-Host ' from Desktop or Start menu.'
        Write-Host ''
    }
}

# Run main function
try {
    Main
}
catch {
    Write-Host ''
    Write-Host ('  ' + ('=' * 38)) -ForegroundColor Red
    Write-Host '  =  BUILD FAILED                  =' -ForegroundColor Red
    Write-Host ('  ' + ('=' * 38)) -ForegroundColor Red
    Write-Host ''
    Write-Host "  Error: $_" -ForegroundColor Red
    Write-Host ''
    Write-Host '  Stack trace:' -ForegroundColor DarkGray
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
}