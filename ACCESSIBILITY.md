# Přístupnost SwiDe

Cílem je, aby při výběru souboru, úpravě kódu a čtení výsledku sestavení šlo poznat aktuální stav i bez rozlišování barev. Při hlášení bariéry pomůže vědět, ve kterém kroku se práce zastavila.

## Co můžeš použít

Ve webovém editoru i v iOS aplikaci mají tlačítka v postranní liště textové názvy pro asistivní technologie. Strom souborů označuje vybraný soubor a stav rozbalených složek. Zdrojový text se upravuje v textovém poli. Dekorativní vrstva se zvýrazněním syntaxe a čísla řádků jsou před čtečkou skryté.

S hardwarovou klávesnicí otevřeš paletu příkazů pomocí **⌘K** a rychlé otevření souboru pomocí **⇧⌘O**. V paletě lze vybrat položku šipkami, potvrdit ji klávesou Enter a zavřít klávesou Escape.

## Rozsah ověření a známá omezení

U verze 0.4.0 automatické testy kontrolovaly navigaci při šířce 320 pixelů a práci se souborem ve WKWebView simulovaného iPhonu. Ověření celého postupu s VoiceOverem, Switch Control a největší systémovou velikostí textu na fyzickém zařízení zůstává otevřené. Editor kódu má pevně nastavenou velikost písma. Statický snímek simulátoru má jen obecný alternativní popis, takže z něj čtečka nezíská obsah zobrazené aplikace.

## Jak nahlásit překážku

[Otevři hlášení chyby](https://github.com/HappyMistake64/Xcode-for-iphone/issues/new?template=bug_report.md). Stačí napsat například „Po přidání souboru nevím, kam se přesunul fokus.“ Doplň zařízení, verzi iOS, prostředí (Safari nebo aplikace), použitou pomůcku a krok, kde problém nastal. U VoiceOveru pomůže přesné znění toho, co přečetl. Snímek obrazovky je nepovinný.
