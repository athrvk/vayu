---
description: >-
  Importing a collection from a live MCP server in Vayu - the Import dialog's MCP server tab, what the preview shows, how a bearer token and credential headers are handled, and what the import does not do.
---

# MCP server import

The Import dialog's **MCP server** tab asks a running MCP server what it offers and turns the answer into a collection: one request per tool, resource or prompt, ready to send.
Unlike the other tabs it reads no document.
It sends the engine a URL and gets the parsed tree back, so the preview and the apply that follow are the ones every other tab uses.

- **Route:** [`POST /import/mcp`](../../engine/api-reference/import.md#post-importmcp) is the contract: the calls the engine makes, the tree it builds, the bounds and every error. This page covers only what the dialog does with it.
- **Code:** `app/src/modules/collections/ImportMcpForm.tsx` (the fields), `import-mcp.ts` (the form's state and the request it makes), `ImportModal.tsx` (`handleConnectMcp`), `McpReimportDiff.tsx` (the report of a server imported before), `apiService.importMcp` and `apiService.importMcpDiff` in `app/src/services/api.ts`, and `mcpBatchEntry` in `app/src/services/importers/batch.ts`.

## The form

| Field | What it holds |
|---|---|
| Server URL | The server's endpoint (`https://mcp.example.com/mcp`). Required. A key in the query string is saved with the collection. |
| Headers | Name and value rows, sent on every call the engine makes. A row that is blank or switched off is not sent; a named row with no value is sent as it stands. |
| Bearer token (optional) | A secret input. Sent to the server as a bearer token. |
| Tools, Resources, Prompts | Which of the server's primitives to list. Tools is ticked by default. Connect is off while none is ticked, because the engine refuses an `include` that leaves nothing in. |

**Connect** (or Enter in the URL or token box) makes the call, and is off while the URL is blank.
While the call runs every field is held and the progress bar reads *Asking the server*; there are no figures to report, because it is one engine call that makes several to the server.
A tab switch keeps what was typed and leaves a running connect to land on its own tab.

## The preview

A successful connect shows the preview every other format shows, with the server's URL under the format name: a count line, the tree of folders (`Tools`, `Resources`, `Prompts`, as included) and requests under a root collection named after the server, and a note for anything the engine stepped over.
A legacy-era server's tree also holds its handshake as requests on the root, listed in the order a run sends them: `initialize` and `notifications/initialized` above the folders, and `Close session` below them when the server keeps a session ([A legacy-era server](../../engine/api-reference/import.md#a-legacy-era-server)).
Run the collection with **Include nested collections** on, or `initialize` first: a request sent on its own before that has no session to send, and a run of the root alone sends only the handshake and `Close session`, no tool.
**Nothing is stored at this point.** The route reads only, and the dialog holds the answer in memory until **Import** writes it through [`POST /import/apply`](../../engine/api-reference/import.md#post-importapply), as one new root collection.
Dismissing the preview, or closing the dialog, discards the tree.

### A server imported before

Right after the connect succeeds the dialog also asks [`POST /import/mcp/diff`](../../engine/api-reference/import.md#post-importmcpdiff) with the same request, so it reads the server a second time.
When a collection already holds this URL (as the `mcpBaseUrl` variable an import stores), the preview adds a report on it: *You already imported this server*, and for each such collection the counts of entries *added*, *changed* and *removed* (zeros stated), then the names under each.
A tool the server renamed is one changed row, `old → new`, not an added tool and a removed one; a changed row also names what differs (description, input schema, output schema).
The footer's button then reads **Import anyway**: it creates a new collection exactly as Import does.
**Nothing is changed in the existing collection**, and the dialog offers no way to apply the difference to it.
A comparison that fails (the server answered the connect and then not the second read, say) is logged and treated as no match: the preview shows no report and Import is unchanged.

The environment and script checkboxes are not offered on this tab: the tree carries no environment, no global and no script, so each would answer a question the source cannot ask.
Their values stay for the other tabs.

## What each request is

What the route generates, the requests' shape and what the engine adds at send are in [`POST /import/mcp`](../../engine/api-reference/import.md#post-importmcp); the dialog previews and applies that tree unchanged.
A tool's output schema is kept with the request, so adding "Assert JSON Schema" to an imported tool request starts from it.

## Credentials

**The token is never stored.** It lives in the dialog's state for the length of the form and in the one request to the engine, and nowhere else: not a store, not a query key, not a log.
Dismissing the preview or closing the dialog clears it with the rest of the form.

What the collection holds in its place is a **secret `mcpToken` collection variable left empty**, which the route's tree reads.
The preview says so (*The token is not stored in the collection - set the mcpToken variable before you send*), and the line follows what the engine returned, not the form, so it appears exactly when the variable does.
Until the user sets `mcpToken`, the requests send no token.

A header the user typed whose name is a credential's arrives on each request **blank and disabled**, so its value never reaches the collection.
The preview says so (*1 header holds a credential and arrives blank and disabled - fill it in before you send*), counting distinct header names, and the line follows the rows the engine returned.
Which names count is the engine's rule, in [`POST /import/mcp`](../../engine/api-reference/import.md#post-importmcp).

Both lines are kept after the dialog closes: **Import** records them in the collection's import report like any other notice, so *Review import notes* and the toast's *things to finish* count them.

## Cancel

Closing the dialog while a connect runs aborts the wait and drops the answer: a reply that lands later is not written into the dialog the next time it opens, and no error is shown for the abort.
The engine does not stop on the abort: it goes on talking to the server until its own bound, but nothing acts on what it gets and nothing is stored.
`apiService.importMcp` waits for that bound plus the transport grace the other proxied imports get, rather than the `defaultTimeout` setting, so the engine's own error for an overrun arrives before the client gives up.

## Errors

A failure shows the engine's message under the form and leaves what was typed in place, so a typo in the URL is fixed and Connect pressed again. Each message is listed with the route.
Every failure arrives as the engine's own sentence.

## Limits

The dialog has no OAuth sign-in; it sends a static bearer token (tracked in [#3983](https://github.com/athrvk/vayu/issues/3983)).

Importing a server again shows what changed against the collection an earlier import built, and the dialog cannot apply it yet ([#3994](https://github.com/athrvk/vayu/issues/3994)): Import always makes a new collection.
The engine can: [`POST /import/mcp/apply`](../../engine/api-reference/import.md#post-importmcpapply) writes the selected rows to the existing collection in place, only the fields the diff names, so a request's arguments, headers and auth are kept.
