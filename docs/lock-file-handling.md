---
description: >-
  How Vayu handles vayu.lock during install and uninstall on each platform, and what happens when a stale lock is found.
---

# Lock File Handling During Install/Uninstall

This document describes how lock files (`vayu.lock`) are handled during installation and uninstallation across all platforms.

## Overview

The lock file (`vayu.lock`) prevents multiple instances of the Vayu engine from running simultaneously. It contains the PID of the running engine process and is located at:

- **Windows**: `%APPDATA%\Vayu\vayu.lock`
- **macOS**: `~/Library/Application Support/Vayu/vayu.lock`
- **Linux**: `~/.config/Vayu/vayu.lock`

The directory is `app.getPath("userData")`, which `main.ts` sets to
`USER_DATA_DIR_NAME` (`app/electron/constants.ts`) before anything opens a file
there. `engineDataDirectory()`
(`app/electron/sidecar.ts`) is the one place that resolves it; anything else
naming a directory is a copy that can drift.

## Platform-Specific Handling

### Windows (NSIS Installer)

**Installation (`installer.nsh`):**
- Checks if Vayu is running and prompts user to close it
- Kills any orphaned `vayu-engine.exe` processes
- Removes stale lock files during installation
- **Not on an updated launch.** "Restart to install" runs the installer with
  `--updated` (not `/S`) while the app is still shutting down - the renderer's
  save flush, then the engine's graceful exit. `customInit` does none of the
  three there: no prompt, no `taskkill`, no lock `Delete`. electron-builder's
  own running-app check waits for the app to exit and force-kills only after,
  and a lock left behind is reclaimed by app startup (#1882)

**Uninstallation (`installer.nsh`):**
- Kills running Vayu and engine processes before uninstall
- "Keep my data" removes only the lock file; "Delete everything" removes the whole data directory, and logs a skip rather than deleting anything if that directory is not there
- Lock file path: `$APPDATA\${APP_DATA_DIR}\vayu.lock`

NSIS cannot read `package.json`, so the script defines `APP_DATA_DIR` once and
uses it everywhere rather than spelling a path.
`app/electron/installer-nsh-paths.test.ts` fails if that define drifts from the
`name`, if any path bypasses it, or if a path segment anywhere in the file -
comments included - is `productName`. It is the Windows counterpart to the
`Script lint` job's check over the shell scripts, which covers `~/.config/` and
cannot see a `.nsh` file.

Both macros also flip NSIS back to the user's shell context around those paths.
An all-users install leaves NSIS in the machine context, where `$APPDATA` is not
the roaming profile Electron writes userData to - so a correctly named path
would still miss the real directory in that install mode.

Until #1393 the script named `productName` for both, so "Delete everything"
ran `RMDir /r` over `$APPDATA\Vayu` and removed nothing the app owns - the same
wrong-directory defect the Linux hooks had, and worse, because here it was a
promise about the user's data rather than a no-op.

### macOS (DMG)

**Installation:**
- No install hooks (DMG doesn't support them)
- Lock file cleanup handled automatically in app startup (see below)

**Uninstallation:**
- User manually drags app to Trash
- Lock file cleanup handled automatically in app startup on next launch

### Linux (.deb Package)

**Installation:**
- No maintainer script of Vayu's. The package's `postinst` is the one
  electron-builder generates; stale locks are reclaimed by app startup (see
  below)

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

They also cost more than they looked. `afterInstall` and `afterRemove` are
passed to fpm as `--after-install` and `--after-remove`, which **replace**
electron-builder's generated maintainer scripts rather than running alongside
them, so every `.deb` built while those hooks existed shipped the lock cleanup
in place of the `/usr/bin/vayu-client` alternative, the `chrome-sandbox` mode
fix, the mime and desktop database updates and the AppArmor profile Ubuntu 24
requires. Removing them restores all of it. Anything a future hook needs to do
belongs in a script that keeps that generated content, not one that supersedes
it.

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
5. **Waits for, then replaces,** a live engine that never answers `/health`
   (below)
6. **Logs warnings** for debugging

This ensures that:
- Stale locks from crashes are cleaned up
- Reinstalls work correctly
- No manual intervention needed

**A live engine is replaced, never adopted** (issue #2356). The lock file can
point at a PID that is alive and answering `/health`: an orphan from a crashed
session, two installed builds sharing a data directory, or in development an
engine started by hand. Every write to file trust (an allowed folder, a picked
file) needs the grant secret the app passes the engine it spawns, and that
engine was given another launch's secret or none, so `EngineSidecar` stops it
(`POST /shutdown`, then the same PID kill the graceful path already falls back
to) and spawns its own on the same port. That also covers an engine built for a
different Vayu release (issue #1492).

**A live lock PID that does not answer `/health` is waited for, then replaced**
(issue #1905). Between "stale" and "healthy" there is a third case: the PID is
alive and is a Vayu engine, but nothing answers on the port. It is either still
starting - an orphan from a crashed session reads its database and runs
migrations before it listens - or hung. Spawning beside it loses the flock, and
reporting the port as held would blame another program for Vayu's own engine.
So `EngineSidecar` polls `/health` on the same ramped
budget a freshly spawned engine gets (`ENGINE_HEALTH_POLL_BUDGET_MS`). An
engine that answers in time is asked to shut down and replaced like any other
(above). One that does not is stopped by PID (the name-verified kill, so a
recycled PID is left alone), the port is given `ENGINE_PORT_RELEASE_DELAY_MS`
to clear, the replaced PID is logged, and this instance spawns its own. The
port-in-use error (`EnginePortInUseError`) is left for ports held when the lock
file names no live Vayu engine.

**A live lock is looked for on every candidate port** (issue #2118). The engine
may run on 9876 or a fallback (`ENGINE_PORT_CANDIDATES`), so with a live lock
PID every candidate is asked for `/health` before any free port is taken: an
orphan left on a fallback port is replaced there even after 9876 has come free. When
it answers on none, the wait above watches the first free candidate (where a
still-starting engine, not yet listening, would be), or 9876 when none is free.

**The engine releases the lock after its database has closed** (issue #2420).
`run_daemon` (`engine/src/daemon.cpp`) holds the flock in an `InstanceLock`
declared before the `Database`, so on the way out the database's destructor -
its close-time WAL checkpoint included - runs first and the lock goes last, on
an early exit and a thrown startup error as much as on a graceful shutdown. A
replacement that wins the lock therefore never meets its predecessor's
connection at its own startup probe. If something else still holds the
database when an engine starts (a `sqlite3` shell left in a transaction, a sync
agent), the engine waits for it (10 s on each connection it opens), then exits 1 naming the database
and leaves every file as it was, rather than treating the held file as corrupt
([db-schema.md](engine/db-schema.md#startup-validation-backup-and-recovery)).

## Manual Cleanup

If needed, users can manually remove the lock file:

**Windows:**
```powershell
Remove-Item "$env:APPDATA\Vayu\vayu.lock"
```

**macOS/Linux:**
```bash
rm ~/.config/Vayu/vayu.lock
# or on macOS:
rm ~/Library/Application\ Support/Vayu/vayu.lock
```

## Implementation Details

### Windows Implementation
- Uses `tasklist` and `taskkill` commands
- NSIS macros: `customInit`, `customUnInit`, `customUnInstall`
- File: `app/installer/installer.nsh`

### Linux Maintainer Scripts
- `app/installer/linux-prerm.sh`: pre-removal, kills a running `vayu-engine`
- It is the only one Vayu writes. The packaged `.deb` still carries a `postinst`
  and a `postrm`, both generated by electron-builder: the `/usr/bin/vayu-client`
  alternative, the `chrome-sandbox` mode, the mime and desktop databases and the
  AppArmor profile Ubuntu 24 needs. `afterInstall` and `afterRemove` **replace**
  those generated scripts rather than adding to them, which is what made the two
  removed hooks worse than dead: every `.deb` built while they existed shipped
  their lock-file cleanup *instead of* that setup.

### Electron Sidecar
- Function: `checkLockFile()` - checks lock file and verifies PID
- Function: `isVayuEngineRunning()` - cross-platform process check with process name verification. `process.kill(pid, 0)` first on every platform (no subprocess, and the stale-lock case ends there), then `tasklist` / `ps` to verify the name against PID reuse
- Method: `replaceAnsweringEngine()` - stops a healthy engine `start()` finds already on the port, so it can spawn its own
- Method: `replaceLockedEngine()` - settles a live lock PID: waits on `pollHealthWithinBudget()`, then asks it to shut down if it answered or kills it if it stayed silent
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

**Solution**: Startup reclaims a lock whose PID is not a live `vayu-engine`, so launching the reinstalled app is the fix. A live engine that never answers `/health` is replaced automatically after the health budget; if the engine still refuses to start, the replacement kill failed - stop the PID in the lock file, or remove the lock file manually.
