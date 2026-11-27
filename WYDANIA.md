# Wydania i aktualizacje Kadr

Kadr (od 1.4.0) sam sprawdza przy starcie publiczne wydania tego repozytorium (`electron-updater`, kanał GitHub).
Gdy jest nowsza wersja, pokazuje „Dostępna aktualizacja Kadr Player” → **Pobierz** / **Później**,
a po pobraniu **Uruchom ponownie i zainstaluj** (film gra dalej, dopóki użytkownik nie kliknie).
Ręcznie: *O programie → Sprawdź aktualizacje*. Ustawienia i historia (`%APPDATA%\Kadr Player`) zostają.

Wersję 1.3.0 i starsze trzeba raz zaktualizować ręcznie do 1.4.0 (nie mają aktualizatora).

## Nowa wersja

```powershell
npm version 1.4.1            # zmienia "version" w package.json, robi commit i tag v1.4.1
git push origin main --follow-tags
```

Tag `vX.Y.Z` uruchamia `.github/workflows/release.yml`: testy → FFmpeg (Gyan 9.0.2 full, z filtrem whisper) →
`npm run installer` → sprawdzenie `latest.yml` / `.blockmap` → szkic wydania → wysłanie
`Kadr-Player-Setup-X.Y.Z.exe`, `Kadr-Player-Setup-X.Y.Z.exe.blockmap`, `latest.yml` → publikacja jako „Latest”.
Aplikacje widzą wydanie dopiero po publikacji, czyli gdy są już wszystkie trzy pliki.
Tag musi być równy wersji z `package.json`, inaczej workflow przerywa.

Postęp: `gh run watch -R CpMiko2005pl/KadrPlayer`, wynik: `gh release view vX.Y.Z -R CpMiko2005pl/KadrPlayer`.

## Lokalnie (bez publikacji)

```powershell
$env:KADR_FFMPEG_DIR = 'C:\ścieżka\do\ffmpeg\bin'   # albo ffmpeg w PATH
npm run installer                                   # dist\Kadr-Player-Setup-X.Y.Z.exe + latest.yml + .blockmap
node scripts/verify-release.js
```

`appId` (`fun.tacticalops.kadrplayer`) nie może się zmienić — inaczej instalator nie zaktualizuje istniejącego Kadr.
