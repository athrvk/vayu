# Building Vayu for macOS

This guide explains how to build and package Vayu for macOS with the bundled C++ engine.

## Architecture

Vayu uses the **sidecar pattern** to bundle the C++ engine with the Electron app:

```
Vayu.app/
├── Contents/
│   ├── MacOS/
│   │   └── Vayu          # Electron executable
│   └── Resources/
│       ├── app.asar              # Electron app (UI)
│       └── bin/
│           └── vayu-engine       # C++ engine binary
```

When the app launches:
1. Electron main process starts
2. Sidecar manager spawns the `vayu-engine` process
3. Engine starts on `http://127.0.0.1:9876`
4. UI connects to the engine API

## Prerequisites

### For Development

- **macOS** (10.15 Catalina or later)
- **Node.js** v18+ with pnpm
- **CMake** v3.25+
- **vcpkg** package manager
- **Xcode Command Line Tools**

```bash
# Install prerequisites
xcode-select --install
brew install cmake ninja vcpkg pnpm

# Verify vcpkg is in PATH
which vcpkg
```

### For Building Production Apps

All of the above, plus:
- **electron-builder** (installed via pnpm)

## Development Workflow

### 1. Initial Setup

```bash
# Clone the repository
git clone https://github.com/vayu/vayu.git
cd vayu

# Run the development setup script
./scripts/build-app-dev.sh
```

This script will:
- Build the C++ engine in debug mode
- Install app dependencies via pnpm
- Set up the development environment

### 2. Running in Development Mode

```bash
cd app
pnpm run electron:dev
```

This starts:
1. **Vite dev server** (React app on http://localhost:5173)
2. **TypeScript compiler** (watches electron/ folder)
3. **Electron** (launches the app)
4. **C++ Engine** (auto-started by sidecar)

**Development Paths:**
- Engine binary: `../engine/build/vayu-engine`
- Data directory: `../engine/data/`
  - Database: `../engine/data/db/vayu.db`
  - Logs: `../engine/data/logs/`
  - Lock file: `../engine/data/vayu.lock`

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
- Rebuild the engine:
  ```bash
  cd engine/build
  cmake --build . -j 8
  ```
- Restart the Electron app

## Production Build

### 1. Build the Complete App

```bash
# From project root
./scripts/build-app-prod.sh
```

This script will:
1. **Build C++ engine** for production (Release mode)
2. **Copy engine binary** to `app/resources/bin/`
3. **Install app dependencies**
4. **Compile TypeScript** for Electron
5. **Build React app** with Vite
6. **Package with electron-builder** (creates .dmg)

### 2. Output

The final installer is created at:
```
app/release/Vayu-<version>-<arch>.dmg
```

**Production Paths (inside .app):**
- Engine binary: `Vayu.app/Contents/Resources/bin/vayu-engine`
- Data directory: `~/Library/Application Support/vayu/`
  - Database: `~/Library/Application Support/vayu/db/vayu.db`
  - Logs: `~/Library/Application Support/vayu/logs/`
  - Lock file: `~/Library/Application Support/vayu/vayu.lock`

### 3. Testing the Production Build

```bash
# Open the DMG
open app/release/Vayu\ Desktop-*.dmg

# Drag to Applications and launch
# Or test directly
./app/release/mac/Vayu\ Desktop.app/Contents/MacOS/Vayu\ Desktop
```

## Build Scripts Reference

### `scripts/build-engine-macos.sh`

Builds the C++ engine for production:
- Compiles in **Release** mode with optimizations
- Links all dependencies statically
- Copies binary to `app/resources/bin/vayu-engine`
- **Flags:**
  - `VAYU_BUILD_ENGINE=ON` - Build daemon
  - `VAYU_BUILD_CLI=OFF` - Skip CLI
  - `VAYU_BUILD_TESTS=OFF` - Skip tests

Usage:
```bash
./scripts/build-engine-macos.sh
```

### `scripts/build-app-dev.sh`

Sets up the development environment:
- Checks for engine binary (builds if missing)
- Installs pnpm dependencies
- Prepares for `pnpm run electron:dev`

Usage:
```bash
./scripts/build-app-dev.sh
```

### `scripts/build-app-prod.sh`

Builds the complete production app:
- Calls `build-engine-macos.sh`
- Builds React app with Vite
- Packages with electron-builder
- Creates .dmg installer

Usage:
```bash
./scripts/build-app-prod.sh
```

## Electron Configuration

### `app/electron-builder.json`

Key settings:
- **appId:** `com.vayu.desktop`
- **extraResources:** Bundles `vayu-engine` binary
- **mac.target:** Universal binary (arm64 + x64)
- **mac.category:** Developer Tools

### `app/electron/sidecar.ts`

Manages the engine process:
- **Environment detection:** Dev vs Prod
- **Path resolution:** Binary and data directory
- **Process lifecycle:** Start, stop, health checks
- **Error handling:** Graceful failures

## Troubleshooting

### Engine fails to start in development

**Symptoms:** Error dialog "Failed to Start Engine"

**Solution:**
1. Check if engine binary exists:
   ```bash
   ls -la engine/build/vayu-engine
   ```
2. If missing, rebuild:
   ```bash
   cd engine/build
   cmake --build . -j 8
   ```

### Port 9876 already in use

**Symptoms:** Engine fails with "Address already in use"

**Solution:**
1. Find and kill the process:
   ```bash
   lsof -i :9876
   kill <PID>
   ```
2. Or use a different port (edit `app/electron/main.ts`)

### Production app crashes on launch

**Symptoms:** App quits immediately after opening

**Solution:**
1. Check Console.app for crash logs
2. Look in `~/Library/Application Support/vayu/logs/`
3. Verify engine binary has correct permissions:
   ```bash
   ls -la Vayu\ Desktop.app/Contents/Resources/bin/vayu-engine
   ```

### DMG creation fails

**Symptoms:** `electron-builder` errors during packaging

**Common causes:**
- Missing engine binary in `app/resources/bin/`
- Missing icon files in `app/build/`
- Unsigned binary (requires Developer ID certificate)

**Solution:**
1. Ensure engine is built:
   ```bash
   ./scripts/build-engine-macos.sh
   ```
2. For unsigned builds, electron-builder will skip signing

## Code Signing & Notarization

For distribution outside the Mac App Store, you need:

1. **Apple Developer Account** ($99/year)
2. **Developer ID Application Certificate**
3. **App-specific password** for notarization

### Setup

```bash
# Set environment variables
export APPLE_ID="your@email.com"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

### Build with Signing

```bash
# electron-builder will use the above env vars
./scripts/build-app-prod.sh
```

For now, the scripts build **unsigned** apps for development testing.

## Next Steps

- Add Windows build support (`build-engine-windows.sh`)
- Add Linux build support (`build-engine-linux.sh`)
- Set up GitHub Actions for automated builds
- Add automatic updates with electron-updater

## Resources

- [Electron Documentation](https://www.electronjs.org/docs)
- [electron-builder](https://www.electron.build/)
- [vcpkg Package Manager](https://vcpkg.io/)
- [CMake Documentation](https://cmake.org/documentation/)
