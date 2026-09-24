---
description: >-
  Vayu's UX writing rules: voice, the three failure-source error templates, the
  terminology glossary, and the case/punctuation/truncation rules that make the
  guide enforceable across hundreds of scattered strings.
---

# Vayu UX Writing

> Reference for every user-facing string: labels, placeholders, tooltips,
> empty states, dialog copy, error and toast messages. Future sessions must
> read this before touching UI text.

---

## Voice

Direct, precise, dry. The audience is developers testing APIs - they want the
fastest path to the fact, not a friendly tone layered over it.

- Second person ("you"), active voice, present tense.
- No whimsy, no apologies, no marketing words in-product ("Supercharge your
  testing!"). This is not Slack or Mailchimp's register.
- Use the jargon developers already have (HTTP status, header, cURL, JSON).
  Never invent cutesy names for standard concepts, and never paraphrase a
  technical value - show it verbatim.

## Errors have three sources, and each gets its own shape

Vayu error copy fails today because it treats every failure the same. It
isn't the same:

1. **The user's own target API responding with an error** (a 404, a 500) is
   *data*, not a Vayu error. Show it as a response, never dress it in error
   chrome (no red banner, no "Something went wrong").
2. **The network or target failing to respond at all** (timeout, refused,
   TLS): `Couldn't [verb] [target] ([raw code]). [one-line cause]. [next
   action]`.
   - `Couldn't connect to localhost:3000 (ECONNREFUSED). Nothing is listening
     on that port - is your server running?`
   - `No response after 30s from api.example.com. Raise the timeout in
     Settings › Network & connectivity or check the server.`
3. **Vayu itself failing** (disk full, engine crash, local storage): name the
   actual failure. Never blur it into the same shape as a network error - a
   full disk and a refused connection are different problems with different
   fixes.

**One opener only: "Couldn't [verb] [object]."** `Failed to` and `Could not`
are banned in UI text (they're both still in the codebase in ~60+ places -
that's the drift this rule exists to stop). Log strings and code comments are
a separate surface and keep whatever form reads well there.

## Terminology glossary

One name per concept, everywhere in the UI. This is mostly ratifying what's
already consistent in the codebase, plus fixing the one real overload.

| Concept | Term | Notes |
|---|---|---|
| A named group of requests | **Collection** | Never "Folder" - don't introduce it even for nested sub-groups. |
| A named set of variables (dev/staging/prod) | **Environment** | No synonym. |
| A single HTTP request | **Request** | Never "Call" as a noun for it - "call" stays fine in prose ("a script calls `pm.variables.get`"). |
| A `{{token}}` value | **Variable** | Never "env var" - a variable can live in collection or global scope too, not just an environment, so that phrasing is inaccurate, not just inconsistent. |
| Where a variable resolves from (global / collection / environment / row) | **Scope** | Use it a bit more deliberately in variable-related copy (tooltips, the variable popover) rather than avoiding it. |
| Firing a single request | **Send** | Locked. Matches Postman/Insomnia convention and keeps "Run" free for the two below. |
| Firing a whole collection sequentially | **Run** | As in "Collection Run" / run history - already established. |
| The load-testing feature | **Load test** (noun), **Run** (verb: "Run a load test") | Already consistent as its own noun phrase. |
| Assertions on a response | **Tests** (tab), **Test Validation** (results) | The one real overload - "Test" means two different things across the load-test feature and response assertions. Not renaming either (both are established, product-defined terms), but never let both appear in the same sentence or dialog without a qualifier ("load test" / "response tests") to disambiguate. |
| A pre-request/post-request script | **Script**, living under the **Elements** tab | Keep "Elements" as the tab name (the consolidation from separate Pre-request/Tests tabs was deliberate), but individual script errors/labels keep saying "Pre-request script" / "Post-request script" (sentence case, matching the engine's own labels in `script_kinds.cpp`) - renaming those to "Elements" would lose information the label carries. |
| The mock-server feature | **Mock server** | Sentence-case mid-sentence, Title Case only in headings - this is normal casing variance, not a naming split. |
| Vayu's own backend process (the daemon on port 9876) | **Vayu's engine** | Bare "the engine" isn't wrong grammatically, but avoid it as a sentence's opening word or its subject noun with nothing attached - "Vayu's engine" is what tells the reader whose process failed rather than leaving "engine" to mean the request's own target server. |
| Multi-project container | *(doesn't exist)* | "Workspace" isn't a Vayu concept. Don't introduce it as filler vocabulary during a string rewrite even where a sentence seems to want one. The one exception is **Backup** (Settings › General), a feature that used to be called "Workspace backup" - "Backup" alone is the locked term now, and "Workspace" should not reappear as a qualifier for it. |

## Decision rules

Rules a writer or reviewer can apply without judgment calls, so hundreds of
scattered strings land the same way.

- **Case.** Sentence case everywhere - buttons, headings, tabs, menu items.
  Proper nouns and protocol names keep their casing (HTTP, cURL, OpenAPI,
  GraphQL, JSON).
- **Punctuation.** A full sentence ends with a period, including in a
  tooltip; a fragment does not. Oxford comma. No exclamation marks. " - " for
  a dash (the repo bans em-dashes everywhere), "…" for an ellipsis.
- **Numbers and units.** Always state the unit (ms or s, never a bare
  number). One format via `Intl`, not hand-built string concatenation. Real
  plural handling via `Intl.PluralRules`, never "request(s)".
- **Truncation.**
  - URLs truncate in the middle, keeping the host and the last path segment.
  - Variable names and file paths truncate keeping the final segment (never
    cut the part that identifies *which* variable or file).
  - IDs keep their first 8 characters.
  - The full value always goes in a tooltip or `title` attribute.
- **User-supplied names vs identifiers.** Quote user-supplied names ("Prod
  API"). Put technical identifiers and literal values in code style
  (`{{authToken}}`, `ECONNREFUSED`, header names).
- **Length budgets.** Buttons: at most 3 words. Toasts: at most one sentence
  plus one action. Empty states: one heading, one line, one primary button.
- **Confirmations name the consequence.** Destructive, unrecoverable actions
  get a dialog whose body states what's lost, and a button labelled with the
  real verb matching the title ("Delete environment", never "OK" or "Yes").
  Recoverable actions (anything that lands in Trash) skip the confirm dialog
  entirely and use an undo toast instead - a dialog for a reversible action
  is friction with no purpose.
- **Keyboard shortcuts in tooltips**, platform-aware glyphs, one format:
  `Send request (⌘↵)`.
- **State-machine copy** uses one vocabulary per state machine, not
  synonyms: `Saving… / Saved / Unsaved changes` for persistence,
  `Running / Stopped / Completed / Failed` for a load test run. The present
  participle plus ellipsis means "in progress" and nothing else uses that
  form.

## Calibration examples

| Before | After |
|---|---|
| "Request failed" | "No response after 30s. The server at api.example.com accepted the connection but didn't reply. Raise the timeout in Settings › Network & connectivity or check the server." |
| "Failed to fetch" | "Couldn't connect to localhost:3000 (ECONNREFUSED). Nothing is listening on that port - is your server running?" |
| "No collections yet" | Heading: "No collections yet." Body: "Group related requests and share variables across them." Buttons: [New collection] [Import]. |
| "Are you sure?" / [OK] | Title: "Delete 'Prod API'?" Body: "Its 12 variables are removed. Requests that use them will send the literal `{{baseUrl}}`. This can't be undone." Buttons: [Cancel] [Delete environment]. |
| "Variable not found" | "`{{authToken}}` isn't defined in 'Staging' or globals. It will be sent as literal text." |
| Static "Save" button | "Save" (disabled when clean) → "Saving…" → "Saved" (fades after 2s). On failure: "Couldn't save - disk full. Changes kept in this tab." |

## Enforcement

A sweep against this guide is only as durable as the test that keeps drift
from creeping back in afterward. Add a source-scanning test (same pattern as
`app/src/components/a11y-suppressions.test.ts`) that fails on "Failed to",
"Could not", "Oops", "!" in UI strings, and on title-cased button labels,
before considering the sweep done.
