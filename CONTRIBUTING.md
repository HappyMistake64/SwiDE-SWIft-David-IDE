# Jak přispět do SwiDe

K hlášení chyby nebo návrhu na zlepšení ti stačí iPhone a účet na GitHubu. Nejdřív zkus najít existující issue podle chybové hlášky nebo názvu ovládacího prvku. Pokud popisuje stejný problém, přidej k němu své poznatky.

## Chyby a návrhy

V [nabídce hlášení](https://github.com/HappyMistake64/Xcode-for-iphone/issues/new/choose) vyber chybu nebo návrh funkce. U chyby pomůže přesný sled klepnutí, verze aplikace a rozdíl mezi očekávaným a skutečným výsledkem. U návrhu popiš, co chceš na iPhonu udělat a kde se dnes zastavíš. Pro otázky můžeš použít [Discussions](https://github.com/HappyMistake64/Xcode-for-iphone/discussions).

Pokud se hlášení týká úniku tokenu, cizího kódu nebo přístupu k jinému sestavení, postupuj podle [bezpečnostních pravidel](SECURITY.md). Překážky při ovládání s asistivní technologií popisuje [stránka přístupnosti](ACCESSIBILITY.md).

## Změny kódu nebo dokumentace

1. Vytvoř větev ve své kopii repozitáře a uprav soubory pro jednu konkrétní změnu. Mobilní rozhraní je ve složce `web/`, iOS obal v `pocket-editor/` a generátor projektu v `native-build/`.
2. Vyzkoušej postup, který změna ovlivňuje. Pro rychlou kontrolu importu a komunikace editoru spusť z kořene projektu s Node.js 22 následující příkaz.

   ```sh
   node --test tests/web-core.test.mjs tests/device-files.test.mjs
   ```

   Pythonové testy můžeš spustit příkazem `python3 -m unittest discover -s tests -v`. Testy vyžadující Xcode používají macOS.
3. Otevři pull request do větve `main`. Napiš, co se pro uživatele změnilo, jak jsi změnu ověřil a které prostředí jsi použil. U úpravy rozhraní může pomoci snímek nebo krátký záznam bez soukromých údajů.

Pro ukázku použij malý vlastní projekt. Soubory odeslané do veřejného repozitáře včetně historie sestavení si mohou přečíst ostatní. Při spolupráci platí [pravidla komunity](CODE_OF_CONDUCT.md).
