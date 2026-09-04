---
description: >-
  How Vayu handles vayu.lock during install and uninstall on each platform, and what happens when a stale lock is found.
---

# Lock File Handling During Install/Uninstall

This document describes how lock files (`vayu.lock`) are handled during installation and uninstallation across all platforms.

## Overview

The lock file (`vayu.lock`) prevents multiple instances of the Vayu engine from running simultaneously. It contains the PID of the running engine process and is located at:

- **Windows**: `%APPDATA%\vayu-client\vayu.lock`
- **macOS**: `~/Library/Application Support/vayu/vayu.lock`
- **Linux**: `~/.config/vayu/vayu.lock`

## Platform-Specific Handling

### Windows (NSIS Installer)

**Installation (`installer.nsh`):**
- Checks if Vayu is running and prompts user to close it
- Kills any orphaned `vayu-engine.exe` processes
- Removes stale lock files during installation

**Uninstallation (`installer.nsh`):**
- Kills running Vayu and engine processes before uninstall
- "Keep my data" removes only the lock file; "Delete everything" removes the whole data directory, and logs a skip rather than deleting anything if that directory is not there
- Lock file path: `$APPDATA\${APP_DATA_DIR}\vayu.lock`

The directory name is not `productName`. Electron derives `app.getPath("userData")`
from `app.getName()`, which reads `name` in `app/package.json`, so the script
defines `APP_DATA_DIR` from that file rather than spelling a path
(`app/electron/installer-nsh-paths.test.ts` fails if the two drift apart).

Both macros also flip NSIS back to the user's shell context around those paths.
An all-users install leaves NSIS in the machine context, where `$APPDATA` is not
the roaming profile Electron writes userData to - so a correctly named path
would still miss the real directory in that install mode.

### macOS (DMG)

**Installation:**
- No install hooks (DMG doesn't support them)
- Lock file cleanup handled automatically in app startup (see below)

**Uninstallation:**
- User manually drags app to Trash
- Lock file cleanup handled automatically in app startup on next launch

### Linux (.deb Package)

**Installation:**
- Maintainer scripts available in `build/linux-postinst.sh`
- Lock file cleanup handled automatically in app startup (see below)
- Note: electron-builder doesn't inject maintainer scripts automatically, but cleanup happens on app startup

**Uninstallation:**
- Maintainer scripts available in `build/linux-prerm.sh` and `build/linux-postrm.sh`
- Lock file cleanup handled automatically in app startup

**AppImage:**
- No install/uninstall hooks
- Lock file cleanup handled automatically in app startup

## Automatic Cleanup on App Startup

The Electron sidecar (`app/electron/sidecar.ts`) automatically handles stale lock files:

1. **Checks lock file** before starting the engine
2. **Reads PID** from lock file
3. **Verifies process** is still running - cheap first, subprocess second: a
   signal-0 probe answers a PID nothing holds, and only a live PID is worth a
   `tasklist` / `ps` call to verify the name
4. **Removes stale lock** if process is dead
5. **Logs warnings** for debugging

This ensures that:
- Stale locks from crashes are cleaned up
- Reinstalls work correctly
- No manual intervention needed

## Manual Cleanup

If needed, users can manually remove the lock file:

**Windows:**
```powershell
Remove-Item "$env:APPDATA\vayu-client\vayu.lock"
```

**macOS/Linux:**
```bash
rm ~/.config/vayu/vayu.lock
# or on macOS:
rm ~/Library/Application\ Support/vayu/vayu.lock
```

## Implementation Details

### Windows Implementation
- Uses `tasklist` and `taskkill` commands
- NSIS macros: `customInit`, `customUnInit`, `customUnInstall`
- File: `app/installer/installer.nsh`

### Linux Maintainer Scripts
- `linux-postinst.sh`: Post-installation cleanup
- `linux-prerm.sh`: Pre-removal (kill processes)
- `linux-postrm.sh`: Post-removal (cleanup lock file)
- Note: These are reference scripts. electron-builder doesn't inject them automatically, but the app startup handles cleanup.

### Electron Sidecar
- Function: `checkLockFile()` - checks lock file and verifies PID
- Function: `isVayuEngineRunning()` - cross-platform process check with process name verification. `process.kill(pid, 0)` first on every platform (no subprocess, and the stale-lock case ends there), then `tasklist` / `ps` to verify the name against PID reuse
- Automatic cleanup in `start()` method
- File: `app/electron/sidecar.ts`

## Testing

To test lock file handling:

1. **Start Vayu** - lock file should be created
2. **Kill engine process** - lock file should remain
3. **Restart Vayu** - stale lock should be detected and removed
4. **Reinstall** - lock file should be cleaned up during install

## Troubleshooting

**Issue**: Lock file prevents engine from starting after crash

**Solution**: The app automatically cleans up stale locks on startup. If this doesn't work, manually remove the lock file (see Manual Cleanup above).

**Issue**: Multiple instances error after uninstall/reinstall

**Solution**: The installer/uninstaller should handle this. If not, manually remove the lock file before reinstalling.
