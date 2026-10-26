; Included by electron-builder's NSIS installer and uninstaller (build.nsis.include).
;
; The installer copies itself to %LOCALAPPDATA%\shellmind-updater\installer.exe
; (APP_INSTALLER_STORE_FILE, in installApplicationFiles), the base that
; electron-updater downloads differential updates against, and the uninstaller
; never removes that copy. ShellMind has no updater (build.publish is null), so
; it is only a ~100 MB orphan per install: customInstall, which runs after the
; copy (templates/nsis/installSection.nsh), deletes it and customUnInstall
; deletes it again on uninstall.
;
; The copy goes to the user's own local app data even in a per-machine install,
; where $LOCALAPPDATA follows SetShellVarContext all: hence ReadEnvStr. RMDir
; without /r only removes the folder when nothing else is left in it.

!ifdef APP_INSTALLER_STORE_FILE
  !define SHELLMIND_INSTALLER_COPY "${APP_INSTALLER_STORE_FILE}"
!else
  !define SHELLMIND_INSTALLER_COPY "shellmind-updater\installer.exe"
!endif

!macro shellmindRemoveInstallerCopy
  Push $0
  Push $1
  ReadEnvStr $0 LOCALAPPDATA
  ${if} $0 != ""
    Delete "$0\${SHELLMIND_INSTALLER_COPY}"
    ${StdUtils.GetParentPath} $1 "$0\${SHELLMIND_INSTALLER_COPY}"
    RMDir "$1"
  ${endif}
  ClearErrors
  Pop $1
  Pop $0
!macroend

!macro customInstall
  !insertmacro shellmindRemoveInstallerCopy
!macroend

!macro customUnInstall
  !insertmacro shellmindRemoveInstallerCopy
!macroend
