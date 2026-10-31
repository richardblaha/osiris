---
name: skill-creator
description: Vytvoření nové dovednosti nebo úprava existující. Použij, když uživatel chce asistenta naučit nový postup („nauč se…“, „příště to dělej takhle“, „udělej z toho dovednost“), nebo když se v konverzaci opakuje úkol, který by se hodilo mít sepsaný.
---

# Tvorba dovedností

Dovednost je pojmenovaný postup. V seznamu DOVEDNOSTI je vidět jen její název a popis; celý postup si načteš nástrojem `load_skill`, až ho potřebuješ. Dovednost ukládáš nástrojem `save_skill`.

## 1. Zjisti, co má dovednost dělat

Než cokoli napíšeš, ujasni si s uživatelem:

- **Účel:** jaký úkol dovednost řeší a podle čeho poznáš, že ji máš použít.
- **Postup:** jednotlivé kroky, v jakém pořadí, a co je výsledkem (soubor, záznam v databázi, e-mail, odpověď).
- **Vstupy:** co musí uživatel dodat, a co si dohledáš sám (znalosti, soubory, databáze, paměť).
- **Pravidla a výjimky:** co se nesmí stát, kdy se zeptat, jak řešit chybějící údaje.
- **Příklad:** jeden konkrétní případ od začátku do konce, pokud ho uživatel má.

Když už postup v konverzaci proběhl, vyjdi z něj a doptej se jen na to, co chybí. Ptej se po jednom tématu, ne vším najednou; na víc údajů najednou použij `ask_user`.

Než začneš, podívej se do seznamu DOVEDNOSTI, jestli podobná dovednost už neexistuje. Pokud ano, načti ji přes `load_skill` a navrhni úpravu místo nové dovednosti.

## 2. Napiš ji

- **name:** krátký, výstižný, malá písmena bez diakritiky, slova spojená pomlčkou (`vystaveni-faktury`, `cenova-nabidka`).
- **description:** jedna až dvě věty: co dovednost dělá **a kdy ji použít**. Podle popisu se dovednost vybírá, takže v něm uveď slova, kterými o úkolu mluví uživatelé.
- **instructions:** postup v Markdownu:
  - nadpis a jedna věta o účelu,
  - očíslované kroky v rozkazovacím způsobu („Zjisti…“, „Vytvoř…“), u každého konkrétní nástroj, tabulku, soubor nebo šablonu, se kterou pracuje,
  - pravidla a výjimky jako odrážky,
  - případně krátký příklad vstupu a výstupu.

Piš stručně a konkrétně. Neopakuj obecné věci, které asistent umí sám; zapiš to, co je pro tuto firmu a tento úkol zvláštní. Nevkládej do postupu hesla ani klíče: na ty se odkazuj jako `{{secret:NÁZEV}}` (seznam je v sekci SECRETS).

## 3. Ukaž ji a ulož

1. Ukaž uživateli název, popis a postup a zeptej se, jestli je takhle v pořádku.
2. Po souhlasu ji ulož nástrojem `save_skill`. Správce ukládá dovednosti pro celý projekt; ostatní si ukládají vlastní (ty platí jen pro ně a projektovou dovednost se stejným názvem jim nahradí). Uživateli, který není správce, to řekni.
3. Potvrď, že je uložená, a že se od další zprávy objeví v seznamu DOVEDNOSTI.

Úprava existující dovednosti je totéž: načti ji, navrhni změny, po souhlasu ji ulož pod stejným názvem.

## Když postup potřebuje vlastní kód

Dovednost je text. Když úkol potřebuje výpočet nebo napojení, které žádný nástroj neumí, navrhni uživateli vlastní nástroj: soubor `.osiris/tools/<nazev>.ts` ve složce projektu, který tam uloží on (sám ho zapsat nemůžeš). Ukaž mu kostru:

```ts
export default {
  description: "Co nástroj dělá a kdy ho použít",
  input: {
    type: "object",
    properties: { castka: { type: "number", description: "Částka bez DPH" } },
    required: ["castka"],
  },
  async run({ castka }, ctx) {
    // Volání API: ctx.fetch(url, { method, headers, body }); klíče jako {{secret:NÁZEV}} doplní Osiris.
    return { sDph: Math.round(castka * 1.21 * 100) / 100 };
  },
};
```

Dovednost pak může na takový nástroj odkazovat jménem.
