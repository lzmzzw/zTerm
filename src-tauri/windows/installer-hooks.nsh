; Author: Liz
; Use the installer's shell context for both per-user and all-users installations.
!macro ZTERM_EXPLORER_ENTRY KEY TARGET
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\zTerm" "" "通过zTerm打开"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\zTerm" "Icon" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  ; Appending \. keeps drive roots from ending in a backslash before the closing quote.
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\zTerm\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --open-local "${TARGET}\."'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\zterm.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro ZTERM_EXPLORER_ENTRY "Directory" "%1"
  !insertmacro ZTERM_EXPLORER_ENTRY "Directory\Background" "%V"
  !insertmacro ZTERM_EXPLORER_ENTRY "Drive" "%1"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\zterm.exe"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\zTerm"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\zTerm"
  DeleteRegKey SHCTX "Software\Classes\Drive\shell\zTerm"
!macroend
