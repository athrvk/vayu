; Vayu NSIS Installer Script
; Handles closing running instances, reinstalls, and cleanup
;
; Process name: productName in electron-builder.json is "Vayu", so the packaged
; executable is Vayu.exe. That name applies to the *process* and nothing else.
;
; Data directory: the app names it explicitly - `USER_DATA_DIR_NAME` in
; app/electron/constants.ts, the product name - and moves an older install's
; directory there on its first launch. Every release up to 0.36 kept it under
; the npm package's name, which Electron derived because nothing named one, so
; an install that has not launched since the upgrade still has only that one:
; APP_DATA_DIR_LEGACY. Both are cleaned up here, and they are the only places
; either name appears; app/electron/installer-nsh-paths.test.ts fails if they
; ever disagree with constants.ts. The legacy half goes with the migration
; (#1758).
;
; Everything the app owns lives under that one directory: the engine's database
; and logs, the renderer's settings, and Chromium's caches. Nothing of the
; app's is under %LOCALAPPDATA% except the install root, which the uninstaller
; removes on its own.
;
; Lock file handling:
;   - Lock file path: %APPDATA%\${APP_DATA_DIR}\vayu.lock
;   - Cleaned up during install (stale locks) and uninstall
;   - Also handled automatically in app startup (sidecar.ts)

!define APP_DATA_DIR "Vayu"
!define APP_DATA_DIR_LEGACY "vayu-client"

!include "MUI2.nsh"
!include "FileFunc.nsh"

; Electron keeps userData in the *user's* roaming profile even when the app was
; installed for all users, and this installer offers that choice (oneClick is
; false and allowElevation is true in electron-builder.json). In that mode NSIS
; has already run SetShellVarContext all by the time these macros are inserted -
; customInit sits right after initMultiUser, customUnInstall near the top of the
; uninstall section - so $APPDATA resolves to the machine profile and every path
; below would miss the real directory again. electron-builder does the same flip
; around its own userData removal; these two macros are that flip, so it is
; written once instead of four times.
!macro useUserShellContext
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
!macroend

!macro restoreShellContext
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

; ============================================================================
; INSTALL: Check for running instances and handle reinstall
; ============================================================================
!macro customInit
  ; Check if Vayu is running
  nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq Vayu.exe" /NH'
  Pop $0  ; Exit code
  Pop $1  ; Output

  ; Check if the output actually contains "Vayu.exe" (means it's running)
  ; When tasklist finds the process, output starts with "Vayu.exe"
  ; When not found, output is empty or contains "INFO: No tasks..."
  ; We check if output starts with "Vayu.exe" (first 8 chars) to avoid locale issues
  StrCpy $2 $1 8  ; Extract first 8 characters
  ${If} $2 == "Vayu.exe"
    ; Vayu.exe is running. A silent install - winget, or electron-updater's own
    ; `quitAndInstall()` - has nobody to answer a MessageBox; NSIS does not
    ; suppress a raw MessageBox under /S on its own, so a silent run would
    ; otherwise sit blocked on a dialog forever. Silent always proceeds
    ; (close the app, keep installing): there is no unattended "abort" a
    ; scripted caller could act on either.
    IfSilent closeApp askToClose

    askToClose:
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION \
        "Vayu is currently running.$\n$\nClick OK to close it and continue installation, or Cancel to abort." \
        IDOK closeApp IDCANCEL abortInstall

    closeApp:
      ; Kill both the app and engine processes
      nsExec::ExecToStack 'taskkill /F /IM "Vayu.exe"'
      nsExec::ExecToStack 'taskkill /F /IM "vayu-engine.exe"'
      ; Wait for processes to fully terminate
      Sleep 1000
      Goto cleanupLock

    abortInstall:
      Abort
  ${Else}
    ; App not running, but engine might be orphaned from a crash
    ; Silently try to kill it (ignore errors)
    nsExec::ExecToStack 'taskkill /F /IM "vayu-engine.exe"'
    Pop $0  ; Discard result
    Goto cleanupLock
  ${EndIf}

  cleanupLock:
    !insertmacro useUserShellContext
    ; Clean up any stale lock files from previous installations or crashes
    ; For simplicity, just remove stale lock files during install - the engine
    ; creates a new one when it starts. Both directories: an install upgraded
    ; from 0.36 or earlier has its lock in the legacy one until its first launch.
    Delete "$APPDATA\${APP_DATA_DIR}\vayu.lock"
    Delete "$APPDATA\${APP_DATA_DIR_LEGACY}\vayu.lock"
    !insertmacro restoreShellContext
!macroend

; ============================================================================
; UNINSTALL: Close running instances before uninstall
; ============================================================================
!macro customUnInit
  ; Close any running instances before uninstall
  nsExec::ExecToStack 'taskkill /F /IM "Vayu.exe"'
  nsExec::ExecToStack 'taskkill /F /IM "vayu-engine.exe"'
  Sleep 500
!macroend

; ============================================================================
; POST-UNINSTALL: Clean up app data (with user confirmation)
; ============================================================================
!macro customUnInstall
  !insertmacro useUserShellContext

  ; A silent uninstall (an updater's reinstall, winget, a scripted removal) has
  ; nobody to answer a Yes/No MessageBox, and NSIS does not suppress a raw
  ; MessageBox under /S on its own - left unguarded, this blocked every
  ; unattended update on a dialog nobody could see. Default to the answer a
  ; human is told is the safe one: keep the data.
  IfSilent keepData askUser

  askUser:
    ; Ask user if they want to KEEP app data (Yes = safe/keep, No = delete)
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Would you like to keep your Vayu data for future reinstalls?$\n$\n\
      This includes:$\n\
      • Saved requests and collections$\n\
      • Environment variables$\n\
      • Test history and results$\n\
      • Application settings$\n$\n\
      Yes = Keep my data$\n\
      No = Delete everything" \
      IDYES keepData IDNO removeData

  keepData:
    ; User chose to keep data
    ; Still remove the lock file to prevent issues on reinstall
    ; (the lock sits beside the db directory, not inside it)
    Delete "$APPDATA\${APP_DATA_DIR}\vayu.lock"
    Delete "$APPDATA\${APP_DATA_DIR_LEGACY}\vayu.lock"
    Goto cleanupDone

  removeData:
    ; Remove the app's userData directory - database, logs, settings, caches.
    ;
    ; Guarded rather than unconditional. This branch spent its whole life
    ; deleting a tree it only believed was the app's, and a wrong RMDir /r is
    ; silent in both directions: it removes nothing when the name is wrong, and
    ; removes someone else's data if it is wrong the other way. If the
    ; directory is not there, say so in the log and leave the disk alone.
    ; Both directories: an install that has not launched since upgrading from
    ; 0.36 or earlier still keeps everything in the legacy one.
    IfFileExists "$APPDATA\${APP_DATA_DIR}\*.*" 0 dataDirMissing
      RMDir /r "$APPDATA\${APP_DATA_DIR}"
      Goto legacyDataDir

  dataDirMissing:
    DetailPrint "No Vayu data directory at $APPDATA\${APP_DATA_DIR} - nothing to delete."

  legacyDataDir:
    IfFileExists "$APPDATA\${APP_DATA_DIR_LEGACY}\*.*" 0 cleanupDone
      RMDir /r "$APPDATA\${APP_DATA_DIR_LEGACY}"

  cleanupDone:
    !insertmacro restoreShellContext
!macroend
