# Příkazy Xcode a jejich protějšky ve SwiDe

Inventář odpovídá historické verzi 0.3.2 vydané pod názvem Xcode Pocket.

[Inventář příkazů v CSV](XCODE-PRIKAZY.csv) obsahuje všech 1 154 řádků z tabulky `declared-commands.csv` v dodaném archivu `Xcode_REA_audit_Argon4_2026-11-12.zip`. Archiv zaznamenal verzi Xcode 27.2 a označení sestavení 27B52. Číslo řádku v inventáři začíná jedničkou u první deklarace po záhlaví. Při hledání používej sloupec `id_xcode`, protože některé názvy se opakují v různých editorech.

| Klasifikace | Počet deklarací | Význam |
|---|---:|---|
| Implementovaný protějšek | 23 | Editor má přímo dostupnou akci se stejným hlavním výsledkem v popsaném rozsahu. |
| Částečný protějšek | 87 | Editor řeší část úlohy nebo vyžaduje další ruční kroky. Poslední sloupec vymezuje rozdíl. |
| Protějšek nezjištěn | 994 | V porovnávaných zdrojích nebyla k tomuto ID nalezena doložitelná funkce. |
| Interní nebo neprůkazná deklarace | 50 | ID a název popisují například diagnostickou zkoušku, technické okno nebo výpis stavu. Zpřístupnění uživateli nebylo doloženo. |

### Jak vzniklo srovnání

Ke konkrétním ID byly přiřazeny pouze akce, pro které lze uvést cestu v rozhraní editoru a dohledatelný zdrojový soubor. Například příkaz pro přejmenování dokumentu má protějšek v editoru. Samostatný příkaz pro sémantické přejmenování symbolu má odlišné ID a zůstal bez přiřazení. Otevření historie větve na GitHubu se také nezapočítává jako přepnutí pracovní kopie na tuto větev.

Jednotkou počítání je **deklarace příkazu**. Více deklarací může vést ke stejné místní funkci. Celkové počty proto nepředstavují podíl funkcí Xcode dostupných v Pocketu. Položky ze standardních textových polí zařízení jsou označeny jako částečné. Ruční kroky, import reportů, vzdálená sestavení a jednorázové snímky jsou uvedeny v omezeních.

Srovnání vychází ze statického inventáře a zdrojů verze 0.3.2. Neobsahuje samostatnou zkoušku každého příkazu na Macu ani na iPhonu. Pro výsledek nad konkrétní IPA je potřeba zaznamenat její verzi, zařízení a skutečně provedené kroky. Přehled oblastí produktu je v [porovnání Xcode a SwiDe](XCODE-PARITA.md).

SHA-256 původního souboru `declared-commands.csv` je `88bd92d6be46d4a507654e831ce212a3c1ef4907d18ef57beb973254591a19f3`.
