# Osiris AI Agent — Cílová architektura (referenční spec pro Claude Code)

> **Status: projekt Osiris již existuje a funguje.** Tento dokument je
> **cílová architektura**, ne zadání "postav od nuly". Veškeré další úkoly
> jsou v zásadě refaktoring — sbližování skutečného stavu kódu s tímto
> popisem, případně úprava tohoto dokumentu, pokud se ukáže, že realita je
> lepší/jinak zdůvodněná než tady napsaná verze.
>
> Doporučený postup pro každý úkol: (1) nechat Claude Code nejdřív
> prozkoumat aktuální stav relevantní části kódu, (2) porovnat se
> spec, (3) navrhnout/potvrdit diff, (4) až pak implementovat. Nepoužívat
> tento dokument jako jediný prompt pro "udělej vše najednou" — vkládat vždy
> jen relevantní sekci + explicitní rozsah úkolu (viz šablona v sekci 9).
>
> Tento spec sám o sobě **nepopisuje aktuální stav** implementace (jaké
> repo/moduly/verze skutečně existují) — to zjišťuje Claude Code při každém
> úkolu z reálného kódu, ne odsud. Pokud se při práci zjistí trvalý rozpor
> mezi kódem a tímto dokumentem, promítněte ho zpět sem (sekce 8).

## 1. Vize

Osiris je AI agent distribuovaný jako CLI nástroj (`osiris`), který běží lokálně,
ale veškerou práci (dev prostředí, session, paměť) deleguje do lokálního
Kubernetes clusteru (`kind`). Cílem je mít reprodukovatelné, izolované,
uspávatelné vývojové/agentní session s perzistentní vrstvenou pamětí
(global → project → session), rozšiřitelné o MCP servery a LLM providery přes
YAML konfiguraci, a s IDE nadstavbou (desktop + web).

## 2. Repozitáře

| Repo | Obsah |
|---|---|
| `osiris-ai` | CLI `osiris`, `osiris-kind-operator`, `osiris-api`, sdílené knihovny |
| `osiris-ide` | Osiris IDE (desktop + web), spouští se `osiris-ide`, obsahuje extensions `osiris-workspace`, `osiris-ui-chat`, `osiris-ui-config` |

> Otevřená otázka k rozhodnutí: `osiris-api` a `osiris-kind-operator` — dát do
> monorepa `osiris-ai` (např. Go workspace / Nx / Turborepo) nebo do
> samostatných repozitářů? Doporučení: monorepo `osiris-ai` s jasně
> oddělenými moduly (`/cmd/osiris`, `/cmd/osiris-api`, `/operator`), protože
> sdílí typy CRD a klienta pro cluster.

## 3. `osiris` CLI

### 3.1 Chování při spuštění
- `osiris` bez parametrů → spustí TUI.
- `osiris <příkaz>` → klasické CLI chování (podobně jako `docker`/`kubectl`).
- Při jakékoli akci vyžadující cluster: CLI ověří, že Docker běží, že existuje
  `kind` cluster `osiris-kind`, a že v něm běží `osiris-kind-operator` a
  potřebné core služby (ChromaDB apod.). Pokud ne — automaticky
  provede bootstrap (vytvoření clusteru, nasazení operátoru, core služeb).
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
- Pro každý projekt běží dedikovaný `.dev` kontejner (pod) v `osiris-kind`.
- Session = izolovaný běh v rámci projektu, N:1 (více session na projekt),
  každá session = vlastní kontejner, namapovaný na konkrétní projekt.
- Idle timeout (default 5 min, konfigurovatelné globálně i per-projekt) —
  session se "uspí" (scale-down / suspend kontejneru, ne smazání).
- `osiris session resume <id>` — obnoví běh kontejneru se zachovaným stavem.
- `osiris session rm <id>` — smaže kontejner i navázané prostředky session.
- Nutno definovat: co přesně přežívá uspání (FS mount, paměť v ChromaDB ano,
  in-memory stav procesu ne) a jaký mechanismus suspend/resume použít
  (`kubectl scale to 0` + PVC, nebo checkpoint/restore přes CRIU — doporučeno
  začít s jednodušší variantou scale-to-0 + persistentní volume).

### 3.4 `osiris-kind-operator`
- Kubernetes operátor (Go, kubebuilder/operator-sdk doporučeno) nasazovaný do
  `osiris-kind` při bootstrapu.
- Řídí vše přes CRD, návrh CRD (názvy k doladění):
  - `OsirisProject` — reprezentuje projekt (unikátní jméno, cesta, `.dev`
    kontejner spec)
  - `OsirisSession` — reprezentuje session (odkaz na `OsirisProject`, stav:
    Running/Suspended/Terminating, idle timeout override)
  - `OsirisMemoryStore` (případně) — reprezentuje napojení na ChromaDB
    kolekce pro daný scope (global/project/session)
- Operátor implementuje reconcile loop pro suspend/resume na základě
  posledního timestampu aktivity (aktivitu reportuje CLI/API při interakci).

### 3.5 Paměť (ChromaDB)
- ChromaDB běží jako služba uvnitř `osiris-kind`.
- Tři úrovně kolekcí: global, project, session.
- Skládání kontextu paměti pro daný běh: global → + project → + session
  (v tomto pořadí, session má nejvyšší prioritu/nejnovější kontext).
- Je třeba definovat: embedding model (lokální vs. přes nakonfigurovaný LLM
  provider), retention/expiraci session paměti při smazání session
  (project/global paměť přežívá).

### 3.6 MCP podpora
- Lokální MCP servery nainstalované na stroji — CLI je umí detekovat/spravovat.
- Vzdálené MCP servery — CLI umí prohledávat MCP registry/knihovnu, stahovat
  a instalovat, zapsat konfiguraci do `.osiris/mcp/*.yml`.
- MCP konfigurace je scope-aware (global/project) stejně jako LLM konfigurace.

### 3.7 TUI
- Spouští se automaticky při `osiris` bez argumentů.
- Musí pokrývat minimálně: přehled projektů, přehled a přepínání session,
  stav clusteru/kontejnerů, chat s agentem.
- Doporučená technologie (Go): Bubble Tea / Lip Gloss (pokud CLI bude v Go).

## 4. `osiris-api`
- Běží uvnitř clusteru.
- Poskytuje management API — vše, co jde přes CLI, musí jít i přes API
  (1:1 parita příkazů CLI ↔ endpointy API; doporučeno CLI interně volat
  stejné API, ne duplikovat logiku).
- Autentizace/autorizace k domluvení (lokální use-case — pravděpodobně token
  generovaný při bootstrapu clusteru).

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
1. Jazyk CLI + operátor: doporučeno Go (přirozené pro k8s operátory,
   kubebuilder, dobré TUI knihovny).
2. `osiris-api`: Go (sdílení typů s operátorem) vs. jiný stack pro IDE
   snadnější integraci (např. Node/TS, pokud IDE bude Electron + web).
3. IDE stack: Electron/Tauri pro desktop + shared web core (VS Code
   extension model inspirace, nebo vlastní).
4. Perzistence konfigurace projektů/session mimo ChromaDB (potřeba nějaké
   "system of record" pro CRD stavy mimo etcd? pravděpodobně ne, etcd stačí).

## 7. Bezpečnostní a provozní požadavky
- Validace unikátnosti jména projektu při vytváření.
- Graceful handling: Docker neběží, `kind` není nainstalován, cluster
  existuje ale je nekonzistentní (self-heal / `osiris doctor` příkaz).
- Konfigurovatelné timeouty (idle suspend) na úrovni global/project/session.

## 8. Aktuální stav vs. cíl (evidence rozdílů)

> Vyplňovat průběžně podle zjištění z jednotlivých refaktoringových úkolů.
> Účel: nemuset pokaždé znovu objevovat, kde se realita rozchází se spec.

| Oblast | Cílový stav (viz sekce výše) | Skutečný stav | Poznámka |
|---|---|---|---|
| CLI framework | — | Node/TS (`@osiris/cli`, `packages/cli`), ne Go | TUI (§3.7, Bubble Tea) není postaveno; `osiris` je zatím čistě příkazové (`run.ts` dispatch), bez `osiris` bez-argumentů TUI |
| Bootstrap clusteru | auto při potřebě + volitelně při startu OS | Ruční/skriptované (`operator/hack/bootstrap.sh`) | Žádná automatická detekce/bootstrap z CLI (§3.1) — CLI dnes cluster vůbec nezná, jen mluví s `osiris-server`, který mluví s clusterem |
| CRD | `OsirisProject`, `OsirisSession`, `OsirisMemoryStore` | `OsirisProject` + `OsirisSession` implementovány (`operator/api/v1alpha1`), Go/kubebuilder v4, controller-runtime | `OsirisMemoryStore` záměrně nepostaveno (mimo rozsah 2026-09-04 úkolu). Skutečná API group je `osiris.osiris.dev` (kubebuilder spojuje `--group`+`--domain`), ne `osiris.dev` jak by naznačovala prozaická zkratka výše |
| Suspend/resume mechanismus | scale-to-0 + PVC (návrh) | Implementováno přesně takto | `OsirisSessionReconciler` škáluje Deployment 0/1 podle `coordination.k8s.io/v1 Lease` (aktivita) a `spec.desiredPhase`; PVC se vytváří jednou a nikdy nemaže při suspend. Idle-timeout auto-suspend nikdy nepřepisuje `spec.desiredPhase` (zůstává `Running`) — resume z idle stavu stačí bumpnout Lease, bez CR patch. `osiris session rm` = finalizer drénující Deployment→PVC. Ověřeno `envtest` suitou (5 scénářů) + `kind`-backed CI jobem (`.github/workflows/osiris-operator.yml`) |
| Konfigurace `.osiris` | global+local deep-merge | Existuje (`packages/dot-osiris`), ale ne ve tvaru `llm/*.yml`/`mcp/*.yml` z §3.2 | Necíleno tímto úkolem |
| Paměť / ChromaDB | 3 vrstvy, skládání kontextu | Existuje (`packages/memory`, `osiris-crew-backlog-memory` memory) | Mimo rozsah 2026-09-04 úkolu (suspend/resume) — nekontrolováno v rámci něj |
| MCP | lokální detekce + registry install | `packages/mcp` existuje, scope neověřen | Mimo rozsah 2026-09-04 úkolu |
| TUI | Bubble Tea | Neexistuje | `osiris` je Node/TS CLI bez TUI |
| `osiris-api` | 1:1 parita s CLI | `apps/osiris-server` (Fastify) — session lifecycle (create/get/suspend/resume/delete/activity) 1:1 s novými CLI příkazy `osiris session resume/suspend/rm`; ostatní CLI příkazy (crew/backlog/memory/init/doctor) běží lokálně v CLI, ne přes API | Parita je zatím jen pro session-lifecycle podmnožinu |
| `osiris-ide` a extensions | samostatné repo | Monorepo (`extensions/osiris-workspace`, `apps/osiris-desktop`, `apps/osiris-web`), ne samostatný `osiris-ide` repo | Vědomá odchylka, monorepo místo dvou repozitářů |

**Poznámka k historii (2026-09-02 → 2026-09-04):** mezi 2026-09-02 a
2026-09-04 platila v repu odlišná, čistě TS/Docker-based architektura session
lifecycle (freeze/thaw kontejneru mezi "local" a "server" lokací, bez
Kubernetes vůbec — viz `osiris-pure-ts-architecture-revision` memory).
2026-09-04 byl na explicitní žádost tento Docker-based mechanismus zcela
nahrazen výše popsaným `osiris-kind-operator` řešením, čímž se řádek
"Suspend/resume mechanismus" (a částečně CRD) vrátil blíž k této spec, na
úkor dřívějšího rozhodnutí "žádné Kubernetes". Ostatní části té revize (git
hosting, devcontainer tooling, agent-core snapshoty, telemetry) zůstávají v
platnosti beze změny.

## 9. Šablona promptu pro refaktoringový úkol

Pro každý dílčí úkol (ne celý spec najednou) použijte tuto strukturu:

```
Kontext: Přiložený/odkazovaný OSIRIS_SPEC.md popisuje cílovou architekturu
projektu Osiris. Projekt už existuje a běží — tohle je refaktoring,
NE stavba od nuly.

Krok 1 — Prozkoumej: Projdi si aktuální implementaci [KONKRÉTNÍ OBLAST,
např. "session suspend/resume v operátoru"] v repu [cesta/moduly].
Neupravuj nic. Shrň mi:
  - jak to funguje dnes (soubory, tok dat, klíčová rozhodnutí v kódu)
  - kde se to shoduje se spec sekcí [X.Y]
  - kde se to rozchází a proč to tak podle tebe může být (bug, záměrná
    odchylka, zastaralý spec)

[ČEKAT NA POTVRZENÍ / dál v jednom promptu, podle preference]

Krok 2 — Navrhni refaktoring: Na základě rozdílů navrhni konkrétní plán
změn (soubory, které se dotknou, případné breaking changes, migrace dat/CRD
pokud relevantní). Neimplementuj zatím.

Krok 3 — Implementuj: Po mém schválení proveď refaktoring podle plánu z
kroku 2. Zachovej zpětnou kompatibilitu [ANO/NE + v čem]. Přidej/uprav testy
pokrývající změněné chování. Na konci shrň, co se změnilo a jestli něco
ze spec (sekce 8 tabulka) je potřeba aktualizovat.

Rozsah: pouze [KONKRÉTNÍ OBLAST]. Neřeš [sousední oblasti, které NEJSOU
předmětem tohoto úkolu].
```

Poznámky k šabloně:
- **Krok 1 je povinný a oddělený** — u refaktoringu je nejdražší chyba
  začít měnit kód dřív, než se pochopí, proč je současný stav takový, jaký
  je (může tam být záměrný workaround).
- U rizikovějších změn (CRD schema, formát `.osiris` configu, cokoliv, co
  má existující data/instance) explicitně žádejte krok 2 (plán) jako
  samostatný checkpoint před krokem 3 (implementace) — nedávat do jednoho
  souvislého běhu.
- Po dokončení úkolu doplňte řádek v tabulce sekce 8, ať se znalost
  o skutečném stavu neztrácí mezi konverzacemi.
