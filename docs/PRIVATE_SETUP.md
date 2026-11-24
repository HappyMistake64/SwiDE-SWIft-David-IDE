# Soukromý build z iPhonu

SwiDe 0.6 používá samostatný soukromý repozitář na aplikaci. Jeho vlastník řídí přístup, uchovává snímky a čerpá vlastní kvótu GitHub Actions. Editor ověřuje přesný obsah šablony. Pro první pokus použij malý projekt bez osobních údajů.

## Založení v Safari

1. Přihlas se na GitHub pod osobním účtem. Vytvoř **nový soukromý repozitář** s výchozí větví `main`. Při založení vynech README, licenci a .gitignore. Nepoužívej fork veřejného editoru.
2. Z [čisté šablony v této revizi](../build-template) přenes přesně dva soubory. V Safari otevři zdrojový soubor v GitHubu a použij **Copy raw file**. V novém repozitáři vyber **Create a new file**, vlož cestu z tabulky a zkopírovaný obsah, potvrď commit přímo na `main`. U každého souboru zachovej koncový nový řádek. Tato ruční cesta funguje i bez samostatně publikovaného template repozitáře.
3. V **Settings → Actions → General** zkontroluj, že repozitář povoluje použitý veřejný reusable workflow a jeho připnuté akce. Další workflow do tohoto vyhrazeného repozitáře nepřidávej.
4. V **Settings → Developer settings → Personal access tokens → Fine-grained tokens** vytvoř časově omezený token. Jako Resource owner zvol svůj účet a v **Only select repositories** pouze nový privátní repozitář. Vyber **Contents: Read and write** a **Actions: Read and write**. Metadata jsou dostupná pro čtení. Administrace nebo změny workflow nejsou při sestavování potřebné.
5. V editoru otevři nastavení GitHubu, zadej `majitel/repozitar` a vlož token. Po ověření cíle můžeš sestavit místní Swift projekt. Po ukončení relace vlož token znovu. Zdroj projektu, token ani dočasnou adresu stažení neposílej do hlášení chyby.

| Zdroj | Cesta v soukromém repozitáři |
|---|---|
| [swide-build.yml](../build-template/.github/workflows/swide-build.yml) | `.github/workflows/swide-build.yml` |
| [swide-template.json](../build-template/swide-template.json) | `swide-template.json` |

Je-li z těchto přesných souborů publikována samostatná GitHub template repository, oba kroky kopírování nahradí **Use this template → Create a new repository → Private**. Běžný token editoru šablonu neinstaluje ani neaktualizuje. Při nesouladu ověř cestu, obsah a revizi obou souborů.

## Převzetí výsledku

V historii sestavení vyber konkrétní požadavek a zvol ověření IPA. Když Safari neumožní přímé stažení, otevři odkaz na tento soukromý artefakt na GitHubu, ulož celý ZIP do Souborů a vyber jej v editoru k ověření. Pokud Safari stažený ZIP samo rozbalí, stáhni původní archiv znovu se zachovanými bajty. Nově zabalený ZIP má jiný otisk. Editor porovnává archiv, identitu sestavení a bajty IPA. V nativní aplikaci pak sdílecí nabídka umožní uložit IPA do Souborů. Výsledná uživatelská IPA vyžaduje samostatný podpis a provisioning pro instalaci.

## Kvóta a data

Podle dokumentace z 24. listopadu 2026 GitHub Free zahrnuje 12 USD výpočetního kreditu za fakturační cyklus. Standardní macOS stojí 0,062 USD za minutu; za deset účtovaných minut spotřebuje 0,62 USD. Kredit se dělí s dalšími způsobilými úlohami vlastníka. Úložiště artefaktů má 500 MB sdílených s Packages. Bez platební metody se po vyčerpání kreditu placené výpočty zastaví. Pokud platební metodu máš, nastavení blokujícího rozpočtu najdeš v GitHub Billing. [Aktuální účtování GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Zdroje zůstávají v soukromém Gitu i po vypršení artefaktů. GitHub, lidé a aplikace s přístupem ke čtení repozitáře je mohou přečíst. Změna viditelnosti repozitáře může zpřístupnit i jeho historii. Pro oddělení spolupracovníků použij samostatný repozitář na aplikaci.

## Přechod z veřejného buildu

Starý klient nejprve nahrával soubor do repozitáře a poté spouštěl workflow. Odeber proto dřívějšímu build tokenu přístup k veřejnému editoru nebo jej odvolej v GitHubu. Aktualizuj web/PWA i nainstalovanou IPA. Případné samostatné instance starého webu mají vlastní distribuční cyklus. Existující veřejné commity včetně pocket-builds lze stále přečíst. Staré požadavky se nepřehrávají. Pro nový soukromý build otevři místní projekt a založ nový požadavek.
