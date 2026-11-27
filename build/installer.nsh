; Kadr — installer additions (electron-builder nsis.include)
; • welcome page with the sponsors (sidebar bitmap + text)
; • a "Sponsorzy" page after choosing the folder: two clickable sponsor cards
; • a sponsor link on the finish page

!include nsDialogs.nsh
!include LogicLib.nsh

!define KP_PZ_URL "https://prozlecenie.pl/?utm_source=kadr-player&utm_medium=installer"
!define KP_CS_URL "https://cyberscope.pl/?utm_source=kadr-player&utm_medium=installer"

!define MUI_FINISHPAGE_LINK "$(kpFinishLink)"
!define MUI_FINISHPAGE_LINK_LOCATION "${KP_PZ_URL}"
!define MUI_FINISHPAGE_LINK_COLOR "E8452C"

!macro customHeader
  LangString kpWelcomeTitle ${LANG_POLISH} "Witaj w instalatorze Kadr"
  LangString kpWelcomeTitle ${LANG_ENGLISH} "Welcome to Kadr Setup"
  LangString kpWelcomeText ${LANG_POLISH} "Kadr odtwarza każdy format wideo i audio — MKV, MP4, AVI, WMV, MOV, TS, FLV, HEVC, AV1… — w najlepszej jakości: skalowanie Lanczos, wyostrzanie AMD RCAS, płynny ruch, korektor dźwięku i polskie napisy (SRT, MicroDVD, MPL2, ASS).$\r$\n$\r$\nInstalacja nie wymaga uprawnień administratora.$\r$\n$\r$\nProgram jest darmowy dzięki sponsorom: ProZlecenie.pl i CyberScope.pl. Dziękujemy!$\r$\n$\r$\nKliknij Dalej, aby kontynuować."
  LangString kpWelcomeText ${LANG_ENGLISH} "Kadr plays every video and audio format — MKV, MP4, AVI, WMV, MOV, TS, FLV, HEVC, AV1… — in the best quality: Lanczos scaling, AMD RCAS sharpening, smooth motion, an equalizer and subtitles.$\r$\n$\r$\nNo administrator rights needed.$\r$\n$\r$\nIt is free thanks to its sponsors: ProZlecenie.pl and CyberScope.pl. Thank you!$\r$\n$\r$\nClick Next to continue."
  LangString kpSponsorsTitle ${LANG_POLISH} "Sponsorzy Kadr"
  LangString kpSponsorsTitle ${LANG_ENGLISH} "Kadr sponsors"
  LangString kpSponsorsSub ${LANG_POLISH} "Kadr jest darmowy dzięki naszym sponsorom."
  LangString kpSponsorsSub ${LANG_ENGLISH} "Kadr is free thanks to our sponsors."
  LangString kpSponsorsText ${LANG_POLISH} "Kliknij kartę, aby otworzyć stronę sponsora w przeglądarce. Instalacja nie zostanie przerwana."
  LangString kpSponsorsText ${LANG_ENGLISH} "Click a card to open the sponsor's website in your browser. Setup will keep running."
  LangString kpFinishLink ${LANG_POLISH} "Sponsor: ProZlecenie.pl — fachowcy z Twojej okolicy"
  LangString kpFinishLink ${LANG_ENGLISH} "Sponsor: ProZlecenie.pl — local contractors (Poland)"
  !ifndef BUILD_UNINSTALLER
    Var kpImgPZ
    Var kpImgCS
    !insertmacro kpSponsorFunctions
  !endif
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(kpWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(kpWelcomeText)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom kpSponsorsShow kpSponsorsLeave
!macroend

; functions use MUI macros, so they are emitted from customHeader (after MUI2 is loaded)
!macro kpSponsorFunctions
  Function kpSponsorsShow
    !insertmacro MUI_HEADER_TEXT "$(kpSponsorsTitle)" "$(kpSponsorsSub)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    InitPluginsDir
    File "/oname=$PLUGINSDIR\kp-pz.bmp" "${BUILD_RESOURCES_DIR}\sponsor-prozlecenie.bmp"
    File "/oname=$PLUGINSDIR\kp-cs.bmp" "${BUILD_RESOURCES_DIR}\sponsor-cyberscope.bmp"

    ${NSD_CreateLabel} 0 0 100% 20u "$(kpSponsorsText)"
    Pop $0

    ${NSD_CreateBitmap} 0 36 440 80 ""
    Pop $1
    ${NSD_AddStyle} $1 0x00000100   ; SS_NOTIFY: the picture reports clicks
    ${NSD_SetImage} $1 "$PLUGINSDIR\kp-pz.bmp" $kpImgPZ
    ${NSD_OnClick} $1 kpOpenPZ

    ${NSD_CreateBitmap} 0 126 440 80 ""
    Pop $2
    ${NSD_AddStyle} $2 0x00000100
    ${NSD_SetImage} $2 "$PLUGINSDIR\kp-cs.bmp" $kpImgCS
    ${NSD_OnClick} $2 kpOpenCS

    nsDialogs::Show
  FunctionEnd

  Function kpSponsorsLeave
    ${NSD_FreeImage} $kpImgPZ
    ${NSD_FreeImage} $kpImgCS
  FunctionEnd

  Function kpOpenPZ
    Pop $0
    ExecShell "open" "${KP_PZ_URL}"
  FunctionEnd

  Function kpOpenCS
    Pop $0
    ExecShell "open" "${KP_CS_URL}"
  FunctionEnd
!macroend
