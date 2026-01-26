; Vayu NSIS Installer Script
; Handles closing running instances, reinstalls, and cleanup
;
; Process names and directories must match:
;   - productName in electron-builder.json: "Vayu" → Vayu.exe
;   - Electron userData: app.getPath("userData") → AppData\Roaming\Vayu
;
; Lock file handling:
;   - Lock file path: %APPDATA%\Vayu\vayu.lock
;   - Cleaned up during install (stale locks) and uninstall
;   - Also handled automatically in app startup (sidecar.ts)

!include "MUI2.nsh"
!include "FileFunc.nsh"

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
    ; Clean up any stale lock files from previous installations or crashes
    ; Lock file path: %APPDATA%\Vayu\vayu.lock
    ; Check if lock file exists and if the process is still running
    IfFileExists "$APPDATA\Vayu\vayu.lock" 0 initDone
      ; Lock file exists, check if process is running by reading PID
      ; For simplicity, just remove stale lock files during install
      ; The engine will create a new one if needed
      Delete "$APPDATA\Vayu\vayu.lock"
  
  initDone:
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
    ; Lock file path: %APPDATA%\Vayu\vayu.lock (not in db subdirectory)
    Delete "$APPDATA\Vayu\vayu.lock"
    Goto cleanupDone
    
  removeData:
    ; Remove main app data directory (Electron userData)
    ; Path: %APPDATA%\Vayu (from productName in electron-builder.json)
    RMDir /r "$APPDATA\Vayu"

    ; Remove Electron cache/local storage
    ; Path: %LOCALAPPDATA%\Vayu
    RMDir /r "$LOCALAPPDATA\Vayu"
    
  cleanupDone:
!macroend
