# Contributing

Thanks for helping. Before opening a pull request:

1. Install with `pnpm install` (Node.js 24+).
2. Run `pnpm typecheck` and `pnpm test`; both must pass.
3. Keep changes focused, and follow the conventions in [CLAUDE.md](CLAUDE.md): code, comments and docs are in
   English; user-facing text goes into the message catalogs, never inline.

## Translations

English (`en`) is the source language. Every other language translates the English catalogs, and anything a language
lacks falls back to English, message by message.

### Where the texts are

| Catalog | Used by | Layout |
| --- | --- | --- |
| `apps/osiris-pwa/src/locales/<lang>/<namespace>.json` | the web app | one file per namespace (roughly one per view; `common` holds shared words) |
| `packages/platform/src/locales/<lang>.json` | gateway, control, runtime | API errors, WhatsApp replies, e-mails, sign-in pages |

The agent's system prompts, tool descriptions and tool results (`packages/core/src/agent`) are not catalogs: they
steer the model, so changing their language needs evaluation, not just translation. The bundled skills
(`apps/osiris/skills`) and the legal pages (`apps/osiris-pwa/public/*.html`) are content and are translated separately.

### Adding a language

1. Add its BCP 47 language subtag (for example `de`) to `LOCALES` in `packages/shared/src/i18n.ts`. If a related
   language should use it instead of English, add that to `RELATED` there.
2. Copy `apps/osiris-pwa/src/locales/en/` to `apps/osiris-pwa/src/locales/de/` and `packages/platform/src/locales/en.json` to
   `packages/platform/src/locales/de.json`, then translate the values.
3. Add zod's built-in validation messages for it to `ZOD_LOCALES` in `packages/platform/src/i18n.ts` (zod ships
   `z.locales.<lang>`).
4. Run `pnpm test`. The catalog check (`packages/shared/test/catalogs.test.ts`) lists every missing or extra key,
   missing plural form, and placeholder or markup that differs from English.

### Rules for messages

- **Keys** are stable and semantic (`files:closeUnsaved`, `errors.schedule.notFound`), never the English text or a
  component path. Don't rename a key just because its wording changed.
- **Placeholders** are `{{name}}`. Keep every placeholder of the English message, with the same name; move them
  freely within the sentence. Never split a sentence into several keys to insert values.
- **Plurals** use i18next's suffixes with the language's CLDR categories: English has `_one` and `_other`; Czech needs
  `_one`, `_few` and `_other` (and `_many`, used for decimals). The count is `{{count}}`. The check knows which forms
  each language needs.
- **Markup**: a few web messages contain `<strong>`, `<code>` or `<a>` tags for `<Trans>`. Keep the tags around the
  matching words; they are mapped to components, never inserted as HTML. Everything else is plain text, escaped by
  React.
- **Identifiers stay as they are**: tool names, API fields, environment variables, file and folder names, slash
  commands (WhatsApp accepts both `/new` and `/nova`), and `code` values of API errors.
- Write numbers, dates and lists through the formatting helpers, not into the catalog.

### Testing a translation

- `pnpm --filter @osiris/shared test` runs the catalog check alone.
- In the web app, choose the language in My profile → Personalization → Language, or set your browser's language.
- API errors follow the `Accept-Language` header: `curl -H 'accept-language: de' …`.

### Pull requests for translations

Translate whole namespaces where you can, keep the English file untouched (unless you are fixing the source text, in
a separate commit), and say in the pull request which files you reviewed. Machine translation is fine as a starting
point, but please review every message before submitting.
