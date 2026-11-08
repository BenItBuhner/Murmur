; Ensure Murmur is not running during (un)install so files/hooks are released cleanly.
!macro customInit
  nsExec::Exec 'taskkill /f /im Murmur.exe'
!macroend

; An update (--updated) keeps the user's shortcuts as they are, so one that went missing never
; comes back and Murmur drops out of Start and Windows search. Always restore the Start menu entry.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    !insertmacro createMenuDirectory
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /f /im Murmur.exe'
!macroend
