---
description: >-
  Sending GraphQL requests in Vayu - the query and variables editor, schema-aware behaviour, and how the body reaches the engine.
---

# GraphQL

Vayu's GraphQL body mode is a two-pane editor - a **Query** pane and a
**Variables** pane - plus a **schema explorer** that browses the endpoint's own
documentation beside them.

Pick **GraphQL** in the Body tab's mode picker. Vayu appends
`Content-Type: application/json` to the Headers tab and says so with an Undo,
because GraphQL goes on the wire as a JSON envelope
(`{"query": …, "variables": …}`) rather than as a bare document.

Picking the mode also sets the method to **POST**, when the request still
holds the default GET a new request starts with. Leaving GraphQL for another
body mode gives the method back, the same way it removes the header. There is
no Undo button for this one - the method selector is on screen and already
shows what changed, which the Headers tab does not. A method you chose
yourself is never touched, in either direction.

That is because GraphQL means something different on a GET: the query travels
as URL query parameters instead of a JSON body, and a mutation cannot be sent
that way at all. A GET still reaches GraphQL when you pick it back yourself, or
when an import wrote one - the Query pane header then carries a **Sent as query
parameters** badge naming what will happen, so nothing silently 400s with no
explanation on screen.

## The schema

The moment a GraphQL body is on screen with a URL in the bar, Vayu introspects
the endpoint. The request it sends is **your** request, composed by the engine
first: `{{variables}}` resolved, and the Auth panel's configuration applied -
including `inherit` walked up the collection chain, and OAuth 2.0. Two
environments pointing the same URL at different credentials are two different
schemas, and Vayu keeps them apart.

The badge in the Query pane's header says which state it is in:

| Badge | Meaning |
|---|---|
| **Schema** (spinner) | Introspecting. |
| **Schema** (tick) | Loaded. Completion, validation and hover are live. |
| **Schema stale** | A refresh failed over a schema that had loaded. The editors still use the older one; the tooltip says how old it is and what went wrong. |
| **No schema** | Nothing loaded. The editor still checks syntax. The tooltip names the reason - rejected credentials and an endpoint with introspection switched off are different problems with different fixes. |

Introspection happens on the body tab's own lifecycle and when you press
**Refresh**, and never leaves a run, a trace or a History entry behind. A
header you typed by hand is not part of the schema's identity, so after editing
an `Authorization` row directly, press Refresh.

## The schema explorer

Press **Browse schema**, the panel icon at the left of the Query pane's header,
to dock the explorer beside the editor. It opens on that side, which is where
the icon points; the same button closes it again, so the control does not move
when the pane appears.

- **Browse** Query, Mutation, Subscription and Types. A field's row shows its
  name and result type, with a muted argument count - `(2 args)` - standing in
  for the list; the full signature leads its tooltip, ahead of the description,
  so an argument list is a hover away rather than a drag of the splitter. A
  field that takes arguments expands into an **Arguments** group, one row per
  argument, above the fields of what it returns. Descriptions sit beside rows,
  and a deprecated field or enum value is struck through, with the reason in its
  tooltip.
- **Search** filters across every field and type in the schema at once. Press
  `/` from anywhere in the tree to jump to the search box. Results are grouped
  under the same Query / Mutation / Subscription / Types headings the tree uses,
  and a field names the type that declares it - `User.handle`, so three types
  that each declare an `id` are three rows you can tell apart. The control at
  the left of a result **shows that row in the tree**: it opens the path, clears
  the search and lands on the row.
- **Insert** a row by clicking it, or by pressing Enter with it focused. Every
  activation answers: it inserts, it selects the line you already have, or it
  says in the pane why it could not.

The tree is a full keyboard surface: arrows move, Right opens a row, Left closes
it or steps out, Home and End jump to the ends, and typing letters jumps to the
row that starts with them.

### What insertion writes

Inserting always leaves a document that parses **and can be sent**. Where a
field lands depends on where your cursor is:

- **Inside a selection set that can hold the field** - it is added there, as a
  sibling of what is already selected.
- **Inside a selection set that cannot** - Vayu walks outwards to the nearest
  one that can.
- **Nowhere compatible** - it becomes a new named operation appended to the
  document.

Required arguments become `$variables`, and they are **declared** on the
operation that gained them. If that operation was the shorthand `{ … }` form,
which cannot carry variables at all, Vayu promotes it to `query ( … )` in the
same edit. Object-typed fields arrive with their scalar fields selected and the
cursor inside the braces; deprecated fields are browsable but are never selected
for you.

Activating an **argument** row writes it onto the field as a `$variable`:
`posts(first: $first)` plus `$first: Int` declared on the operation, with a
placeholder merged into the Variables pane the same way a required argument's
is. When the document does not select that field yet, Vayu inserts the field
first by the rules above and writes the argument onto what that wrote.
Activating an argument the selection already carries selects the existing one
instead of writing a duplicate, the same "already present" behaviour a field
gets. An argument under a **subscription** field is refused, naming the
subscription it belongs to.

Selecting a **type** inserts the operation that returns it - `Post` writes the
`createPost` mutation that answers with one, following the shortest route the
schema offers and never a deprecated one. A route through a field that returns
an interface or a union counts: `Query.node: Node` reaches a `Post`, and Vayu
writes the `... on Post` the selection needs to be legal.

Where nothing in Query or Mutation returns the type at all - one reachable only
through its parent - Vayu writes a fragment on it **and the spread that uses
it**, into a selection on screen that can hold it, including an interface or
union selection the type belongs to. It needs that: a fragment nothing spreads
is rejected along with the rest of the document, so with nowhere to put the
spread Vayu says so rather than handing you a request the server will refuse.
Under a type row, **Returned by** lists the root fields that answer with it, so
you can pick a different route than the one a click takes. A route that gets
there through an interface or union says so - `node(id: ID!): Node → Post`.

A field found by **search** under a type you have not opened - `User.handle`,
say - is inserted through that same route, so it no longer needs your cursor to
already be inside a `User`.

**Subscriptions are shown and cannot be inserted.** Vayu sends one HTTP request
and reads one response, so a subscription has no transport here. Hiding the
branch would be the friendlier answer and the less honest one.

### The Variables pane is never overwritten

Argument placeholders are merged into the Variables pane only when its text is
already strict JSON, and only into keys it does not have - a value you typed is
never replaced.

If the pane holds something `JSON.parse` rejects - most often a working
`{"id": {{userId}}}` template - Vayu writes nothing into it and badges the
header instead (*"1 variable needs a value"*), naming what it could not add.
Your draft is not a thing to make room in.

## The Variables pane

The pane validates against a JSON Schema derived from the operation's
`$variable` definitions and the introspected schema, so values are checked and
completed against what the operation actually expects.

Its header badges what the text will do when the request is sent:

- **Templated** - the text holds `{{variable}}` tokens. It is not JSON at rest
  and is JSON on the wire, because the engine resolves the body before sending.
  It **is** sent.
- **Not sent** - the text is broken for some other reason, so the request goes
  out with no variables at all. To the editor both look like the same red
  squiggle; on the wire they could not be more different.

## Several operations in one document

A document defining more than one named operation gets an **operation picker**
in the Query pane's header. The spec forbids an anonymous operation beside a
named one, and a server given no `operationName` for such a document answers
with an error rather than a guess - so the picker appears exactly when the
choice becomes real. Whatever else the envelope carries (`extensions`, an
`operationName` an importer preserved) rides along through every edit.

## The context bar

The bar's **GraphQL** section carries the glanceable half: whether a schema is
loaded, how old it is, the endpoint, and an outline of the operations the
request defines. Refreshing is not part of it - there is one Refresh, in the
Query pane's header, on screen whether the explorer is open or closed. Browsing
belongs beside the cursor that inserts, which is why the tree lives in the
editor pane and not here.

The section is hidden outright off a non-GraphQL body (`useGraphQLRelevance`),
rather than rendering to say the request does not send one - a header every REST
request used to carry and the reader scanned past on the way to the two sections
that meant something (#1310). That verdict answers from the same
`useRequestQuery` data the section itself reads, so a REST tab never even
requests the section's own lazy ~320KB chunk (#1146): it used to arrive the
moment the expanded section mounted just to say the request was not GraphQL.

The outline reads the saved request, so it follows the editor as autosave
catches up rather than keystroke by keystroke.
