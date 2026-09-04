---
description: >-
  How Vayu handles vayu.lock during install and uninstall on each platform, and what happens when a stale lock is found.
---

# Lock File Handling During Install/Uninstall

This document describes how lock files (`vayu.lock`) are handled during installation and uninstallation across all platforms.

## Overview

The lock file (`vayu.lock`) prevents multiple instances of the Vayu engine from running simultaneously. It contains the PID of the running engine process and is located at:

- **Windows**: `%APPDATA%\vayu-client\vayu.lock`
- **macOS**: `~/Library/Application Support/vayu-client/vayu.lock`
- **Linux**: `~/.config/vayu-client/vayu.lock`

The directory is `app.getPath("userData")`, which Electron derives from the
`name` in `app/package.json` (`vayu-client`) rather than from the product name,
so it is `vayu-client` on every platform. `engineDataDirectory()`
(`app/electron/sidecar.ts`) is the one place that resolves it; anything else
naming a directory is a copy that can drift.

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

The path in those two lines is the script's, not the app's: `installer.nsh`
targets `$APPDATA\Vayu` while the app writes `%APPDATA%\vayu-client`, the same
wrong-directory defect the Linux hooks had. It is tracked in #1393, which needs
a Windows machine to verify before the script changes; the lines above describe
the script as it is until then.

### macOS (DMG)

**Installation:**
- No install hooks (DMG doesn't support them)
- Lock file cleanup handled automatically in app startup (see below)

**Uninstallation:**
- User manually drags app to Trash
- Lock file cleanup handled automatically in app startup on next launch

### Linux (.deb Package)

**Installation:**
- No maintainer script. Stale locks are reclaimed by app startup (see below)

**Uninstallation:**
- `app/installer/linux-prerm.sh`, wired as fpm's `--before-remove` in
  `app/electron-builder.json`, kills any running `vayu-engine` so dpkg does not
  replace or remove the binary underneath a live process. It touches no path,
  which is why running as root does not break it
- Lock file cleanup handled automatically in app startup

A postinst and a postrm hook used to clean the lock file here. They were
removed (#1356): both looked for `$HOME/.config/vayu/vayu.lock`, a directory the
app has never written, and dpkg runs maintainer scripts as root, so even the
right directory name would have resolved under `/root` rather than the
installing user's home. The recovery they attempted - read the PID, verify it
belongs to `vayu-engine`, remove the file if not - is what startup already does,
against a path it resolves rather than spells, and at every launch rather than
only at install time.

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
rm ~/.config/vayu-client/vayu.lock
# or on macOS:
rm ~/Library/Application\ Support/vayu-client/vayu.lock
```

## Implementation Details

### Windows Implementation
- Uses `tasklist` and `taskkill` commands
- NSIS macros: `customInit`, `customUnInit`, `customUnInstall`
- File: `app/build/installer.nsh`

### Linux Maintainer Scripts
- `app/installer/linux-prerm.sh`: pre-removal, kills a running `vayu-engine`
- It is the only one. `app/electron-builder.json`'s `deb` block wires it as
  fpm's `--before-remove`, so the packaged `.deb` carries a `prerm` and no
  `postinst` or `postrm`.

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
4. **Reinstall** - the first launch after it reclaims any lock left behind

## Troubleshooting

**Issue**: Lock file prevents engine from starting after crash

**Solution**: The app automatically cleans up stale locks on startup. If this doesn't work, manually remove the lock file (see Manual Cleanup above).

**Issue**: Multiple instances error after uninstall/reinstall

**Solution**: Startup reclaims a lock whose PID is not a live `vayu-engine`, so launching the reinstalled app is the fix. If the engine still refuses to start, the PID in the lock file belongs to a live engine - stop it, or remove the lock file manually.
