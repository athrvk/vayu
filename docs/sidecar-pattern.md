# Sidecar Pattern Implementation

This document explains how Vayu bundles and manages the C++ engine using the sidecar pattern.

## Overview

The **sidecar pattern** is a design pattern where a helper process (the "sidecar") runs alongside the main application. In Vayu:

- **Main Process:** Electron app (UI)
- **Sidecar Process:** vayu-engine (C++ backend)

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Vayu.app                            │
│                                                             │
│  ┌──────────────────┐              ┌──────────────────┐   │
│  │  Electron Main   │   spawns     │   vayu-engine    │   │
│  │    Process       │─────────────>│   (C++ Sidecar)  │   │
│  │                  │              │                  │   │
│  │  - Window mgmt   │   HTTP API   │  - HTTP server   │   │
│  │  - Sidecar mgr   │<─────────────│  - Event loop    │   │
│  │  - IPC bridge    │  port 9876   │  - Database      │   │
│  └──────────────────┘              │  - Logging       │   │
│           ↓                         └──────────────────┘   │
│  ┌──────────────────┐                       ↓              │
│  │  Renderer Process│                  User Data           │
│  │  (React UI)      │              ~/Library/App Support   │
│  │                  │                    /vayu/            │
│  │  - Request UI    │                    ├── db/           │
│  │  - Response UI   │                    ├── logs/         │
│  │  - Dashboard     │                    └── vayu.lock     │
│  └──────────────────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. Sidecar Manager (`app/electron/sidecar.ts`)

**Responsibilities:**
- Detect environment (development vs production)
- Resolve binary and data paths
- Spawn the engine process
- Monitor engine health
- Gracefully stop the engine on app quit

**Key Methods:**

```typescript
class EngineSidecar {
  async start(): Promise<void>
  async stop(): Promise<void>
  getApiUrl(): string
  isRunning(): boolean
}
```

### 2. Path Resolution

The sidecar manager resolves paths differently based on the environment:

#### Development Mode

```typescript
// Detected via: process.env.NODE_ENV === "development"

Binary Path:   ../engine/build/vayu-engine
Data Directory: ../engine/data/
```

Why?
- Engine binary is built locally during development
- Data is stored in the engine directory for easy access/debugging
- Allows testing without packaging

#### Production Mode

```typescript
// Detected via: process.env.NODE_ENV !== "development"

Binary Path:    process.resourcesPath/bin/vayu-engine
Data Directory: app.getPath("userData")  // ~/Library/Application Support/vayu
```

Why?
- Binary is bundled inside the .app package
- Data is stored in the user's Application Support directory (macOS standard)
- Persists across app updates

### 3. Engine Configuration

The engine accepts a `--data-dir` parameter to configure all file paths:

```bash
vayu-engine --port 9876 --data-dir ~/Library/Application\ Support/vayu
```

This creates:
```
~/Library/Application Support/vayu/
├── db/
│   └── vayu.db           # SQLite database
├── logs/
│   └── vayu_*.log        # Rotating log files
└── vayu.lock             # Single-instance lock file
```

## Lifecycle Management

### Startup Sequence

1. **Electron app launches** (`app.whenReady()`)
2. **Sidecar manager initializes**
   - Detects environment
   - Resolves binary path
   - Resolves data directory
3. **Data directory created** (if not exists)
4. **Engine process spawned**
   ```typescript
   spawn(binaryPath, [
     "--port", "9876",
     "--data-dir", dataDir,
     "--verbose", "1"
   ])
   ```
5. **Health check loop**
   - Poll `http://127.0.0.1:9876/health` every 500ms
   - Max 30 attempts (15 seconds timeout)
   - Throw error if engine doesn't start
6. **Main window created**
7. **UI connects to engine API**

### Shutdown Sequence

1. **User quits app** (Cmd+Q or window close)
2. **`before-quit` event triggered**
3. **Sidecar manager stops engine**
   - Send SIGTERM signal
   - Wait up to 5 seconds for graceful shutdown
   - Send SIGKILL if still running
4. **Engine cleanup**
   - Stop active load tests
   - Flush database writes
   - Close log files
   - Release lock file
5. **Electron app quits**

### Error Handling

**Engine fails to start:**
- Show error dialog to user
- Display helpful error message
- Suggest solutions (e.g., check logs)
- Quit the app gracefully

**Engine crashes during runtime:**
- Log error to console
- Optionally: Auto-restart (not currently implemented)
- User can manually restart the app

**Port conflict:**
- Engine fails with "Address already in use"
- Sidecar catches error
- Suggests killing existing process or using different port

## Building & Packaging

### Development Build

No special packaging needed:
```bash
./scripts/build-app-dev.sh
cd app && pnpm run electron:dev
```

The sidecar manager automatically finds the development binary.

### Production Build

The build process packages the engine binary:

1. **Build engine for production**
   ```bash
   ./scripts/build-engine-macos.sh
   ```
   - Compiles in Release mode
   - Strips debug symbols
   - Copies to `app/resources/bin/vayu-engine`

2. **electron-builder packages the app**
   ```json
   {
     "extraResources": [
       {
         "from": "resources/bin/vayu-engine",
         "to": "bin/vayu-engine"
       }
     ]
   }
   ```
   - Bundles binary into `Vayu.app/Contents/Resources/bin/`
   - Makes it executable
   - Signs it (if certificate provided)

3. **Creates installer**
   - DMG file for macOS
   - User drags to Applications folder
   - Binary is extracted and runs from the installed location

## Security Considerations

### Code Signing

For distribution, both the Electron app and the engine binary must be signed:

```bash
# Sign the engine binary
codesign --force --sign "Developer ID Application: Your Name" \
  app/resources/bin/vayu-engine

# electron-builder signs the app automatically
./scripts/build-app-prod.sh
```

### Entitlements

The engine needs specific entitlements to run:

```xml
<!-- app/build/entitlements.mac.plist -->
<key>com.apple.security.network.client</key>
<true/>
<key>com.apple.security.network.server</key>
<true/>
```

These allow:
- Outbound network connections (HTTP requests)
- Inbound connections (HTTP API on port 9876)

### Hardened Runtime

macOS requires hardened runtime for notarization:

```json
{
  "mac": {
    "hardenedRuntime": true,
    "entitlements": "build/entitlements.mac.plist"
  }
}
```

## Debugging

### Enable Sidecar Logging

All sidecar logs go to the Electron console:

```typescript
// View in DevTools Console (Cmd+Option+I)
[Sidecar] Starting engine...
[Sidecar]   Binary: /path/to/vayu-engine
[Sidecar]   Data Dir: /path/to/data
[Sidecar]   Port: 9876
[Engine] Vayu Engine 0.1.1
[Engine] Database initialized at /path/to/data/db/vayu.db
[Sidecar] Engine is ready
```

### Engine Logs

Check the engine's own logs:

```bash
# Development
cat engine/data/logs/vayu_*.log

# Production
cat ~/Library/Application\ Support/vayu/logs/vayu_*.log
```

### Manual Engine Testing

Test the engine independently:

```bash
# Development
./engine/build/vayu-engine --data-dir /tmp/vayu-test --verbose 2

# Production
./Vayu\ Desktop.app/Contents/Resources/bin/vayu-engine \
  --data-dir /tmp/vayu-test --verbose 2
```

## Alternatives Considered

### 1. Single Executable

**Idea:** Embed the engine directly in Electron via Node addon

**Pros:**
- Simpler packaging
- No process management

**Cons:**
- C++ crashes kill entire app
- Hard to update engine independently
- Mixing Node and C++ event loops is complex

### 2. Separate Installation

**Idea:** Install engine as a system service

**Pros:**
- Engine runs independently
- Can serve multiple clients

**Cons:**
- Complex installation
- Harder to uninstall
- Version mismatch issues
- Security implications (system service)

### 3. Sidecar Pattern (Chosen)

**Pros:**
- Clean separation of concerns
- Engine crashes don't kill UI
- Easy to update both components
- Standard macOS app packaging
- No system modifications required

**Cons:**
- Process management complexity
- IPC via HTTP (small overhead)

## Best Practices

1. **Always check binary exists before spawning**
   ```typescript
   if (!fs.existsSync(binaryPath)) {
     throw new Error(`Binary not found: ${binaryPath}`);
   }
   ```

2. **Wait for health check before showing UI**
   - Prevents "connection refused" errors
   - Better user experience

3. **Graceful shutdown**
   - Send SIGTERM first (allows cleanup)
   - Wait reasonable time (5 seconds)
   - SIGKILL only as last resort

4. **Log everything**
   - Helps diagnose issues
   - Shows in Console.app for production builds

5. **Handle errors gracefully**
   - Show user-friendly messages
   - Provide actionable solutions
   - Don't leave zombie processes

## Future Enhancements

- **Auto-restart:** Restart engine if it crashes
- **Health monitoring:** Periodic health checks during runtime
- **Update mechanism:** Update engine without reinstalling app
- **Multiple ports:** Support running multiple instances
- **Remote engine:** Connect to engine on different machine

## References

- [Electron Process Model](https://www.electronjs.org/docs/tutorial/process-model)
- [electron-builder](https://www.electron.build/)
- [macOS Code Signing](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
