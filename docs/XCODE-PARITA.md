# Xcode Pocket 0.3.0 a Xcode pro Mac

Srovnání vychází z katalogu dodaného archivu Xcode 27.2, mobilní IPA 0.2.0 a zdrojů verze 0.3.0. Inventář našel 1 154 deklarací příkazů, 194 čitelných manifestů rozšíření a 455 čitelných šablon. Statické deklarace samy neověřují chování příkazů. Tato tabulka porovnává uživatelské výsledky.

| Oblast Xcode | V 0.2.0 | V 0.3.0 | Zbývající rozdíl |
|---|---|---|---|
| Navigátor a Swift editor | Strom, hledání, symboly, historie, kontrolní bod | Přesun a přejmenování souborů, úryvky, pohled se sbalenými bloky a lokální nápověda | Sémantické refaktoringy a kompletní sada příkazů SourceEditoru |
| Zdrojový projekt a schéma | ZIP šel upravit a exportovat | Ze ZIPu lze vybrat sdílené schéma .xcodeproj, výslovně schválit sestavení IPA nebo snímek ze simulátoru | Vlastní editor targetů, build phases, konfigurací, workspaces a správa SwiftPM závislostí |
| Sestavení, testy a chyby | Sestavení iOS, XCTest na runneru, odkazy na logy | Strukturované diagnostiky a výsledky XCTest, import protokolu s ověřením běhu a otevření odpovídajícího zdrojového řádku | Interaktivní správce testovacích plánů, pokrytí kódu a UI test recorder |
| SourceKit | Lexikální zvýraznění a obrys deklarací | Jednorázový dotaz na definici či doplnění pro uložený snímek aplikačního targetu | Trvalá relace, návrhy při každém úhozu a indexace libovolného workspace |
| Debugger | Snímek po spuštění v simulátoru | Jednorázový LLDB záznam na zadaném zdrojovém řádku, zásobník a dostupné lokální proměnné | Krokování ovládané z telefonu, podmíněné breakpointy, konzole a memory graph |
| Git | Snapshot na GitHubu | Porovnání změn textových souborů s odeslaným snímkem či kontrolním bodem, vrácení vybraného souboru | Staging, práce s větvemi, merge konflikty, pull requesty a úplná historie |
| Assets a lokalizace | Podporované assety šlo přenést přes JSON v3 | Vložení PNG/JPEG do univerzálního imagesetu; úprava jednoduchých překladových jednotek původního ZIP projektu | Plný editor variant, AppIcon, plurály, export/import lokalizací |
| Rozhraní aplikace | Jednotlivý snímek simulátoru | Snímek pro Pocket projekt i pro podporovaný původní projekt | Živý SwiftUI Canvas, interaktivní obraz a ovládání simulátoru, Interface Builder |
| Distribuce | IPA a externí podpis přes SideStore | Aktualizace editoru stejnou cestou | Organizer, archivace pro App Store, TestFlight, správa certifikátů a připojených zařízení |
| Další prostředí a nástroje | Zaměření na iPhone a vzdálený macOS | Stejný rozsah platforem | Instruments, GPU profiler, sanitizéry s interaktivním zobrazením, další Apple platformy, úplné katalogy šablon, integrovaní AI agenti a kompletní offline dokumentace |

CI rozlišuje sestavení editoru, původní Xcode projekt, ověření SourceKit a záznam ze simulátoru. Pro přejímku na fyzickém telefonu je třeba projít odpovídající funkci s reálným projektem a účtem. Výstupy z GitHubu se vztahují ke konkrétnímu snímku a běhu.
