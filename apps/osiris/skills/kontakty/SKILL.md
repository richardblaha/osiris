---
name: kontakty
description: Evidence kontaktů firmy (zákazníci, dodavatelé, řemeslníci) v databázi. Použij, když uživatel chce kontakt uložit, najít, upravit, smazat nebo vypsat, nebo když v konverzaci padne nový kontakt, který stojí za uložení.
requires: database
---

# Kontakty

Kontakty jsou v tabulce `contacts` v databázi firmy. Jsou společné pro celou firmu.

## Tabulka

Než do tabulky poprvé sáhneš, zjisti nástrojem `db_schema`, jestli existuje. Když neexistuje, vytvoř ji nástrojem `db_create_table` přesně takto:

- name: `contacts`
- description: `Kontakty firmy: zákazníci, dodavatelé a další`
- columns:
  - `name` (text, required): celé jméno osoby, nebo název firmy, když osoba není známá
  - `company` (text): firma
  - `email` (text, unique)
  - `phone` (text, unique): telefon v mezinárodním tvaru, např. `+420777123456`
  - `kind` (text): `zákazník`, `dodavatel`, `partner` nebo `jiný`
  - `address` (text)
  - `ico` (text): IČO firmy
  - `note` (text): krátká poznámka
  - `tags` (json): seznam štítků, např. `["kuchyně", "Brno"]`

Když tabulka existuje a chybí v ní sloupec z tohoto seznamu, přidej ho nástrojem `db_alter_table`. Stávající sloupce nepřejmenovávej a nemaž.

## Ukládání

1. Nejdřív hledej duplicitu: `db_query` podle e-mailu, telefonu, nebo jména (`LIKE`, bez ohledu na velikost písmen). Pokud kontakt existuje, doplň chybějící údaje nástrojem `db_update` (podle `id`), nevkládej nový.
2. Telefon normalizuj: bez mezer, české číslo s předvolbou `+420`, slovenské `+421`.
3. E-mail ukládej malými písmeny.
4. Ukládej jen údaje, které uživatel řekl, nebo které jsou zřejmé z podkladů (podpis e-mailu, vizitka). Nic si nedomýšlej.
5. Kontakt ukládej, když o to uživatel požádá nebo když souhlasí. U kontaktu z cizího zdroje (e-mail, dokument) se nejdřív krátce zeptej.
6. Po uložení stručně potvrď, co jsi uložil nebo změnil.

## Hledání

- Hledej přes `db_query`, např. `SELECT id, name, company, phone, email FROM contacts WHERE name LIKE '%novák%' OR company LIKE '%novák%' LIMIT 20`.
- Najdeš-li víc kontaktů, vypiš je stručně a zeptej se, který myslí.
- Telefon vypisuj tak, aby šel z mobilu vytočit.

## Mazání

Kontakt smaž (`db_delete` podle `id`) jen na výslovný pokyn uživatele a jen ten, který jednoznačně určil.
