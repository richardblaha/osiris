# Nasazení interaktivního chatu

Nástroj agenta `ask_user` je společný pro PWA po přihlášení, veřejný webový chat a WhatsApp.
Podporuje text, konečná čísla, kalendářní data, výběr jedné či více možností a potvrzení ano/ne.
Definice otázek a odpovědi ukládá migrace 019 do databáze tenantu s vazbou na uživatele a vlákno.
Otázka vyprší za 24 hodin. Odpověď se ověří a přijme jediným podmíněným zápisem; opakované odpovědi,
nesprávný vlastník a neznámé možnosti se odmítnou. Hodnota `false` zůstává zachována. Zrušení se uloží
a model dostane pokyn, aby navrženou akci neprovedl. Nástroj zjišťuje záměr uživatele; nepředstavuje
obecný mechanismus oprávnění pro libovolné nástroje MCP. Volání otázky současně s jiným nástrojem
se odmítne ještě před spuštěním kteréhokoli z nich.

PWA zobrazuje formuláře přímo ve zprávách asistenta. Každých 5 sekund při zobrazené stránce a také
při návratu do okna načítá stav ze serveru a přebírá dokončené vzdálené výměny zpráv, včetně zpráv
z WhatsAppu. Právě probíhající místní výměnu zpráv přitom nepřepisuje. Osobní webový chat podporuje
nahrávání souborů a záznam z mikrofonu. Soubory se ukládají do dočasného úložiště příslušného vlákna
uživatele se zachováním kontrol typu, signatury, velikosti a kvót. Jedna výměna zpráv může obsahovat
nejvýše 5 souborů o celkové velikosti 25 MB; jednotlivý soubor nahraný přes rozhraní může mít nejvýše
20 MB. Obrázky model obdrží jako obrázky. Text v UTF-8 se vloží přímo, nejvýše 100 000 znaků na soubor.
U PDF se pomocí Mistral OCR zpracuje nejvýše prvních 30 stran, u zvuku se použije přepis od Mistralu.
Ostatní podporované kancelářské dokumenty se uloží a zpřístupní souborovým nástrojům agenta;
aplikace netvrdí, že jejich obsah již přečetla. Nahrávání zvuku se zastaví po 5 minutách a při odebrání
komponenty se uvolní mikrofon. Dočasné soubory vyprší podle stávajících pravidel za 24 hodin.

Nastavení runtime v systémovém prostředí, případně přes operátor `RUNTIME_ENV_*` / `RUNTIME_SECRET_*`:

- `MISTRAL_API_KEY`: přístupový klíč pro OCR a přepis zvuku, nezávislý na zvoleném poskytovateli chatu.
- `AUDIO_MODEL=voxtral-mini-latest`, `OCR_MODEL=mistral-ocr-latest`.
- Chatové modely používané s obrázky musí podporovat obrazový vstup. Tokeny spotřebované přepisem
  se započítávají, pokud je poskytovatel vykazuje. OCR se účtuje podle stran a nepřevádí se na
  smyšlený počet tokenů.

WhatsApp přijímá obrázky, dokumenty, zvuk, odpovědi pomocí tlačítek a seznamů i dokončené formuláře
Flow. Soubory se stahují přes autentizované Graph API. Stahování ověřuje vráceného hostitele HTTPS,
odmítá přesměrování a omezuje velikost na 20 MB. Runtime následně ověřuje i obsah uloženého souboru.
Nástroj `send_chat_file` může výslovně nabídnout soubor ke stažení v PWA nebo k doručení jako médium
ve WhatsAppu. Interní koncový bod pro soubory poskytuje vlastníkovi vlákna pouze soubory nabídnuté
tímto nástrojem v aktuální výměně zpráv.

Jednoduché volby automaticky používají tlačítka odpovědí, nejvýše 3 s popisky do 20 znaků, nebo
nativní seznam, nejvýše 10 položek s popisky do 24 znaků. Ostatní otázky použijí text a odkaz do PWA,
kde je nutné přihlášení. Na jedno pole lze odpovědět také textem; příkaz `/zrusit` otázku zruší.
U více polí lze použít formulář v PWA, což je doporučený postup, nebo objekt JSON. Přepnutí tenantu
neopravňuje k odpovídání na otázky jiných tenantů. Runtime odmítá nativní odpovědi na otázky,
které již vypršely nebo byly zodpovězeny.

## Nativní formuláře WhatsApp Flows

Ve vlastním Meta WhatsApp Manageru zveřejněte odpovídající Flow a poté v komponentě control
nastavte mapování jeho ID:

```dotenv
WHATSAPP_FLOWS_JSON=[{"id":"123456789012345","screen":"FORM","fields":[{"name":"name","type":"text"},{"name":"date","type":"date"}]}]
```

Soubor `appointment-flow.json` obsahuje konkrétní příklad pro toto mapování. Ověřte jej a zveřejněte
v editoru Flow společnosti Meta. Otázky vytvářené za běhu musí obsahovat přesně uvedené názvy a typy
polí ve stejném pořadí. Odesílaná data obsahují `title`, `<name>_label` a u výběrových polí také
`<name>_options` s položkami `{ id, title }`. Flow musí při dokončovací akci vrátit stejné názvy polí.
UUID otázky se předává jako `flow_token` a po přijetí podepsaného webhooku se ověřuje proti otevřené
otázce přihlášeného odesílatele. Tyto statické a navigační formuláře nevyžadují koncový bod
`data_exchange` ani šifrovací klíče. Aplikace sama nemůže zajistit způsobilost účtu Meta ani ID
zveřejněných formulářů Flow. Pokud se nenajde odpovídající Flow nebo je odeslání odmítnuto,
zůstává dostupný náhradní formulář v PWA.

## Doručování a plánované zprávy

Migrace 010 v komponentě control ukládá ID odeslaných zpráv a webhooky se stavy
sent/delivered/read/failed tak, aby se již dosažený stav nevracel zpět. V části Profil → Aktivita a relace
se zobrazují stavy doručení pouze pro jednoznačně ověřené telefonní číslo daného uživatele.
Záznamy se uchovávají 7 dní. Události o stavu nevytvářejí zprávy ani znovu neotevírají 24hodinové okno.

Pro doručování výsledků plánovaných úloh mimo 24hodinové okno zahájené uživatelem zveřejněte
šablonu `osiris_result` v jazyce čeština s následujícím obsahem:

- Text zprávy (BODY): `Plánovaná úloha „{{1}}“ byla dokončena. Podrobnosti najdete v aplikaci.`
- Parametr `{{1}}` v textu: název úlohy, například `Souhrn zakázek`.
- První tlačítko: **Zobrazit výsledek**, typ **Navštívit web**, dynamická URL
  `https://osiris.k6labs.cz/{{1}}`. Pro vlastní nasazení nahraďte doménu adresou aplikace.
- Ukázková hodnota proměnné tlačítka: `t/acme/chat/ID_VLAKNA` (při schvalování použijte
  skutečný odkaz na testovací výsledek).

Parametr tlačítka je oddělený od parametru textu. Aplikace do něj předává cestu
`t/<tenant>/chat/<vlákno>` ke konkrétnímu výsledku. Celý výsledek zůstává ve webovém chatu;
do šablony se posílá pouze název úlohy. Odkaz vyžaduje přihlášení a běžná oprávnění k vláknu.
Otevření v prohlížeči nebo nainstalované PWA závisí na zařízení a jeho nastavení.

Po schválení šablony nastavte:

```dotenv
WHATSAPP_NOTIFICATION_TEMPLATE=osiris_result
WHATSAPP_TEMPLATE_LANGUAGE=cs
```

Šablona se používá pouze pro úlohy naplánované na žádost uživatele a doručované na jeho ověřené
telefonní číslo. Bez ní výsledek zůstane ve webovém vlákně a plánovač ohlásí stávající upozornění
na problém s doručením. Šablonu i oprávnění účtu musí schválit Meta. Toto nastavení během sestavení
ani testů nic neodesílá. Před nasazením do produkce ověřte Flow i šablonu pomocí testovacího čísla v Meta.
