---
description: >-
  The command palette module of the Vayu desktop app: the Cmd/Ctrl+K overlay for reaching tabs, requests, collections and commands by name.
---

# Command Palette (`modules/palette/`)

The ⌘K/Ctrl+K overlay: reach any open tab, saved request, collection or app view by name, and
run any command by name. Mounted once by `Shell`, alongside `ImportModal`.

- **`CommandPalette.tsx`** - the dialog, the chord (capture phase; refused while another dialog is open, with an info toast saying to close it, but still toggles the palette closed, #3320), focus restoration, the open flag
  (`useLayoutStore.paletteOpen` / `setPaletteOpen`, deliberately not persisted), and the host
  for the dialogs its commands open (see `useCommandSurfaces.ts` below).
- **`sources/`** - one hook per family, each returning `PaletteItem[]`. Two shapes of source:
  the **shallow** ones return everything they know and let the ranking narrow it - `useTabItems` (open
  tabs), `useEntityItems` (requests + collections), `useViewItems` (drawer views and singleton
  tabs) - while the **deep** ones take the query, because their corpus is too large to render:
  `useSettingsItems` (every app setting and engine entry, through the shared settings index),
  `useVariableItems` (environment names and variable keys across every scope; a key is found by
  its pasted `{{name}}` spelling too, the braces and whitespace stripped from the query before it
  is matched) and `useRunItems` (server-backed, `GET /runs?q=`). `commandItems.ts` is a plain function, not a hook: it owns no
  data, it maps the [command registry](command-registry.md#command-registry-libcommands) onto the same shape.
- **`useCommandSurfaces.ts`** - the collection picker, the run dialog, the theme hook and
  `useCopy`'s `copy`, which four commands need and no store can hold. Their original hosts are not always on screen (the
  welcome screen's picker only on the welcome tab, the tree's run dialog only while the drawer
  is open), so the palette mounts its own - the same components, driven by the same calls. It
  also merges the surfaces a *mounted feature* contributes (the request builder's live draft,
  for "Load test …" and "Send …") - see [Command Registry](command-registry.md#command-registry-libcommands).
- **`types.ts`** - the `PaletteItem` shape, the fixed group order, and `rankForEmptyQuery`.
- **`ranking.ts`** - what renders and in what order, decided once. See Ranking below.
- **`PaletteResults.tsx`** - grouping and rendering, and nothing else: it asks `ranking.ts` what
  to draw. **Mounted only while the palette is open**, the same cost rule the context bar applies
  to a collapsed section: a shut palette holds no query observers on collections, requests or run
  history.

Three things about it are load-bearing:

- **The chord is on the capture phase**, unlike every other shortcut in the app (which lives in
  `Shell`'s bubble-phase keydown map). Monaco treats ⌘K as the start of a chord and stops it
  propagating, so a bubble listener never sees the key while the caret is in an editor.
  `PALETTE_CHORD` lives in `constants/shortcuts.ts` so the handler and every label that
  advertises the chord read one definition. It is also the one chord declared `mod: "strict"`:
  capture phase plus a lenient modifier meant Ctrl+K on macOS - Cocoa's kill-to-end-of-line, and
  Monaco's `deleteAllRight` - opened the palette instead of reaching the focused control (#938).
- **Focus goes back where it came from**, and that is the palette's own code: Radix's
  `FocusScope` restores to a dialog's *trigger*, and a palette summoned by a chord has none, so
  focus would land on `<body>`. The previous element is captured from a store subscription
  rather than an effect - child effects run first, so by the time an effect here fires the
  dialog has already taken focus.
- **Tab rows are named by `components/layout/tab-descriptors.ts`**, the same hook `TabStrip`
  uses. A tab must not read "GET /v1/orders" in the strip and "Request" in the palette. Its
  subtitle is the descriptor's `path` ("Users / Get user") so two same-named tabs differ; a tab
  with no path falls back to the descriptor's `title`. A request row is titled by the same
  `requestTabTitle` rule, so an unnamed request reads as its URL path in both places.

Ranking lives in `ranking.ts` and happens **once**. The palette declares `shouldFilter={false}`,
so cmdk scores nothing a second time; the scorer is still cmdk's own (`defaultFilter`, the
`commandScore` it would have filtered with), applied by the palette where the result can also
decide the top result, the floor and the announced count. Before #1175 both matched: each deep
source pre-selected with a ranking of its own and cmdk re-scored every rendered row, and neither
was in charge - searching "theme" surfaced 0.01-scored requests over the 0.99-scored Theme Mode
setting, because sections render in a fixed order that cmdk's cross-group re-sort cannot cross
(each is wrapped in a `div` its `appendChild` cannot reach past).

On the empty query, `rankForEmptyQuery` puts the most recent first - focus time for tabs
(`tabFocusedAt` in `tabs-store`, session-scoped), last-run time for requests (from the run history
already in cache) - and nothing is promoted, because nothing has been asked for. Two sections lead
it (#1176), and both are built here rather than by a source of their own:

- **`Recents`** - the dated rows across every kind, newest first, capped at `RECENT_LIMIT` (6, a
  glance at what you were just doing). The cap stayed at six when the list grew taller (#1177):
  the extra height went to the sections *under* Recents, which were the ones nobody could see, and
  a longer list of recents would take it straight back. It reads the same `recencyAt` the within-section
  order reads, so nothing re-derives a recency and the two cannot disagree. A request that is sent
  and open has two dated rows, its own and its tab's, so the request row is dropped from Recents
  (matched on `PaletteItem.entityKey`, `request:<id>`, which both sources stamp) and keeps its
  place in Requests, instead of taking two of the six slots (#3323). In practice that is
  open tabs and requests that have been sent: the deep sources contribute nothing to an empty
  query at all, so a past run reaches the list only once something is typed - where it is a
  search result rather than a recent, which is the distinction being drawn. How far back it
  reaches follows the data. Tab focus times are session-scoped by `tabs-store`'s documented
  design, so after a restart Recents is the requests the run history remembers, and fills with
  tabs again as they are used; persisting focus time to lengthen the list would rank a restored
  strip by yesterday's attention, which is the thing that rationale refuses.
- **`Quick actions`** - the `command` rows. The verbs are what an empty palette is *for*, and they
  sat fifth of eight sections, under a fold that showed about six rows before #1177 raised it.
  Typed, they rank as the `Commands` section they have always been, so the heading follows the
  query rather than the section moving around - except on a query that matched nothing, where they
  come back as the offer (#1177, below).

Both **lift** their rows out of the sections below rather than copying them into the new ones -
the same rule the top result follows, and for the same reason: two rows carrying one cmdk `value`
would both read as selected, and both would be counted. A row past the Recents cap is still
reachable in the section it was not lifted from. Neither section is a `PaletteKind`: no source
produces one, so a kind for it would be a shape nothing returns.

They lift out of **each other** too, by the order they render: Recents is built first and the
verbs exclude whatever it took (#1197). The two tests are independent - a verb is a `command` row,
a recent is one carrying a `recencyAt` stamp - so a stamped command would otherwise sit under both
headings, which is the duplicate the lift exists to prevent. No source stamps a command today, so
this decides nothing on screen; it is what keeps the first one that does from arming the defect
silently, and `ranking.test.ts` pins it.

Once something is typed, four rules apply:

- **The best match is promoted to a `Top result` section**, lifted out of its own section rather
  than copied into the new one: two rows carrying the same `value` would both read as selected.
  Ties go to the earlier section. Below it, groups render in the same fixed order as ever (Tabs,
  Requests, Collections, Views, Commands, Settings, Variables, Runs) so the list does not reshuffle
  as you type; within a section, rows are ordered by score, with the source's own order as the
  stable tiebreak. A deep row is sorted on what it *prints*, which can be nothing - a run the
  engine matched on snapshot text sinks below one whose URL says what was typed, and among equals
  stays newest-first. That is a change for Runs alone, and a deliberate one: their old order came
  of stuffing the query into every row's keywords, which scored them all alike. Settings is its own
  group rather than more Commands: twelve sections would bury the handful of things the palette can
  actually *do*.
- **A row must clear `MATCH_FLOOR` (0.1) to render.** cmdk keeps every score above zero, so a
  0.0008 match used to render exactly like a 0.99 one. The floor sits just under `commandScore`'s
  `SCORE_CHARACTER_JUMP` (0.17), which is what a match beginning mid-word scores - so "oken" still
  finds "Issue token", and a query reached only by two or more scattered jumps does not.
- **`substringKeywords` are matched literally, not fuzzily.** A URL is the case this exists for:
  to a subsequence scorer any path is character soup, and "theme" scores 0.51 against
  `/the/most/expensive/endpoint`. A request's URL uses this, and so does a settings command's
  description (#3322): the whole sentence is one entry, so it finds a section the way the settings
  sidebar does (by a phrase it prints), where the description's words in `keywords` let "theme"
  reach Observability by five letters in five words. A hit scores low enough that a row whose
  name says the query always outranks it. The piece typed has to be contiguous, and that is the
  cost - `v1/charges` finds the row, `v1charges` does not. No floor could buy that back: a URL is
  all separators, so a query scattered across its segments reads as a series of *word* jumps,
  which is what scores the soup so highly to begin with.
- **Requests and collections render at most `PALETTE_GROUP_RENDER_LIMIT` (50) rows each** (#2545).
  They are the two kinds that grow with the workspace, and a row per request was ~5,200 mounted
  `CommandItem`s at 5,000 requests, re-rendered per keystroke. `groupsOf` caps *after* ordering, so
  ranking still sees every row and the best match is inside the cap: a typed exact name is
  promoted to Top result however deep it sat in default order. A capped group closes with a plain
  `N more - keep typing` line (`RankedGroup.hidden`, drawn by `HiddenRowsHint`) that is not a
  `CommandItem`, so the arrows and Enter cannot reach it. A growing window was rejected: the
  palette is a search box, and a longer query is the way to row 51. Tabs, views and commands are
  bounded by the app and the deep kinds by `DEEP_GROUP_LIMIT`, so none of them is capped here;
  Recents, Quick actions and escape rows are unaffected.
- **The announced count is the matched count.** The `aria-live` line reports what the ranking
  kept, hidden rows included, which nothing downstream can drop unannounced.

Four rules govern the deep sources, and each exists because of a way the naive version fails:

- **They contribute nothing to the empty query.** The palette's empty state answers "what was I
  just doing"; ~65 settings entries and every variable key in the app are not that, and a
  server-backed group must not fetch for a palette nobody typed into.
- **Each caps itself at `DEEP_GROUP_LIMIT` rows and offers an escape row** - `Search settings
  for "x"…`, `Search runs for "x"…` - that opens the surface built for browsing the rest, with
  the query carried over (the settings sidebar's `searchQuery`, the History drawer's, whose
  other filters the escape resets so a stale one cannot hide what was just promised). The row
  appears only when there *is* more. Variables has none: no surface browses variables across
  scopes, so it would have nowhere to go.
- **An escape row renders in a group of its own**, below the results. It is not a result: it is
  never scored, never promoted to the top, and never counted. It echoes the query by construction,
  which is exactly what would otherwise score it above every result it is an escape from.
- **A deep row says `preMatched`**, and the ranking takes it at its word rather than forming a
  second opinion from less evidence - decisively so for runs, where the engine matched against
  stored snapshot text that no row prints. It is a property of the row and not of its `kind`: the
  command registry contributes `settings` rows too, one per panel, and those are ordinary shallow
  rows that must clear the floor. Before #1175 the same end was reached by stuffing the keywords -
  with a whole description sentence for settings, and with the query itself for runs, which scored
  every run as an exact match and outranked everything else. A settings command's description now
  rides in `substringKeywords` (#3322), so only the id and the fixed terms ("settings",
  "preferences", "engine") are fuzzy.

Three things the rows and the frame say (#1176):

- **A row's trailing edge tells you what already runs it.** A command bound to a chord prints that
  chord's key-caps - one `Kbd` per key, through `chordKeys`, from the `Chord` in
  `constants/shortcuts.ts` that the handler itself matches (#938) and never a second spelling of
  one. The registry carries it as `Command.shortcut`, and eighteen commands have one - thirteen
  of the action rows plus the five drawer-view commands generated alongside them; every other row
  prints nothing, because a plausible key that answers to nothing is worse than no key at all. A
  `Recents` row prints its age there instead, that being the reason it is in the section. A row
  that carries both - a chord-bound command with a recency stamp, which no source produces today -
  prints the chord: the stamp is why the row is in the section, the chord is how the row is run
  (#1260).
  `palette-parity.test.ts` is the check that keeps the two lists honest: every chord in
  `SHORTCUT_GROUPS` either carries a command here or an entry in that file's `NO_COMMAND` map
  giving the reason it does not, so a chord cannot go undiscoverable from both surfaces without
  someone having written down why.
- **The keyboard hints sit outside the band that scrolls.** `CommandFooter`
  (`components/ui/command.tsx`) is a sibling of `CommandList`, not a row in it: the list is the
  one scroller here, so hints placed inside it would scroll away with the results they describe -
  the same reason `DialogFooter` sits outside `DialogBody` in every other dialog (#773). All three
  keys it names are real: the arrows and Enter are cmdk's, Escape is the dialog's.
- **The placeholder does not advertise the chord that opened the palette.** By the time anyone
  reads it the dialog is open, so the one thing the suffix could teach has just been used. The
  title bar's search bar carries ⌘K, where it is still worth knowing.

Three about the frame itself (#1177):

- **Density is a launcher's, not a menu's.** `CommandDialog` no longer overrides row padding or
  icon size at all, so a row is `CommandItem`'s own `px-2 py-1.5` - the 30px single-line row this
  app draws everywhere else - and `PaletteResults` caps its `CommandList` at `min(400px, 60vh)`.
  Measured in Chromium: **eleven rows and two headings on screen at a 768px or taller window,
  nine at 600px**, where the old `py-3` rows in a 300px list showed about six. Six rows plus a
  heading is two sections, which is why the Settings group a query named could sit below the fold
  with nothing on screen saying it existed - the search fix (#1175) put the right row first, and
  this is what makes the rest of the answer visible. The `60vh` half keeps the whole panel inside
  its own `max-h-[85vh]` on a short window once the input and the hints are counted (435px of a
  600px viewport, measured); the autocompletes that share these primitives keep the 300px
  default, their popups being anchored under an input rather than centred. The icon override went
  because it never did what it read as: `[&_[cmdk-item]_svg]:h-5` outranks the `h-3.5` a row
  writes on its own icon, so every palette row drew a 20px icon beside the 14px method rail
  written to match it.
- **The chrome sits on a declared surface, so its dividers can be `border-rule`.** `Command`
  declares `bg-card surface-card` - `--popover` and `--card` are the same three numbers in both
  themes, and only one of them has a surface class to declare, so this is a rename rather than a
  repaint. With it declared, the input's divider, the separators between sections and the footer's
  `border-t` all resolve through the surface instead of the canvas token that is the card's own
  background in dark. Section headings are the `Eyebrow` primitive, wrapped inside the element
  cmdk labels the group by, rather than a third hand-typed copy of its eleven pixels.
  `command.chrome.test.tsx` pins the declaration, the absence of the canvas tokens, and the
  density - `border-rule` classes on their own prove nothing.
- **A query that matched nothing gets an offer, not a dead end.** `ranking.ts` hands the verbs
  back as `quickActions` when a typed query keeps no result, and the list says
  `No matches for “…”. Try one of these:` above them. They are suggestions, not results: the
  announced total stays at zero, which is what "did what I typed narrow anything" asks. cmdk's
  own `CommandEmpty` is unused here for the same reason - it renders only when the list has no
  rows at all, and the verbs are rows. Being an offer, no verb is highlighted until an arrow key
  (or Home, End, Ctrl+N/J/P/K) or the pointer chooses one, so Enter on a miss does nothing rather
  than opening a new request (#3321). `CommandPalette` withholds the highlight by controlling
  cmdk's `value` (`CommandDialog` forwards `value`, `onValueChange`, `onKeyDown` and
  `onPointerMove` to its `Command`) and takes the miss from `PaletteResults`, which owns the
  ranking. Typing takes the choice back, and a query that matches auto-highlights its first row
  as before.

Two invariants are tested rather than commented. **A variable's value is never indexed**, secret
or not (`secret` is a masking hint, so trusting it would leak every token nobody flagged) - held
in `sources/useVariableItems.test.ts` against the source's output, because the ranking would hide
an indexed value from any DOM assertion. And **an engine that is down hides the Runs
group silently**: typing is idle input, and idle input must never raise a toast.

**Entry points:** the chord, and the `Search` tile on the welcome Launcher. The title bar's
search bar (#529) is the third and becomes the primary one - it flips the same store flag.
