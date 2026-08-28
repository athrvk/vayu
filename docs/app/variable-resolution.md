---
description: >-
  How {{variables}} resolve in Vayu - the globals, collection chain and environment layers, precedence, and when resolution happens.
---

# Variable Resolution

Vayu resolves `{{variableName}}` placeholders at request-execution time using a layered
priority system. Higher-priority layers override lower ones; within each layer the last
write wins.

**Where resolution runs (since issue #226):** the **engine** owns
execution-time resolution - `POST /compose` interpolates and resolves
`inherit` auth, and every client executes the composed result
(`engine/src/http/request_composer.cpp`). The renderer keeps a **preview-only**
copy of the same rules (`app/src/lib/variable-resolution.ts`, consumed by
`useVariableResolver`) for tab titles, previews and the unresolved-token
painting. The rules on this page are the contract both implement, pinned by
the shared conformance fixture
(`engine/tests/fixtures/variable-resolution-conformance.json`), which the
engine's gtest suite and the renderer's vitest suite both drive.

**One matcher in the renderer.** `{{name}}` is recognised by
`VARIABLE_PATTERN` in `app/src/constants/variables.ts` and nowhere else -
import it (or `containsVariableToken` / `isVariableToken`, which wrap the two
boolean questions) rather than writing the literal again. The app had four
identical copies before issue #227, and copies are how a preview drifts from
what `/compose` will substitute without anything failing. The C++ side is the
one legitimate other copy, and the conformance fixture is what holds it to
this one. `constants/variable-pattern-single-source.test.ts` fails on a fifth.

**Malformed stored data (the D17 rules, decided in #226).** A definition whose
`enabled` is **absent** (or not a boolean) counts as **enabled** - only an
explicit `enabled: false` disables. A **non-string stored `value`** reads as
the empty string. One rule, both sides: the engine enforces it in
`parse_variables`, the renderer in `lib/variable-resolution.ts`, and the
fixture varies both fields so a divergence cannot hide.

## Priority order (lowest → highest)

```
Globals  <  Collection chain (root → leaf)  <  Active environment  <  Bound data row (bare column names)
```

A variable set in the active environment always wins over a collection variable, which
always wins over a global. The fourth tier exists only **while a data row is
bound** - a data-driven collection run, a load run given rows, or a single send
bound to one row (issue #1007). With no dataset the ladder is the three-tier
one it has always been; a bare name resolves exactly as it did before this
tier existed.

### `data.*` is reserved, and sits outside this order

`{{data.column}}` addresses a column of a collection run's data file (issue
#402), and it is **not a fourth tier above the three**. It is a reserved
namespace, disjoint from them: `{{data.id}}` and `{{id}}` are different names,
so a data set can neither shadow nor be shadowed by a variable, and attaching a
data file to a collection cannot change what its other tokens resolve to. That
is what dissolves the precedence question rather than answering it, and
nothing about it changed.

**A bound row's bare column names are a different rule, and they *are* a
tier** (issue #1007). Postman binds a dataset's columns to bare names -
`{{username}}`, not `{{data.username}}` - so an imported data-driven
collection is written that way, and Vayu answering `{{username}}` from the
scopes (or from nowhere) sent a request the file's author never wrote. While a
row is bound, that row's own column names answer a bare `{{username}}` **above
the active environment** - the ladder in the section above. A column the row
does not carry is not a bind failure: the name falls through to the scopes
exactly as it would with no dataset at all, which is what lets one script or
one request work both with and without a data file.

**Mechanically, neither spelling is substituted by composition.** A plan is
composed once, before any row exists to bind - so composition can no more
substitute a bare bound column than it can substitute `{{data.username}}`. It
**defers** the token instead, leaving it written exactly as it stands, and the
per-row bind (`core::apply_data_template`) is what joins *both* spellings
against the row, through the same walk. That is what makes the two rules cost
nothing extra to keep consistent: a bare column gets the identical JSON/XML
escaping, the identical missing-column refusal, the identical null-cell
refusal, and the identical header CRLF/NUL and header-collision refusals that
`{{data.column}}` has always had. There is no second, looser substitution path
for the bare spelling - see [Data-Driven Runs](data-driven-runs.md) for what
those refusals say.

**Which bare names a bind owns travels as a set of names, never values** - the
engine fills it wherever a dataset is known (a collection or scenario run's
plan, a single-request load run, a single send carrying one row), and a client
composing ahead of a run of its own states it explicitly as the `dataColumns`
field of [`POST /compose`](../engine/api-reference.md#post-compose): an array
of the data file's column names, absent or `null` meaning no dataset and
composition exactly as before.

Nothing in the tables above resolves a `{{data.column}}` token. Both resolvers
- the engine's `resolve_template` and the renderer's `resolveTemplate` - leave
it written exactly as it stands, because only a scenario run's iteration knows
which row is bound; the run's worker substitutes it immediately before each
send. A `data.*` token in an ordinary Send therefore reaches the wire as
written: there is no row. `{{data.}}` with nothing after the dot names no column
and follows the ordinary unknown-name rule instead - which since #1009 also
leaves it written as it stands, for a different reason.

**The UI paints it as its own state, not as a broken variable.** Unresolved is
the accurate word for what the resolvers do with the token, but it is the wrong
thing to *show*: the builder used to render `{{data.email}}` red, hover it to
"not defined", and offer to create a variable of that name - which, the
namespace being disjoint, can never answer for the column. So a `data.*` token
gets the muted run-time treatment (`RuntimeToken`) and a tooltip naming the run's
data file, and no surface offers to create one. See
[COMPONENTS.md](COMPONENTS.md#shared-variable-input-componentssharedvariableinput)
for the three token states.

A **collection run** is the one place that reading is not left to the user: a
run started without a data file whose plan still carries a `data.*` token is
refused with a `400` naming the step and the token, rather than sending the
literal text once per iteration (issue #415). The single Send above keeps its
behaviour - a token someone typed into a request they are editing is not yet a
run.

The conformance fixture pins all three cases, so the two resolvers cannot
drift on them. See
[api-reference.md](../engine/api-reference.md#scenario-runs) for what the
engine does with the token once a row exists.

### `$vu` and `$iteration` are reserved too, for the same reason

`{{$vu}}` and `{{$iteration}}` name the run that is executing - which virtual
user this request belongs to, and which of that user's iterations it is (issue
#994). They are spelled like a dynamic variable and behave like `data.*`: both
resolvers leave them written exactly as they stand, and the executor
substitutes them immediately before each send, because the value belongs to the
iteration rather than to the request.

Being reserved is what makes them bindable at all. A variable someone happens
to name `$vu` does **not** answer for the identity - unlike `$guid`, where a
scope of that name wins (rule 1 below) - because a scope that could answer would
substitute one value at composition and leave every iteration of the run sending
it. That is the one thing these names exist to prevent. The two names are
matched exactly, so `{{$vus}}` is an ordinary unknown `$name` and keeps its
braces.

What they resolve to depends on the shape of the run, and every shape has an
answer:

| Where | `{{$vu}}` | `{{$iteration}}` |
|---|---|---|
| A collection load run | the virtual user's own number, 1-based | that user's iteration, 0-based |
| A single request under load | `1` | the submission's index, 0-based |
| A collection run in design mode | `1` | the pass, 0-based |
| A single Send | `1` | `0` |

**A single request repeated is one user's iterations**, however many are in
flight: `concurrency` says how many of them overlap, which is a different
question from how many users there are. Virtual users that differ from one
another are a collection load run's shape, and that is the run where `{{$vu}}`
spans more than `1`. A run that needs distinct values per request without a
collection uses `{{$iteration}}`, which is unique per submission - and is the
same counter the data-row cursor claims from, so iteration *i* binds row
*i % rows* and a script cannot be told it is on iteration 3 while holding row
1's values.

**Credentials are the one place they do not bind.** A `{{$vu}}` in a basic-auth
username or a bearer token goes out written as it stands: a credential is
encoded when the request is built, and the deferral that lets a *row* reach one
first happens only in a run that has rows - so binding the identity there would
work in a data-driven run and silently not in every other. #1055 tracks lifting
that. Everywhere else binds: the URL, header names and values, the body and
both halves of every form field, each escaped for the document it lands in.

### D18 - a bound row's bare column names outrank the environment (issue #1007)

This repo labels the decisions #226 recorded D1, D2, D16, D17. This one is
new, and it is not from #226: recorded here as **D18**.

**What it costs.** #402 deliberately bought the property that attaching a data
file to a collection cannot change what any existing token resolves to -
`{{id}}` and `{{data.id}}` were guaranteed different names, full stop. D18
trades part of that away: a collection whose data file happens to have a
column sharing a variable's name now resolves that name differently while a
row is bound than it does on a plain Send. That is a real, deliberate
narrowing of #402's guarantee.

**Why it is worth it anyway.** The owner's standing direction prefers Postman
compatibility here: Postman binds a dataset's columns bare, so every imported
data-driven collection is already written `{{username}}`, and #402's guarantee
was making every one of those requests send the literal token instead of the
row's value (see [`{{data.*}}` puts the row into the request
itself](../engine/api-reference.md#scenario-runs)). A collection that never
attaches a data file, or whose columns share no variable's name, pays nothing.

**Why the reserved `data.*` spelling is kept too.** `{{data.username}}` still
addresses the column even where no row is bound, still refuses a header a
value would forge with the same message, and can never collide with a
same-named variable - it is the collision-proof spelling for a request written
by hand, or shared with people who are not relying on Postman muscle memory.
D18 does not replace it; it adds the bare spelling beside it, at Postman's
position in the ladder.

**Why the deferral is what makes both work at once.** Composition already had
to leave `{{data.*}}` unresolved, because a plan is composed once and a row is
bound per iteration - D18 gives a bare bound column the identical treatment,
so both spellings reach the same bind-time join and the same refusal rules.
Nothing about the two rules can drift, because there is only the one path that
substitutes either of them.

**What the builder's preview does not show yet.** The request builder paints a
bare `{{name}}` as a bound column only when *no* scope defines that name. Where
a scope does define it, the token keeps painting as that variable and shows its
value - which is right for a Send with no row, and wrong for the moment a run
binds one, since the column outranks it. The preview resolver takes the bound
columns (`resolveTemplate`'s third argument, pinned against the engine by the
conformance fixture) but nothing passes them yet: no preview surface knows which
row a run will bind. So a collision is *stated* rather than painted - the Data
tab's column audit names any declared column that shares a name with a variable
in scope, and says the column wins while a row is bound. Painting it in the
builder is a design question of its own, tracked separately; nothing here reads
a value the engine cannot send, it just does not yet show the one it will.

### Which contract answers for a request: nearest declared ancestor

A collection can **declare** the columns its data files carry (the Data tab,
issue #599). Which declaration applies to a given request is a chain answer, and
the rule is the variable chain's own read backwards: **the nearest declared
ancestor, leaf to root** (`resolveDataContract` in `lib/data-contract.ts`). A
request in a sub-collection run recursively under a parent binds the parent's
data, so when the sub-collection declares nothing the walk finds the parent's
contract - and when it declares its own, its own wins, exactly as a leaf
variable shadows an ancestor's.

A collection that declared a contract and then cleared it holds `{}`, which is
how "no contract" is spelled, so the walk treats it as transparent rather than
as a contract of zero columns - an empty declaration cannot shadow a working one
above it.

This is what makes the token states possible: with a contract in scope,
`{{data.email}}` is *checkable*. A declared column paints informationally, a
column no contract in scope declares paints **amber** with the declared list in
its tooltip, and a chain that declares nothing keeps the neutral token above. It
is authoring-time advice in every case - the run's file is the authority, and a
run with a mismatched file is still the user's to start. Declared columns are
also completed: `{{data.` offers them in the request fields and the body editors,
and `pm.iterationData.get("` offers them in the script editors (see below).

The script panel's **"Names mentioned:" chips** read the same three states
(issue #604). They used to paint a name red whenever no scope defined it, which
for a `data.*` name is always - the reading that made a working column look
broken in a row whose whole job is to say whether a name resolves. A column
reached by its **bare** name gets that same paint (issue #1063): a script reads
one through `pm.iterationData.get("email")`, or through `pm.variables.get("email")`
while no scope defines `email`, and both are the column `{{data.email}}` names.
The accessor is what decides, not the spelling - `pm.environment.get("email")`
cannot see the row whatever the collection declares, so it stays an ordinary
variable chip.

The **audit** in the Data tab is the same comparison in the other direction -
the declared columns against the tokens the collection's requests actually
carry.

Every surface that acts on a contract resolves it this way, including the **Run
dialog**: running a sub-collection under a declaring parent offers the parent's
declared file as the pre-fill and diffs the chosen file against the parent's
columns, the same answer Send-with-row and the token painter give. See
[COMPONENTS.md](COMPONENTS.md#shared-variable-input-componentssharedvariableinput)
for the paint and
[Data-Driven Runs](data-driven-runs.md) for the file itself.

---

## Layers

### 1. Globals

App-wide variables stored in the singleton `globals` table. Edited via the Globals panel.
These form the base layer - any layer above can override them.

### 2. Collection chain

Each collection can define its own variables. When a request belongs to a nested
collection (e.g. `Root → API → Users`), variables are merged walking **root-first**:

```
Root.variables   →  applied first
API.variables    →  overrides Root
Users.variables  →  overrides API  ←  request's direct parent
```

This means a child collection's variable always takes precedence over an ancestor's
variable of the same name.

### 3. Active environment

The environment selected in the variables store (top of the sidebar). Environment
variables override everything else. This is the intended override point for
per-environment values like base URLs and API keys.

---

## Implementation

`useVariableResolver` (`app/src/hooks/useVariableResolver.ts`) collects **every**
definition of every name on every render via `useMemo`, keyed by
`(collectionId, environmentId)`, in precedence order (lowest first):

```typescript
// 1. Globals - a singleton, so no source name
for ([key, val] of globalsData.variables) push(key, val, "global");

// 2. Collection chain - root first so leaf overrides parent. Each collection is
//    its own origin: two in one chain both have scope "collection".
const chain = buildCollectionChain(activeCollectionId, collections); // root-first array
for (const col of chain)
  for ([key, val] of col.variables)
    push(key, val, "collection", { id: col.id, name: col.name });

// 3. Environment - highest priority
for ([key, val] of env.variables)
  push(key, val, "environment", { id: env.id, name: env.name });

// The winner is the last *enabled* definition.
```

`buildCollectionChain(startId, collections)` walks `parentId` links upward and
returns the chain with the root at index 0. It keeps a `seen` set and stops on
a revisit: the engine rejects parent cycles on write (issue #79), so a cycle
means the database already went bad, and the walk runs inside a `useMemo` -
an unterminated one is a frozen window, not a wrong preview.

**Collection scope is explicit only.** It comes from the `collectionId` option
and nothing else; a caller that passes none resolves against globals +
environment. There used to be a session-store fallback (`activeCollectionId`),
but nothing ever wrote that field, so it could only ever hold a value
rehydrated from an old build - scoping a preview to a collection the user had
left, or deleted, versions ago. It was removed in the `vayu.session` v2
migration.

The resolved `Record<string, ResolvedVariable>` is **derived** from that list
(the origin carrying `winner: true`) rather than built beside it, so the two
cannot disagree about which definition won. A name whose every definition is
disabled is absent from the map, not present-and-empty - the red token keys off
absence, so a present-and-empty entry would paint it resolved and send "".

### `getVariableOrigins(name)`

Returns every definition of a name, lowest precedence first, **including the
disabled ones that never resolve**. Empty array for a name nothing defines.

Display-only; nothing about execution reads it. It exists because the winner
alone cannot answer "why is this the value?" - and the two cases that need
answering are exactly the ones a flat map destroys:

- the same name defined at several scopes, where the losers were overwritten;
- a name whose highest-scope definition is **disabled**, which is the more
  common surprise. The old loop skipped those with `if (v.enabled)`, so nothing
  could report that the value you set is being *skipped* rather than missing.

The variable popover renders this as its "also defined" list. `VariableOrigin`
carries `enabled` and an explicit `winner` flag - once disabled definitions are
in the list, "last" and "wins" are different things.

`ResolvedVariable.sourceId` / `sourceName` name the specific environment or
collection the winning value came from (absent for `global`), so the popover can
say *which* environment rather than just "Environment".

**An edit writes back to that source, never to one re-derived.** The context bar
commits against `sourceId`, so the definition that receives the value is the one
the bar displayed. It used to walk the collection chain itself for the first
definition with a truthy `enabled`, which disagrees with the resolver's
`isEnabledDefinition` on every definition where `enabled` is *absent* (D17 counts
absent as enabled) - so a leaf definition without the key displayed while an
ancestor's took the write. Any second implementation of "which definition wins"
can drift from this one; there is only meant to be the one, and `sourceId` is how
it is carried.

### The engine implementation

`engine/src/http/request_composer.cpp` is the execution-time implementation of
this page (`build_variable_values` + `resolve_template`), reached through
`POST /compose`. It has no `getVariableOrigins` analogue - the origins list is
display metadata, and execution has no use for losers. MCP no longer carries a
copy at all: it composes via the engine and its old `resolve.ts` port is
deleted (#226).

The resolved map is then used by `resolveString(input)` (preview) and
`resolve_template` (engine) which replace all `{{name}}` occurrences.

**A name nothing defines keeps its braces** (#1009), plain and `{{$name}}`
alike. The token goes out on the wire, where it becomes a DNS or a `4xx`
failure naming the thing that was never set; it used to resolve to the empty
string, which sent `https://{{host}}/x` as `https:///x` - a different request,
made silently. A definition that *exists* and holds an empty value still
substitutes empty: the rule is about a name nothing answers, not about a blank
answer. There is no way to escape a literal `{{`.

**A value that itself holds `{{tokens}}` resolves through them** (#1009), which
is how `baseUrl = "{{protocol}}://{{host}}"` - the shape most imported
environments are written in - composes as the URL it spells. Two rules bound
the walk, because the values come from a user's environment and nothing there
promises to terminate: a name already being expanded is a **cycle** and its
token is left written as it stands (`a = "{{b}}"` with `b = "{{a}}"` resolves
to the literal `{{a}}`), and expansion stops after **8 levels**, keeping what
it resolved and leaving the rest literal. Text that a substitution did *not*
put there is never rescanned, and a value holding no `{{` costs one search - so
everything composition can answer resolves in a single pass, at compose time.

A name composition could not answer keeps its braces (#1009's rule above) and
gets one more chance: `vayu::http::routes::resolve_residual_tokens` (#1008)
runs the *same* resolver again, after the pre-request script and before the
send, against the scopes as the script left them - so a token only the script
can answer (a freshly fetched auth token, typically) still reaches the wire.
It reads the request, not composition's decisions, so a value composition
already substituted is not touched a second time, and it costs nothing on the
ordinary request that has nothing left to resolve. The previews on this page
are unaffected, because they mirror `POST /compose`: a preview can show
`{{token}}` where the wire will carry the value the script set. See
[pm API compatibility](./pm-api-compatibility.md) for what that changes for a
script.

### One value composition refuses: a header a variable would forge (#738)

Substitution is textual everywhere, which is exactly right for a URL, a body and
a form field - and wrong for one field, because a header line ends at CRLF and
has no escape for it. A variable holding `ok\r\nX-Admin: true` written into
`X-Note: {{note}}` would not put that text in `X-Note`: it would end the line
and make `X-Admin: true` a header nobody wrote.

So a header is the one place `POST /compose` rejects a payload over a *value*
rather than over its shape: a `400` with code `unsendable_header`, whose message
names the variable - composition is the last layer that still knows which one
carried the byte. A NUL is refused with it, because the engine hands the header
line to `curl_slist_append`, which reads to the first NUL and would send the
rest of it missing.

Refusal rather than repair, for the same reason a `-->` in an XML comment is
refused: there is no encoding for a line break in a header, so stripping the
bytes would send a header holding something the author did not write. The rule
is scoped to the field, not to the value - the same variable resolves unchanged
into a URL, a body and a form field's value.

Composition is one of three layers holding the same rule, one definition
(`engine/include/vayu/http/header_text.hpp`): a bound `{{data.column}}` is
refused earlier, at bind time, naming the column and the row
([data-driven runs](./data-driven-runs.md)); everything else - a script
assigning to `pm.request.headers`, an auth credential, an import, a payload
posted straight to `POST /execute` - is refused before the transfer starts,
naming the header instead of a variable.

### The other one: a header a variable would erase (#1051)

A header *name* is substituted like anything else, and the map it lands in holds
one value per name. So two names that resolve alike do not both go out:
`{{tenant_header}}: acme` beside a literal `X-Tenant: legacy` is one header once
the variable answers `X-Tenant`, and the other is gone. Names are compared
without case, so a `{{h}}` resolving to `authorization` takes the place of an
`Authorization` typed beside it.

That is the same quiet wrong request as the one above with the fault reversed -
there a value forges a header, here a name erases one - so it gets the same
answer: a `400` with code `colliding_header_names`, naming both spellings as
written and the name they produced. Repair is not on offer for the reason it is
not offered above: the two names are equally the author's, so choosing one is
inventing an intention, and "whichever the map reached last" is an
implementation detail rather than a rule.

**Only a collision resolution made is refused.** Two names typed into one
request are two lines visible side by side, and the later one has always won;
what this refuses is the collision that is invisible until the request comes
back wrong. The distinction is the one [data-driven
runs](./data-driven-runs.md) already draw for a bound row.

The rule has three layers too, one definition
(`engine/include/vayu/http/header_names.hpp`): the bind-time one naming the
column and the row, composition's `400`, and the execute-time residual pass -
which rebuilds the same map after a pre-request script has run, and so can meet
a collision composition never saw. It refuses in the same words, as a failed
send rather than a rejected payload. The pre-send gate is deliberately *not* the
backstop here, and cannot be: by the time it sees a request the erased header is
already missing, with nothing left to notice.

---

## Dynamic variables

A name starting with `$` is not looked up in any scope. It names a **generator**
in `app/src/lib/dynamic-variables.ts`, called where it is written:

| Name | Value |
|---|---|
| `$guid`, `$randomUUID` | UUID v4 |
| `$timestamp` | Unix time in seconds |
| `$isoTimestamp` | ISO 8601 UTC timestamp |
| `$randomInt` | integer 0 - 1000 |
| `$randomAlphaNumeric` | one alphanumeric character |
| `$randomBoolean` | `"true"` or `"false"` |
| `$randomEmail` | email address |
| `$randomFirstName`, `$randomLastName`, `$randomFullName` | person name |
| `$randomCompanyName` | company name |
| `$randomUrl` | absolute `https://` URL |
| `$randomIP` | IPv4 address |
| `$randomPassword` | 15-character password |
| `$randomPhoneNumber` | ten-digit phone number, `700-008-5275` |
| `$randomCity` | city name |
| `$randomStreetAddress` | street address, `5742 Harvey Streets` |
| `$randomCountry` | country name |
| `$randomCountryCode` | ISO 3166-1 alpha-2 country code |
| `$randomDatePast`, `$randomDateFuture`, `$randomDateRecent` | datetime in the past year, the next year, the past week |
| `$randomWord`, `$randomWords` | one word, three to five words |
| `$randomLoremWord`, `$randomLoremWords` | one lorem ipsum word, three of them |
| `$randomLoremSentence`, `$randomLoremSentences` | one lorem ipsum sentence, two to six |
| `$randomLoremParagraph` | a lorem ipsum paragraph |
| `$randomColor` | color name |
| `$randomHexColor` | hex color, `#47594a` |
| `$randomUserAgent` | browser user-agent string |
| `$randomDomainName` | domain under a reserved example domain |
| `$randomAbbreviation` | abbreviation, `SQL` |
| `$randomPrice` | price 0.00 - 1000.00 |
| `$randomCurrencyCode` | ISO 4217 currency code |
| `$randomProductName` | product name |
| `$randomJobTitle` | job title |

They resolve anywhere `{{name}}` does - URL, headers, body, form fields - and the
`{{` autocomplete offers them under a **Dynamic** heading in both the plain
fields and the body editors.

The three date generators write what JavaScript's `Date.prototype.toString`
writes, which is the shape Postman documents them in, and always in UTC:
`Sat Mar 02 2019 09:09:26 GMT+0000 (Coordinated Universal Time)`. The engine has
no user's zone to read, and the two sides have to spell the same string.

`$randomDomainName` draws from the reserved example space (RFC 2606) rather than
Postman's live-looking `gracie.biz`, as `$randomUrl` and `$randomEmail` already
do: a generated hostname reaches DNS the moment someone writes it into a URL.

Three rules decide what happens at a token:

1. **Scopes win.** A workspace that defines a variable literally named `$guid`
   keeps that value; only a name nothing defines reaches a generator. So adding
   this table cannot change what an existing request sends.
2. **One value per occurrence.** Two `{{$guid}}` in one body are two different
   ids, which is the reason to write them. The table holds functions, not
   precomputed values. The two reserved identity names above are the deliberate
   exception and are not in this table: two `{{$iteration}}` in one request are
   one iteration, because they name a fact about the send rather than generate a
   value for it.
3. **An unknown `$name` keeps its braces.** `{{$randomInteger}}` (not a name
   Vayu has) is sent as that literal text rather than resolving to `""`. The `$`
   is a declaration of intent, and a typo that silently emptied a field is the
   defect this feature was added to fix - so it is left where it can be seen, and
   the token stays marked unresolved in the UI.

### The Postman generators Vayu deliberately does not carry

Postman ships around 120 dynamic variables. The table above is the tier imported
collections actually use; everything outside it keeps its braces by rule 3 rather
than resolving to something invented. The categories deliberately left out,
wholesale: finance (`$randomBankAccount`, `$randomCreditCardMask`, IBAN and BIC),
images (`$randomImageUrl` and its per-category siblings), files and directories
(`$randomFileName`, `$randomMimeType`, `$randomFileExt`), databases
(`$randomDatabaseColumn`, `$randomDatabaseType`), catchphrases and business
buzz-phrases, stores and products beyond `$randomProductName`, grammar
(`$randomNoun`, `$randomVerb`, `$randomAdjective`), and the remaining
name/profession/location detail (`$randomNamePrefix`, `$randomJobArea`,
`$randomLatitude`, `$randomLongitude`). A collection using one of those sends the
literal `{{$randomBankAccount}}`, visibly, rather than a plausible wrong value.

`$randomRgbColor` is on neither list because Postman does not ship it - only
`$randomColor` and `$randomHexColor` are documented.

### What this does not cover

**Script text.** A `{{…}}` written directly in script *code* does not resolve
and never will - it is user JavaScript, and rewriting it could not tell a
string literal from code (#226, D16). What a script uses instead is
**`pm.variables.replaceIn("{{$guid}}")`**: the same engine resolver, run at
call time over a string the script opts in - dynamic variables included, one
value per occurrence. `pm.variables.get("$guid")` (getter fall-through to the
generators) is deliberately not wired. See
[pm API compatibility](./pm-api-compatibility.md).

**Load runs generate once, not per iteration.** A run's request half is
composed once (`POST /compose`) and then handed to the engine, which repeats
it - so every request in the run carries the *same* `{{$guid}}`. The load-test
dialog says so when the request contains one. Per-iteration values would mean
interpolating on the load generator's hot path (which targets 60k+ RPS), and
were deliberately kept out of #226's scope.

That still holds for this table. It does **not** hold for the two reserved
identity names (issue #994), and the difference is what makes them cheap enough
to be the exception: a generator has to run per occurrence per iteration, while
`{{$vu}}` and `{{$iteration}}` substitute two integers the executor is already
holding, into fields a compose-time scan has already located. A request that
spells neither is walked for neither - the template is empty, and the executor
tests that before doing anything - so the freeze above is lifted for exactly two
names and for nothing else. `{{$guid}}` per iteration on the load path is #995,
and is a different measurement.

### The engine copy of the table

`engine/src/http/request_composer.cpp` carries the C++ generator table that
actually executes; the renderer's `lib/dynamic-variables.ts` drives
autocomplete and preview. **The two must list the same names**: the
conformance fixture pins the name set, and both suites compare their table
against it, so a name added to one side fails the other side's suite. (MCP's
`dynamic-variables.ts` copy is deleted - MCP composes via the engine.)

`$vu` and `$iteration` are deliberately in neither table - they generate
nothing, and a renderer entry that produced a value would make the preview show
a number the engine will not send. They are reserved names on both sides
instead, and the fixture pins that too: a case asserts each stays written as it
stands, and another that a variable of the same name does not answer for it.

---

## Auth inheritance

When a request's auth mode is `"inherit"`, Vayu walks the collection ancestor chain
**leaf-first** (most specific wins) and uses the first collection that defines auth.
The walk that decides what is *sent* lives in the engine
(`request_composer.cpp::resolve_inherited_auth`, reached via `POST /compose`);
the renderer keeps `resolveAuthSource`
(`modules/request-builder/utils/auth-resolution.ts`) for the UI that *explains*
inheritance (`InheritanceChain`, `AuthInheritBanner`, the load dialog's OAuth
guard) - the two must agree on this walk:

```
Users auth  →  checked first  (leaf, most specific)
API auth    →  checked second
Root auth   →  checked last   (root, least specific)
```

Two collection modes mean "no credentials here" and the walk treats them
differently:

| Collection `auth.mode` | Meaning | Effect on the walk |
|---|---|---|
| `none` | nothing configured at this level | stepped over - keep climbing |
| `noauth` | configured to send nothing | **stops the walk** - the request sends no auth |

`noauth` exists because Postman's folder-level *No Auth* terminates inheritance,
and collapsing it into `none` meant an imported No Auth folder's requests silently
regained the parent collection's credentials. A collection *below* a `noauth` one
may still define its own auth - termination is about what is inherited, not a lock
on the subtree. Engine gtest (`request_composer_test.cpp`) covers the
terminator; an unresolved `inherit` that somehow reaches `POST /execute`
directly is treated as no auth and logged as a warning.

If no ancestor defines auth the request executes without auth.

Auth variable placeholders (e.g. `{{bearer_token}}`) are resolved through the
same variable map inside the winning block at compose time - deliberately
**before** any OAuth 2.0 token cache key is derived from the config, so two
environments whose configs differ only through `{{vars}}` never share a token.

---

## Script composition

Pre-request and post-request scripts run as one script assembled from the
collection chain plus the request's own, in order **root → leaf → request**:

```
Root.preRequestScript
API.preRequestScript
Users.preRequestScript
request.preRequestScript    ←  runs last
```

This lets a parent collection set up shared variables or auth tokens that child
requests and their own scripts can rely on.

The app builds the ordered list of script parts (empty or whitespace-only
scripts are dropped); the **engine** joins the surviving parts with a blank
line and runs the result. See `docs/engine/architecture.md` → *Request
composition boundary* for the wire shape.

### Reading a variable from a script

A script does not see `{{name}}` - those are resolved at compose time,
strictly **before** any script runs, and that includes the dynamic variables
above: `pm.variables.get("$guid")` is not a thing Vayu supports. Composition
still runs first and still owns resolution (#226, decision D1 stands) - but
since #1008, a name composition could not answer is resolved a second time
after the pre-request script and before the send, against the scopes as the
script left them. That works because of #1009: an unknown name keeps its
braces at compose time instead of becoming `""`, so it survives to be resolved
later. So the canonical pattern now works: `pm.environment.set("token", …)` in
a pre-request script **does** reach `Bearer {{token}}` in the same send, as
long as nothing answered `{{token}}` at compose time - a value composition
already substituted is finished text, and this second pass does not touch it.
A script that must change a value composition already resolved still edits
`pm.request` directly (the write-back is applied to the outgoing request).

A script reads a scope by name (`pm.environment.get`,
`pm.collectionVariables.get`, `pm.globals.get`) or reads across all three with
`pm.variables.get`, which walks **environment → collection → global** and stops
at the first scope that has the name enabled - this page's priority order, read
from the top down. While a row is bound, `pm.variables.get` (and `.has` and
`.toObject`) checks that row's bare column names **first**, above all three
scopes - the same D18 tier the ladder above adds, reached from a script. See
[scripting.md](../engine/scripting.md#variables-pmvariables) and
[pm API compatibility](./pm-api-compatibility.md) for the details.

The collection scope a script reads is the **whole chain**, the same one
`{{name}}` merges (issue #234; `load_script_variable_scopes` in
`execution.cpp` builds it from `collection_chain`). A variable defined on an
ancestor collection therefore reads the same in `pm.collectionVariables.get`,
`pm.variables.get` and `pm.variables.replaceIn("{{name}}")` as it substitutes
in the URL.

**Reads walk the chain; writes stay on the leaf.** `set`, `unset` and `clear`
only ever touch the request's own collection - the one
`persist_script_variables` writes back. So the rule for an inherited name is
CSS-like:

- `pm.collectionVariables.set("token", x)` on a descendant **shadows** the
  ancestor's `token`; the ancestor's stored value is untouched.
- `pm.collectionVariables.unset("token")` removes the descendant's copy, and
  `get("token")` then finds the ancestor's value again.
- `pm.collectionVariables.clear()` empties the request's own collection only.

Inheritance can be shadowed from below, never deleted from below. That
asymmetry is the point rather than an oversight: #226 (decision D2) originally
kept the whole chain out of scripts precisely because a single merged,
writable map would have let one `set()` copy every ancestor's variables down
into the leaf collection on the next persist. Read-only ancestors make that
impossible while still answering the read. A disabled row is looked past
wherever it sits, so unticking an inherited name in a descendant falls through
to the ancestor's value rather than hiding it. See
[pm API compatibility](./pm-api-compatibility.md) and
[scripting.md](../engine/scripting.md#variables-pmvariables).

#### Autocomplete inside the accessors

The script editors complete variable **names** inside the string argument of a
`pm.*` accessor - `pm.environment.get("…")`, and the `set` / `has` / `unset`
spellings beside it (`useScriptVariableCompletionProvider`). The `{{name}}`
list is deliberately *not* registered for `javascript`: braces are not the
syntax in a script, so offering them there would teach the wrong thing. The
names are the same names; only the place you type them differs.

Three rules make the offered set match what the call can actually read:

- **The accessor picks the scope.** `pm.environment.get` lists environment
  variables only, because that is the one scope it reads - a collection
  variable offered there would be a name that returns `undefined`. Only the
  merged `pm.variables.get` lists all three, and it alone also lists the
  declared columns (below), because it alone reads both.
- **Collection variables come from the active tab.** Collection scope is
  explicit-only (see *Collection scope is explicit only* above) and a Monaco
  completion provider is registered once per *language*, not per editor, so it
  has no request builder context to take a `collectionId` from. Both providers
  get one from `useActiveCollectionId` instead - the active tab's request's
  collection, or a collection tab itself - so the list is globals + the
  collection chain + the active environment, the same set every other surface
  offers.
- **The script list carries the same chain.** The engine walks the collection
  chain for scripts too (#234), so an ancestor's variable is offered inside
  `pm.collectionVariables.get()` and the merged `pm.variables.get()` - it is a
  name the call can read. This list narrowed to the immediate collection while
  the engine did; the rule underneath is unchanged, which is that the list
  offers exactly what the call resolves.
- **`pm.iterationData` completes columns, not variables.** The row it reads is
  bound from the collection's data file, so the names offered inside
  `pm.iterationData.get("…")` and `.has("…")` are the declared columns of the
  contract in scope (issue #600) - the same list the `{{data.*}}` tokens are
  painted against, so an editor and the builder cannot disagree. Optional
  chaining counts as the dot it is (`pm.iterationData?.get("`), because the
  surface is `undefined` outside a data-driven run or a send-with-row, and its own documentation
  tells scripts to guard before calling. Nothing is offered when the chain
  declares no contract.
- **`pm.variables` completes both, because it reads both.** A bound row answers
  bare column names through the merged accessor, above every scope (issue
  #1007), so the declared columns are blended into its list beside the
  variables (issue #1063) - as bare names inside `get("…")` / `has("…")`, and
  as `{{column}}` tokens inside `replaceIn`, which resolves them from the same
  row. They carry the field icon and name their declaring collection, so a
  column is distinguishable from a variable at a glance, and a name that is
  both is offered twice on purpose: the row wins while one is bound and the
  scope answers when none is. The single-scope accessors never see the row, so
  no column is offered there. The prefixed `{{data.column}}` spelling is not in
  this list: `pm.variables.get` does not read it at all, and it is completed
  where its own accessor is.
- **Generators belong to `replaceIn` alone.** `pm.variables.replaceIn` takes a
  template and interpolates it, so it gets brace-style completion including
  `{{$guid}}`; `pm.variables.get("$guid")` is not a lookup that resolves, so no
  generator is offered there.

The dotted `pm.*` completions (served by the engine, see
[the scripting docs](../engine/scripting.md)) yield inside a string literal so
the two lists never appear together.

---

## Scope labels

`ResolvedVariable.scope` is a display hint used by the variable inspector:

| Value         | Meaning                        |
|---------------|--------------------------------|
| `"global"`    | Came from globals              |
| `"collection"`| Came from any collection layer |
| `"environment"`| Came from the active environment |
