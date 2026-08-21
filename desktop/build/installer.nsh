!include "LogicLib.nsh"
!include "getProcessInfo.nsh"
!define /ifndef INSTALL_REGISTRY_KEY "Software\${APP_GUID}"
!define /ifndef UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
Var pid
Var ccHeiheiProcessDiagnostic

!ifndef BUILD_UNINSTALLER
Var ccHeiheiRecoveryDone
Var ccHeiheiPerUserInstallLocation
Var ccHeiheiPerMachineInstallLocation
Var ccHeiheiPerUserUninstallString
Var ccHeiheiPerMachineUninstallString

Function CcHeiheiUninstallerParent
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R2 0

  cc_heihei_uninstall_parent_find_first_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_heihei_uninstall_parent_invalid
    StrCmp $R1 '"' cc_heihei_uninstall_parent_after_first_quote
    IntOp $R2 $R2 + 1
    Goto cc_heihei_uninstall_parent_find_first_quote

  cc_heihei_uninstall_parent_after_first_quote:
    IntOp $R2 $R2 + 1
    StrCpy $R0 $R0 "" $R2
    StrCpy $R2 0

  cc_heihei_uninstall_parent_find_second_quote:
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "" cc_heihei_uninstall_parent_invalid
    StrCmp $R1 '"' cc_heihei_uninstall_parent_have_file
    IntOp $R2 $R2 + 1
    Goto cc_heihei_uninstall_parent_find_second_quote

  cc_heihei_uninstall_parent_have_file:
    StrCpy $R0 $R0 $R2
    StrLen $R2 $R0

  cc_heihei_uninstall_parent_find_slash:
    IntOp $R2 $R2 - 1
    IntCmp $R2 0 cc_heihei_uninstall_parent_invalid 0 0
    StrCpy $R1 $R0 1 $R2
    StrCmp $R1 "\" cc_heihei_uninstall_parent_done
    Goto cc_heihei_uninstall_parent_find_slash

  cc_heihei_uninstall_parent_invalid:
    StrCpy $R0 ""
    Goto cc_heihei_uninstall_parent_done

  cc_heihei_uninstall_parent_done:
    StrCpy $R0 $R0 $R2
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHeiheiFinalInstallDir
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  StrCpy $R1 "${APP_FILENAME}"
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 0

  cc_heihei_final_install_find_name:
    IntCmp $R4 $R3 cc_heihei_final_install_append 0 cc_heihei_final_install_append
    StrCpy $R5 $R0 $R2 $R4
    StrCmp $R5 $R1 cc_heihei_final_install_done
    IntOp $R4 $R4 + 1
    Goto cc_heihei_final_install_find_name

  cc_heihei_final_install_append:
    StrCpy $R0 "$R0\${APP_FILENAME}"

  cc_heihei_final_install_done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function CcHeiheiCanSkipLegacyRecovery
  Push $R3
  Push $R0
  Push $R1
  Push $R2

  StrCpy $R0 "0"
  ${If} $8 != "trusted-user"
    Goto cc_heihei_skip_recovery_done
  ${EndIf}
  ${If} $ccHeiheiPerUserInstallLocation == ""
    Goto cc_heihei_skip_recovery_done
  ${EndIf}
  ${If} $ccHeiheiPerMachineInstallLocation != ""
    Goto cc_heihei_skip_recovery_done
  ${EndIf}
  ${If} $ccHeiheiPerMachineUninstallString != ""
    Goto cc_heihei_skip_recovery_done
  ${EndIf}
  StrCmp $ccHeiheiPerUserInstallLocation $INSTDIR 0 cc_heihei_skip_recovery_done

  ReadEnvStr $R1 APPDATA
  ${If} $R1 == ""
    Goto cc_heihei_skip_recovery_done
  ${EndIf}
  ReadEnvStr $R0 CLAUDE_CONFIG_DIR
  ${If} $R0 != ""
    StrCpy $R0 "0"
    Goto cc_heihei_skip_recovery_done
  ${EndIf}
  StrCpy $R0 "0"

  IfFileExists "$ccHeiheiPerUserInstallLocation\CLAUDE_CONFIG_DIR\*.*" cc_heihei_skip_recovery_done 0
  IfFileExists "$R1\Claude Code Heihei\app-mode.json" cc_heihei_check_default_mode 0
  StrCpy $R0 "1"
  Goto cc_heihei_skip_recovery_done

  cc_heihei_check_default_mode:
    ClearErrors
    FileOpen $R2 "$R1\Claude Code Heihei\app-mode.json" r
    IfErrors cc_heihei_skip_recovery_done 0
    FileRead $R2 $R3
    StrCmp $R3 '{$\n' 0 cc_heihei_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '  "mode": "default",$\n' 0 cc_heihei_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '  "portable_dir": null$\n' 0 cc_heihei_close_mode_file
    FileRead $R2 $R3
    StrCmp $R3 '}' 0 cc_heihei_close_mode_file
    ClearErrors
    FileRead $R2 $R3
    IfErrors 0 cc_heihei_close_mode_file
    StrCpy $R0 "1"

  cc_heihei_close_mode_file:
    FileClose $R2

  cc_heihei_skip_recovery_done:
    StrCpy $R3 $R0
    Pop $R2
    Pop $R1
    Pop $R0
    Exch $R3
FunctionEnd

Function CcHeiheiRecoverLegacy
  ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $5 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R0 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R0 HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $4 == ""
  ${AndIf} $R0 != ""
    Push $R0
    Call CcHeiheiUninstallerParent
    Pop $4
  ${EndIf}
  ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $R1 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  ${If} $5 == ""
  ${AndIf} $R1 != ""
    Push $R1
    Call CcHeiheiUninstallerParent
    Pop $5
  ${EndIf}

  Push "$INSTDIR"
  Call CcHeiheiFinalInstallDir
  Pop $9

  ${If} $4 == ""
  ${AndIf} $5 == ""
    StrCpy $0 "0"
    StrCpy $1 "No registered installation needs legacy data recovery"
    DetailPrint "$1"
    Return
  ${EndIf}

  InitPluginsDir
  File /oname=$PLUGINSDIR\recover-legacy-install-data.ps1 "${BUILD_RESOURCES_DIR}\recover-legacy-install-data.ps1"

  ReadEnvStr $2 APPDATA
  ReadEnvStr $3 USERPROFILE
  ReadEnvStr $6 CLAUDE_CONFIG_DIR
  ReadEnvStr $7 CC_HEIHEI_APP_PORTABLE_DIR
  ${If} $2 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user APPDATA"
    Return
  ${EndIf}
  ${If} $3 == ""
    StrCpy $0 "21"
    StrCpy $1 "missing current-user USERPROFILE"
    Return
  ${EndIf}

  DetailPrint "Checking registered installations for legacy Claude Code Heihei data..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\recover-legacy-install-data.ps1" -PerUserInstallDir "$4" -PerMachineInstallDir "$5" -CandidateInstallDir "$9" -UserDataDir "$2\Claude Code Heihei" -RecoveryRoot "$3\Claude Code Heihei Data\Recovered" -ProcessName "${PRODUCT_FILENAME}.exe" -ActiveConfigDir "$6" -ActiveConfigManaged "$7" -InstallerIdentitySafety "$8"'
  Pop $0
  Pop $1
FunctionEnd

!macro CcHeiheiRunLegacyRecovery
  ${If} $ccHeiheiRecoveryDone != "1"
    ReadRegStr $ccHeiheiPerUserInstallLocation HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHeiheiPerMachineInstallLocation HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $ccHeiheiPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ReadRegStr $ccHeiheiPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ${If} $ccHeiheiPerUserUninstallString == ""
        ReadRegStr $ccHeiheiPerUserUninstallString HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
      ${If} $ccHeiheiPerMachineUninstallString == ""
        ReadRegStr $ccHeiheiPerMachineUninstallString HKLM "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      ${EndIf}
    !endif

    ${If} $ccHeiheiPerUserInstallLocation == ""
    ${AndIf} $ccHeiheiPerMachineInstallLocation == ""
    ${AndIf} $ccHeiheiPerUserUninstallString == ""
    ${AndIf} $ccHeiheiPerMachineUninstallString == ""
      StrCpy $ccHeiheiRecoveryDone "1"
      DetailPrint "No registered installation needs legacy data recovery"
    ${Else}
      StrCpy $8 "trusted-user"
      ${If} ${UAC_IsAdmin}
      ${AndIfNot} ${UAC_IsInnerInstance}
        StrCpy $8 "untrusted-elevated"
      ${EndIf}
      ${If} ${UAC_IsInnerInstance}
        StrCpy $8 "trusted-uac-outer"
      ${EndIf}

      Call CcHeiheiCanSkipLegacyRecovery
      Pop $R0
      ${If} $R0 == "1"
        StrCpy $ccHeiheiRecoveryDone "1"
        DetailPrint "No legacy data candidates found for the registered per-user installation"
      ${Else}
        ${If} ${UAC_IsInnerInstance}
          !insertmacro UAC_AsUser_Call Function CcHeiheiRecoverLegacy ${UAC_SYNCREGISTERS}|${UAC_SYNCOUTDIR}|${UAC_SYNCINSTDIR}
        ${Else}
          Call CcHeiheiRecoverLegacy
        ${EndIf}

        ${If} $0 != "0"
          DetailPrint "Legacy data recovery stopped the installer (helper exit code: $0; output: $1)"
          ${If} $1 == ""
            StrCpy $1 "Recovery helper failed without diagnostic output (exit code $0)"
          ${EndIf}
          StrCpy $R2 "$1" 360
          MessageBox MB_ICONSTOP|MB_OK "Claude Code Heihei stopped setup before removing the old version. Reason: $R2$\r$\n$\r$\nClose the app and retry. If the reason mentions an elevated installer, launch setup normally instead of using Run as administrator.$\r$\n$\r$\nClaude Code Heihei 已在删除旧版本前停止安装。原因：$R2$\r$\n$\r$\n请关闭旧程序后重试；如果原因提到安装器权限过高，请直接双击运行，不要使用“以管理员身份运行”。旧版本和原数据尚未删除。" /SD IDOK
          SetErrorLevel 20
          Quit
        ${EndIf}
        StrCpy $ccHeiheiRecoveryDone "1"
        DetailPrint "Legacy Claude Code Heihei data safety check completed"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro CcHeiheiFindInstallProcess _FILE _RETURN
  ${If} $IsPowerShellAvailable == 0
    nsExec::ExecToStack '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-install-processes.ps1" -InstallDir "$INSTDIR" -ProcessName "${_FILE}" -Action Find -InstallerPid "$pid" -InstallerParentPid "$1"'
    Pop ${_RETURN}
    Pop $ccHeiheiProcessDiagnostic
    ${If} $ccHeiheiProcessDiagnostic != ""
      DetailPrint "$ccHeiheiProcessDiagnostic"
    ${EndIf}
  ${Else}
    Delete "$PLUGINSDIR\cc-heihei-processes.csv"
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec '"$CmdPath" /D /C tasklist /FO CSV /NH > "$PLUGINSDIR\cc-heihei-processes.csv"'
    !else
      nsExec::Exec '"$CmdPath" /D /C tasklist /FI "USERNAME eq %USERNAME%" /FO CSV /NH > "$PLUGINSDIR\cc-heihei-processes.csv"'
    !endif
    Pop ${_RETURN}
    ${If} ${_RETURN} != 0
      StrCpy $ccHeiheiProcessDiagnostic "PowerShell unavailable and tasklist process enumeration failed (exit code ${_RETURN}); blocking setup."
      StrCpy ${_RETURN} 0
    ${Else}
      nsExec::Exec '"$SYSDIR\findstr.exe" /I /L /C:"${_FILE}" /C:"claude-sidecar-x86_64-pc-windows-msvc.exe" /C:"claude-sidecar-aarch64-pc-windows-msvc.exe" /C:"claude-sidecar.exe" /C:"OpenConsole.exe" /C:"winpty-agent.exe" /C:"rg.exe" "$PLUGINSDIR\cc-heihei-processes.csv"'
      Pop ${_RETURN}
      ${If} ${_RETURN} == 0
        StrCpy $ccHeiheiProcessDiagnostic "PowerShell unavailable; the main app, a known sidecar, or a bundled terminal/search helper is running with an unknown path. Close it manually."
      ${ElseIf} ${_RETURN} == 1
        StrCpy $ccHeiheiProcessDiagnostic "PowerShell unavailable; exact-image fallback found no main app, known sidecar, or bundled terminal/search helper. Differently named child processes cannot be attributed without path data."
      ${Else}
        StrCpy $ccHeiheiProcessDiagnostic "PowerShell unavailable and fallback process filtering failed (exit code ${_RETURN}); blocking setup."
        StrCpy ${_RETURN} 0
      ${EndIf}
    ${EndIf}
    DetailPrint "$ccHeiheiProcessDiagnostic"
  ${EndIf}
!macroend

!macro CcHeiheiKillInstallProcess _FILE _FORCE
  Push $0
  ${If} ${_FORCE} == 1
    StrCpy $0 "KillForce"
  ${Else}
    StrCpy $0 "Kill"
  ${EndIf}

  ${If} $IsPowerShellAvailable == 0
    nsExec::ExecToStack '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\check-install-processes.ps1" -InstallDir "$INSTDIR" -ProcessName "${_FILE}" -Action "$0" -InstallerPid "$pid" -InstallerParentPid "$1"'
    Pop $0
    Pop $ccHeiheiProcessDiagnostic
    ${If} $ccHeiheiProcessDiagnostic != ""
      DetailPrint "$ccHeiheiProcessDiagnostic"
    ${EndIf}
  ${Else}
    StrCpy $ccHeiheiProcessDiagnostic "PowerShell unavailable; refusing to terminate by image name because the executable path is unknown. Close the app manually."
    DetailPrint "$ccHeiheiProcessDiagnostic"
  ${EndIf}
  Pop $0
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\check-install-processes.ps1 "${BUILD_RESOURCES_DIR}\check-install-processes.ps1"
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $ccHeiheiProcessDiagnostic ""
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${If} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${If} ${isUpdated}
      Sleep 300
    ${EndIf}

    !insertmacro CcHeiheiFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${If} ${isUpdated}
        Sleep 1000
        Goto cc_heihei_stop_process
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK cc_heihei_stop_process
      SetErrorLevel 22
      Quit

      cc_heihei_stop_process:
        DetailPrint "$(appClosing)"
        !insertmacro CcHeiheiKillInstallProcess "${APP_EXECUTABLE_FILENAME}" 0
        Sleep 300
        StrCpy $R1 0

      cc_heihei_process_retry:
        IntOp $R1 $R1 + 1
        !insertmacro CcHeiheiFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
        ${If} $R0 == 0
          Sleep 1000
          !insertmacro CcHeiheiKillInstallProcess "${APP_EXECUTABLE_FILENAME}" 1
          !insertmacro CcHeiheiFindInstallProcess "${APP_EXECUTABLE_FILENAME}" $R0
          ${If} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${Else}
            Goto cc_heihei_process_not_running
          ${EndIf}
        ${Else}
          Goto cc_heihei_process_not_running
        ${EndIf}

        ${If} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)$\r$\n$\r$\n$ccHeiheiProcessDiagnostic" /SD IDCANCEL IDRETRY cc_heihei_process_retry
          SetErrorLevel 22
          Quit
        ${Else}
          Goto cc_heihei_process_retry
        ${EndIf}

      cc_heihei_process_not_running:
    ${EndIf}
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
    !insertmacro CcHeiheiRunLegacyRecovery
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!macro customPageAfterChangeDir
  Function CcHeiheiRecoveryBeforeInstall
    ${If} ${UAC_IsInnerInstance}
      !insertmacro CcHeiheiRunLegacyRecovery
    ${EndIf}
    Abort
  FunctionEnd
  Page custom CcHeiheiRecoveryBeforeInstall
!macroend

!macro customInit
  StrCpy $ccHeiheiRecoveryDone "0"
  ${If} ${UAC_IsInnerInstance}
  ${AndIf} ${Silent}
    !insertmacro CcHeiheiRunLegacyRecovery
  ${EndIf}
!macroend
!endif
