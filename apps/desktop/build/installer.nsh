; Ensure Murmur is not running during (un)install so files/hooks are released cleanly.
!macro customInit
  nsExec::Exec 'taskkill /f /im Murmur.exe'
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /f /im Murmur.exe'
!macroend
