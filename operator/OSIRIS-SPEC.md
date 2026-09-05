# Osiris AI Agent — Cílová architektura (referenční spec pro Claude Code)

> **Status: projekt Osiris již existuje a funguje.** Tento dokument je
> **cílová architektura**, ne zadání "postav od nuly". Práce na projektu
> **není čistý refaktoring** — u řady oblastí bude potřeba doplnit chybějící
> části kódu (funkcionalita, která zatím vůbec neexistuje), vedle úprav a
> sbližování existujícího kódu s tímto popisem. Každý úkol proto může být
> mix: uprav-existující + dopiš-chybějící. Pokud se ukáže, že realita je
> lepší/jinak zdůvodněná než tady napsaná verze, upravte tento dokument.
>
> **Technologie:** projekt je **TS/JS všude kromě `osiris-kind-operator`**.
> Operátor je a zůstává v **Go, s Kubebuilderem** (standardní k8s operátor
> tooling — CRD scaffolding, reconcile loop, kubebuilder markers apod.).
> Všechno ostatní — CLI (`osiris`), API (`osiris-api`), IDE (`osiris-ide`)
> a jeho extensions — je TS/JS (Node.js). Nepřepisujte operátor do JS a
> nezaváděite Go jinde, než v operátoru.
>
> **Existující funkce se nesmí ztratit.** Osiris už má funkční
> featury, které při úpravách/refaktoringu musí zůstat zachované a funkční,
> i když nejsou (ještě) v tomto spec dokumentu detailně popsané — např.
> **crew** (viz sekce 1.1). Pokud úkol zasahuje do kódu, kde taková
> featura žije, je součástí kroku 1 (průzkum) ji identifikovat a explicitně
> ošetřit v plánu (krok 2), ne ji tiše smazat nebo rozbít jako "vedlejší
> efekt" refaktoringu.
>
> Doporučený postup pro každý úkol: (1) nechat Claude Code nejdřív
> prozkoumat aktuální stav relevantní části kódu, (2) porovnat se
> spec — rozlišit, co se má **upravit** vs. co **zatím neexistuje a musí se
> nově napsat**, (3) navrhnout/potvrdit plán, (4) až pak implementovat.
> Nepoužívat tento dokument jako jediný prompt pro "udělej vše najednou" —
> vkládat vždy jen relevantní sekci + explicitní rozsah úkolu (viz šablona
> v sekci 9).
>
> Tento spec sám o sobě **nepopisuje aktuální stav** implementace (jaké
> repo/moduly/verze skutečně existují) — to zjišťuje Claude Code při každém
> úkolu z reálného kódu, ne odsud. Pokud se při práci zjistí trvalý rozpor
> mezi kódem a tímto dokumentem, promítněte ho zpět sem (sekce 8).
>
> **Povinný první krok, než se začne cokoliv dalšího:** tabulka v sekci 8
> (a tabulka existujících featur v sekci 1.1) musí být nejdřív vyplněná na
> základě skutečného stavu projektu — ne teoreticky, ne z paměti, ale
> průchodem reálného kódu. Dokud tahle úvodní aktualizace neproběhne,
> neplánujte ani nezadávejte žádný dílčí implementační úkol podle šablony
> v sekci 9 — vycházeli byste z neověřených předpokladů o tom, co existuje
> a co ne. Postup pro tento úvodní audit je v sekci 0.

## 0. Povinný úvodní krok — audit skutečného stavu

> Tohle proveďte **jednou, jako první věc**, dřív než zadáte jakýkoli
> dílčí úkol podle šablony v sekci 9. Bez toho pracujete nad neověřenými
> předpoklady o tom, co v projektu existuje.

Prompt pro Claude Code (spusťte samostatně, ideálně na začátku nové
konverzace, s přístupem ke všem relevantním repozitářům — `osiris-ai` i
`osiris-ide`, pokud už existuje):

```
Kontext: Přiložený/odkazovaný OSIRIS_SPEC.md popisuje cílovou architekturu
projektu Osiris. Projekt už existuje a běží. Předtím, než se začne
plánovat jakákoli konkrétní změna, potřebuji kompletní audit skutečného
stavu proti tomuto spec.

Neuprvuj žádný kód. Projdi si celý dostupný kód projektu (všechny
relevantní repozitáře/balíčky) a pro každou oblast ze sekce 8 tabulky ve
spec (CLI framework, bootstrap clusteru, CRD, reconcile loop operátoru,
suspend/resume mechanismus, konfigurace .osiris, paměť/ChromaDB, MCP, TUI,
osiris-api, osiris-ide a extensions) zjisti a popiš:
  - co skutečně existuje a jak to je implementované (soubory, klíčové
    moduly, použité knihovny/framework)
  - jestli to odpovídá cílovému stavu ze spec, částečně odpovídá, nebo
    zatím neexistuje vůbec
  - jazyk, ve kterém je to napsané (uprav, pokud něco neodpovídá pravidlu
    "vše TS/JS kromě osiris-kind-operátoru, který je Go/Kubebuilder")

Dále aktivně vyhledej existující featury, které nejsou (ještě) popsané ve
spec sekci 1.1 (příklad, který už víme, že existuje: "crew") — projdi kód
a identifikuj takové funkční celky, popiš jejich účel a kde v kódu žijí.
Nejde jen o "crew" – hledej cokoliv funkčního, co spec nezmiňuje.

Výstup potřebuji ve formě rovnou použitelné pro doplnění do spec:
  1. Vyplněná tabulka pro sekci 8 (stejné sloupce: Oblast / Cílový stav /
     Skutečný stav / Typ rozdílu: uprav, doplň chybějící, nebo OK)
  2. Vyplněná/rozšířená tabulka pro sekci 1.1 (Featura / Popis / Kde v kódu
     žije / Pokrytá ve spec?)
  3. Krátký seznam největších/nejrizikovějších rozdílů, na které by se
     mělo zaměřit jako na první dílčí úkoly

Neplánuj ani nenavrhuj konkrétní implementační kroky pro jednotlivé
oblasti — to je předmětem samostatných navazujících promptů (viz spec
sekce 9). Cílem tohoto kroku je jen zjistit a zdokumentovat pravdivý stav.
```

Po dostání výstupu doplňte tabulky v sekcích 1.1 a 8 tímto dokumentem
(ručně, nebo tím, že necháte Claude Code rovnou upravit tento soubor) —
teprve pak má smysl zadávat konkrétní úkoly podle šablony v sekci 9.

## 1. Vize

Osiris je AI agent distribuovaný jako CLI nástroj (`osiris`), který běží lokálně,
ale veškerou práci (dev prostředí, session, paměť) deleguje do lokálního
Kubernetes clusteru (`kind`). Cílem je mít reprodukovatelné, izolované,
uspávatelné vývojové/agentní session s perzistentní vrstvenou pamětí
(global → project → session), rozšiřitelné o MCP servery a LLM providery přes
YAML konfiguraci, a s IDE nadstavbou (desktop + web).

### 1.1 Existující featury k zachování

> Tento seznam doplňujte, jak se při jednotlivých úkolech objevují další
> existující funkce, které nejsou (ještě) rozepsané jinde v tomto dokumentu.
> Účel: aby žádný úkol tuto funkcionalitu omylem neodstranil nebo nerozbil,
> jen proto, že o ní spec explicitně nemluví.

> Audit proveden 2026-09-05 průchodem reálného kódu (viz sekce 8 výše pro souhrn rozdílů proti cíli).

| Featura | Stručný popis | Kde v kódu žije | Pokrytá v tomto spec? |
|---|---|---|---|
| **crew** | Multi-agent coordinator: lead agent (`architect`) deleguje úkoly specialistům (`implementer`, `researcher`, `reviewer`) definovaným v `.osiris/agents/*.md` (YAML frontmatter + Markdown system prompt); sdílený in-memory "blackboard" log per běh (`Blackboard`, nepersistuje se); bridge nástroje na `memory_search` a `backlog_read`; volitelně napojení na MCP tools. Limity delegace (hloubka/iterace/počet) v `.osiris/crew.json`. | `packages/crew/src/{crew.ts,blackboard.ts,registry.ts,tools.ts,assemble.ts}`; agenti v `.osiris/agents/`; config `.osiris/crew.json`; CLI `osiris crew run`; UI `apps/osiris-console` (Crew tab) | Ne — trvalá architektonická součást, doporučeno doplnit vlastní sekci (agent orchestration/delegation) |
| **backlog** (Git-orphan-branch kanban) | File-based projektový backlog (stavy `todo/in-progress/review/done` jako podadresáře), verzovaný přes dedikovanou orphan branch `osiris/backlog` v samostatném git worktree (`.osiris/temp/backlog-worktree`) — backlog churn nikdy nezasahuje do historie source branch. Úkoly jako soubory `[type]-id-slug.md` s frontmaticí. `push`/`pull`/`autoPush` synchronizují s `origin`. | `packages/backlog/src/{orphan.ts,repo.ts,task.ts,states.ts}`; CLI `osiris backlog list|new|move|push|pull|lint`; UI `apps/osiris-console` (Board tab); bridge z `packages/crew` (`backlog_read`) | Ne |
| **memory / knowledge-base indexer (ChromaDB)** | Heading-aware chunking Markdown dokumentů z `.osiris/memory/`, content-addressed inkrementální indexování, ChromaDB jako HTTP klient (`chromadb` npm balíček) nebo automatický in-process fallback store, pokud ChromaDB není dostupné. Embedding: default `hash` (offline, nesémantický), volitelně `ollama` nebo `openai-compatible`. Jedna kolekce, žádná global/project/session vrstva — jde o dokumentační KB search, ne o session/conversation paměť podle §3.5. | `packages/memory/src/{config.ts,store.ts,indexer.ts,embed.ts}`; CLI `osiris memory reindex|watch|search`; UI `apps/osiris-console` (Memory tab) | Částečně — spec §3.5 popisuje jinou věc (3-vrstvá session paměť); toto je samostatná dokumentační KB featura, kterou spec vůbec nepojmenovává |
| **osiris-orchestrator** (lokální Docker stack pro desktop) | TS náhrada za .NET Aspire AppHost: deklarativní `StackSpec` (otel-collector, dashboard, ollama, sync-worker) nasazovaný na plain Docker přes `dockerode`, alternativně render do docker-compose. Používá ho výhradně `packages/desktop-host` jako lokální sidecar stack desktop appky — nesouvisí s project/session kontejnery ani s `kind`/Kubernetes. | `packages/orchestrator/src/{stack.ts,runner.ts,compose.ts}`; konzument `packages/desktop-host` | Ne |
| **container-sync** (DevContainer identita/mobilita) | Deterministická identita DevContaineru přes `sha256(cesta)` (`devcontainerHash`), použitá jako Docker label i jako `vscode-remote://osiris-devcontainer+<hash>` remote authority; wrapper nad `@devcontainers/cli` (`devcontainer up`), fallback `devcontainer.json` template, content-digest helper pro přenos volume dat. Toto je reálný mechanismus za spec's abstraktním ".dev kontejner (pod)" (§3.3) — ale implementovaný jako plain Docker kontejner, ne jako Kubernetes pod v `osiris-kind`. | `packages/container-sync/src/{hash.ts,devcontainer.ts,devcontainer-template.ts,digest.ts}`; konzument `extensions/osiris-workspace` | Částečně — odpovídá duchu §3.3 (dedikovaný kontejner na projekt), ale na jiné infrastruktuře (Docker, ne k8s pod v kind clusteru) |
| **lm-proxy** (editor LM API most) | OpenAI-compatible HTTP shim (`GET /v1/models`, `POST /v1/chat/completions`) nad VS Code/Copilot Chat Language Model API (`vscode.lm.selectChatModels/sendRequest`), volitelně bindovaný na `0.0.0.0` s bearer tokenem přes `host.docker.internal` — umožňuje agentovi běžícímu uvnitř DevContaineru použít modely nakonfigurované v hostitelském IDE bez vlastní API-key konfigurace. | `packages/lm-proxy/src/{handler.ts,bridge.ts,server.ts}`; host `extensions/osiris-workspace/src/{lm-bridge.ts,lm-proxy-host.ts}` | Ne — integrační mechanismus, který spec vůbec neřeší (spec počítá jen s LLM providery v `.osiris/llm/*.yml`) |
| **agent-core** (provider-agnostic agent loop + handover snapshot) | Jednotná smyčka volej-model→proveď-tooly→opakuj nad Anthropic/OpenAI-compatible/Ollama providery (`AgentOrchestrator`); přenosný `AgentSnapshot` (konverzace, úkoly, working set, provider — bez API klíčů) perzistovaný do `.osiris/agent-state.json` (`JsonSnapshotStore`, atomický zápis). Fakticky odpovídá na otevřenou otázku spec §3.3 "co přesně přežívá uspání" na úrovni stavu konverzace/úkolů agenta, ale spec o tomto mechanismu vůbec nemluví. | `packages/agent-core/src/{orchestrator.ts,session.ts,snapshot.ts,providers/*}`; konzument `packages/crew` | Ne — implicitně dořešuje otevřenou otázku §3.3, ale spec balíček nejmenuje |
| **osiris-console** | Samostatná SPA (taby Board/Crew/Memory) pro Kanban backlog (drag&drop, sync), spouštění/sledování crew běhů a KB semantic search. Nepokrývá MCP/LLM/timeout/cluster konfiguraci. Spec ji nikde nezmiňuje jako součást `osiris-ide`. | `apps/osiris-console/src/App.tsx` a routy | Ne |
| **model-config wizard** (editor-based LLM config UI) | Webview "Configure Models" (`osiris.configureModels` příkaz) — mapování task-class → provider/model, secrety v keychainu. Jediný reálně existující kus toho, co spec v §5.3 zamýšlí jako `osiris-ui-config`, ale žije uvnitř `osiris-workspace` extension a pokrývá jen LLM část — ne MCP instalaci, timeouty ani cluster stav. | `extensions/osiris-workspace/src/{start-view.ts,model-config.ts}` | Částečně — pokrývá jen LLM podmnožinu §5.3 |
| **session handover protokol (historický, supersednutý operátorem)** | Dřívější "Handover to Server" / "Fetch to Local" mechanismus přenosu běžícího DevContaineru+volume mezi lokálem a serverem (zdrojový kód smazán, commit `c868441`; artefakt jen v `dist/handover.d.ts`). Nahrazeno CRD-based suspend/resume (`OsirisSession.desiredPhase`, viz §3.3/3.4) — `packages/protocol/src/session.ts` to explicitně komentuje. Zmiňuji zde jen jako historickou stopu, funkčně už nahrazeno operátorem, viz sekce 8. | `packages/protocol/src/{session.ts,client.ts,routes.ts}`; konzument `extensions/osiris-workspace`, `apps/osiris-server`, `apps/osiris-console`, `packages/cli` | Ano — nahrazená funkcionalita už spadá pod §3.3/3.4 |
| **shared-core & telemetry** (infrastrukturní vrstva) | `shared-core`: `Result<T,E>` typ, logger factory, typovaný event bus, sdílené domain typy — konzumováno napříč ~15 balíčky. `telemetry`: OTLP-first OpenTelemetry bootstrap (traces/metrics/logs) pro `osiris-server`, `desktop-host` aj., posílající do `otel-collector` z orchestrator stacku. Infrastrukturní společná vrstva, ne uživatelská featura — zmíněno pro úplnost, nepotřebuje vlastní sekci. | `packages/shared-core/src/*`, `packages/telemetry/src/*` | Ne (infrastruktura) |

## 2. Repozitáře

| Repo | Obsah |
|---|---|
| `osiris-ai` | CLI `osiris`, `osiris-kind-operator`, `osiris-api`, sdílené knihovny |
| `osiris-ide` | Osiris IDE (desktop + web), spouští se `osiris-ide`, obsahuje extensions `osiris-workspace`, `osiris-ui-chat`, `osiris-ui-config` |

> Otevřená otázka k rozhodnutí: `osiris-api` a `osiris-kind-operator` — dát do
> monorepa `osiris-ai` nebo do samostatných repozitářů? Pozor: operátor je
> **Go** (Kubebuilder projekt s vlastním layoutem — `PROJECT`, `api/`,
> `controllers/`, `config/`), zatímco CLI a API jsou **TS/JS** — pokud zůstane
> monorepo, musí jasně oddělovat Go a Node části (např. `/go/operator` +
> `/packages/cli`, `/packages/api`, `/packages/shared-types` pro TS/JS), ne
> je míchat do jednoho workspace nástroje.

## 3. `osiris` CLI

### 3.1 Chování při spuštění
- `osiris` bez parametrů → spustí TUI.
- `osiris <příkaz>` → klasické CLI chování (podobně jako `docker`/`kubectl`).
- Při jakékoli akci vyžadující cluster: CLI ověří (přes kubeconfig/kind API),
  že existuje `kind` cluster `osiris-kind`, a že v něm běží
  `osiris-kind-operator` a potřebné core služby (ChromaDB, Ollama, OTel
  collector apod. — všechny jako Kubernetes workloady, ne jako samostatné
  Docker kontejnery vedle clusteru). Pokud cluster neexistuje → automaticky
  provede bootstrap (vytvoření clusteru, nasazení operátoru, core služeb).
  Docker (nebo Podman) se ověřuje/vyžaduje pouze jako **runtime závislost
  samotného `kind`** v tomto bootstrap kroku — mimo něj CLI, `osiris-api`
  ani žádná jiná TS/JS komponenta s Docker démonem nikdy nekomunikuje přímo
  (žádné `dockerode`, žádné přímé `docker`/`@devcontainers/cli` volání pro
  project/session kontejnery nebo pomocné služby — rozhodnuto, viz bod 6.7).
- Podpora: volitelné spuštění clusteru při startu systému (systemd
  service / launchd / registrace do OS autostart — platformově specifické).

### 3.2 Konfigurace
- Globální: `~/.osiris/`
- Per-projekt override: `<project>/.osiris/` (merge nad globální, projekt vyhrává)
- Struktura:
  ```
  ~/.osiris/
    config.yml          # globální nastavení agenta (cluster name, timeouty, ...)
    llm/*.yml            # definice přístupů k LLM providerům
    mcp/*.yml             # definice MCP serverů (lokální i vzdálené)
  <project>/.osiris/
    config.yml           # override
    llm/*.yml
    mcp/*.yml
  ```
- Je potřeba specifikovat merge strategii (deep-merge dle klíče, projekt může
  přidat i přepsat jednotlivé LLM/MCP záznamy podle názvu souboru/ID).

### 3.3 Projekty a session
- Každý projekt má unikátní jméno (validace při `osiris project init` /
  registraci — kontrola kolize v rámci clusteru).
- Pro každý projekt běží dedikovaný `.dev` kontejner jako Kubernetes Pod v
  `osiris-kind`, spravovaný výhradně operátorem přes CRD (`OsirisProject`/
  `OsirisSession`) — nikdy jako přímo spravovaný Docker kontejner z TS/JS
  kódu (žádné `dockerode`/`@devcontainers/cli` volání mimo operátor).
- Session = izolovaný běh v rámci projektu, N:1 (více session na projekt),
  každá session = vlastní kontejner, namapovaný na konkrétní projekt.
- Idle timeout (default 5 min, konfigurovatelné globálně i per-projekt) →
  session se "uspí" (scale-down / suspend kontejneru, ne smazání).
- `osiris session resume <id>` → obnoví běh kontejneru se zachovaným stavem.
- `osiris session rm <id>` → smaže kontejner i navázané prostředky session.
- Nutno definovat: co přesně přežívá uspání (FS mount, paměť v ChromaDB ano,
  in-memory stav procesu ne) a jaký mechanismus suspend/resume použít
  (`kubectl scale to 0` + PVC, nebo checkpoint/restore přes CRIU — doporučeno
  začít s jednodušší variantou scale-to-0 + persistentní volume).

### 3.4 `osiris-kind-operator`
- Kubernetes operátor v **Go, s Kubebuilderem** (jediná Go komponenta v
  projektu) nasazovaný do `osiris-kind` při bootstrapu.
- Řídí vše přes CRD, návrh CRD (názvy k doladění):
  - `OsirisProject` — reprezentuje projekt (unikátní jméno, cesta, `.dev`
    kontejner spec)
  - `OsirisSession` — reprezentuje session (odkaz na `OsirisProject`, stav:
    Running/Suspended/Terminating, idle timeout override)
  - `OsirisMemoryStore` (případně) — reprezentuje napojení na ChromaDB
    kolekce pro daný scope (global/project/session)
- Operátor implementuje reconcile loop pro suspend/resume na základě
  posledního timestampu aktivity (aktivitu reportuje CLI/API při interakci).
- Komunikace CLI/API (TS/JS) ↔ operátor (Go) probíhá výhradně přes
  Kubernetes API (vytváření/čtení CRD objektů) — CLI ani API nevolají
  operátor přímo, takže přechod přes jazykovou hranici je čistě přes
  Kubernetes, ne přes vlastní RPC/HTTP kontrakt mezi TS/JS a Go.

### 3.5 Paměť (ChromaDB)
- ChromaDB běží jako služba uvnitř `osiris-kind`.
- Tři úrovně kolekcí: global, project, session.
- Skládání kontextu paměti pro daný běh: global → + project → + session
  (v tomto pořadí, session má nejvyšší prioritu/nejnovější kontext).
- Je třeba definovat: embedding model (lokální vs. přes nakonfigurovaný LLM
  provider), retention/expiraci session paměti při smazání session
  (project/global paměť přežívá).

### 3.6 MCP podpora
- Lokální MCP servery nainstalované na stroji → CLI je umí detekovat/spravovat.
- Vzdálené MCP servery → CLI umí prohledávat MCP registry/knihovnu, stahovat
  a instalovat, zapsat konfiguraci do `.osiris/mcp/*.yml`.
- MCP konfigurace je scope-aware (global/project) stejně jako LLM konfigurace.

### 3.7 TUI
- Spouští se automaticky při `osiris` bez argumentů.
- Musí pokrývat minimálně: přehled projektů, přehled a přepínání session,
  stav clusteru/kontejnerů, chat s agentem.
- Doporučená technologie (TS/JS): **Ink** (React pro CLI) jako hlavní
  kandidát; alternativa `blessed`/`neo-blessed`, pokud by React model
  nevyhovoval pro daný rozsah UI.

## 4. `osiris-api`
- Běží **vždy uvnitř `osiris-kind` clusteru** jako Kubernetes Deployment +
  Service (`osiris-api`), nasazovaný při bootstrapu spolu s operátorem a
  core službami — nikdy jako samostatný Docker Compose kontejner nebo host
  proces mimo cluster.
- Publikace ven z clusteru: Service `osiris-api` naslouchá uvnitř clusteru
  na portu **8080**; bootstrap nastaví v konfiguraci `kind` clusteru
  `extraPortMappings`, které tento port zpřístupní na hostiteli jako
  `localhost:8080` (interně např. NodePort **30880**, mapovaný kindem na
  host port 8080). CLI/IDE se tak vždy připojují na `http://localhost:8080`
  (`OSIRIS_SERVER_URL`, zachovává dnešní výchozí hodnotu) — provoz ale nově
  vždy prochází přes `kind`, nikdy přímo do samostatného Docker kontejneru
  vedle clusteru.
- Poskytuje management API — vše, co jde přes CLI, musí jít i přes API
  (1:1 parita příkazů CLI ↔ endpointy API; doporučeno CLI interně volat
  stejné API, ne duplikovat logiku).
- Autentizace/autorizace k domluvení (lokální use-case — token generovaný
  při bootstrapu clusteru; protože je API nově vždy publikované na
  hostitele, nesmí běžet bez nastaveného tokenu — žádný "no-auth" fallback).

## 5. Osiris IDE (`osiris-ide`)
- Desktop i web varianta, sdílené jádro + extension systém.
- Spouští se příkazem `osiris-ide`.
- Vlastní repozitář `osiris-ide`.

### 5.1 `osiris-workspace`
- Vytváření nových projektů, otevírání existujících, zakládání struktury.

### 5.2 `osiris-ui-chat`
- Chat UI, přepínání mezi session.

### 5.3 `osiris-ui-config`
- Instalace/správa MCP serverů přes UI.
- Konfigurační UI pro všechny aspekty Osiris (LLM, MCP, timeouty, cluster).

## 6. Technologické otázky k rozhodnutí před startem
1. **Jazyk (rozhodnuto):** TS/JS (Node.js) pro CLI, API, IDE i extensions.
   **Výjimka: `osiris-kind-operator` je Go + Kubebuilder** — jediná Go
   komponenta v celém projektu. Nepřepisovat operátor do JS ani zavádět
   Go jinde.
2. Hranice mezi Go operátorem a TS/JS světem je Kubernetes API (CRD) — CLI
   a API čtou/zapisují CRD objekty přes `@kubernetes/client-node`, operátor
   je reconciluje přes controller-runtime (Go). Sdílení typů mezi Go a TS/JS
   se neřeší kódem, ale CRD OpenAPI schématem jako společným kontraktem
   (např. generovat TS typy z CRD schema, ne ručně duplikovat).
3. CLI framework (TS/JS): např. `commander`/`yargs`/`oclif` — vybrat podle
   toho, co je (případně už) použito v existujícím repu.
4. `osiris-api`: TS/JS (Node), sdílí typy s CLI přes společný balíček v
   monorepu (`packages/shared-types` nebo obdoba) — operátor do tohoto
   sdílení typů nespadá (jiný jazyk, kontrakt jde přes CRD schema, viz bod 2).
5. IDE stack: Electron/Tauri pro desktop + shared web core (VS Code
   extension model inspirace, nebo vlastní) — v TS/JS.
6. Perzistence konfigurace projektů/session mimo ChromaDB (potřeba nějaké
   „system of record" pro CRD stavy mimo etcd? pravděpodobně ne, etcd stačí).
7. **Docker (rozhodnuto):** je výhradně interní runtime závislost `kind`
   (kind cluster potřebuje Docker nebo Podman jako container engine pro své
   uzly) — žádná komponenta projektu (CLI, `osiris-api`, IDE extensions,
   pomocné balíčky typu `osiris-orchestrator`/`container-sync` apod.) nesmí
   komunikovat s Docker démonem přímo (`dockerode`, přímé
   `docker`/`@devcontainers/cli` volání) kvůli správě project/session
   kontejnerů ani pomocných služeb (ChromaDB, Ollama, OTel collector). Vše
   běží jako Kubernetes workloady uvnitř `osiris-kind`, spravované
   operátorem přes CRD (viz sekce 3.3/3.4). Jediná výjimka je samotný
   bootstrap krok, který Docker jen ověřuje jako předpoklad pro vytvoření
   `kind` clusteru (viz sekce 3.1).

## 7. Bezpečnostní a provozní požadavky
- Validace unikátnosti jména projektu při vytváření.
- Graceful handling: Docker neběží, `kind` není nainstalován, cluster
  existuje ale je nekonzistentní (self-heal / `osiris doctor` příkaz).
- Konfigurovatelné timeouty (idle suspend) na úrovni global/project/session.
- Balíčkování (`.deb`, `.rpm`, případně AppImage/snap): protože Osiris
  pracuje vždy přes `kind` a Docker je jen jeho interní závislost (viz bod
  6.7), `.deb`/`.rpm` balíčky musí deklarovat Docker Engine (a `kind`/
  `kubectl`, pokud nejsou bundlovány přímo v balíčku) jako runtime závislost
  v balíčkových metadatech (`Depends:` u `.deb`, `Requires:` u `.rpm`), ne
  jen zmínku v dokumentaci. Sandboxované formáty (AppImage, snap) takovou
  deklarativní závislost k dispozici nemají — tam musí chybějící Docker/
  `kind` detekovat a srozumitelně nahlásit `osiris doctor` při startu.

## 8. Aktuální stav vs. cíl (evidence rozdílů)

> Vyplňovat průběžně podle zjištění z jednotlivých úkolů. Účel: nemuset
> pokaždé znovu objevovat, kde se realita rozchází se spec — a hlavně
> odlišit **"existuje, ale jinak"** od **"neexistuje vůbec, musí se
> napsat"**, protože se to promítá do odhadu rozsahu i do promptu.

> Audit proveden 2026-09-05 (viz sekce 1.1 pro featury, které spec vůbec nezmiňuje).

| Oblast | Cílový stav (viz sekce výše) | Skutečný stav | Typ rozdílu (uprav / doplň chybějící / OK) |
|---|---|---|---|
| CLI framework (TS/JS) | commander/yargs/oclif dle existujícího repa | Ruční parsování `argv` bez knihovny (`packages/cli/src/run.ts` `parseFlags`, bin entry `packages/cli/src/cli.ts`). Žádný commander/yargs/oclif/ink v závislostech. Reálné příkazy: `init`, `agent list`, `crew run`, `memory reindex\|watch\|search`, `backlog list\|new\|move\|push\|pull\|lint`, `serve`, `session resume\|suspend\|rm`, `doctor`, `repl`. | uprav (funguje, ale bez CLI frameworku ze spec bodu 6.3) |
| Bootstrap clusteru | auto při potřebě (kontrola stavu `kind` clusteru přes kubeconfig, Docker jen jako interní závislost `kind` — viz bod 6.7) + volitelně při startu OS | Neexistuje. CLI nikdy nevytváří ani nekontroluje `kind` cluster, nekontroluje Docker, nemá OS autostart. `osiris session *` (`packages/cli/src/session-commands.ts`) jen předpokládá běžící `osiris-server` na `OSIRIS_SERVER_URL`. Reálné K8s API volání (`KubeConfig.loadFromDefault/loadFromCluster`) jsou až v `apps/osiris-server` — i ten cluster jen *používá*, nevytváří. Souběžně `packages/orchestrator` (dockerode) spravuje jiný, čistě Docker-based lokální stack (ollama/otel/dashboard/sync-worker) pro `desktop-host` — nesouvisí s kind/k8s vůbec. | doplň chybějící |
| CRD | `OsirisProject`, `OsirisSession`, `OsirisMemoryStore` | `OsirisProject` a `OsirisSession` existují (`operator/api/v1alpha1/{osirisproject_types.go,osirissession_types.go}`) se solidním pokrytím polí (`path`, `devContainer` spec, `idleTimeoutSeconds`, `desiredPhase`, `status.phase` enum Pending/Running/Suspending/Suspended/Resuming/Terminating, `lastActivityAt`, `workloadRef`/`pvcRef`/`leaseRef`). `OsirisMemoryStore` neexistuje vůbec, ani jako stub — nula výskytů v Go kódu. | OK (Project/Session) + doplň chybějící (MemoryStore) |
| Reconcile loop operátoru (Go/Kubebuilder) | controller-runtime | Plně implementováno: Go 1.26.0, Kubebuilder CLI 4.15.0 (`go.kubebuilder.io/v4`), `sigs.k8s.io/controller-runtime v0.24.1`, `k8s.io/client-go v0.36.0`. `osirisproject_controller.go` (tenký, jen Ready condition) + `osirissession_controller.go` (plná suspend/resume logika, řádky ~70-320) + `workload.go` (Deployment/PVC/Lease). Testováno envtestem (`osirissession_controller_test.go`), e2e zatím jen manager startup, ne suspend/resume flow. | OK |
| Suspend/resume mechanismus | scale-to-0 + PVC (návrh) | Přesně scale-to-0 + PVC, žádné CRIU (0 výskytů). Idle detekce přes Kubernetes `Lease` (`coordination.k8s.io`) per session, kterou externě "obnovuje" `apps/osiris-server` (`kubernetes-executor.ts` `patchNamespacedLease`) při hlášené aktivitě. Reconciler počítá `idleExpired` a nastaví `replicas` 0/1, aniž by měnil `desiredPhase` (auto-suspend odděleno od manuálního suspend/resume). PVC i Lease přežívají suspend; Deployment se maže jen při `osiris session rm`. Idle timeout precedence: session override → project default → operator default (300s). | OK |
| Konfigurace `.osiris` | global (`~/.osiris`) + local (`<project>/.osiris`) deep-merge, `config.yml`+`llm/*.yml`+`mcp/*.yml` | Existuje jen `<project>/.osiris/` s plochými soubory `crew.json`, `memory.json`, `mcp.json` (`packages/dot-osiris/src/layout.ts`) a fallback na bundlovanou template (`packages/dot-osiris/template/`) — ne na uživatelský `~/.osiris`. Nula výskytů homedir/globálního scope napříč `dot-osiris`, `mcp`, `memory`. Merge = "projektový soubor, nebo bundlovaná šablona" (`resolve.ts`), ne deep-merge dvou uživatelských úrovní. Žádné adresáře `llm/*.yml` ani `mcp/*.yml` — jen jednotlivé JSON soubory. | uprav + doplň chybějící (chybí globální `~/.osiris` úroveň a granularita per-entry `llm/`/`mcp/` adresářů) |
| Paměť / ChromaDB | 3 vrstvy (global/project/session), skládání kontextu, služba v clusteru | ChromaDB integrace existuje (`packages/memory`, `chromadb` npm klient), ale běží jen lokálně/Docker Compose (`.devcontainer/docker-compose.yml`, `apps/osiris-server/docker-compose.yml`) — nikde v `operator/` ani jiném k8s manifestu. Bez dostupného ChromaDB automatický fallback na in-process store. Jen jedna kolekce (default `osiris-memory`) — žádná vrstva global/project/session. Fakticky jde o dokumentační knowledge-base indexer nad `.osiris/memory/` Markdown soubory, ne o session/conversation paměť. Embedding default = `hash` (offline, nesémantický), volitelně Ollama nebo OpenAI-compatible. | uprav + doplň chybějící (chybí cluster deployment i 3-vrstvá struktura; jde o jinou featuru než spec §3.5 zamýšlí — viz sekce 1.1) |
| MCP | lokální detekce + registry install, scope-aware `mcp/*.yml` | Transporty stdio + Streamable HTTP implementovány (`packages/mcp/src/transport.ts`). Config je jeden soubor `.osiris/mcp.json` (ne adresář `mcp/*.yml`), merge jen projekt-vs-bundlovaná šablona (žádné `~/.osiris`). Bridge do crew existuje (`crew-tools.ts`). Lokální detekce nainstalovaných MCP serverů na stroji neexistuje. Registry pro vyhledávání/stahování/instalaci vzdálených MCP serverů neexistuje — `registry.ts` je jen lifecycle wrapper nad už nakonfigurovanými servery, ne marketplace. | uprav + doplň chybějící |
| TUI | Ink (React pro CLI), pokrývá projekty/session/cluster/chat | Neexistuje. `osiris` bez argumentů jen vypíše nápovědu a skončí (`run.ts`). Nejbližší náhrada je `osiris repl` — obyčejný Node `node:repl` s pomocnými funkcemi (`backlog()`, `agents()`, `search()`, `crew()`) vázanými do scope; žádné full-screen UI, žádný Ink/blessed, žádný ze 4 požadovaných pohledů. | doplň chybějící |
| `osiris-api` | 1:1 parita s CLI, TS/JS, běží vždy jako Deployment+Service uvnitř `osiris-kind`, publikováno na host port 8080 přes kind `extraPortMappings` (NodePort 30880), auth token povinný (žádný no-auth fallback) | `apps/osiris-server` (Fastify) existuje s reálnými endpointy: session API (create/get/suspend/resume/delete/activity/events-SSE), git hosting (smart-HTTP), console API (backlog/crew/memory), SPA serving. Session operace jsou skutečně CRD-backed (`KubernetesSessionExecutor` → `OsirisSession` CRD + Lease patch). Ale: neběží "v clusteru" jako workload — jen Docker Compose/Dockerfile/`osiris serve` subprocess, žádný k8s Deployment manifest pro server samotný. Auth = jeden statický bearer token (`OSIRIS_SERVER_TOKEN`) nebo Basic pro git; bez nastaveného tokenu běží úplně bez auth (jen varování) — ne token generovaný při bootstrapu clusteru. CLI parita jen částečná: session příkazy jdou přes API (`session-client.ts`), ale `backlog`/`crew`/`memory` příkazy v CLI volají balíčky přímo (`packages/{backlog,crew,memory}`) — duplicitně se stejnou logikou, kterou má i server. | uprav |
| `osiris-ide` a extensions | samostatné repo, TS/JS, spustitelné `osiris-ide`, workspace/ui-chat/ui-config extensions | Jeden monorepo (ne samostatné repo — potvrzeno root `package.json` `"osiris-ide"` + pnpm workspace). Desktop = VSCodium overlay (rebrand prebuild, `apps/osiris-desktop`), Web = OpenVSCode Server pattern (`apps/osiris-web`) — "overlay not vendored" přístup zachován. Žádný jednotný `osiris-ide` bin příkaz — desktop a web se spouští odděleně (Electron bundle vs. `osiris-web` node server). `extensions/osiris-workspace` NEODPOVÍDÁ §5.1 — místo project scaffoldingu dělá DevContainer enforcement, remote-authority resolver, LLM model-config wizard a session handover/suspend-resume UI. `extensions/osiris-ai` částečně odpovídá §5.2 — má chat panel s agentem a MCP status, ale bez přepínání mezi session (jeden perzistentní panel/thread). `osiris-ui-config` (§5.3) jako samostatná featura neexistuje — LLM config wizard žije uvnitř `osiris-workspace`, MCP config je jen syrový JSON, timeout/cluster config UI chybí úplně. `apps/osiris-console` (spec nezmíněná SPA) pokrývá Kanban backlog + crew runs + KB search, ale ne MCP/LLM/timeout/cluster. | uprav + doplň chybějící |
| Přímá závislost na Docker mimo `kind` (nové architektonické pravidlo, bod 6.7) | žádná — Docker je jen interní runtime `kind`, žádná TS/JS komponenta s ním nekomunikuje přímo | `packages/orchestrator` (dockerode) spravuje lokální Docker stack (ollama/otel/dashboard/sync-worker) mimo `kind`, konzumovaný `packages/desktop-host`. `packages/container-sync` + `extensions/osiris-workspace` spravují DevContainery přímo přes `@devcontainers/cli`/`dockerode` a Docker socket (`devcontainerHash`, `docker-cli.ts`), ne přes Kubernetes pody v `osiris-kind`. `apps/osiris-server` dnes běží přes Docker Compose / host proces, ne jako in-cluster Deployment (viz řádek `osiris-api` výše). | uprav — toto je nově formulované pravidlo (dřív ho spec jen naznačoval v bodě 2 sekce 6); `orchestrator` a `container-sync` je potřeba buď přepracovat na Kubernetes workloady v `osiris-kind`, nebo explicitně vyčlenit jako desktop-only pomocnou vrstvu mimo hlavní project/session cestu — rozhodnutí je předmětem samostatného úkolu, ne tohoto auditu |
| **crew** (existující featura) | zachovat funkčnost, viz 1.1 | Plně funkční multi-agent coordinator (`packages/crew`) — lead agent deleguje specialistům, sdílený blackboard, bridge na memory/backlog/MCP. Žádné narušení zjištěno v rámci tohoto auditu. Popis a umístění doplněny do sekce 1.1. | OK (zachovat) |

## 9. Šablona promptu pro dílčí úkol

> Předpoklad: úvodní audit ze sekce 0 už proběhl a tabulky v sekcích 1.1 a
> 8 jsou vyplněné aspoň orientačně. Pokud ještě ne, udělejte nejdřív to.

Pro každý dílčí úkol (ne celý spec najednou) použijte tuto strukturu. Není
to čistě refaktoringová šablona — počítá s tím, že část práce bude psaní
nového kódu pro chybějící funkcionalitu:

```
Kontext: Přiložený/odkazovaný OSIRIS_SPEC.md popisuje cílovou architekturu
projektu Osiris. Projekt už existuje a běží. Tento úkol NENÍ čistý
refaktoring — může jít o úpravu existujícího kódu, doplnění zcela chybějící
funkcionality, nebo obojí zároveň.

Jazyk: CLI, `osiris-api`, IDE i extensions jsou TS/JS (Node.js).
VÝJIMKA: `osiris-kind-operator` je a zůstává v Go + Kubebuilder — pokud
úkol zasahuje do operátoru, piš/uprav ho v Go dle Kubebuilder konvencí
(controllers/, api/ typy, kubebuilder markery), NE v TS/JS. Pokud úkol
zasahuje do CLI/API/IDE, piš v TS/JS, NE v Go.

Zachování existujících featur: Osiris má existující funkce (viz spec
sekce 1.1, např. "crew"), které nejsou nutně detailně popsané ve zbytku
spec, ale musí zůstat funkční. Pokud kód, kterého se úkol dotýká, s
takovou featurou souvisí nebo ji jen míjí, over v kroku 1, že ji úkol
nerozbije, a v kroku 2 to explicitně ošetři (i kdyby řešením bylo "nedotýkat
se tohoto souboru/modulu").

Krok 1 — Prozkoumej: Projdi si aktuální implementaci [KONKRÉTNÍ OBLAST,
např. "session suspend/resume v operátoru"] v repu [cesta/moduly].
Neupravuj nic. Shrň mi:
  - co dnes existuje a jak to funguje (soubory, tok dat, klíčová rozhodnutí)
  - co ze spec sekce [X.Y] chybí úplně (musí se napsat od nuly)
  - kde existující kód odpovídá spec, kde se rozchází a proč to tak podle
    tebe může být (bug, záměrná odchylka, zastaralý spec)
  - jestli se dotýká nebo je v blízkosti nějaké existující featury ze
    sekce 1.1 spec (např. crew) a pokud ano, jak funguje dnes

[ČEKAT NA POTVRZENÍ / dál v jednom promptu, podle preference]

Krok 2 — Navrhni plán: Na základě zjištění navrhni konkrétní plán práce,
rozděl ho na (a) úpravy existujícího kódu a (b) novou funkcionalitu k
napsání. Ke každé části uveď dotčené soubory/balíčky, jazyk (TS/JS vs. Go
podle komponenty), případné breaking changes a migrace dat/CRD, pokud
relevantní. Pokud úkol hraničí s existující featurou (crew apod.), uveď
explicitně, jak zůstane zachována. Neimplementuj zatím.

Krok 3 — Implementuj: Po mém schválení proveď plán z kroku 2 (úpravy i
nový kód, ve správném jazyce dle komponenty). Zachovej zpětnou kompatibilitu
[ANO/NE + v čem] a funkčnost existujících featur (crew apod.). Přidej testy
pro nově napsaný kód i pro změněné chování. Na konci shrň, co bylo
upraveno, co bylo nově napsáno, a jestli je potřeba aktualizovat tabulky
v sekcích 1.1 a 8 spec.

Rozsah: pouze [KONKRÉTNÍ OBLAST]. Neřeš [sousední oblasti, které NEJSOU
předmětem tohoto úkolu].
```

Poznámky k šabloně:
- **Krok 1 je povinný a oddělený i tam, kde se čeká hlavně nový kód** —
  i "chybějící" funkcionalita může mít částečné základy (typy, prázdné
  stuby, komentáře s TODO), které je potřeba najít a navázat na ně, ne
  duplikovat.
- **Jazyková výjimka pro operátor se píše do každého promptu, ne jen do
  spec** — je to jediné místo v projektu, kde platí jiné pravidlo, a je
  snadné na to při psaní promptu zapomenout/přehlédnout, pokud to Claude
  Code nevidí explicitně přímo v zadání úkolu.
- Explicitně nechte Claude Code rozlišit v kroku 2 "uprav" vs. "napiš nově"
  — usnadní to odhad rozsahu a review.
- U rizikovějších změn (CRD schema, formát `.osiris` configu, cokoliv, co
  má existující data/instance) explicitně žádejte krok 2 (plán) jako
  samostatný checkpoint před krokem 3 (implementace) — nedávat do jednoho
  souvislého běhu.
- Po dokončení úkolu doplňte řádek v tabulce sekce 8 (a případně sekce 1.1,
  pokud jste narazili na další dosud nezapsanou existující featuru), ať se
  znalost o skutečném stavu neztrácí mezi konverzacemi.
