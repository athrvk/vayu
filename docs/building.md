# Building Vayu

This guide covers building Vayu on all platforms (macOS, Linux, Windows).

## Quick Start

```bash
# Clone the repository
git clone https://github.com/athrvk/vayu.git
cd vayu

# Development build
python build.py --dev

# Start the app
cd app && pnpm run electron:dev
```

## Prerequisites

### All Platforms

- **Node.js** v20+ with pnpm
- **CMake** v3.25+
- **Ninja** build system
- **vcpkg** package manager

### Platform-Specific

**macOS:**
```bash
xcode-select --install
brew install cmake ninja vcpkg pnpm
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install build-essential cmake ninja-build git curl

# Install vcpkg
git clone https://github.com/Microsoft/vcpkg.git ~/vcpkg
cd ~/vcpkg
./bootstrap-vcpkg.sh
export VCPKG_ROOT=~/vcpkg

# Install pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs
npm install -g pnpm
```

**Windows:**
- **Visual Studio 2022** with "Desktop development with C++" workload
- **vcpkg**:
  ```powershell
  git clone https://github.com/Microsoft/vcpkg.git C:\vcpkg
  cd C:\vcpkg
  .\bootstrap-vcpkg.bat
  ```
- **Node.js** from [nodejs.org](https://nodejs.org/)
- **pnpm**: `npm install -g pnpm`

**Note:** On Windows, the script auto-detects CMake and vcpkg bundled with Visual Studio.

## Build Script Usage

The `build.py` script works identically on all platforms.

### Basic Commands

```bash
# Show help
python build.py --help

# Development build (engine + app)
python build.py --dev

# Production build (engine + app, packaged)
python build.py
```

### Build Options

| Option | Description |
|--------|-------------|
| `--dev` | Development build (Debug mode) |
| `--prod` | Production build (Release mode, default) |
| `-e, --engine-only` | Build only the C++ engine |
| `-a, --app-only` | Build only the Electron app |
| `-c, --clean` | Clean build directories before building |
| `-t, --tests` | Build and run unit tests |
| `--test-only` | Run tests without rebuilding |
| `-v, --verbose` | Show detailed build output |
| `-h, --help` | Show help message |

### Examples

```bash
# Full development build
python build.py --dev

# Production build, app only (use existing engine)
python build.py -a

# Clean production build
python build.py -c

# Build engine with tests
python build.py -e -t

# Quick test iteration
python build.py --test-only

# Verbose build (for debugging)
python build.py -v
```

## Development Workflow

### 1. Initial Build

```bash
python build.py --dev
```

This will:
- Build the C++ engine in debug mode
- Install app dependencies via pnpm
- Set up the development environment

### 2. Running the App

```bash
cd app
pnpm run electron:dev
```

This starts:
1. **Vite dev server** (React app on http://localhost:5173)
2. **TypeScript compiler** (watches electron/ folder)
3. **Electron** (launches the app)
4. **C++ Engine** (auto-started by sidecar)

### 3. Making Changes

**Frontend Changes (React/TypeScript):**
- Edit files in `app/src/`
- Vite will hot-reload automatically

**Electron Main Process Changes:**
- Edit files in `app/electron/`
- TypeScript compiler will rebuild
- Restart Electron manually

**C++ Engine Changes:**
- Edit files in `engine/src/`
- Rebuild: `python build.py --dev -e`
- Restart the Electron app

## Production Build

### Building

```bash
python build.py
```

This will:
1. Build C++ engine in Release mode
2. Copy engine binary to app resources
3. Install app dependencies
4. Compile TypeScript for Electron
5. Build React app with Vite
6. Package with electron-builder

### Output

Production builds are created in `app/release/`:

- **macOS**: `Vayu-<version>.dmg`
- **Windows**: `Vayu Setup <version>.exe`
- **Linux**: `Vayu-<version>.AppImage` and `vayu-client_<version>_amd64.deb`

### Testing Production Builds

**macOS:**
```bash
open app/release/Vayu-*.dmg
# Drag to Applications and launch
```

**Linux:**
```bash
# AppImage
chmod +x app/release/Vayu-*.AppImage
./app/release/Vayu-*.AppImage

# Debian package
sudo dpkg -i app/release/vayu-client_*.deb
```

**Windows:**
```powershell
.\app\release\Vayu Setup *.exe
```

## Advanced: Manual CMake Build

If you prefer to use CMake directly, the project uses CMakePresets.

### Available Presets

**Configure presets:**
- `windows-dev`, `windows-prod`
- `linux-dev`, `linux-prod`
- `macos-dev`, `macos-prod`

### Usage

```bash
cd engine

# Configure
cmake --preset macos-prod    # or linux-prod, windows-prod

# Build
cmake --build --preset macos-prod

# Test
ctest --preset macos-prod
```

## Data Directories

### Development
- **All platforms**: `engine/data/`
  - Database: `engine/data/db/vayu.db`
  - Logs: `engine/data/logs/`
  - Lock file: `engine/data/vayu.lock`

### Production
- **macOS**: `~/Library/Application Support/vayu/`
- **Linux**: `~/.config/vayu/`
- **Windows**: `%APPDATA%\vayu\`

## Troubleshooting

### Prerequisites Not Found

**Problem:** "Missing prerequisites" error

**Solution:**

**macOS/Linux:**
```bash
# Ensure VCPKG_ROOT is set
export VCPKG_ROOT=~/vcpkg
export PATH=$VCPKG_ROOT:$PATH
```

**Windows:**
- Run from "Developer Command Prompt for VS" to use bundled tools
- Or set `VCPKG_ROOT` environment variable
- Script auto-detects Visual Studio bundled CMake and vcpkg

### Engine Fails to Start

**Problem:** "Failed to Start Engine" error

**Solution:**
1. Verify binary exists:
   ```bash
   # Development
   ls -la engine/build/vayu-engine           # macOS/Linux
   dir engine\build\Debug\vayu-engine.exe    # Windows
   ```

2. Rebuild if missing:
   ```bash
   python build.py --dev -e
   ```

### Port 9876 Already in Use

**Problem:** "Address already in use"

**Solution:**
```bash
cd app
pnpm kill-ports
```

### Build Fails

**Problem:** Compilation or linking errors

**Solution:**
```bash
# Clean rebuild with verbose output
python build.py -c -v

# Check for specific issues in the detailed output
```

### Tests Not Found

**Problem:** `--test-only` says tests not found

**Solution:** Build with tests enabled first:
```bash
python build.py -e -t
```

## CI/CD

The project uses GitHub Actions for automated builds:

- **PR Tests**: `.github/workflows/pr-tests.yml`
  - Runs on every pull request
  - Tests engine and frontend on Linux/Windows/macOS

- **Release Build**: `.github/workflows/release.yml`
  - Triggers on version tags (`v*`)
  - Builds and publishes installers for all platforms
  - Uses CMakePresets and lukka actions for optimal caching

Both workflows use the same CMakePresets as local development for consistency.

## Resources

- [Engine Building Details](engine/building.md)
- [App Building Details](app/building.md)
- [vcpkg Documentation](https://vcpkg.io/)
- [CMake Presets](https://cmake.org/cmake/help/latest/manual/cmake-presets.7.html)
