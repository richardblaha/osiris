# Architektura Osirisu

Osiris je multi-tenant asistent pro živnostníky a malé firmy (zakázky, termíny, poznámky, nabídky, faktury). Uživatelé s ním mluví přes webový chat a WhatsApp, česky nebo slovensky. Tento dokument popisuje, z čeho se systém skládá, jak spolu části mluví, kde leží data a jak je zajištěná bezpečnost a provoz.

Podrobnosti pro vývoj jsou v [CLAUDE.md](../CLAUDE.md), postup nasazení a provozu v [deploy/README.md](../deploy/README.md).

## Hlavní principy

- **Každý tenant má vlastní kontejner.** Agent tenanta běží v samostatném podu v jeho vlastním namespace, s vlastní databází a soubory na vlastním svazku. Tenanti se nevidí ani po síti.
- **Nečinný tenant spí.** Runtime tenanta se po nastavené době nečinnosti zazálohuje a vypne (scale-to-zero). Probudí ho další požadavek, zpráva z WhatsAppu nebo naplánovaná úloha.
- **Přihlašování zajišťuje Osiris sám.** Control je poskytovatel identity (OpenID Connect) na `osiris.k6labs.cz/auth`: hesla, klíče (passkeys), účty Google, Facebook a Microsoft, dvoufázové ověření. Uživatelé a jejich claimy (kdo kam patří) jsou v centrální databázi. PocketID v clusteru zůstává pro jiné služby.
- **Jediný vstup z internetu.** Na `osiris.k6labs.cz` odpovídá jen gateway. Ostatní služby jsou dostupné jen uvnitř clusteru a jen tomu, komu to síťové politiky dovolí.
- **Nejmenší možná oprávnění.** Přihlašovací klíče a údaje uživatelů má jen control, ke Kubernetes API jen operátor (a control pro objekty `Tenant`), klíče k S3 jen control a sites. Runtime tenanta nedrží žádný sdílený klíč.

## Komponenty

```mermaid
flowchart LR
    user([Uživatel<br/>prohlížeč])
    wa([WhatsApp<br/>Meta Cloud API])
    visitor([Návštěvník<br/>webu tenanta])
    idp[(Google, Facebook,<br/>Microsoft, SMTP)]
    llm[(Mistral API<br/>a další LLM)]
    s3[(Civo Object Store<br/>bucket osiris)]

    subgraph cluster[k3s cluster abydos]
        traefik[Traefik<br/>ingress + TLS]

        subgraph ns_osiris[namespace osiris]
            gateway[gateway<br/>2 repliky]
            control[control<br/>2 repliky]
            operator[operator<br/>1 replika]
            sites[sites<br/>2 repliky]
            gotenberg[gotenberg<br/>HTML/DOCX → PDF]
            rqlite[(rqlite<br/>3 uzly, Raft)]
        end

        subgraph ns_tenant_a[namespace osiris-t-acme]
            runtimeA[runtime acme<br/>0–1 pod]
            pvcA[(svazek acme<br/>DB + soubory)]
        end

        subgraph ns_tenant_b[namespace osiris-t-beta]
            runtimeB[runtime beta<br/>0–1 pod]
            pvcB[(svazek beta)]
        end
    end

    user -->|HTTPS| traefik
    wa -->|webhook| traefik
    visitor -->|HTTPS vlastní doména| traefik
    traefik --> gateway
    traefik --> sites

    gateway -->|/auth, identita tokenu| control
    gateway -->|interní JWT| control
    gateway -->|interní JWT| runtimeA
    gateway -->|interní JWT| runtimeB

    control --> rqlite
    control -->|přihlášení, e-maily| idp
    control -->|odpovědi| wa
    control --> s3
    control -->|objekty Tenant| operator
    control -->|běhy, WhatsApp| runtimeA

    operator -->|spravuje| ns_tenant_a
    operator -->|spravuje| ns_tenant_b

    runtimeA --- pvcA
    runtimeB --- pvcB
    runtimeA -->|ServiceAccount token| control
    runtimeA --> gotenberg
    runtimeA --> llm

    sites --> rqlite
    sites --> s3
    rqlite -->|zálohy| s3
```

| Služba | Úloha | Data a klíče |
|---|---|---|
| **gateway** | Jediný vstup pro `osiris.k6labs.cz`. Přihlašování (`/auth`) předává do control, u API se control zeptá, komu access token patří, spočítá z claimů členství a pošle požadavek do control nebo do runtime aktivního tenanta. Spící runtime probudí. Servíruje webovou aplikaci, nastavuje bezpečnostní hlavičky (CSP) a limity požadavků. | Soukromý klíč pro interní JWT |
| **control** | Řídicí rovina: přihlašování (OIDC provider), uživatelé a jejich přihlašovací údaje, tenanti, správa členů, WhatsApp, plánovač úloh, domény a publikace webů, zálohy tenantů. Zapisuje objekty `Tenant` pro operátora. | rqlite, S3, podepisovací klíč ID tokenů, klíče Google/Facebook/Microsoft, SMTP, WhatsApp token |
| **operator** | Z objektů `Tenant` udržuje namespace tenantů: StatefulSet s runtime, svazek, síťové politiky, kvóty, ingressy pro domény. Uspává nečinné tenanty a budí je na požádání. | Master klíč pro odvození klíčů tenantů |
| **runtime** | Agent jednoho tenanta (LangGraph): chat, znalostní báze, dovednosti, paměť, MCP, tajemství, soubory. Interní rozhraní pro control a operátora. | Databáze a soubory tenanta na jeho svazku, klíč tenanta pro tajemství |
| **sites** | Statický server pro weby tenantů na jejich vlastních doménách. | rqlite (jen čtení), S3 |
| **gotenberg** | Převod HTML a dokumentů Office do PDF. Bez přístupu ven. | žádná |
| **rqlite** | Centrální databáze (SQLite replikované přes Raft). | Svazky uzlů, automatické zálohy do S3 |

### Sdílené balíčky

```mermaid
flowchart TB
    shared[packages/shared<br/>typy API, funkce tenantů, typy souborů]
    platform[packages/platform<br/>interní JWT, rqlite klient, S3,<br/>identita runtime, probouzení, SecretBox]
    core[packages/core<br/>agent, checkpointer, RAG, MCP,<br/>tajemství, soubory, DB tenanta]

    web[apps/web] --> shared
    gateway[apps/gateway] --> platform
    control[apps/control] --> platform
    operator[apps/operator] --> platform
    sites[apps/sites] --> platform
    runtime[apps/runtime] --> core
    runtime --> platform
    core --> platform
    platform --> shared
```

Všechny balíčky se importují jako zdrojový TypeScript (`@osiris/<balíček>/<cesta>.ts`) bez build kroku. Služby spouští `tsx`, každá má vlastní Docker image (`ghcr.io/richardblaha/osiris-<služba>`).

## Identita a přístup

Uživatelé jsou v centrální databázi (tabulka `users`), jejich oprávnění jako claimy:

| Claim | Význam |
|---|---|
| `role=osiris-user` | Smí používat Osiris (bez něj 403) |
| `role=osiris-admin` | Správce systému: správce všech tenantů, zakládá a ruší tenanty |
| `tenant=<slug>` | Uživatel tenanta (může jich být víc, oddělených čárkou) |
| `tenant-admin=<slug>` | Správce tenanta |
| `phone_number` | Ověřené telefonní číslo pro WhatsApp |

Claimy jmenující neexistujícího nebo archivovaného tenanta se ignorují. Správce tenanta zve lidi e-mailem: existující uživatel se připojí, nový se založí a dostane jednorázový přihlašovací odkaz. Registrace bez pozvánky není. Telefon si uživatel ověří sám tak, že ze svého čísla pošle na WhatsApp Osirisu zprávu `OVERENI <kód>`.

### Přihlášení

```mermaid
sequenceDiagram
    autonumber
    participant B as Prohlížeč (web)
    participant G as gateway
    participant C as control (OIDC provider)
    participant X as Google / Facebook / Microsoft

    B->>G: /auth/authorize (PKCE)
    G->>C: přepošle i s cookies
    C-->>B: přesměrování na /login?uid=…
    alt klíč (passkey)
        B->>C: /auth/interaction/:uid/passkey (WebAuthn)
    else e-mail a heslo
        B->>C: /auth/interaction/:uid/password
    else účet Google, Facebook nebo Microsoft
        B->>X: přihlášení u poskytovatele
        X-->>C: /auth/social/:provider/callback
    end
    opt má ověřovací aplikaci (ne po klíči)
        B->>C: /auth/interaction/:uid/second-factor (TOTP nebo záložní kód)
    end
    C-->>B: přesměrování na /callback?code=…
    B->>C: /auth/token (kód + PKCE)
    C-->>B: access token, refresh token, ID token
```

- **Způsoby přihlášení:** klíč (passkey) s ověřením uživatele na zařízení je sám o sobě dvoufázový. Po hesle, účtu Google/Facebook/Microsoft nebo jednorázovém odkazu se uživatel s ověřovací aplikací ptá ještě na kód (nebo záložní kód). Hesla jsou uložená jako argon2id, tajemství TOTP zašifrovaná.
- **Účty u poskytovatelů:** Google a Facebook ručí za e-mail, takže pozvaný člověk se jimi přihlásí rovnou. Účet Microsoft si uživatel musí nejdřív propojit v profilu.
- **Jednorázové odkazy** (pozvánka, odkaz od správce, „zapomenuté heslo“ e-mailem) se spotřebují až při přihlášení, ne otevřením, takže je nespálí skenery pošty.
- **Ochrana:** omezení neúspěšných pokusů na účet, adresu a přihlášení; každý krok přihlášení je svázaný s cookie prohlížeče, který ho začal.
- **Session:** přihlášení platí 30 dní, refresh token se při každém použití mění a končí s odhlášením. Access token je neprůhledný a gateway se na něj ptá control (výsledek drží minutu).

### Důvěra mezi službami

```mermaid
flowchart LR
    browser([Prohlížeč]) -->|"access token"| gateway
    gateway -->|"komu token patří?<br/>/internal/gateway/identify"| control
    gateway -->|"interní JWT (ES256, 60 s)<br/>aud=control<br/>uživatel + členství"| control
    gateway -->|"interní JWT<br/>aud=tenant:acme<br/>uživatel + role"| runtime[runtime acme]
    control -->|"interní JWT, iss=control<br/>naplánované běhy, WhatsApp"| runtime
    operator -->|"interní JWT, iss=operator<br/>aktivita, snapshot"| runtime
    runtime -->|"projektovaný ServiceAccount token<br/>aud=osiris-control"| control
    control -->|"TokenReview: komu token patří?<br/>tenant = namespace"| k8s[(Kubernetes API)]
```

- **Prohlížeč → gateway:** OIDC access token vydaný control. Dál než do gateway (a k ověření do control) se nedostane.
- **Gateway, control, operátor → ostatní služby:** krátký interní JWT (ES256, 60 s). Nese ověřeného uživatele, jeho roli v tenantovi a kanál. Audience je `control`, nebo `tenant:<slug>`, takže token pro jednoho tenanta je u jiného k ničemu. Runtime má jen veřejný klíč.
- **Runtime → control:** projektovaný ServiceAccount token s audience `osiris-control`. Control se Kubernetes API zeptá (TokenReview), komu patří, a tenanta určí z namespace `osiris-t-<slug>`, nikdy z obsahu požadavku. Runtime tak může jednat jen za svého tenanta.
- **Tajemství tenantů** (API klíče, hlavičky MCP serverů) jsou zašifrovaná klíčem tenanta odvozeným z master klíče (HKDF). Únik z podu jednoho tenanta neodhalí tajemství ostatních.

## Tok požadavku z webu

```mermaid
sequenceDiagram
    autonumber
    participant B as Prohlížeč
    participant G as gateway
    participant C as control
    participant R as runtime tenanta

    B->>G: GET /api/threads (Bearer token, X-Tenant-Id: acme)
    G->>C: komu token patří (cache 60 s)
    C-->>G: profil + claims (role, tenant, tenant-admin)
    G->>G: členství z claimů, role v tenantovi acme
    alt cesta řídicí roviny (/api/me, /admin, /members, /schedules, /domains, /sites)
        G->>C: požadavek + interní JWT (aud=control)
        C-->>G: odpověď
    else data tenanta (vlákna, chat, soubory, nastavení…)
        G->>R: požadavek + interní JWT (aud=tenant:acme)
        R-->>G: odpověď (chat jako SSE stream)
    end
    G-->>B: odpověď
```

Chat posílá jen novou zprávu uživatele. Historii drží runtime v checkpointeru a odpověď agenta se streamuje přes gateway jako server-sent events.

## Agent

```mermaid
flowchart LR
    start((start)) --> agent
    agent["agent<br/>systémový prompt + zprávy → model"] -->|volání nástrojů| tools["tools<br/>spuštění nástrojů"]
    tools --> agent
    agent -->|odpověď bez nástrojů| finish((konec))
```

Agent je ručně postavená ReAct smyčka v LangGraphu (`StateGraph` nad `MessagesAnnotation`). Modely a nástroje dodává LangChain (`initChatModel`, `@langchain/core`, `@langchain/mcp-adapters`). Systémový prompt se skládá při každém volání z pravidel, formátu kanálu, data a času, seznamu dovedností, souborů, paměti, názvů tajemství a profilu uživatele, a do checkpointu se neukládá.

Nástroje se vybírají při každém kroku podle zapnutých funkcí tenanta:

| Funkce | Nástroje |
|---|---|
| `knowledge` | `search_knowledge` (vektorové hledání v libSQL) |
| `skills` | `load_skill` |
| `memory` | `remember`, `forget` |
| `files` | `list_files`, `read_file`, `write_file`, `delete_file`, `move_file`, `render_template`, `resize_image`, `convert_to_pdf` |
| `http` | `http_request` (s ochranou proti SSRF a doplňováním tajemství) |
| `mcp` | nástroje registrovaných MCP serverů (`<server>_<nástroj>`) |
| `scheduler` | `schedule_task`, `list_schedules`, `cancel_schedule` |
| `sites` | `publish_site` |

Identitu a roli uživatele berou nástroje vždy z kontextu běhu, nikdy z argumentů modelu.

## Probouzení a uspávání tenanta

```mermaid
sequenceDiagram
    autonumber
    participant G as gateway
    participant C as control
    participant K as Kubernetes API
    participant O as operator
    participant R as runtime
    participant S as S3

    G->>R: požadavek
    R--xG: nedostupný (tenant spí)
    G->>C: POST /internal/gateway/tenants/acme/wake
    C->>K: Tenant acme: spec.wakeRequestedAt = teď
    K-->>O: watch: Tenant změněn
    O->>K: StatefulSet runtime: replicas 1
    K->>R: start podu (připojení svazku)
    opt prázdný svazek (nový pod, ztracený disk, import)
        R->>C: GET /internal/runtime/backups/latest
        C->>S: poslední záloha
        S-->>R: tar.gz (DB + soubory)
    end
    loop dokud /health neodpoví (max. 120 s)
        G->>R: GET /health
    end
    G->>R: původní požadavek znovu
    R-->>G: odpověď

    Note over O,R: každou minutu
    O->>R: GET /internal/activity
    R-->>O: poslední aktivita, běžící běhy
    alt nečinný déle než idleMinutes a nic neběží
        O->>R: POST /internal/snapshot?reason=sleep
        R->>C: PUT /internal/runtime/backups (stream)
        C->>S: uložit zálohu
        Note over R: od teď odpovídá 503 (x-osiris-sleeping)
        O->>K: replicas 0, status Sleeping
    end
```

```mermaid
stateDiagram-v2
    [*] --> Sleeping: nový tenant
    Sleeping --> Running: požadavek / zpráva / úloha<br/>(wakeRequestedAt)
    Running --> Sleeping: nečinnost > idleMinutes<br/>(snapshot, replicas 0)
    Running --> Running: idleMinutes = 0 (vždy běží)
    Sleeping --> Suspended: tenant archivován
    Running --> Suspended: tenant archivován
    Suspended --> Running: tenant obnoven
```

Svazek tenanta zůstává i ve spánku, takže probuzení obvykle trvá jen pár sekund. Delší je jen první start, kdy se zakládá svazek. Gateway mezitím drží požadavek otevřený.

## Data

```mermaid
flowchart TB
    subgraph rq[rqlite – centrální databáze]
        tenants[tenants<br/>název, stav, funkce, uspávání, disk]
        users[users + passkeys, user_identities,<br/>recovery_codes, login_links]
        oidc[oidc_store + auth_challenges<br/>sessions, granty, tokeny]
        schedules[schedules + schedule_runs]
        wa[wa_inbox + wa_selection]
        phones[phone_challenges]
        domains[domains + site_releases]
        backups[backups]
    end

    subgraph tdb[libSQL na svazku tenanta – db/tenant.db]
        threads[threads + checkpointy]
        knowledge[documents + chunks<br/>vektory vector32]
        skillsT[skills, memories]
        mcp[mcp_servers, secrets<br/>šifrované klíčem tenanta]
        settings[user_settings, whatsapp_sessions,<br/>processed_runs]
    end

    subgraph files[soubory na svazku tenanta – files/]
        ft[tenant/ – firemní]
        fu[users/&lt;sub&gt;/ – osobní]
        fx[tmp/&lt;vlákno&gt;/ – dočasné, 24 h]
    end

    subgraph s3[Civo Object Store – bucket osiris]
        s3sites[sites/&lt;tenant&gt;/&lt;vydání&gt;/…]
        s3backups[backups/&lt;tenant&gt;/…tar.gz]
        s3rq[rqlite/osiris.sqlite3.gz]
    end

    backups -.odkazuje.-> s3backups
    domains -.vydání.-> s3sites
```

- **rqlite** drží jen to, co sdílí služby: seznam tenantů a jejich nastavení, frontu WhatsApp zpráv, rozvrhy úloh, domény a vydání webů, evidenci záloh. rqlite nemá interaktivní transakce. Fronty se proto zabírají jedním podmíněným `UPDATE` s claim tokenem a časy předává aplikace jako parametr.
- **Data tenanta** (konverzace, znalostní báze, dovednosti, paměť, MCP servery, tajemství, nastavení) jsou v jeho vlastní libSQL databázi a nikdy neopustí jeho svazek, kromě záloh.
- **Soubory** mají tři rozsahy: firemní (zapisuje správce), osobní a dočasné soubory konverzace. Úložiště hlídá cesty, typy souborů podle obsahu, velikost a kvótu.
- **S3** obsahuje publikované weby, zálohy tenantů (před každým uspáním, denně a na vyžádání; drží se 30 dní, nejméně 3 poslední) a zálohy rqlite (každých 5 minut, když se něco změnilo).

## WhatsApp

```mermaid
sequenceDiagram
    autonumber
    participant M as Meta (WhatsApp)
    participant G as gateway
    participant C as control
    participant R as runtime tenanta

    M->>G: POST /webhooks/whatsapp (X-Hub-Signature-256)
    G->>C: přepošle beze změny
    C->>C: ověří podpis, uloží do wa_inbox (duplicity podle id)
    C-->>M: 200 OK (hned)
    Note over C: worker na libovolné replice,<br/>zprávy jednoho odesílatele postupně
    C->>C: uživatel podle phone_number
    alt OVERENI <kód>
        C->>C: nastaví claim phone_number
    else /tenant, /nova, /pomoc
        C->>C: výběr tenanta (wa_selection) / nové vlákno
    else běžná zpráva
        C->>R: POST /internal/whatsapp/message (interní JWT za uživatele)
        R->>R: agent ve WhatsApp vlákně uživatele (jednou na id zprávy)
        R-->>C: odpověď
        C->>M: odeslání odpovědi (po 4096 znacích)
    end
```

Runtime tenanta WhatsApp token nemá, posílá jen control. Uživatel ve více tenantech si přepíná příkazem `/tenant <zkratka>`. Když je runtime nedostupný, zkusí to worker znovu a nakonec odpoví omluvou.

## Plánované úlohy

```mermaid
sequenceDiagram
    autonumber
    participant U as Uživatel (web / chat)
    participant C as control
    participant R as runtime tenanta
    participant M as WhatsApp

    U->>C: nová úloha (cron nebo jednorázový čas)
    Note over C: worker každých 5 s,<br/>claim s leasem 15 min
    C->>C: je vlastník stále členem? funkce zapnutá?
    C->>R: POST /internal/runs (interní JWT za vlastníka,<br/>idempotency key = id:čas)
    R->>R: agent v novém vlákně vlastníka
    R-->>C: id vlákna + výsledek
    opt doručení na WhatsApp (do 24 h od poslední zprávy uživatele)
        C->>M: výsledek
    end
    C->>C: zapíše běh, spočítá další spuštění
```

Úloha běží s oprávněními svého vlastníka. Běh zpožděný o víc než hodinu se přeskočí, chyby se třikrát zopakují. Opakovaný požadavek se stejným klíčem runtime odbaví ze záznamu a agenta znovu nespustí.

## Weby tenantů

```mermaid
sequenceDiagram
    autonumber
    participant A as Správce tenanta
    participant C as control
    participant D as veřejné DNS
    participant O as operator
    participant R as runtime tenanta
    participant S3 as S3
    participant V as Návštěvník
    participant W as sites

    A->>C: přidat doménu www.firma.cz
    C-->>A: TXT _osiris-challenge.www.firma.cz = token,<br/>A záznam na IP ingressu
    A->>C: ověřit
    C->>D: TXT a A/CNAME
    C->>O: Tenant.spec.domains += www.firma.cz
    O->>O: Ingress + certifikát (Let's Encrypt, HTTP-01)
    A->>R: publikovat složku web/ (tlačítko nebo agent)
    R->>C: tar.gz složky
    C->>C: kontrola: jen soubory, povolené typy, limity, index.html
    C->>S3: sites/tenant/vydání/…
    C->>C: doména → nové vydání (jeden zápis)
    V->>W: https://www.firma.cz/
    W->>W: host → tenant + vydání (rqlite, cache 60 s)
    W->>S3: soubor
    W-->>V: statický obsah
```

Doménu, která přestane mířit na Osiris, control při pravidelné kontrole (každých 6 hodin) vypne. Ponechává se posledních 5 vydání a k předchozímu se dá vrátit.

## Bezpečnost

### Síťové politiky

```mermaid
flowchart LR
    traefik[Traefik] --> gateway
    traefik --> sites
    gateway --> control
    gateway --> runtime
    control --> runtime
    operator --> runtime
    runtime --> control
    runtime --> gotenberg
    runtime --> internet[(internet<br/>LLM, MCP, API)]
    control --> rqlite
    sites --> rqlite

    runtime -. ✕ .-> rqlite
    runtime -. ✕ .-> sites
    runtime -. ✕ .-> k8s[(Kubernetes API)]
    runtime -. ✕ .-> meta[(metadata<br/>169.254.169.254)]
    runtime -. ✕ .-> other[runtime jiného tenanta]
    gotenberg -. ✕ .-> internet
```

- V namespace `osiris` je výchozí zákaz příchozího provozu a povolené jsou jen šipky výše. Namespace tenanta má výchozí zákaz v obou směrech: runtime přijímá provoz jen od gateway, control a operátora a ven smí jen do DNS, control, Gotenbergu a internetu mimo privátní rozsahy. Vynucuje to Cilium. Izolace je ověřená přímo z podu tenanta.
- **Pody** běží bez roota, s read-only root FS, bez capabilities, se seccomp profilem a bez automaticky připojeného tokenu (kromě control a operátora). Namespace tenantů vynucují Pod Security `restricted`.
- **Agent** nespouští žádný kód. Jen pevně dané nástroje, šablony Mustache bez logiky, PDF přes izolovaný Gotenberg. `http_request` a MCP smí jen na veřejné https adresy, tajemství se doplňují jen pro povolené hosty a ve výstupu se maskují.
- **Soubory** se stahují vždy jako příloha s `nosniff` a sandbox CSP, takže HTML nebo SVG tenanta se nikdy nevykreslí na doméně Osirisu. Weby tenantů běží na jejich vlastních doménách.
- **Gateway** omezuje velikost požadavků a počet požadavků a běhů agenta na uživatele a nastavuje CSP, HSTS a zákaz vkládání do rámců.

## Nasazení

```mermaid
flowchart TB
    gh[GitHub main] -->|CI: testy, typecheck| ci[GitHub Actions]
    ci -->|5 images :main a :sha| ghcr[(ghcr.io)]
    ghcr --> k8s

    subgraph k8s[k3s abydos]
        subgraph osiris[osiris]
            d1[Deployments: gateway, control, sites, gotenberg, operator]
            s1[StatefulSet: rqlite ×3]
            crd[CRD Tenant + objekty Tenant]
            np[NetworkPolicies]
            ing[Ingress osiris.k6labs.cz → gateway<br/>Ingressy domén tenantů → sites]
        end
        subgraph tns[osiris-t-&lt;slug&gt; pro každého tenanta]
            sts[StatefulSet runtime 0–1 + PVC]
            cfg[ConfigMap, Secret s klíčem tenanta]
            tnp[NetworkPolicies, ResourceQuota, LimitRange]
        end
    end
    crd -->|operator| tns
```

Manifesty jsou v `deploy/k8s` (kustomize). Runtime tenantů vytváří operátor a při každém probuzení stahují aktuální image. Nová verze se tak k tenantovi dostane při jeho dalším probuzení.

## Lokální vývoj

Lokálně běží stejné služby bez Kubernetes: control místo rqlite použije soubor SQLite (i pro uživatele), místo S3 složku, e-maily vypisuje do logu a runtime tenantů spouští jako podprocesy (`ORCHESTRATOR=local`). Gateway může přihlašování přeskočit (`AUTH_DEV_BYPASS`); prvního správce založí `pnpm --filter @osiris/control users add-admin <e-mail>`. `pnpm dev` spustí gateway, control, sites a web, runtime si control spustí sám při prvním požadavku na tenanta.
