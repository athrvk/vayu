# Lock File Handling During Install/Uninstall

This document describes how lock files (`vayu.lock`) are handled during installation and uninstallation across all platforms.

## Overview

The lock file (`vayu.lock`) prevents multiple instances of the Vayu engine from running simultaneously. It contains the PID of the running engine process and is located at:

- **Windows**: `%APPDATA%\Vayu\vayu.lock`
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
- Removes lock file when user chooses to keep or remove data
- Lock file path: `$APPDATA\Vayu\vayu.lock`

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
3. **Verifies process** is still running
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
Remove-Item "$env:APPDATA\Vayu\vayu.lock"
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
- File: `app/build/installer.nsh`

### Linux Maintainer Scripts
- `linux-postinst.sh`: Post-installation cleanup
- `linux-prerm.sh`: Pre-removal (kill processes)
- `linux-postrm.sh`: Post-removal (cleanup lock file)
- Note: These are reference scripts. electron-builder doesn't inject them automatically, but the app startup handles cleanup.

### Electron Sidecar
- Function: `checkLockFile()` - checks lock file and verifies PID
- Function: `isVayuEngineRunning()` - cross-platform process check with process name verification
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
