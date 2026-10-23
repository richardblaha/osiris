#!/usr/bin/env node
// Creates (or refreshes) the `demo` project: a made-up plumbing firm that shows every Osiris feature to prospective
// customers. It uses only the public API, as the web app does, with a system admin's access token:
//
//   OSIRIS_TOKEN=<access token> node deploy/demo/seed.mjs [https://osiris.k6labs.cz]
//
// The token is the signed-in admin's `access_token` (browser devtools: localStorage key `oidc.user:…:osiris-web`).
// Running it again overwrites what it wrote before instead of adding copies.

const BASE = (process.argv[2] ?? "https://osiris.k6labs.cz").replace(/\/$/, "");
const TOKEN = process.env.OSIRIS_TOKEN;
const PROJECT = "demo";
if (!TOKEN) throw new Error("Set OSIRIS_TOKEN to a system admin's access token.");

/** A call through the gateway; a sleeping (or brand new) runtime answers 502–504 while it starts, so wait for it. */
async function api(method, path, body, { project = PROJECT, ok = [] } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(project ? { "x-project-id": project } : {}),
        ...(typeof body === "string" ? { "content-type": "text/plain; charset=utf-8" } : body ? { "content-type": "application/json" } : {}),
      },
      body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
    });
    if ([502, 503, 504].includes(res.status) && attempt < 30) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!res.ok && !ok.includes(res.status)) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return { status: res.status, data: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  }
}
const step = (s) => console.log(`• ${s}`);

// ---------------------------------------------------------------------------------------------------------------
// Content. The firm, people, numbers and addresses are made up.

const FIRM = "Instalatérství Novák";

const KNOWLEDGE = [
  {
    id: "public/cenik.md",
    folder: "public",
    title: "Ceník",
    content: `# Ceník prací ${FIRM}

Ceny jsou bez DPH. Na práce v bytech a rodinných domech účtujeme sníženou sazbu DPH 12 %, jinak 21 %.

| Položka | Jednotka | Cena |
|---|---|---|
| Hodinová sazba instalatéra | hod | 650 Kč |
| Výjezd po Praze | výjezd | 450 Kč |
| Výjezd mimo Prahu (do 30 km) | výjezd | 750 Kč |
| Výměna baterie (umyvadlo, dřez) | ks | 900 Kč |
| Výměna WC kombi včetně odvozu starého | ks | 2 400 Kč |
| Montáž závěsného WC do předstěny | ks | 4 800 Kč |
| Výměna rohového ventilu | ks | 350 Kč |
| Čištění odpadu strojem | hod | 1 100 Kč |
| Tlaková zkouška rozvodů | zkouška | 1 500 Kč |
| Výměna plynového kotle (práce) | ks | 9 500 Kč |
| Servisní prohlídka kotle | ks | 1 900 Kč |
| Rozvody vody PPR (nové) | bm | 420 Kč |
| Rekonstrukce koupelny – instalace (orientačně) | m² | 3 200 Kč |

Příplatky: práce o víkendu a svátcích +30 %, havarijní výjezd do 2 hodin +50 %.
`,
  },
  {
    id: "public/sluzby.md",
    folder: "public",
    title: "Služby",
    content: `# Co děláme

${FIRM} je rodinná firma z Prahy 8 (ukázková firma pro demo Osirisu).

- **Opravy a havárie**: kapající baterie, ucpané odpady, prasklé trubky. Havarijní výjezd po Praze do 2 hodin.
- **Rekonstrukce koupelen a kuchyní**: nové rozvody vody a odpadů, předstěny, sprchové kouty, montáž zařizovacích předmětů.
- **Topení a plyn**: výměny a servis kotlů, revize, radiátory, podlahové topení.
- **Novostavby**: kompletní rozvody vody, kanalizace a topení podle projektu.

Pracujeme v Praze a do 30 km od Prahy. Pracovní doba Po–Pá 7:00–17:00, havárie i o víkendu.
Kontakt: 777 000 111 (ukázkové číslo), info@novak-instalace.example.
`,
  },
  {
    id: "public/caste-dotazy.md",
    folder: "public",
    title: "Časté dotazy",
    content: `# Časté dotazy

**Jak rychle přijedete?** Běžné opravy do 3 pracovních dnů, havárie po Praze do 2 hodin.

**Dáváte záruku?** Na práci 24 měsíců, na materiál podle výrobce.

**Musím materiál koupit sám?** Ne, materiál zajistíme. Vlastní materiál zákazníka namontujeme, ale bez záruky na něj.

**Jak se platí?** Převodem na fakturu se splatností 14 dní, u menších oprav i kartou na místě. U zakázek nad 30 000 Kč chceme zálohu 50 %.

**Uděláte nezávaznou prohlídku?** Ano, u rekonstrukcí zdarma; u ostatního účtujeme jen výjezd, který se při objednání odečte.
`,
  },
  {
    id: "interni/postup-reklamace.md",
    folder: "interni",
    title: "Postup reklamace",
    content: `# Postup reklamace (interní)

1. Zapiš reklamaci do složky zakazky/ k původní zakázce (datum, popis závady, fotky).
2. Do 2 pracovních dnů zavolej zákazníkovi a domluv prohlídku.
3. Závada z naší práce: oprava zdarma, bez výjezdu. Vada materiálu: reklamace u dodavatele, zákazník dostane náhradu, až ji schválí.
4. Výsledek zapiš do zakázky a pošli zákazníkovi shrnutí e-mailem.
`,
  },
  {
    id: "interni/bezpecnost-prace.md",
    folder: "interni",
    title: "Bezpečnost práce",
    content: `# Bezpečnost práce (interní)

- Před prací na plynu vždy uzavři přívod a zkontroluj těsnost detektorem.
- Práce s otevřeným ohněm jen s hasicím přístrojem po ruce.
- U rekonstrukcí v panelových domech ohlas uzavírání stoupaček správci domu den předem.
`,
  },
];

const MEMORIES = [
  "Faktury vystavujeme se splatností 14 dní; u zakázek nad 30 000 Kč chceme zálohu 50 %.",
  "Práce o víkendu a svátcích účtujeme s příplatkem 30 %, havarijní výjezd do 2 hodin +50 %.",
  "Firma je plátce DPH; na práce v bytech a rodinných domech používáme sníženou sazbu 12 %.",
  "Majitel je Jan Novák (777 000 111), zakázky plánuje jeho kolegyně Petra (777 000 222). Obě čísla jsou ukázková.",
  "Materiál bereme hlavně z velkoobchodu v Libni; objednávky do 14:00 dorazí druhý den ráno.",
];

const SKILLS = {
  "cenova-nabidka": {
    description: "Připraví cenovou nabídku pro zákazníka podle ceníku a firemní šablony, včetně PDF.",
    instructions: `# Cenová nabídka

1. Zjisti od uživatele zákazníka (jméno, adresa, kontakt) a rozsah prací. Co chybí, doptej se.
2. Ceny vezmi z ceníku (search_knowledge „ceník“). Nic neodhaduj z hlavy; když položka v ceníku není, zeptej se.
3. Spočítej řádky (množství × cena), součet bez DPH, DPH (12 % u bytů a rodinných domů, jinak 21 %) a celkem s DPH. Čísla formátuj česky (12 400 Kč).
4. Vyplň šablonu sablony/cenova-nabidka.html nástrojem render_template do temp (např. nabidka-<klient>.html). Číslo nabídky ve tvaru N<rok>-<pořadí>, platnost 30 dní.
5. Převeď ji do PDF (convert_to_pdf) a nabídni uživateli ke stažení.
6. Do zakazky/ připiš k zakázce, že nabídka odešla a na kolik (edit_text).
`,
  },
  "zapis-zakazky": {
    description: "Založí nebo doplní zápis zakázky ve složce zakazky/ (termíny, práce, materiál, stav).",
    instructions: `# Zápis zakázky

- Každá zakázka má soubor zakazky/<rok>-<měsíc>-<příjmení>-<co>.md podle vzoru v zakazky/.
- Nová zakázka: vytvoř soubor write_file se sekcemi Zákazník, Rozsah, Termíny, Materiál, Stav, Poznámky.
- Doplnění: použij edit_text (replace_exact s okolním řádkem, nebo insert_at), nikdy nepřepisuj celý soubor.
- Stav je jeden z: poptávka, nabídka odeslána, objednáno, v realizaci, hotovo, fakturováno.
`,
  },
};

const FILES = {
  "sablony/cenova-nabidka.html": `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<title>Cenová nabídka {{cislo}}</title>
<style>
  body { font-family: "Helvetica", sans-serif; color: #1f2328; margin: 40px; font-size: 13px; }
  h1 { font-size: 22px; margin: 0; }
  .firma { color: #57606a; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #d0d7de; text-align: left; }
  td.num, th.num { text-align: right; }
  .souhrn td { border: none; }
  .celkem td { font-weight: bold; font-size: 15px; }
</style>
</head>
<body>
  <h1>Cenová nabídka {{cislo}}</h1>
  <div class="firma">${FIRM} · Praha 8 · 777 000 111 · info@novak-instalace.example</div>
  <p><strong>Pro:</strong> {{klient}}<br>{{adresa}}<br>{{kontakt}}</p>
  <p><strong>Předmět:</strong> {{predmet}}</p>
  <table>
    <tr><th>Položka</th><th class="num">Množství</th><th class="num">Cena/jedn.</th><th class="num">Celkem</th></tr>
    {{#polozky}}
    <tr><td>{{nazev}}</td><td class="num">{{mnozstvi}} {{jednotka}}</td><td class="num">{{cena}}</td><td class="num">{{celkem}}</td></tr>
    {{/polozky}}
  </table>
  <table class="souhrn">
    <tr><td class="num">Bez DPH</td><td class="num">{{bez_dph}}</td></tr>
    <tr><td class="num">DPH {{sazba_dph}}</td><td class="num">{{dph}}</td></tr>
    <tr class="celkem"><td class="num">Celkem s DPH</td><td class="num">{{s_dph}}</td></tr>
  </table>
  <p>Nabídka platí do {{platnost}}. Termín realizace po dohodě. Na práci dáváme záruku 24 měsíců.</p>
  <p>Vystavil: {{vystavil}}, {{datum}}</p>
</body>
</html>
`,
  "sablony/predavaci-protokol.md": `# Předávací protokol

**Zakázka:** {{zakazka}}
**Zákazník:** {{klient}}, {{adresa}}
**Datum předání:** {{datum}}

## Provedené práce
{{#prace}}
- {{.}}
{{/prace}}

## Zkoušky
- Tlaková zkouška: {{tlakova_zkouska}}
- Těsnost odpadů: {{tesnost}}

Zákazník převzal dílo bez výhrad{{#vyhrady}}, s výhradami: {{vyhrady}}{{/vyhrady}}.

Za ${FIRM}: {{predal}}          Převzal: {{klient}}
`,
  "zakazky/2026-10-dvorakova-koupelna.md": `# Dvořáková – rekonstrukce koupelny

## Zákazník
Eva Dvořáková, Ke Stírce 12, Praha 8, 777 123 456 (ukázkové údaje)

## Rozsah
Nové rozvody vody a odpadu, předstěna se závěsným WC, sprchový kout 90×90, umyvadlo s baterií.

## Termíny
- Prohlídka: 6. 10.
- Realizace: 20.–24. 10.

## Materiál
Předstěna, WC, vanička a baterie objednány 14. 10. (velkoobchod Libeň).

## Stav
v realizaci

## Poznámky
- Stoupačka se uzavírá 21. 10. dopoledne, správce domu informován.
`,
  "zakazky/2026-10-kral-kotel.md": `# Král – výměna plynového kotle

## Zákazník
Tomáš Král, Na Pecích 3, Praha 8, tomas.kral@example.com (ukázkové údaje)

## Rozsah
Demontáž starého kotle, montáž kondenzačního kotle 24 kW, napojení na komín, revize.

## Termíny
- Realizace: 28. 10.

## Stav
nabídka odeslána

## Poznámky
- Nabídka N2026-041: 48 900 Kč s DPH.
`,
  "kontakty/dodavatele.csv": `firma,obor,telefon,poznamka
Velkoobchod Libeň,instalační materiál,777 000 301,objednávky do 14:00 druhý den
Obklady Karlín,obklady a dlažby,777 000 302,vzorkovna Po–So
Komíny Vysočany,revize komínů,777 000 303,revize do 5 pracovních dnů
`,
};

const GUARDS = {
  terminy: {
    description: "Nepotvrzovat termíny bez ověření",
    rule: "Nikdy nepotvrzuj zákazníkovi konkrétní termín výjezdu nebo realizace. Navrhni termín a řekni, že ho potvrdí Petra nebo majitel.",
  },
  "osobni-udaje": {
    description: "Ochrana údajů zákazníků",
    rule: "Nesděluj údaje jednoho zákazníka (jméno, adresa, telefon, zakázka) nikomu jinému než pracovníkům firmy.",
  },
};

const PUBLIC_GUARD = {
  name: "jen-k-veci",
  description: "Jen dotazy k firmě",
  rule: "Odpovídej jen na dotazy ke službám, cenám a objednávkám firmy. Na jiná témata zdvořile řekni, že s tím neporadíš.",
};

const SITE = "novak-instalace.example";
const SITE_INDEX = `---
layout: home

hero:
  name: ${FIRM}
  text: Voda, topení a plyn v Praze
  tagline: Opravy, havárie i kompletní rekonstrukce koupelen. Rodinná firma s 15 lety praxe.
  actions:
    - theme: brand
      text: Ceník
      link: /cenik
    - theme: alt
      text: Kontakt
      link: /kontakt

features:
  - title: Havárie do 2 hodin
    details: Prasklá trubka nebo ucpaný odpad? Po Praze přijedeme do dvou hodin, i o víkendu.
  - title: Koupelny na klíč
    details: Rozvody, předstěny, sprchové kouty a montáž. Prohlídka a nabídka zdarma.
  - title: Kotle a revize
    details: Výměny a servis plynových kotlů, revize a napojení na komín.
---

<!-- The firm's assistant for customers (Osiris), bottom right. -->
<script setup>
import { onMounted } from "vue";
onMounted(() => {
  const s = document.createElement("script");
  s.src = "https://osiris.k6labs.cz/widget.js";
  s.dataset.project = "demo";
  s.dataset.assistant = "web";
  s.dataset.label = "Zeptejte se nás";
  document.body.appendChild(s);
});
</script>
`;
const SITE_PAGES = {
  "cenik.md": `# Ceník

Orientační ceny bez DPH. Přesnou cenu vám spočítá náš asistent vpravo dole nebo ji pošleme po prohlídce.

| Práce | Cena |
|---|---|
| Hodinová sazba | 650 Kč |
| Výjezd po Praze | 450 Kč |
| Výměna baterie | 900 Kč |
| Výměna WC kombi | 2 400 Kč |
| Servisní prohlídka kotle | 1 900 Kč |
`,
  "kontakt.md": `# Kontakt

**${FIRM}**, Praha 8 (ukázková firma)

- Telefon: 777 000 111
- E-mail: info@novak-instalace.example
- Po–Pá 7:00–17:00, havárie nonstop
`,
};

const SCHEDULE = {
  title: "Pondělní přehled zakázek",
  prompt:
    "Projdi složku zakazky/ a připrav stručný přehled na tento týden: co je v realizaci, co čeká na nabídku nebo materiál a co je potřeba vyfakturovat. Na konec dej seznam úkolů pro Petru.",
  cron: "0 7 * * 1",
  timezone: "Europe/Prague",
  delivery: "web",
  // Off in the demo: it shows the feature without spending tokens every Monday. Switch it on to show a run.
  enabled: false,
};

// ---------------------------------------------------------------------------------------------------------------

step("project");
const created = await api("POST", "/admin/projects", { id: PROJECT, name: `Demo – ${FIRM}` }, { project: undefined, ok: [409] });
console.log(created.status === 409 ? "  už existuje" : "  založen, čekám na jeho runtime…");

step("znalostní báze");
for (const doc of KNOWLEDGE) {
  const exists = await api("GET", `/knowledge/documents/${doc.id}`, undefined, { ok: [404] });
  if (exists.status === 404) {
    const { data } = await api("POST", "/knowledge/documents", { title: doc.title, content: doc.content, folder: doc.folder });
    if (data.id !== doc.id) console.log(`  ${doc.id} uložen jako ${data.id}`);
  } else await api("PUT", `/knowledge/documents/${doc.id}`, { title: doc.title, content: doc.content });
}

step("paměť");
const known = (await api("GET", "/memories")).data;
for (const content of MEMORIES) if (!known.some((m) => m.content === content)) await api("POST", "/memories", { content, scope: "project" });
const memories = (await api("GET", "/memories")).data.filter((m) => MEMORIES.includes(m.content));

step("dovednosti");
for (const [name, skill] of Object.entries(SKILLS)) await api("PUT", `/skills/${name}`, { ...skill, scope: "project" });

step("soubory (šablony, zakázky, kontakty)");
for (const [path, text] of Object.entries(FILES)) {
  await api("PUT", `/files/content?scope=project&path=${encodeURIComponent(path)}&overwrite=true`, text);
}

step("kontroly");
for (const [name, guard] of Object.entries(GUARDS)) await api("PUT", `/guards/project/${name}`, guard);

step("asistent pro zákazníky „web“");
await api("PUT", "/public-assistants/web", {
  enabled: true,
  title: `${FIRM} – poradíme`,
  greeting: "Dobrý den, jsem asistent instalatérství Novák. Poradím s cenou, termínem i tím, co pro vás můžeme udělat.",
  knowledge: ["public"],
  memories: memories.filter((m) => !m.content.startsWith("Majitel") && !m.content.startsWith("Materiál")).map((m) => m.id),
  skills: [],
  tools: ["estimate_price", "create_inquiry"],
  tokensPerMonth: 300_000,
});
await api("PUT", `/guards/assistant/${PUBLIC_GUARD.name}?assistant=web`, { description: PUBLIC_GUARD.description, rule: PUBLIC_GUARD.rule });

step(`web ${SITE}`);
await api("POST", "/vitepress-sites", { name: SITE }, { ok: [400, 409] });
await api("PUT", `/files/content?scope=project&path=${encodeURIComponent(`vitepress/${SITE}/index.md`)}&overwrite=true`, SITE_INDEX);
for (const [page, text] of Object.entries(SITE_PAGES)) {
  await api("PUT", `/files/content?scope=project&path=${encodeURIComponent(`vitepress/${SITE}/${page}`)}&overwrite=true`, text);
}

step("plánovaná úloha");
const schedules = (await api("GET", "/schedules")).data;
if (!schedules.some((s) => s.title === SCHEDULE.title)) await api("POST", "/schedules", SCHEDULE);

console.log(`\nHotovo: ${BASE}/t/${PROJECT} · veřejný chat ${BASE}/c/${PROJECT}/web`);
