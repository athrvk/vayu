---
description: >-
  `pm.request`: what a script reads from the request, including GraphQL and string bodies.
---

# Request Object (`pm.request`)

Access request data:

```javascript
pm.request.method            // HTTP method (string)
pm.request.url               // Full URL (Postman Url object - see below)
pm.request.headers           // Request headers (object, with the methods below)
pm.request.body              // Request body (Postman RequestBody object, if any - see below)
pm.request.auth              // The auth the script assigned, else undefined - see below
```

**`headers` is a different set in each hook, and that is the point.**
A pre-request script sees the **composed** headers - the set it is there to edit, and the set the write-back applies back onto the request.
A test script sees the **sent record**: those same headers as the transfer actually issued them, which means the ones the engine derives at send time are there too -
the body-implied `Content-Type` (`json`, `graphql`, `jsonrpc` and `mcp` -> `application/json`, `text` -> `text/plain`, `xml` -> `application/xml`, `x-www-form-urlencoded` -> `application/x-www-form-urlencoded`;
a bodyless `POST` sends none, issue #2464) and the [default headers](../api-reference/health-config.md#default-request-headers) the send added - the `User-Agent`, a negotiated `Accept-Encoding`, and a correlation id where one is switched on.
So a test asserting on the Content-Type a GraphQL request sent reads the header the engine supplied, rather than the `undefined` it read before (#483) - with one exception the method decides:
a `graphql` body on a **GET** travels as query parameters and sends no body at all, so there is nothing for a Content-Type to describe and the engine derives none (issue #1228, see [the `graphql` envelope](../api-reference/request-body.md#the-graphql-envelope)).

Four consequences worth knowing:

- **An authored header is never overridden.**
  The engine only derives a Content-Type the request does not declare, so what a script reads back is what its author wrote.
- **A `form-data` Content-Type is absent, not blank.** libcurl writes that one itself, boundary and all, so the engine suppresses an authored one and does not report as sent what it did not send.
  The script's view matches the response pane's Headers tab exactly.
- **A header with an empty value is sent empty.**
  An enabled row whose value is empty (or only whitespace) goes on the wire with no value and reads back as `''` (issue #3220).
  A pre-request script that sets a header to `''` has blanked it, not removed it; `pm.request.headers.remove` removes one.
  A blank `Content-Type` is the exception: it means no Content-Type, so it is absent, and so is a blank `Cookie` row.
- **`Cookie` is not here.**
  It is wire-only by design; `pm.cookies` is the cookie surface, and the response's raw view is the full wire frame (which also carries libcurl's own `Accept`, `Host` and `Content-Length`).

`pm.request.body` is Postman's `RequestBody` object (issue #1003), present only when the request has a body: a bodyless request still defines no `body` property at all, so `typeof pm.request.body === 'undefined'` still separates "no body" from "a body that happens to be empty", exactly as it did when this was a string.

```javascript
pm.request.body.mode         // 'urlencoded' | 'formdata' | 'graphql' | 'file' | 'raw'
pm.request.body.raw          // the body as a string, for every mode
pm.request.body.urlencoded   // [{key, value, disabled}, ...] or undefined
pm.request.body.formdata     // [{key, value?, type, fileName?, disabled}, ...] or undefined
pm.request.body.graphql      // {query, variables?} or undefined (unreadable, or nested past 128 levels)
pm.request.body.file         // {name, size?} or undefined
pm.request.body.length       // the body string's own length
```

`.mode` reads `raw` for every content mode without a Postman name of its own - `json`, `text`, `xml`, `jsonrpc` and `mcp` all carry their body as one string, which is what `raw` means.

A `binary` body - one file sent as the whole body - reads `file`, Postman's name for it.
`.file` answers `{ name, size? }`: `name` is the file name the request declares, else the last part of its path, and `size` its length in bytes, present once the send has read the file.
Postman's `file.src`, the path, is never answered - a local path is one machine's filesystem and is not disclosed to a script, the rule a form-data file part already follows (issue #411) - see [pm-api-compatibility.md](../../app/pm-api-compatibility.md).

## `graphql` bodies

`.mode` reads `graphql` for a GraphQL body, and `.graphql` answers Postman's `{query, variables}` pair (issue #1111).
Vayu stores such a body as **one string** that is allowed to be either the `{"query": …}` envelope the request builder writes or the bare document an agent or a `curl` caller hands over; the pair is derived from that string by the same classifier the send itself goes through, so `.graphql.query` is the query that goes on the wire rather than a second reading of the same bytes.

```javascript
// An enveloped body answers its own members.
pm.request.body.graphql.query        // 'query User($id: ID!) { user(id: $id) { name } }'
pm.request.body.graphql.variables.id // '42'

// A bare document answers as the query it would be wrapped and sent as.
pm.request.body.graphql.query        // 'query User { user { name } }'
```

Three things worth knowing before scripting against it:

- **`variables` is the JSON value the envelope carries**, where Postman's is the *text* of its variables editor.
  Vayu never stored that text, and serializing one here would invent whitespace and key order the user never wrote.
  Read it as an object; a lifted `JSON.parse(…variables)` is the one call to change.
- **A body that is envelope-shaped but does not parse answers `undefined`** - an unresolved `{{token}}`, or a mistyped envelope.
  The send passes such a body through untouched rather than wrapping something it could not read, and a pair invented here would be the guess it refuses.
  `.raw` still carries the string.
  So does an envelope **nested deeper than 128 levels**, its own root counted (issue #2672): the body is one string, the request-body depth bound never looks inside it, and the GET transport refuses it by the same bound.
- **`.raw` stays the whole string in this mode too**, where Postman leaves it undefined - the same divergence `.raw` already carries for the two form modes, and for the same reason.
  Assigning `.raw` moves the pair with it.

A lifted `pm.request.body.mode === 'raw'` guard over a GraphQL body took the true branch before this and takes the false one now.
That is the break, and it is the compatible answer: Postman names this mode too, so a script written against Postman was already reading `graphql` there.

`.raw` is the string every mode reads as, including the two whose content is a list of fields rather than text - and it is defined for both of those, where Postman leaves it `undefined`, because a form body reading as nothing cannot be told apart from a request with no body (issue #411).
A form body's `.raw` reads its **enabled** fields encoded `key=value&…`:

| Body mode | What `.raw` reads | Assigning a string (or `.raw`) |
|---|---|---|
| `json` / `text` / `xml` / `graphql` / … | the content, as stored | replaces it |
| `x-www-form-urlencoded` | the encoded fields - **exactly** the bytes sent | parses back into the fields |
| `form-data` | the encoded fields, file parts as `key=@filename` - a *rendering*, not the bytes sent | refused with a named error |
| `binary` | `@` and the file name, as a form-data file part is named - never the file's bytes | refused with a named error: a script never chooses the file |
| none | the property is absent (`undefined`) | sends that string as raw text |

A **file part** reads `avatar=@portrait.png`, borrowing curl's `-F` spelling, because it carries its content in a path rather than a value - encoded as a pair it would read `avatar=`, indistinguishable from a text part whose value happens to be empty.
The name shown is the one the server is told (the part's declared filename, else the basename of the chosen file), never the local path.
A text value starting with `@` cannot be confused with it: percent-encoding escapes that to `%40`, and the marker is written unescaped.

The `form-data` split is not an oversight: a multipart body carries a boundary libcurl generates at transfer time, so no faithful string exists before the send.
That makes the string safe to read and log, but a digest taken over it is **not** a digest of the multipart body that goes out - and it is why an assignment is refused there rather than accepted and then ignored by the transfer layer.
To change a multipart body, edit the request's form fields; `delete pm.request.body` still drops it entirely.

`.urlencoded` and `.formdata` are the two field lists, present only in their own mode and `undefined` in every other: `{ key, value, disabled }` per x-www-form-urlencoded pair, or `{ key, value?, type, fileName?, disabled }` per multipart part.
Values are as the user wrote them, not percent-encoded - the encoding is `.raw`'s answer, so a signature built from these pairs would double-encode if this were encoded too.
A disabled row is listed with `disabled: true` rather than omitted, so a script can see the row it would otherwise re-add.
A file part carries no `value` at all, rather than the `""` an empty text field would hold - an empty string there would read as a text field that happens to be empty - and never the local path.

Both lists are **read-only**, and so are `.mode`, `.graphql`, `.file` and `.length`.
Assigning any of them throws naming the member, and so does `push`ing into a list, which is frozen.
Writing to a field *inside* an entry is the one edit that does not throw
- a frozen object drops a write silently in non-strict code, which is JavaScript's own rule rather than one this surface adds - and it reaches nothing either way.
Assign `pm.request.body` or `.raw`, or call `.update()`, to change what is sent, or edit the request's form fields directly.
After such a write `.urlencoded` reads the pairs the new string carries, the way `.graphql` reads the pair a new `.raw` carries, rather than the fields the request was composed with.

Reading a form body never rewrites it.
The write-back reads `body` off the script's object whether or not the script assigned it, so an **unchanged** value means untouched - without that, a script that only looked at the body would delete the disabled rows the encoded view leaves out.

## The body was a string too, and mostly still behaves as one

This shape replaced a plain string (issue #1003: Postman compatibility over the shipped string shape, the same trade issue #991 made for the [URL](request-mutation.md#url-parts-pmrequesturl)).
The object keeps as much of the old behaviour as JavaScript allows - it carries its own `toString`, `valueOf`, `toJSON` and `Symbol.toPrimitive`, and inherits from `String.prototype`:

```javascript
'' + pm.request.body;                     // the body
`${pm.request.body}`;                     // the body
pm.request.body == 'plain text';          // compares as the body
pm.request.body.startsWith('{');          // String methods work
pm.request.body.length;                   // the body's own length
JSON.stringify({ b: pm.request.body });   // embeds the body string
```

Three things did change, and no mitigation can fix them:

| Was | Now | Use |
|-----|-----|-----|
| `pm.request.body === '...'` | `false` | `==`, or `.toString()` |
| `typeof pm.request.body` | `'object'` | - |
| `pm.request.headers['X-Body'] = pm.request.body` | refused | `pm.request.headers['X-Body'] = String(pm.request.body)` |

The third is the same refusal `pm.request.url` already gets: a value the engine cannot send is refused rather than coerced, and an object is not a header value.

`.length` is **not** one of them: it is defined on the object as the body's own length.
Inheriting it from `String.prototype` - which is a String object holding `""` - would have answered `0` for a body that is not empty, and a plausible wrong number is worse than a break you can see.
