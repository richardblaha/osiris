# Zpráva z auditu repozitáře

Datum: 2026-10-31 · Větev `main` na `83bf2cb` (před auditem čistá) · Změny nejsou commitnuté, jsou v pracovním stromu.

Audit proběhl ve dvou kolech. V prvním byl úklid, opravy dokumentace a roadmapa, ve druhém realizace roadmapy (stav
každého bodu je v §7).

## 1. Shrnutí

**Celkový stav: dobrý.** Na svou velikost (34 balíčků workspace, ~400 souborů TypeScriptu, jeden modul v Go, jeden
crate v Rustu, jedna služba v Pythonu) je kód neobvykle čistý. Nejsou v něm značky TODO/FIXME ani zakomentovaný kód,
`any` se objevuje jen dvakrát a to v komentářích a jediný `@ts-expect-error` má uvedený důvod. Smyčky na pozadí
zachytávají vlastní chyby a hlídají, aby se nepřekrývaly. Známé limity škálování jsou v kódu důsledně označené
komentáři `ponytail:`.

**Opravené chyby:**

- `pnpm dev` spouštěl osiris-auth i builder VitePressu na stejném portu 3003. Builder má teď výchozí port 3005
  (produkce nastavuje `PORT=3000` v Dockerfile, takže se jí to netýká).
- `Records.writeText` po neúspěšném zápisu nechával skrytý soubor `.tmp`, zápisy záznamů se nesynchronizovaly na disk
  a jediný poškozený `thread.json` shodil uživateli celý seznam konverzací. Teď se zapisuje synchronizovaně, temp
  soubor se při selhání uklidí a seznam poškozený soubor přeskočí. Na všechno jsou regresní testy.
- `pnpm test` z kořene na stroji s mnoha jádry a malou pamětí padal na timeouty. Teď projde.
- V databázi controlu zůstávalo deset nepoužívaných tabulek starého přihlašování, včetně hashů hesel a passkeyů.
  Migrace controlu i osiris-auth jsou teď sloučené do jednoho výchozího `001_init.sql` a stará databáze o ně při
  převzetí přijde.
- CI netestovalo procesor collectoru v Go a desktopovou aplikaci kompilovalo jen u release. Image collectoru se
  stavěl s `go mod tidy`, takže se verze závislostí mohly mezi buildy lišit. Teď CI procesor testuje, desktop
  kompiluje při každém pushi a image se staví se zamčenými verzemi.

**Úklid:** 15 nepoužívaných závislostí, 24 nepoužitých importů a proměnných, 3 nikde nevolané exporty, 1 zdvojený
regex a 1 zdvojený soubor fontu (112 KB). `.dockerignore` nově vynechává `.pnpm-store` (892 MB) a `.kubeconfig.*`
(přihlašovací údaje). Příliš široké pravidlo `data/` v `.gitignore` je zúžené. Opraveno 14 nepřesností
v dokumentaci a konfiguraci a do `.env.example` přibyla volitelná nastavení.

**Validace** (podrobně v §5): prošel typecheck, všechny testy z kořene, buildy tří webových aplikací, testy
procesoru v Go i build collectoru. Rust/Tauri a Docker image zůstaly neověřené, protože tu ty nástroje nejsou.

**Co zůstává** (podrobně v §6): hlavně to, že první nasazení s novým výchozím bodem migrací nevratně smaže stará
auth data controlu. Před nasazením je potřeba mít zálohu databáze controlu.

## 2. Inventář repozitáře

Nástroje: workspace pnpm 12.10.1, Node ≥ 24, TypeScript 6.0.3 spouštěný přímo přes `tsx` (služby nemají build
krok), Vitest 5, Hono, React 19 + Vite + Tailwind pro webová UI, LangGraph/LangChain pro agenta, libSQL/SQLite,
Go 1.26 (procesor collectoru), Rust/Tauri 2 (desktop), Python 3.12 (Piper TTS). Linter ani formátovač v repozitáři
nejsou; kontrolami jsou podle dokumentace `typecheck` a `test`.

| Projekt | Druh | Odpovědnost | Interní závislosti | Testy |
|---|---|---|---|---|
| `apps/osiris` (`@osiris/agent`) | služba + CLI | runtime projektu a lokální příkaz `osiris` | core, platform, shared, všechny `tools-*` | 36 souborů |
| `apps/osiris-pwa` | web | hlavní PWA (Assistant UI) | shared, client | 2 soubory |
| `apps/osiris-cli` | terminálový klient (Ink) | UI v terminálu | agent, client, shared | 1 soubor |
| `apps/osiris-vscode` | rozšíření VS Code | chat ve webview | client, shared | 1 soubor |
| `apps/osiris-desktop` | aplikace Tauri | výběr složky nebo serveru | — | žádné (Rust), v CI `cargo check` |
| `server/auth` | služba | OIDC provider, uživatelé, skupiny, SCIM | platform, shared | 4 soubory |
| `server/auth/web` | web | stránky přihlášení, účtu a administrace | shared | žádné |
| `server/gateway` | služba | vstup z internetu, introspekce, směrování | platform | 1 soubor |
| `server/control` | služba | projekty, členové, WhatsApp, plánovač, zálohy | platform, shared (dev: auth) | 9 souborů |
| `server/operator` | služba | Kubernetes operátor pro `Project` | platform | 1 soubor |
| `server/vitepress` | služba | izolovaný build VitePressu | — | 1 soubor |
| `server/web-events` | služba | webová analytika bez cookies | platform | 1 soubor |
| `server/digital-twin` | služba | DTDL dvojčata, ops API, alerting | platform, shared | 13 souborů |
| `server/digital-twin/web` | web | 3D PWA dvojčete | client, shared | žádné |
| `server/tts` | služba v Pythonu | převod textu na řeč (Piper) | — | smoke test v Dockerfile |
| `packages/core` | knihovna | jádro agenta (graf, checkpointer, RAG, MCP, trezor, soubory) | platform, shared | přes `apps/osiris` |
| `packages/platform` | knihovna | infrastruktura služeb (JWT, SQLite, S3, telemetrie, i18n) | shared | přes služby |
| `packages/shared` | knihovna | sdílené typy, i18n, téma, ikony, DTDL | — | 5 souborů |
| `packages/client` | knihovna | API klient všech klientů | shared | 1 soubor |
| `packages/tools/*` (15) | knihovny | moduly nástrojů agenta | core (+ ops, platform, shared) | přes `apps/osiris` |
| `deploy/observability/twin-events` | modul Go | procesor a binárka collectoru | — | `processor_test.go`, nově v CI |
| `deploy/*` | manifesty | k8s (kustomize), auth, observabilita, WhatsApp flow, demo seed | — | — |
| `packaging/deb` | skripty | balíčky `.deb` pro release | — | — |

## 3. Provedené změny

### Opravy chyb

| Změna | Proč | Vliv na chování | Ověření |
|---|---|---|---|
| `server/vitepress/src/index.ts`, `.env.example`: výchozí port 3003 → 3005 | `pnpm dev` spouští osiris-auth (3003) i builder (3003; jeho dev skript nečte `.env`) | jen vývoj; produkce má `PORT=3000` a runtimy míří na `:3000` | soupis portů všech služeb, dokumentace upravena |
| `packages/core/src/projects/records.ts`: temp soubor se při selhání smaže | po neúspěšném zápisu zůstával `.<uuid>.tmp` navždy | mění se jen cesta selhání, chyba se dál vyhodí | test `leaves no temp file behind when a write fails` bez opravy selže |
| totéž: před přejmenováním se zápis synchronizuje na disk (`fsync`), jako ve FileStore | pád v nevhodnou chvíli mohl nechat prázdný záznam | o něco pomalejší zápis záznamů | testy agenta |
| `packages/core/src/repo/threads.ts`: seznam poškozený `thread.json` přeskočí a zaloguje; `threadIds` ho dál počítá jako existující | jeden poškozený soubor shodil celý seznam konverzací. Podle `threadIds` se při startu mažou soubory zaniklých konverzací, takže přeskočením by se smazaly soubory živé konverzace | uživatel vidí ostatní konverzace | test `lists a user's threads past a damaged one…` |
| `vitest.config.ts` všech 13 balíčků s testy: timeout 30 s; `apps/osiris` navíc `maxWorkers: "50%"` | výchozích 5 s a worker na každé jádro dávaly při `pnpm test` falešné timeouty (v auth, agentovi a nakonec i v PWA) | produkčního kódu se netýká | `pnpm test` z kořene projde (předtím padal) |
| Migrace controlu (13 souborů) a osiris-auth (2) sloučené do jednoho `001_init.sql` každá. `migrate` (`@osiris/platform/db.ts`) převezme databázi založenou dřív, pokud její historie dosáhla `-- baseline after:` (control `012_no_cluster_sites.sql`, auth `002_clients.sql`), a smaže tabulky z `-- baseline drops:` (10 starých auth tabulek controlu, potomci první). Starší databázi odmítne | identity jsou v osiris-auth, import je hotový a jeho příkaz už neexistuje; tabulky držely stará osobní data. Jedna výchozí migrace místo historie přejmenování a mazání | **při nasazení nevratně smaže stará auth data controlu** | schéma z výchozího bodu se strukturálně shoduje se schématem ze starých migrací (sloupce, typy, výchozí hodnoty, indexy, cizí klíče); testy: nová databáze, převzetí se zachováním dat, odmítnutí starší, převzetí controlu bez auth tabulek |
| `.github/workflows/ci.yml`: job `collector` (`go vet .`, `go test ./...`, `-mod=readonly`) a job `desktop` (`cargo check --locked`); image collectoru čeká na `collector` | procesor v Go se netestoval, desktop se kompiloval jen u release | delší CI | YAML se parsuje; lokálně prošel `go test`, `cargo` neověřen |
| `deploy/observability/twin-events/Dockerfile`: `go mod download` + `go build -mod=readonly` místo `go mod tidy` | build mohl pokaždé vyřešit jiné verze | každý build má stejné moduly | `go mod tidy` na commitnutých souborech nic nemění; build s `-mod=readonly` prošel a binárka obsahuje `twin_events` |

### Závislosti

Každá byla ověřena hledáním ve zdrojích, testech, konfiguraci, Dockerfile a manifestech.

| Balíček | Odstraněno | Poznámka |
|---|---|---|
| `apps/osiris-pwa` | `@simplewebauthn/browser`, `uqr` | passkeys a QR kód pro TOTP se přesunuly do `server/auth/web`, který je má dál |
| `apps/osiris`, `server/control` | `jose` | používá se jen přes `@osiris/platform` |
| `packages/platform` | `@opentelemetry/core` | nikde se neimportuje |
| `server/web-events` | `mmdb-lib` | GeoIP jde přes `@osiris/platform/geoip.ts` |
| `server/gateway`, `server/operator` | `@osiris/shared` | přímo se neimportuje, instaluje se přes platform |
| `packages/tools/{http,images,integrations,knowledge,memory,sites,skills}` | `@osiris/shared` | nikde se neimportuje |

Ponecháno záměrně: `@libsql/client` v auth a controlu (zálohovací CronJoby ho `require`-ují z těchto složek),
`vue` a `@vueuse/core` v builderu (importují je témata webů), `@tauri-apps/cli` a `@vscode/vsce` (používají je
skripty). V `pnpm-lock.yaml` 45 řádků ubylo a žádný nepřibyl; kontrola supply chain prošla.

### Mrtvý kód a duplicity

- Nepoužité importy a proměnné (`tsc --noUnusedLocals` přes všechny tsconfigy): 12 ve zdrojích, 12 v testech.
- Nikde nepoužité exporty: `speechEnabled` (PWA), `connectionUrl` (`packages/client`) a `secretRefs`
  (`packages/core/src/vault/template.ts`). `deactivate` ve VS Code rozšíření zůstal, protože ho volá VS Code.
- `server/digital-twin/src/datasources/template.ts` měl vlastní kopii regexu `DATA_PLACEHOLDER` ze
  `@osiris/shared/dtdl.ts`; teď používá sdílený.
- `server/digital-twin/web` měl bajtově stejnou kopii `FiraCode-VF.woff2` jako PWA. Teď bere soubor z PWA (stejně
  jako `server/auth/web`) a Dockerfile ho do buildu zkopíruje.

### Build a repozitář

- `.dockerignore`: přidány `.kubeconfig.*` a `.pnpm-store`; `**/data` zúženo na `data`, `apps/*/data`,
  `server/*/data`.
- `.gitignore`: pravidlo `data/` ignorovalo každou složku `data` kdekoli (kvůli tomu se musel přesunout kód
  `src/datasources` dvojčete). Je zúžené na `/data/`, `/apps/*/data/`, `/server/*/data/` a nic nového se tím
  neodkrylo.
- `apps/osiris-vscode/.vscodeignore`: nový `vitest.config.ts` se nebalí do `.vsix`.

### Komentáře

Komentáře v kódu vysvětlují, ne převyprávějí. Opraveny byly jen ty chybné: `packages/platform/src/gen-keys.ts`
(klíče patří osiris-auth, ne controlu), Dockerfile a `go.mod` collectoru. Komentáře `ponytail:` zůstaly, protože
zaznamenávají vědomé limity.

## 4. Změny dokumentace

| Soubor | Oprava |
|---|---|
| `CLAUDE.md` | `web/src/chat/adapter.ts` → `apps/osiris-pwa/src/chat/adapter.ts`; core obsahuje „the project database“, ne „project DB and migrations“; port builderu u `pnpm dev`; CLI osiris-auth nemá `import-control`, ale `service-user`; záznamy se zapisují synchronizovaně |
| `README.md` | builder VitePressu na :3005 u `pnpm dev` |
| `server/digital-twin/CLAUDE.md` | collector se staví z `cmd/otelcol/main.go` přes Dockerfile; `builder-config.yaml` ani ocb neexistují |
| `deploy/README.md` | migrace `013_no_auth.sql` nikdy neexistovala; staré tabulky maže převzetí výchozím bodem migrací (nový oddíl „Database migrations“) a `import-control` je odstraněný. `gen-keys` vypisuje názvy bez prefixu, kořenový `.env` je drží s prefixem `OSIRIS_` |
| `deploy/images/README.md` | migrace `020_images.sql`/`021_image_execution.sql` ani „libSQL checkpointer“ neexistují; úlohy, katalog a výběry jsou JSON záznamy v `.osiris/private/images/` |
| `server/control/.env.example` | odstraněny `SITES_INGRESS_IPS` a `SITES_CNAME_TARGET` (weby v clusteru zrušila migrace 012); doplněna volitelná nastavení |
| `server/digital-twin/.env.example` | `AUTH_REQUIRED_GROUP` (nic ho nečte) → `AUTH_ADMIN_GROUP`; doplněny `TWIN_SECRETS_KEY`, `CEPH_MANAGERS`, `OSIRIS_*`, `OPS_*` a vývojové přepínače |
| `server/gateway/.env.example`, `apps/osiris/.env.example`, `server/vitepress/.env.example` | doplněna volitelná nastavení s výchozími hodnotami z `config.ts` (zakomentovaná, chování nemění); port builderu |

Jak se dokumentace ověřovala: každá cesta k souboru v backtickách v deseti dokumentech Markdown se dohledala mezi
trackovanými soubory. Každé nastavení psané `VELKÝMI_PÍSMENY` v nich a v `deploy/**/*.yaml` se vyhledalo v kódu.
`.env.example` každé služby se porovnal s jejím zod schématem.

## 5. Výsledky validace

Prostředí: devcontainer s Linuxem, 16 CPU, 7 GB RAM, Node 24. Go 1.26.10 bylo jen pro ověření staženo do
scratchpadu. Nedostupné: Rust/cargo, Docker, kubectl.

| Projekt | Build | Statická analýza | Testy | Poznámka |
|---|---|---|---|---|
| `apps/osiris` | není (běží ze zdrojů) | typecheck prošel | prošlo 925, 3 přeskočené | přeskočené jsou živé testy Comfy Cloud za příznaky `COMFY_LIVE_*`; +2 nové testy |
| `apps/osiris-pwa` | prošel (`vite build`) | typecheck prošel | prošlo 8 | |
| `apps/osiris-cli` | není | typecheck prošel | prošly 4 | |
| `apps/osiris-vscode` | nespuštěno (`build.mjs`/`vsce`) | typecheck prošel | prošly 2 | |
| `apps/osiris-desktop` | blokováno (chybí Rust) | není | nejsou | v CI nově `cargo check` |
| `server/auth` | není | typecheck prošel | prošlo 24 | |
| `server/auth/web` | prošel (`vite build`) | typecheck prošel | nejsou | |
| `server/gateway` | není | typecheck prošel | prošlo 16 | |
| `server/control` | není | typecheck prošel | prošlo 52 | +1 nový test (migrace) |
| `server/operator` | není | typecheck prošel | prošly 4 | |
| `server/vitepress` | není | typecheck prošel | prošly 3 | |
| `server/web-events` | není | typecheck prošel | prošlo 12 | |
| `server/digital-twin` | není | typecheck prošel | prošlo 107 | |
| `server/digital-twin/web` | prošel (`vite build`, font z PWA v bundlu) | typecheck prošel | nejsou | |
| `server/tts` | blokováno (chybí Docker) | `py_compile` prošel | nespuštěno (smoke test v Dockerfile) | |
| `packages/shared` | není | typecheck prošel | prošlo 29 | včetně kontroly katalogů |
| `packages/client` | není | typecheck prošel | prošlo 6 | |
| `packages/core`, `packages/platform`, `packages/tools/*` | není | typecheck prošel | pokryto přes `apps/osiris` a služby | |
| `deploy/observability/twin-events` (Go) | prošel (`go build -mod=readonly -p 1`) | `go vet` balíčku procesoru prošel | prošly (`go test ./...`) | `go vet ./...` přes celý collector tu zabil OOM |
| manifesty `deploy/**` | nespuštěno (`kubectl kustomize`) | 32 YAML se parsuje, zdroje kustomize existují | nejsou | |
| Docker image (11 cílů) | blokováno (chybí Docker) | — | — | |
| Závislosti | `pnpm install --frozen-lockfile` prošel | kontrola supply chain lockfile prošla | — | `pnpm audit` nespuštěn |

**Výchozí stav vs. teď.** Typecheck prošel před změnami i po nich. Na začátku `pnpm test` z kořene padal na
timeouty a i při samostatném běhu balíčků jich v `apps/osiris` padalo 19, přestože každý soubor zvlášť prošel. Teď
`pnpm test` z kořene projde celý (1 192 testů). Žádný test nebyl oslaben a přibyly 3 nové (2 pro záznamy, 1 pro
migraci).

Další statické kontroly: všech 32 YAML souborů se parsuje (včetně upraveného `ci.yml`) a všechny zdroje kustomize
existují. `server/tts/server.py` se zkompiluje (`py_compile`).

## 6. Zbývající problémy

- **Převzetí databáze výchozím bodem je nevratné.** Při příštím nasazení controlu smaže stará auth data. Před nasazením zazálohuj
  `/data/control.db` (stačí CronJob `control-backup` nebo ruční `VACUUM INTO`).
- **Lokálně neověřeno:** nový job `desktop` (`cargo check`) a build Docker image. Obojí se poprvé ověří v CI.
- **`go vet ./...` přes celý collector** se tu nevešlo do paměti (OOM na balíčcích Azure SDK z contribu). CI proto
  spouští `go vet .` jen nad vlastním kódem procesoru; testy i build prošly.
- **Stránka `apps/osiris-pwa/public/privacy.html`** teď popisuje vlastní anonymní měření místo GoatCounteru. Je to
  právní text, takže ho před nasazením zkontroluj.
- **~55 exportů** se používá jen uvnitř vlastního souboru. Nejsou mrtvé; odebrat `export` by byla jen kosmetika.

## 7. Roadmapa a stav

| ID | Bod | Priorita | Stav |
|---|---|---|---|
| R1 | Záznamy projektu odolné proti pádu | vysoká | **hotovo:** `fsync`, úklid temp souborů, seznam konverzací přeskočí poškozený soubor a `threadIds` ho chrání. Ostatní volání `Records.all` (trezor, čekající zápisy checkpointeru, otázky) chybu dál hlásí nahlas, protože tiché přeskočení by tam bylo nebezpečné |
| R2 | Testy nezávislé na stroji | vysoká | **hotovo:** timeout 30 s ve všech balíčcích, `pnpm test` z kořene projde |
| R3 | CI testuje Go a kompiluje desktop | vysoká | **hotovo:** joby `collector` a `desktop`; `desktop` lokálně neověřen |
| R4 | Smazat staré auth tabulky controlu | střední | **hotovo:** výchozí bod migrací (`001_init.sql`, `baseline drops`) + testy; nasazení vyžaduje zálohu (§6) |
| R5 | Reprodukovatelný build collectoru | střední | **hotovo:** `go mod download` + `-mod=readonly`, ověřeno buildem |
| R6 | Index seznamu konverzací | střední | **odloženo podle plánu:** jde o škálování, ne o chybu; řešit, až naroste projekt `twin` (konverzace z alertů). Návrh: index záznamů pro každého uživatele, přestavovaný při `project.init()`, a retence konverzací z alertů |
| R7 | Nahradit GoatCounter v gatewayi | střední | **hotovo:** PWA počítá návštěvy přes vlastní web-events (ClickHouse). `e.js` má nový ruční režim (`data-manual`, `wa.pageview`), ve kterém se posílají jen názvy sekcí, nikdy URL s ID. Gateway vloží skript podle `WEB_EVENTS_SITE` a z CSP zmizel cizí origin. `osiris.k6labs.cz` je v `SITES` i v IngressRoute web-events |
| R8 | Zúžit pravidlo `data/` | střední | **hotovo** |
| R9 | Zdokumentovat volitelná nastavení | nízká | **hotovo** pro gateway, control, runtime a dvojče |
| R10 | Jedna kopie fontu | nízká | **hotovo:** build dvojčete ověřen, font je v bundlu |
| R11 | Proces na každý dotaz do databáze projektu | nízká | **odloženo podle plánu:** ~100 ms na SELECT bez limitu souběhu; řešit, až bude konzole vytížená |
| R12 | Procházení všech úloh obrázků | nízká | **odloženo podle plánu:** řešit, až porostou obrázky |

## 8. Hodnocení architektury

**Silné stránky.** Služby mají jasné hranice a každá data jednoho vlastníka: identity jsou v osiris-auth, projekty
v controlu a data projektu ve složce jeho runtime. Důvěra mezi službami je explicitní: krátké interní JWT vázané na
publikum, TokenReview pro runtimy a klíče odvozené pro každý projekt, které drží jen operátor. SQLite s jedním
zapisovatelem a nárokováním přes podmíněný UPDATE se obejde bez distribuovaných zámků. Moduly nástrojů se načítají
dynamicky a každý běh je filtruje podle funkcí, přepínačů admina a `tools.json` (při chybě se vše vypne).
Nedůvěryhodný kód (vlastní nástroje, weby VitePressu, SQL dotazy, regexy) běží v oddělených procesech s limity.
Chyby se důsledně dělí na „nedostupné“ a „špatná odpověď“ a spící runtimy se probouzejí s opakováním.

**Slabiny.** Některé seznamy rostou s počtem všech záznamů (R6, R11, R12; v kódu jsou přiznané). `CLAUDE.md` je
jediný, velmi dlouhý popis architektury. Je přesný, ale v jeho hustotě se zastaralé pasáže špatně hledají.

**Doporučený směr.** Strukturální změny nejsou potřeba. Odložené body škálování řešit podle skutečného růstu.

## 9. Závěrečné hodnocení

- **Stabilita: dobrá.** Smyčky jsou ošetřené, volání mezi službami mají timeouty (`callJson` 30 s), gateway omezuje
  velikost těl požadavků a shutdown zavírá servery i úložiště. Mezera v trvanlivosti záznamů je opravená.
- **Udržovatelnost: dobrá.** Služby mají konzistentní vzory (Hono + konfigurace přes zod + `onError`
  s lokalizovanými chybami), balíčky nástrojů jsou malé a typované katalogy i18n hlídají testy.
- **Čistota kódu: velmi dobrá.** Kompilátor našel jen 24 nepoužitých symbolů v ~60 tisících řádků.
- **Konzistence architektury: dobrá.** Popsané vrstvy odpovídají importům (core neimportuje žádný balíček nástrojů).
- **Přesnost dokumentace: po opravách dobrá.** Nepřesnosti byly hlavně v deploy README a v příkladech konfigurace,
  které nestačily refaktorům.
- **Důvěra v testy: dobrá.** 1 192 testů TypeScriptu, mezi nimi oficiální validační sada checkpointeru a skutečné
  HTTP toky přihlášení, a nově v CI i testy procesoru v Go. Neověřené zůstávají Rust a Docker image.
- **Provozní robustnost: dobrá.** Operátor a runtimy mají health checky a scale-to-zero, image běží jako non-root
  s read-only kořenovým souborovým systémem a build collectoru je reprodukovatelný.
