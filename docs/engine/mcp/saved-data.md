---
description: >-
  Notes on the MCP tools that change saved data - engine config, collections, requests, examples, environments, variables, cookies and data files.
---

# MCP writes to saved data

- **`update_engine_config`** reads the config back after applying and flags any changed key that needs an engine **restart** to take effect under `restartRequired` in its structured result (read from each entry's typed `requiresRestart` field, not from its label).
  Such values are saved, but the running engine keeps the old value until it is restarted, so the tool says so in its text output too.
- **The collection / request write verbs** are the CRUD an agent needs to work unattended: `create_collection` gives it a `collectionId` to file new requests under, and `update_request` / `delete_request` let it correct or remove a request it got wrong instead of leaving the cleanup to a human.
  The two updates are **merge-patches** - the tool sends only the fields the caller named, and `PUT /collections/:id` / `PUT /requests/:id` keep everything else stored, so a patch naming just `name` cannot blank a url, an auth block or a script.
  A patch naming nothing is refused rather than sent as a write that changes nothing, and `bodyType` without `body` is refused too (the blob and its denormalized column move together or the two disagree about what the request sends).
  `update_collection` carries a collection's own state - name, description, variables, auth, both scripts - and never its position: re-parenting is `move_item`'s job (below), because a move is a batch.
  The destination's siblings renumber with it, and `POST /reorder` is the write path that commits the whole batch or none of it; a `PUT` writes one row.
- **`delete_collection` cascades**, so it reads the subtree first: `GET /collections` gives it every descendant through `parentId`, one `GET /requests?collectionId=` per collection in that subtree gives the request count, and those counts are what the confirmation states.
  An unreadable subtree - or an id no collection has - is a refusal, never a prompt carrying a number nobody verified.
  `delete_request` reads the row the same way, so the prompt names the request and its URL rather than an opaque id.
- **The Trash tools (issue #1071) close the loop those two deletes open**, and the one `delete_environment` opens since #2970 and the one `delete_request_example` opens for a saved example since #2971.
  A client certificate joins them in #2973 although no tool deletes one (the user removes it in Settings): its entry is `kind: "clientCertificate"`, named by its target, a root with `parentId` null and both counts 0.
  `list_trash` answers a page of `GET /trash` (#2443), each entry unchanged -
  roots only, with `collections` / `requests` counting what each entry's delete took (what a restore puts back) and `purgeCollections` / `purgeRequests` counting what a purge would destroy under it (#3449),
  an environment entry carrying `variables`, an example entry carrying its request as `parentId`, and a request or example entry carrying its owner's name as `parentName`, exactly as the route documents.
  `restore_trash_entry` is the one write tool here that is **not** destructive - it puts a row back rather than removing one - so it carries the write toggle alone, with no confirmation step;
  it surfaces the engine's own 404/409 text verbatim instead of writing a second sentence that could disagree with it, and reports `reparentedToRoot` in its result text when a restored collection came back at the top level because its parent is gone or itself in the trash; a restored environment comes back inactive, and `activate_environment` is what makes it the active one again.
  A request or saved example whose owner is in the trash is refused with the engine's 409 text, which names the item and the Trash entry to restore first by name and id (#3449); so is an example whose request is gone or already holds the 100 examples a request may, and so is a client certificate while a live entry holds the same host and port.
  `purge_trash_entry` is the Trash's own hard delete and is gated exactly like `delete_collection`:
  it reads the entry off `GET /trash` first,
  so the confirmation prompt names what a mistyped id would otherwise destroy sight unseen (a collection's sub-collections and requests, counted by the purge totals so an earlier delete's rows under it are included, #3449; an environment's variable count; a saved request's or example's name and the collection or request it came from; a client certificate's registry entry and stored passphrase with its files untouched), and an entry the trash does not hold -
  or one of a kind this build does not know - is a refusal before any prompt is shown.
  Both name the entry with `entryId`, not a bare `id` (#2446: an `id` beside `requestId` / `runId` / `environmentId` reads as "the id of something else").
  A call that sends only `id` is refused with `"entryId" is required.` (the alias was retired in #2962).
- **A saved request an agent writes is the one the builder writes** (issues #759, #795).
  `create_request` / `update_request` carry the request's `auth` block and the eight **Settings** tab fields (`followRedirects`, `maxRedirects`, `timeout`, `httpVersion`, `stream`, `streamTextPath`, `streamFirstContentMarker`, `verifySSL`) as well as its url, headers, body and both scripts, so an agent that can send an authenticated request can now save one.
  The `auth` input is the *same schema* `run_request` takes rather than a copy of it - one definition, four descriptions - which is what lets an agent read a request's `auth` over `get_request` (or `list_requests` with `fields: "full"`) and write it back verbatim.
  Its `mode` is a closed set (`bearer`, `basic`, `apikey`, `oauth2`, `inherit`, `none`, `noauth`): the engine sends a request with an unknown mode and no auth at all, so a misspelling (`Bearer`, `api-key`) or a mode Vayu does not execute (`digest`, `aws`, `ntlm`, `hawk`, `oauth1`, `edgegrid`, `jwt`) is refused at the schema, with a message saying which, and omitting `auth` keeps what is stored.
  An `apikey` block places the key with `in` (`header`, the default, or `query`); a Postman-style `addTo` is refused rather than read as a header (#2477).
  Both the auth block and each setting follow the merge-patch rule the strings already did: named is written, absent is left alone, so an update that mentions only `maxRedirects` cannot hand a stored `followRedirects: false` back to the engine's default.
  `timeout` (issue #2937; milliseconds, `1`-`86400000`, checked at the schema as the engine checks it) has one more state than the others: `null` on `update_request` resets it to "no timeout of its own", so the request sends with the `defaultTimeout` setting again, where an absent key keeps the stored value; `create_request` takes it absent or `null` for none.
  `streamTextPath` (#3773) and `streamFirstContentMarker` (#3774) are the same shape: `null` on `update_request` clears either, and the engine refuses one on a request that does not stream.
  The marker is a literal of 1-256 bytes that a load run times each stream to (`stream.timeToFirstMatch`); `start_load_run` forwards the saved request's beside `stream: true` and drops it when `stream: false` is passed, and `run_request` times nothing with it.
  For `verifySSL` that rule is a *security* rule rather than a convenience: a defaulted `true` on an unrelated update would silently re-enable a certificate check the user turned off.
  The one exclusion left is deliberate: **file body parts**, which name a path on the user's machine an agent cannot choose for them.
  `update_request` also carries `mockResponseMode` / `mockExampleId` (issue #481 phase 3), the same setting the Examples tab's mode picker writes:
  `fixed` is refused before the engine is called when it names no `mockExampleId`, exactly like the bodyType-without-body refusal above, and the change only takes effect the next time `start_mock_server` runs - a running mock's route table is a snapshot, not a live view of the request.
  Deleting the example it names (`delete_request_example`, or the Examples tab) clears `mockExampleId` engine-side (issue #3422).
  One that stops resolving another way is not refused retroactively; the mock server falls back to `"first"` at serve time, same as a `fixed` mode pointed at an example that never existed.
- **A skipped certificate check has to leave a record** (issue #795).
  The *stored* `verifySSL: false` is writable over MCP; a *per-call* one is not.
  `run_request` declares `verifySSL` only so that `false` is refused by name - the refusal points at the two supported routes, adding the internal authority under **Vayu Settings > Network & connectivity** (verification stays on) or saving the request with `verifySSL: false` and running that.
  `start_load_run`, `run_collection` and `run_collection_smoke` take no such argument at all; they compose saved requests, so the stored field is what they honour.
  The difference is what survives the call: a stored value is a document the app's Settings tab shows unticked with a warning under it, `get_request` reads back and the user can undo, while an argument on one send is visible only inside the agent's own transcript.
  The `allowInsecureTls` safety toggle #795 sketched was rejected for the same reason it would have been convenient - it is a global permission, granted once for one dev host and then in force for every allowlisted host, where the stored field is per request.
- **Examples are writable, and where one came from is not** (issue #759).
  `list_request_examples` reads what a request has saved beside it - what a mock server for its collection answers with - and the three write tools author it, so an agent that can start a mock (`start_mock_server`) can now author what it serves.
  The `origin` column is the one field no tool accepts: it says whether a row came from an importer (`import`) or from a person (`user`), and an OpenAPI sync replaces the first kind while leaving the second alone (#588, #655).
  An agent that could claim `import` would hand its own example to the next sync to overwrite, and one that could claim `user` could pin a stale imported row against the document it came from - neither is the agent's call, so `create_request_example` always stores `user` and the update tool cannot restate it.
  **`headers` on the two write tools is an ordered array of `{key, value, enabled?}` rows or a string map** (#3422).
  An example is a stored list and a captured response can repeat a name - several `Set-Cookie` lines are several rows - which a map cannot hold, so the rows are forwarded in order, a repeated key kept and `enabled` defaulting to true; the map is the short spelling, one value per name.
  A row that is not an object with a string `key` and a string `value` is refused by its position, unless it is a row as read with `valueWithheld: true` and no `value`, which keeps the stored value (#3550; see Secret values).
  A row may also carry the members a stored row has beside those, each a string:
  `description`, `type` (a Postman import's) and `source` (`body-mode` on the Content-Type row the app's Body panel or an importer wrote, `legacy-default` on a row the engine's repair pass disabled), forwarded as given, a kept row's included - a row written back without its `source` is no longer the app's own, so rows go back as read.
  Any other member is refused by name.
  Update replaces the whole list.
  The rows are `{key, value}`, unlike `run_request`'s `{name, value}` lines, because they are the rows the engine stores and `list_request_examples` returns, not a request in flight.
  Bodies are bounded on the way out for the reason `get_run_report`'s traces are (#767, #769): an example body is capped engine-side at 1 MB and a request may hold 100 of them.
  One over 32 KB comes back cut, flagged `bodyClipped` with its stored size in `bodyBytes`; once the list has spent 96 KB the remaining bodies are dropped with `bodyOmitted` and counted in `bodiesOmitted`, every row's scalars kept.
  `bodyClipped` is not the engine's `bodyTruncated`, which says the response was already cut when it was *captured* - two different facts, so two different names.
  **`delete_request_example` says what the delete leads to by `origin`** (#2971): a `user` example goes to the Trash, so its description, preview and prompt name `list_trash` and `restore_trash_entry`; an imported one is a spec-sync tombstone with no restore, and a row that states no origin is worded as an imported one, so the prompt never promises a restore the engine would not keep.
  The tool still confirms in both cases.
- **Collection-level state is writable, and merges the way an environment's does** (issue #759).
  `create_collection` / `update_collection` take the `variables`, `auth` and `elements` that shape every request below them - the same list the composer walks (`compose_elements` runs the chain's elements before the request's own, issue #1514).
  `preRequestScript` / `postRequestScript` stay as sugar on these two tools (issue #1517): a non-empty string folds into a `script.pre` / `script.post` entry and an empty one removes it - never sent to the engine under those two names, which `POST /collections` / `PUT /collections/:id` refuse outright now that `elements` is the only script source.
  `variables` uses `update_environment`'s input and its rules unchanged, including `removeVariables` and the "a new variable carries a value" refusal, because it is the same blob shape and a second dialect would be a second thing to learn.
  The read that makes each a merge is only done when it is needed: variables actually changing, or a script argument with no explicit `elements` (which needs the stored list to fold the sugar into without dropping the collection's other elements) - passing `elements` directly, like a plain rename, sends one `PUT` and nothing else.
  A collection never inherits auth (#3445): both tools' `auth` schema omits `inherit` and refuses it as an input error naming the modes that are accepted, and the engine refuses it too (`400`), so `{mode: "none"}` is how a collection stops being an auth source.
  `run_request`, `start_load_run` and the request tools keep `inherit`.
- **`move_item` is a bounded move, not a reorder** (issue #759).
  It maps to `POST /reorder`, whose batch validates and commits under one acquisition of the engine's DB mutex (#386) - which is why re-parenting goes here rather than through `PUT /collections/:id`'s own `parentId`.
  That `PUT` holds its own read to its write since #1440, so two concurrent moves no longer each pass an acyclicity check neither one's commit was visible to; what one row at a time still cannot do is refuse the pair together - the first move is committed by the time the second is rejected - or renumber the destination's siblings in the same write.
  What the tool offers is the row menu's "Move to…" (the moved row is `itemId`): a destination, and `first` or `last` among its new siblings.
  Positions in between stay a UI gesture on purpose - naming one means reproducing the app's ordering arithmetic (`modules/collections/reorder-math.ts`) from outside it, and getting it wrong is a folder that visibly reshuffles.
  The siblings are the destination's sub-collections **and** its requests, one `order` space (#2535, [Ordering](../api-reference.md#ordering)): the tool reads both lists and merges them with the sibling comparator (`tools/sibling-order.ts`, pinned to the engine's and the renderer's by `tree-order-conformance.json`), so `last` lands past every child of either kind and `first` ahead of them all.
  The batch states that list's whole arrangement, each row under its own `type`, rather than leaning on the engine's `normalize` pass, because normalization runs *before* the moves and would leave a row moved to the end of a list it is already in tied with the sibling it displaced; only the rows whose stored `order` actually changes get an entry.
  A collection may move to the top level (`parentId: null`) and a request always belongs to a collection.
  Moving a collection into itself or into its own subtree is refused here, walking the same tree the app's "Move to…" dialog walks, so the answer names the problem - the engine refuses the same batch under its lock, and that check stays the authority.
  A request that records a bound document's operation and lands, alone or under a moved collection, outside that binding's contract (another document, none, or a sibling collection bound to the same document),
  comes back with `specOperation: null`, and the operation is declined at the binding it left (#3446, as `delete_request` declines it), so that collection's next `sync_spec` does not create it again.
- **`update_environment`** fetches the environment and merges the supplied variables (`PUT /environments/:id` replaces the whole variables blob), so partial updates preserve untouched variables and the name.
  **The write is conditioned on the version it read** (#2433): the `PUT` carries `If-Match: W/"<updatedAt>"` from the row the list answered, so a change the app or another client made in between is a `412` rather than a silent loss.
  On a `412` the tool reads the row again, merges the same arguments onto it and writes once more; a second `412` is answered as a `transient` error saying nothing was written, and repeating the call merges into the latest version.
  `update_collection` does the same whenever it reads (a variables or script edit); a call naming only stated fields reads nothing and sends no `If-Match`.
  `update_request` does the same whenever it reads (a script edit, a header row written back withheld, or a `url` or `headers` while secrets are withheld, #3549, #3550), and so does `update_request_example` (a header row written back withheld, or `headers` while secrets are withheld, #3550).
  Overwriting an existing variable changes its value only - its `secret`, `type`, `createdAt` and enabled/disabled state are preserved, so a rotated secret stays masked and a disabled variable stays disabled.
  The answer is the stored row, withheld as `list_environments` withholds it.
  It is a `PUT`, not a `POST`: since #95 the engine's `POST /environments` is create-only, and since #97 it rejects a body carrying an `id` outright.
  `create_request` and `create_environment` stay `POST`s for the same reason - they create, and let the engine assign the id.
  No tool here sends an `id` in a body: on the `PUT` the path is the identity, a body `id` disagreeing with it is a `400`, and on the `POST` any `id` at all is one.
- **The variables an agent writes are the flags it did not state** (issue #758).
  `update_environment` and `update_globals` take each variable either as a string - set the value, keep every flag -
  or as an object `{value, secret, type, enabled, description}` whose *omitted* fields keep their stored setting (an entry as read also carries `valueWithheld` and `createdAt`, accepted and kept as stored, #3556), which is what makes `secret` and `enabled` reachable at all without a read-modify-write dance on the agent's side.
  Two rules make that safe rather than merely convenient: a variable the blob does not already hold (or holds malformed) must carry a `value`, so `{secret: true}` against a mistyped name is an error instead of a new empty secret variable;
  and a name in both `variables` and `removeVariables` is refused, because "set it and delete it" has no correct order and guessing one would apply half the call and report success.
  `removeVariables` is the delete a blank value cannot express - `""` leaves the name resolving to an empty string - and a name that was not there comes back as a note on the result rather than an error, so a retried call does not fail on its own success.
  A blank or whitespace-padded name in `variables` is refused by the engine with a `400` naming the key (#3251); a legacy such key already stored is removed with `removeVariables`, spelled exactly as stored, and until it is every write that merges the blob fails on it.
  `secret` masks the value in the app and withholds it from every MCP read, write answer and run output unless the user enables reveal (see [Secret values](secrets.md#secret-values)).
  Clearing it with `secret: false` is refused while reveal is off, since the next read would return the value; `secret: true` is always accepted.
- **Activation is one write, and `"none"` is the other direction.**
  `activate_environment` sends `isActive: true` and nothing else: the DB layer clears the previously active row in the same transaction (`deactivate_other_environments_locked`), so a companion deactivate would be a second definition of the same rule.
  There is no "no environment" row to write `true` to, so `"none"` reads the list to find the row holding the flag and writes `isActive: false` to it - and when nothing is active it writes nothing, says so, and emits no data-changed event.
  The app follows either direction: `useActiveEnvironmentRestore` adopts whatever the engine reports, including a clear it has seen the engine hold a selection before.
- **`update_globals` has to read first.**
  Globals is the one resource with no create/update split - one row, one id - so `POST /globals` saves the blob whole and an absent `variables` means `{}`, not "keep".
  The tool reads `GET /globals` and posts the merged result under the version it read (`If-Match: W/"<updatedAt>"`, #2988), the conditioned read-merge-write `update_environment` does for the same blob-replacement reason, with the same one re-read on a `412` and the same `transient` answer on a second.
  An engine that never saved any globals answers `updatedAt: 0`, and `W/"0"` is a version like any other, so a first save is conditioned too.
- **`clear_cookies` has three scopes, not two.**
  Omitting `environmentId` clears every jar, passing an id clears that environment's, and passing `null` clears the jar used when no environment is selected - the engine reads an absent query parameter and a present-but-empty one differently, so omitting and passing null are genuinely different calls (the renderer's `apiService.clearCookies` sends the same three).
  No confirmation gate: nothing saved is lost, only session state a re-login restores - which is why it is a `write` tool for the toggle and not one of the confirm-gated deletes.

### Variables

The resolution order is stated once rather than reworded per tool: **globals < collection chain (root to leaf) < active environment**, with a bound data row's bare column names above all three.
That is the ladder [Variable Resolution](../../app/variable-resolution.md) defines and the engine executes; before issue #1207 it lived only inside two tool descriptions that happened to mention it, and nowhere a caller about to write a value could ask for it directly.

The model itself is served once, as a resource (`vayu://variables/resolution`, backed by `variable-origins.ts`'s `VARIABLE_RESOLUTION_MODEL`), rather than restated per tool.
Every variable-writing or -listing tool - `get_globals`, `update_globals`, `list_environments`, `create_environment`, `update_environment`, `create_collection`, `update_collection` - carries one shared sentence (`VARIABLE_PRECEDENCE_SENTENCE`) plus that tier's own position in the order and a pointer to the resource; `precedenceNote()` builds both pieces from one place.
The sentence is shorter than the budget guard's repetition limit on purpose (see [The size of `tools/list` is budgeted](internals.md#the-size-of-toolslist-is-budgeted)): it is the one rule restated in every one of those tools.
A table-driven scan in `tools/variables.tools.test.ts` runs over every variable tool's description and fails on one that omits the sentence, so a new variable tool cannot ship silent about where its tier sits.
A client that cannot read resources still gets the rules: the server instructions carry the sentence and the model's `rules`, read from `VARIABLE_RESOLUTION_MODEL` rather than copied, so the pointer in each description is not the only way to them (#3559).
No tool serves the model; it is a fixed rule set, not engine data.

**`resolve_variables`** answers what the per-tier reads cannot: which definition of a name actually wins in a given collection/environment context, and everything it beat.
It reports the winning value with its scope and source, then every other definition highest-precedence-first, each labelled `outranked` (a higher-ranked definition - a later link in the chain, or a tier above - is enabled and wins instead) or `disabled` (`enabled: false`).
The second is the more common answer to "why is this not the value I set?", and a list built by skipping disabled rows could not give it.
A name whose every definition is disabled resolves to nothing at all, not to an empty string: the tool reports `resolved: false` with no value, because a present-and-empty answer would read as a different fact.

Its context is chosen the way a send's is, by the same code: an omitted `environmentId` is the active environment, `"none"` resolves as if none were active, and an id no environment has is refused.
So the value `resolve_variables` reports for a name is the value `run_request` sends for it in the same context.

Secret values are withheld from `resolve_variables`'s report (`valueWithheld: true`) the way every other read withholds them, unless the user enables reveal (see [Secret values](secrets.md#secret-values)).

**The model is duplicated on purpose, and pinned so the copies cannot drift.**
Neither process can import the other's resolver: the main process emits with `rootDir: "electron"` and cannot compile a file under `src/` (TS6059), and the renderer cannot import from here, because this is a referenced composite project (TS6305).
So `electron/mcp/variable-origins.ts` mirrors `app/src/lib/variable-resolution.ts` the way `compare.ts` mirrors `src/lib/run-compare.ts` (see the file map below), and `variable-origins.conformance.test.ts` replays the engine's own fixture (`engine/tests/fixtures/variable-resolution-conformance.json`) through both, so a divergence fails a test rather than surfacing as a wrong answer months later.
The fixture supplies a pre-flattened chain, so it cannot exercise the `parentId` walk; that half is pinned separately, by running `collectionChain()` and the renderer's `walkAncestors()` over the same rows - including the malformed ones (a self-parent, a two-node loop, a parent that does not exist) - and asserting they agree.

Call this what it is: a second implementation of the resolution order, kept honest rather than avoided.
Importing the renderer's resolver is the option that would have avoided it and the build forbids it; an engine endpoint reporting origins is the other, and it would mean new C++ for a question the engine has no use for (execution needs the winner, never the losers).
This does not make MCP a second **composition** path, which is the split that is load-bearing: `resolve_variables` reports stored definitions and substitutes no `{{tokens}}` - `POST /compose` remains the only place a request is composed.

### Data files

A collection's declared data file reaches MCP in two parts (issue #1742).
`dataSchema` is the contract - column names, the file's name, when it was declared - and is the same on every machine, so it rides the engine row.
`dataFile: { path, fileName, hash }` is where that file is **on this machine**, and comes from the app's renderer (`stores/data-file-store.ts`, its mirror of the collections list's bindings),
which publishes its whole map to the main process over `dataFile:locations` (`electron/data-file-locations.ts` holds the copy and rebuilds each payload, keeping only an absolute path with an extension `dataFile:read` would open).
`hash` (issue #2051) is the SHA-256 of the file's bytes, as 64 lowercase hex.
`list_collections` (its `fields: "full"` rows; a summary carries no `dataFile` and hashes nothing) and `vayu://collections` hash the file as it is **at call time** (`hashDataFile` in `electron/data-file.ts`, behind the same path gates as `dataFile:read`, streamed and never returned), so an edit made after a run shows up without the app re-reading anything.
One of those gates is the grant registry (#2357): only a file the user picked, dropped or opened through the app is hashed, so the digest is no oracle over a path the renderer merely named.
A file that cannot be read - moved, deleted, or never granted (a data file picked before grants existed is granted once it is picked again) - is never an error: the row keeps the hash the app last read the file with (picked in the Data tab, or re-read by a run dialog, Send-with-row or the Data tab), or none for a location it has not read since hashes were recorded.
A write tool's echoed collection row carries that stored hash too; it does not read the disk.

`castNumbers: true` (issue #2540) appears on `dataFile` when the collection's binding reads the CSV/TSV file with **Read numbers as numbers** on: the app reads an unquoted integer or decimal cell as a number and a quoted one as text.
It is absent otherwise, which means every cell is a string.
An agent building `data` rows from the file reads it the same way, so its rows match the ones the app would send, and says so with `dataFileCastNumbers: true` on the run.

A path is true of one filesystem only, which is why it never reaches an export.
The engine stores each collection's `specFile` and `dataFile` binding on its row (issue #2765) so a workspace backup carries them, but MCP drops both from every collection row it answers (`move_item`'s renumbered rows included) and names `dataFile` from the app's record alone, as above.
A path may reach MCP because the Electron-hosted server listens on loopback (`MCP_HOST`): every client that can read the answer runs on the machine the path names, and can open the file with its own access, the way a person would.
The stdio CLI runs without the app, so it has no record and never names a path.
**The rows are never sent:** no tool reads the file, so an agent that wants the data opens it itself, and a run still takes its rows inline as `data`.

**Re-running with the same data file.**
A data-driven run records which file drove it, by name and content hash, never by path or rows, and how it was read (`dataFileCastNumbers`, present as `true` only when its numbers were read as numbers):
`list_runs` carries `summary.dataFileName` / `summary.dataFileHash` / `summary.dataFileCastNumbers` on a single-request run and `summary.scenario.dataFileName` / `dataFileHash` / `dataFileCastNumbers` on a collection run, and `get_run_report` carries all three under `metadata.configuration`.
To repeat such a run, read the run row for the file's name and hash, then `list_collections` with `fields: "full"` for the file's current `dataFile.path` and `hash`, and compare the two hashes *before* reading the file and sending its rows - a mismatch means the file has changed since that run (hash the bytes you read yourself to be certain they are the ones you send).
Read the file the way the run did - numbers as numbers when it recorded `dataFileCastNumbers: true`, every cell as text otherwise - and pass the rows with the same `dataFileName`, `dataFileHash` and `dataFileCastNumbers`: `data` and the three on `run_collection`, `scenario.*` or the same four at the top level on `start_load_run`.
`compare_runs` reports one file read two ways as a `data_file` difference, because the hash is of the bytes and cannot tell the readings apart.
The run tools take rows, never a path: `dataFileName` is `dataFile.fileName`, and a value holding a `/` or `\` is refused by the tool schema (pointing at `dataFile.fileName`) and by the engine alike.
