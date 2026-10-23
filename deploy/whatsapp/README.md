# Deploying the interactive chat

The agent's `ask_user` tool is shared by the signed-in PWA, the public website chat and WhatsApp. It supports text,
finite numbers, calendar dates, single and multiple choice, and yes/no confirmations. Migration 019 stores question
definitions and answers in the project database, bound to the user and the thread. A question expires after 24 hours.
An answer is validated and accepted with a single conditional write; repeated answers, the wrong owner and unknown
options are refused. A `false` value is kept as such. A cancellation is stored, and the model is told not to carry out
the proposed action. The tool asks for the user's intent; it is not a general permission mechanism for arbitrary MCP
tools. Asking a question together with any other tool call refuses the whole batch before any of it runs.

The PWA shows forms directly in the assistant's messages. Every 5 seconds while the page is visible, and when the
window regains focus, it loads the state from the server and takes over completed remote exchanges, including
WhatsApp ones, without overwriting an exchange in progress locally. The personal web chat supports file uploads and
microphone recordings. Files go to the temporary storage of the user's thread, with the usual checks of type,
signature, size and quotas. One exchange can carry at most 5 files of 25 MB in total; a single file uploaded through
the interface can have at most 20 MB. Images reach the model as images. UTF-8 text is inlined, at most 100,000
characters per file. For PDFs, Mistral OCR reads at most the first 30 pages; audio is transcribed by Mistral. Other
supported office documents are stored and offered to the agent's file tools; the app does not claim to have read
their content. Recording stops after 5 minutes, and the microphone is released when the component goes away.
Temporary files expire after 24 hours, as before.

Runtime settings, in its environment or through the operator's `RUNTIME_ENV_*` / `RUNTIME_SECRET_*`:

- `MISTRAL_API_KEY`: the key for OCR and audio transcription, independent of the chat model's provider.
- `AUDIO_MODEL=voxtral-mini-latest`, `OCR_MODEL=mistral-ocr-latest`.
- Chat models used with images must accept image input. Tokens used by transcription are counted when the provider
  reports them. OCR is billed per page and is not converted into an invented number of tokens.

WhatsApp accepts images, documents, audio, reply buttons and lists, and completed Flow forms. Files are downloaded
through the authenticated Graph API; the download checks the returned HTTPS host, refuses redirects and is limited to
20 MB. The runtime then checks the stored file's content as well. The `send_chat_file` tool explicitly offers a file
for download in the PWA or for delivery as WhatsApp media. The internal file endpoint gives the thread's owner only
files offered by that tool in the current exchange.

Simple choices use reply buttons (at most 3, labels up to 20 characters) or a native list (at most 10 items, labels
up to 24 characters). Other questions are sent as text with a link to the PWA, which requires signing in. A
single-field question can also be answered with a text message; `/cancel` (or `/zrusit`) cancels the question. For
several fields, use the PWA form (recommended) or a JSON object. Switching projects gives no right to answer another
project's questions. The runtime refuses native answers to questions that have expired or were already answered.

WhatsApp commands work under their Czech and English names: `/project`, `/nova` or `/new`, `/pomoc` or `/help`,
`/zrusit` or `/cancel`. Phone numbers are verified by sending `OVERENI <code>` or `VERIFY <code>`. Replies from
control (help, errors, project switching) are in `DEFAULT_LOCALE` (`en` by default, `cs` in the production manifests),
since a WhatsApp message carries no language preference.

## Native WhatsApp Flows forms

Publish a matching Flow in your Meta WhatsApp Manager, then map its ID in control:

```dotenv
WHATSAPP_FLOWS_JSON=[{"id":"123456789012345","screen":"FORM","fields":[{"name":"name","type":"text"},{"name":"date","type":"date"}]}]
```

`appointment-flow.json` is a concrete example for this mapping; validate it and publish it in Meta's Flow editor.
Questions created at run time must have exactly the listed field names and types, in the same order. The data sent
contains `title`, `<name>_label` and, for choice fields, `<name>_options` with `{ id, title }` items. The Flow's
completion action must return the same field names. The question's UUID is sent as `flow_token` and, once the signed
webhook arrives, checked against the signed-in sender's open question. These static, navigation-only forms need no
`data_exchange` endpoint and no encryption keys. The app cannot itself ensure the Meta account's eligibility or the
IDs of published Flows. When no matching Flow is found, or sending it is refused, the PWA form remains available.

## Delivery and scheduled messages

Control's migration 010 stores the IDs of sent messages and applies sent/delivered/read/failed webhooks so that a
status already reached never goes back. Profile → Activity and sessions shows delivery statuses only for the user's
uniquely verified phone number. Records are kept for 7 days. Status events create no messages and do not reopen the
24-hour window.

To deliver results of scheduled tasks outside the 24-hour window the user opened, publish a template
`osiris_result` in the language set in `WHATSAPP_TEMPLATE_LANGUAGE`. For Czech (`cs`, as in production):

- Body: `Plánovaná úloha „{{1}}“ byla dokončena. Podrobnosti najdete v aplikaci.`
- Body parameter `{{1}}`: the task's title, for example `Souhrn zakázek`.
- First button: **Zobrazit výsledek**, type **Visit website**, dynamic URL `https://osiris.k6labs.cz/{{1}}`.

For English (`en`): body `The scheduled task “{{1}}” has finished. You'll find the details in the app.`, button
**Show result**. For your own deployment, replace the domain with the app's address. The sample value of the button
variable is `t/acme/chat/THREAD_ID` (use a real link to a test result for the approval).

The button's parameter is separate from the body's. The app passes the path `t/<project>/chat/<thread>` of the
particular result. The whole result stays in the web chat; only the task's title goes into the template. The link
requires signing in and the usual permissions for the thread. Whether it opens in the browser or the installed PWA
depends on the device and its settings.

Once the template is approved, set:

```dotenv
WHATSAPP_NOTIFICATION_TEMPLATE=osiris_result
WHATSAPP_TEMPLATE_LANGUAGE=cs
```

The template is only used for tasks scheduled at the user's request and delivered to their verified phone number.
Without it, the result stays in the web thread and the scheduler reports the existing delivery warning. Meta must
approve both the template and the account's permissions. Nothing is sent during builds or tests. Before going to
production, check the Flow and the template with a Meta test number.
