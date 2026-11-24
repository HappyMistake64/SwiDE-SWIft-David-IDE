# SwiDe — mobilní editor

Adresář `web/` obsahuje rozhraní editoru pro Safari a pro nativní aplikaci SwiDe. [Otevřít webovou verzi](https://happymistake64.github.io/SwiDE-SWIft-David-IDE/) · [Stáhnout SwiDe.ipa](https://github.com/HappyMistake64/SwiDE-SWIft-David-IDE/releases/latest/download/SwiDe.ipa)

## Soukromé sestavování v 0.6

Projekt zůstává při editaci na zařízení. Nastavení sestavování vyžaduje explicitní osobní soukromý repozitář se schválenou šablonou. Uživatel může ověřit automaticky stažený ZIP nebo archiv vybraný ze Souborů. Editor porovnává původ, konkrétní pokus i otisk IPA. Přístupový token zůstává pouze v paměti relace.

[Nastavení z iPhonu, přenos a migrace přístupu](../docs/PRIVATE_SETUP.md) · [Spolehlivá identita sestavení](../docs/RELIABLE_BUILDS.md)

## Publikování

GitHub Pages může publikovat web z main prostřednictvím pocket-pages.yml. Instalovaná nativní verze má vlastní přibalený editor a aktualizuje se samostatně.

## Podpis a instalace

Apple vyžaduje platný podpis, odpovídající provisioning a správnou distribuční cestu.

- Bezplatný Personal Team umožňuje krátkodobé testování přes Xcode; profil má sedmidenní platnost, ale toto řešení neumožňuje automaticky podepisovat pouze z iPhonu.
- Externí podpisové služby mohou podepsat vlastní IPA po registraci zařízení. Jde o službu třetí strany s možným poplatkem a rizikem revokace; žádné platby nebo registrace neprovádíme.
- Apple Developer Program podporuje standardní TestFlight a distribuci, ale jde o jinou cestu.
- Alternativní distribuce v EU neznamená možnost instalovat libovolný nepodepsaný IPA soubor.

Oficiální zdroje:
https://developer.apple.com/help/account/basics/about-your-developer-account
https://developer.apple.com/support/apps-in-the-eu
https://www.signulous.com/register

## Testy

Pro lokální statický web z kořene repozitáře:

    python3 -m http.server 8000 --directory web

Automatická validace:

    node --test tests/web-core.test.mjs
    python3 -m unittest discover -s tests -v

V GitHub Actions navíc běží skutečná kompilace na macOS a strukturální ověření nepodepsané IPA. Zdrojový kontrakt je v docs/RELIABLE_BUILDS.md.

K dokončení na skutečném iPhone 15 Pro zbývá ověřit Safari workflow po deployi, stažení artefaktu a samostatně podpis/instalaci/aktualizaci.
