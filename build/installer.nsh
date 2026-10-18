!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "OpenSpawn Bot is installed"
  !define MUI_FINISHPAGE_TEXT "OpenSpawn Bot has been installed on your computer.$\r$\n$\r$\nOpen it yourself from the desktop shortcut or the Start menu whenever you are ready.$\r$\n$\r$\nClick Close to exit Setup."
  !define MUI_FINISHPAGE_BUTTON "Close"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUnInit
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$dirs = @('$INSTDIR', (Join-Path $$env:LOCALAPPDATA 'OpenSpawn Bot')); $$profiles = Join-Path $$env:APPDATA 'OpenSpawn Bot\browser-profiles'; Get-CimInstance Win32_Process | Where-Object { $$p = $$_; ($$p.ExecutablePath -and ($$dirs | Where-Object { $$p.ExecutablePath.StartsWith($$_, [StringComparison]::OrdinalIgnoreCase) })) -or ($$p.CommandLine -and $$p.CommandLine.Contains($$profiles)) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\OpenSpawn Bot"
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your OpenSpawn Bot chats and settings?$\r$\n$\r$\nChoose No to keep them for the next time you install it." /SD IDNO IDYES deleteUserData IDNO keepUserData
    deleteUserData:
      RMDir /r "$APPDATA\OpenSpawn Bot"
    keepUserData:
  ${endIf}
!macroend
