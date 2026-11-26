---
description: >-
  Importing a collection from a live MCP server in Vayu - the Import dialog's MCP server tab, what the preview shows, how a bearer token and credential headers are handled, and what the import does not do.
---

# MCP server import

The Import dialog's **MCP server** tab asks a running MCP server what it offers and turns the answer into a collection: one request per tool, resource or prompt, ready to send.
Unlike the other tabs it reads no document.
It sends the engine a URL and gets the parsed tree back, so the preview and the apply that follow are the ones every other tab uses.

- **Route:** [`POST /import/mcp`](../../engine/api-reference/import.md#post-importmcp) is the contract: the calls the engine makes, the tree it builds, the bounds and every error. This page covers only what the dialog does with it.
- **Code:** `app/src/modules/collections/ImportMcpForm.tsx` (the fields), `import-mcp.ts` (the form's state and the request it makes), `ImportModal.tsx` (`handleConnectMcp`), `apiService.importMcp` in `app/src/services/api.ts`, and `mcpBatchEntry` in `app/src/services/importers/batch.ts`.

## The form

| Field | What it holds |
|---|---|
| Server URL | The server's endpoint (`https://mcp.example.com/mcp`). Required. Stored as written in every generated request, so keep a key out of the query string. |
| Headers | Name and value rows, sent on every call the engine makes. A row that is blank or switched off is not sent. A named row with no value is sent as it stands, and the engine's own refusal says which. |
| Bearer token (optional) | A secret input. Sent as `Authorization: Bearer <token>`, unless a header row already names `Authorization`, which wins. |
| Tools, Resources, Prompts | Which of the server's primitives to list. Tools is ticked by default. Connect is off while none is ticked, because the engine refuses an `include` that leaves nothing in. |

A URL with `user:password@` is refused by the engine: put credentials in a header or the token field.

**Connect** (or Enter in the URL or token box) makes the call, and is off while the URL is blank.
While the call runs every field is held and the progress bar reads *Asking the server*; there are no figures to report, because it is one engine call that makes several to the server.
A tab switch keeps what was typed and leaves a running connect to land on its own tab.

There is no OAuth field. The token is a static bearer token the user already has; a server that needs an OAuth flow to obtain one cannot be imported from this way, because the import performs no OAuth discovery or consent step.

## The preview

A successful connect shows the preview every other format shows: a count line, the tree of folders (`Tools`, `Resources`, `Prompts`, as included) and requests under a root collection named after the server, and a note for anything the engine stepped over.
**Nothing is stored at this point.** The route reads only, and the dialog holds the answer in memory until **Import** writes it through [`POST /import/apply`](../../engine/api-reference/import.md#post-importapply), as one new root collection.
Dismissing the preview, or closing the dialog, discards the tree.

The environment and script checkboxes are not offered on this tab: the tree carries no environment, no global and no script, so each would answer a question the source cannot ask.
Their values stay for the other tabs.

## What each request is

Every request is a `POST` to the server's URL with an `mcp` body ([the body mode](../../engine/api-reference/request-body.md#the-mcp-body)): a tool becomes a `tools/call`, a resource or template a `resources/read`, a prompt a `prompts/get`.
The engine stamps the protocol envelope when the request is sent.

The requests are currently bare calls. A `tools/call` carries the tool's name and empty `arguments`, and no assertion is added, so a tool that needs arguments is filled in by hand after the import.
Drawing arguments and assertions from the tool's schema is the engine's work ([#3839](https://github.com/athrvk/vayu/issues/3839)); this page does not describe it until it ships.

## Credentials

**The token is never stored.** It lives in the dialog's state for the length of the form and in the one request to the engine, and nowhere else: not a store, not a query key, not a log.
Dismissing the preview or closing the dialog clears it with the rest of the form.

What the collection holds in its place is a reference.
The root collection's auth is a bearer auth reading `{{mcpToken}}`, and `mcpToken` is a **secret collection variable left empty**.
The preview says so (*The token is not stored in the collection - set the mcpToken variable before you send*), and the line follows what the engine returned, not the form, so it appears exactly when the variable does.
Until the user sets `mcpToken`, the requests send no token.

A header whose name is a credential's (`Authorization`, `Cookie`, `X-API-Key` and the rest of the set the logger redacts) is carried onto each request **blank and disabled**: the request shows which header the server wanted, and sends nothing for it.
Every other header is carried as typed.
The set and the rule are the engine's, in [`POST /import/mcp`](../../engine/api-reference/import.md#post-importmcp).

## Cancel

Closing the dialog while a connect runs aborts the wait and drops the answer: a reply that lands later is not written into the dialog the next time it opens, and no error is shown for the abort.
The engine does not stop on the abort: it goes on talking to the server until its own bound (20 seconds a call, 120 for the whole import), but nothing acts on what it gets and nothing is stored.
`apiService.importMcp` gives the call that 120 seconds plus the transport grace the other proxied imports get, rather than the `defaultTimeout` setting, so the engine's own error for an overrun arrives before the client gives up.

## Errors

A failure shows the engine's message under the form and leaves what was typed in place, so a typo in the URL is fixed and Connect pressed again. Each message is listed with the route.
A refused connection, a `401` or `403`, a reply over the size bound, a list that never ends and a timeout each arrive as the engine's own sentence.

A server that speaks only an earlier protocol era is currently refused with a `502`: the import sends the current era's requests, and the engine reports the server as legacy-era. Support for them is tracked in [#3840](https://github.com/athrvk/vayu/issues/3840).
