# Kadr Player

Odtwarzacz wideo na Windows 10/11 (Electron + FFmpeg). Sponsorzy: **ProZlecenie.pl** i **CyberScope.pl** (instalator, ekran powitalny, „O programie”).

## Jak odtwarza
1. `ffprobe` czyta plik → wybór ścieżek (język dźwięku/napisów z ustawień).
2. Najtańsza droga, którą pokaże Chromium:
   - **bezpośrednio** — MP4/MKV/WebM/MP3/FLAC… z obsługiwanymi kodekami,
   - **remux bez strat** — ffmpeg `-c copy` do fragmentowanego MP4 (np. MKV z AC3, TS z H.264),
   - **konwersja w locie** — H.264 przez NVENC / Quick Sync / AMF / x264 (MPEG-2, WMV, Xvid, ProRes, 10-bit H.264, przeplot → bwdif, HDR → tonemap, wypalanie napisów ASS/PGS).
3. Strumienie z ffmpeg idą przez MediaSource. Flagi `-copyts` + `frag_discont+negative_cts_offsets` zachowują prawdziwe znaczniki czasu, więc przewijanie działa normalnie.
4. Zapasowa ścieżka: bezpośrednio → remux → konwersja. Kodek, który wywalił proces GPU, jest zapamiętywany (`badCodecs`). Gdy konwersja nie nadąża, rozdzielczość spada sama.

## Obraz (src/js/gl.js, WebGL2)
prep (przycięcie, obrót, płynny ruch, deband, kolory, sRGB→liniowe) → separowalne skalowanie Lanczos-3/Spline36/Mitchell/Catmull-Rom (jądro poszerzane przy pomniejszaniu, anti-ringing) → RCAS + dithering. Renderer „Natywny” = zwykły `<video>` (HDR, najlżejszy).

## Katalog filmów

Na ekranie startowym zobaczysz sześć popularnych filmów z plakatami. Wybierz **Filmy i seriale** lub naciśnij **Ctrl+K**, aby otworzyć katalog HydraHD. Możesz przeglądać popularne filmy, ostatnio dodane filmy i seriale lub wyszukać tytuł. Po wybraniu serialu wybierz sezon i odcinek w panelu obok wyników.

Kliknięcie plakatu filmu lub odcinka uruchamia odtwarzanie w głównym oknie. Porusz myszą, aby wyświetlić sterowanie i strzałkę powrotu. Strzałka kończy odtwarzanie i otwiera ostatnią listę wyników lub listę odcinków.

W katalogu możesz wybrać jeden z 21 gatunków filmowych. W obrębie gatunku zmienisz kolejność według popularności, daty dodania, premiery lub oceny. Wpisany tytuł możesz połączyć z gatunkiem albo zawęzić wyniki do filmów lub seriali.

Podczas oglądania naciśnij **V** lub kliknij **Napisy**. Wybierz **Wybierz napisy z HydraHD**, żeby wskazać język i wersję udostępnioną przez odtwarzacz. Własny plik SRT, VTT lub ASS wczytasz przyciskiem **Wczytaj plik napisów**.

Opcja **Generuj napisy z dźwięku** transkrybuje dialogi w języku nagrania. Możesz wybrać minutę, pięć minut lub cały film i zapisać wynik jako SRT. Potrzebujesz własnego klucza Groq. Dopiero kliknięcie **Wyślij dźwięk i wygeneruj** rozpoczyna wysyłkę. Dla HydraHD przygotowanie dźwięku odbywa się podczas odtwarzania. Przy plikach lokalnych dźwięk wyodrębnia FFmpeg. [Klucze Groq](https://console.groq.com/keys) · [Limity darmowego planu](https://console.groq.com/docs/rate-limits)

## Budowanie
```
npm install
npm start                 # uruchomienie z kodu
npm run icon              # build/icon-source.svg → ikony
npm run installer-art     # grafiki instalatora z logo sponsorów
npm run installer         # kopiuje ffmpeg.exe+ffprobe.exe (z PATH albo KADR_FFMPEG_DIR) do vendor/ i robi dist\Kadr-Player-Setup-X.Y.Z.exe
```
Testy: `KADR_DEBUG=1`, `KADR_TEST_SCRIPT=plik.js` (kod dostaje `app` i `K`; `window.kadr.test.shot/log/quit`), `KADR_NO_EXTERNAL=1`.
