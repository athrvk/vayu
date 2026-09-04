; Vayu NSIS Installer Script
; Handles closing running instances, reinstalls, and cleanup
;
; Process name: productName in electron-builder.json is "Vayu", so the packaged
; executable is Vayu.exe. That name applies to the *process* and nothing else.
;
; Data directory: Electron builds app.getPath("userData") from app.getName(),
; which reads the `name` field of the packaged app/package.json - not
; productName from electron-builder.json - and nothing calls app.setName(). So
; the two differ, and this script spelled productName for both until #1393,
; which made "Delete everything" at uninstall delete a directory the app has
; never written. APP_DATA_DIR below is the only place the directory name
; appears; app/package.json decides its value, and
; app/electron/installer-nsh-paths.test.ts fails if the two ever disagree.
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

!define APP_DATA_DIR "vayu-client"

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
    ; Vayu.exe is running
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
    ; Check if lock file exists and if the process is still running
    IfFileExists "$APPDATA\${APP_DATA_DIR}\vayu.lock" 0 initDone
      ; Lock file exists, check if process is running by reading PID
      ; For simplicity, just remove stale lock files during install
      ; The engine will create a new one if needed
      Delete "$APPDATA\${APP_DATA_DIR}\vayu.lock"

  initDone:
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
    Goto cleanupDone

  removeData:
    ; Remove the app's userData directory - database, logs, settings, caches.
    ;
    ; Guarded rather than unconditional. This branch spent its whole life
    ; deleting a tree it only believed was the app's, and a wrong RMDir /r is
    ; silent in both directions: it removes nothing when the name is wrong, and
    ; removes someone else's data if it is wrong the other way. If the
    ; directory is not there, say so in the log and leave the disk alone.
    IfFileExists "$APPDATA\${APP_DATA_DIR}\*.*" 0 dataDirMissing
      RMDir /r "$APPDATA\${APP_DATA_DIR}"
      Goto cleanupDone

  dataDirMissing:
    DetailPrint "No Vayu data directory at $APPDATA\${APP_DATA_DIR} - nothing to delete."

  cleanupDone:
    !insertmacro restoreShellContext
!macroend
