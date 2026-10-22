---
name: crm
description: Jednoduché CRM nad kontakty: obchodní případy (poptávky, nabídky, zakázky) a jejich stav, aktivity (hovory, schůzky, e-maily) a připomenutí. Použij, když uživatel řeší poptávku, nabídku, zakázku, obchod, hovor či schůzku se zákazníkem, nebo se ptá, co má rozjednané a koho má kontaktovat.
requires: database
---

# CRM

CRM stojí na kontaktech. **Nejdřív si nástrojem `load_skill` načti dovednost `kontakty`** a drž se jí pro všechno, co se týká osob a firem.

## Tabulky

Zkontroluj `db_schema`. Chybějící tabulky vytvoř nástrojem `db_create_table` (nejdřív `contacts` podle dovednosti kontakty, pak tyto):

**`deals`**: obchodní případy
- `title` (text, required): krátký název, např. „Kuchyňská linka Novákovi“
- `contact_id` (integer, references `contacts`)
- `stage` (text, required): jedna z fází níže
- `value` (real): očekávaná hodnota v Kč bez DPH
- `expected_on` (date): kdy se má rozhodnout nebo dokončit
- `next_step` (text): co je další krok
- `next_step_on` (date): kdy ho udělat
- `note` (text)

**`activities`**: co se se zákazníkem dělo
- `contact_id` (integer, references `contacts`)
- `deal_id` (integer, references `deals`)
- `kind` (text, required): `hovor`, `schůzka`, `e-mail`, `zpráva` nebo `poznámka`
- `happened_at` (datetime, required)
- `summary` (text, required): stručně, co se domluvilo

Description tabulek: `Obchodní případy CRM` a `Aktivity CRM u kontaktů a obchodů`.

## Fáze obchodu (`stage`)

`poptávka` → `nabídka` → `jednání` → `vyhráno` nebo `prohráno`. Jinou hodnotu nepoužívej. Hotová zakázka zůstává `vyhráno`.

## Jak pracovat

- Nová poptávka: najdi nebo ulož kontakt, založ `deals` ve fázi `poptávka`, vyplň další krok a termín, pokud zazněly.
- Uživatel popíše hovor, schůzku nebo e-mail: zapiš `activities` (čas podle toho, co řekl, jinak teď). Když se tím posunul obchod, uprav `stage`, `next_step` a `next_step_on`.
- Změnu fáze vždy stručně potvrď („Nabídka pro Nováka je teď ve fázi jednání.“).
- Částky uváděj v Kč, hodnoty z databáze nepřepočítávej z hlavy, sečti je dotazem.
- Data, která uživatel neřekl, si nevymýšlej. Raději se jednou otázkou zeptej (u hodnoty a termínů to ale není nutné).

## Užitečné dotazy

- Rozjednané obchody: `SELECT d.id, d.title, c.name, d.stage, d.value, d.next_step, d.next_step_on FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id WHERE d.stage NOT IN ('vyhráno', 'prohráno') ORDER BY d.next_step_on IS NULL, d.next_step_on`
- Koho dnes a v týdnu kontaktovat: obchody s `next_step_on <= date('now', '+7 days')`, které nejsou uzavřené.
- Přehled podle fází: `SELECT stage, COUNT(*) AS pocet, SUM(value) AS hodnota FROM deals GROUP BY stage`
- Historie zákazníka: aktivity a obchody podle `contact_id`, od nejnovějších.

Výsledky shrň po lidsku, ne jako tabulku čísel. U přehledu pro WhatsApp jen to nejdůležitější.

## Připomenutí

Když uživatel chce připomenout další krok, nabídni plánovanou úlohu (`schedule_task`) na den `next_step_on`, pokud ten nástroj máš.
