# App (Electron + React + TypeScript)

Renderer and Electron main process for Vayu. Apache-2.0. See the repo root
`CLAUDE.md` for build commands, commit rules and repo-wide conventions.

Tests run from this directory: `pnpm test` for the whole suite,
`pnpm test <pattern>` for the files matching it. Never `pnpm test -- <pattern>`:
pnpm forwards the literal `--` and vitest drops the filter, so that form runs
everything.

## Conventions

- Strict TypeScript: no `any`, no `@ts-ignore` without justification. `pnpm lint`
  runs in CI with zero errors and zero warnings, beside `pnpm format:check`; a
  rule that genuinely cannot be met is suppressed on the one line, with the
  reason in a comment.
- Component files: PascalCase `.tsx`; utilities: camelCase `.ts`.
- Feature-organized: `app/src/modules/<feature>/` (collections, dashboard,
  history, inbox, palette, request-builder, services, settings, trash,
  variables, welcome); shared shell and primitives in `app/src/components/`
  (layout, shared, ui). See `docs/app/COMPONENTS.md`.
- **Import holds no parser** (#877). `app/src/services/importers/` is the batch
  ledger, the temp ids and the apply; `parseImport` is one `POST /import/parse`
  call, and every format is read by `engine/src/core/import_document.cpp`. A
  parser here would be a second reader of a document, and the engine's is the
  one that MCP clients can reach. Per-format mapping docs in
  `docs/app/import-collections/`. `ref-bundler.ts` is the one file that still
  walks a document, and it reads it through the engine (`POST /import/document`):
  inlining a `$ref` target is deterministic re-serialization, not an opinion
  about what the document declares.
- **An Enter that acts uses `isCommitEnter`** (`@/lib/keyboard`), never a bare
  `e.key === "Enter"` (#939). An IME commits its composition buffer with Enter
  and that commit reaches the handler as an ordinary keydown, so an unguarded
  field acts on a half-composed value. The guard also refuses an Enter carrying
  Ctrl/Cmd (#935), which is the app's Send chord: a field acting on it would do
  its own thing and send the request from one press.
- **A window-level chord asks `isModalOpen()` first** (`@/lib/modal`, #935).
  Both global handlers, `Shell.tsx`'s chord map and `RequestBuilderLayout.tsx`'s
  Send / Load Test, are bound on `window`, so they fire wherever focus is. The
  predicate reads the DOM (`[data-slot="dialog-content"]` not in its closed
  state) rather than a counter, so every dialog, including one a future feature
  adds, is covered with nothing to register.
- **A chord the app listens for is a `Chord` in `constants/shortcuts.ts`**,
  matched by `matchesChord`, and every surface that displays one reads that same
  definition through `formatChord` / `chordKeys` in `lib/platform.ts` (#938).
  Hand-rolled comparisons are not a style question: `e.metaKey || e.ctrlKey`
  ignores `altKey`, and AltGr is Ctrl+Alt on European Windows layouts; `e.key`
  compared to `"1"` is dead on AZERTY. Bind a positional chord by `code`
  (`Digit1`); give the palette's ⌘K-class chords `mod: "strict"` so the other
  platform's modifier stays with the focused control; and remember Monaco eats
  what it recognises, so a chord that must work inside an editor is bridged by
  `lib/editor-chords.ts`, which re-dispatches to the one window handler rather
  than calling the action a second way. **A chord also carries its own `label`
  and belongs to a `SHORTCUT_GROUPS` entry** (#951): the Settings > Keyboard
  shortcuts panel draws every row from that registry, and
  `shortcuts.listed.test.ts` fails on a chord outside it. Every app-level chord
  has a palette command or a written excuse (`palette-parity.test.ts`).
- **The collection tree's key guards come from the same file**: it bails out of
  its named cases on Ctrl/Cmd so those chords reach the window, and its
  editable-target check is `isTextEntryTarget`, which is `ownsEnterKey` plus a
  plain input. One list, not two.
- State: Zustand for UI state, TanStack Query for server state.
- Styling: Tailwind CSS v4; all colours via CSS custom properties.
- **Design system: `docs/design-system.md`**: tokens, elevation, typography,
  component patterns, accessibility. **Read it before touching any UI file.**

## Tests default to the `node` environment

A DOM costs about 2s per file and half the suite never touches one. If your
test renders, or reaches `document` / `window` / `localStorage` (zustand
`persist` does, without naming it), start the file with:

```ts
/**
 * @vitest-environment jsdom
 */
```

Forgetting it fails loudly (`document is not defined`), never silently.

**A render-heavy test asserts a wall clock it never wrote.** `vitest.config.ts`
sets no `testTimeout`, so every case gets the default 5s. A case that builds
thousands of rows and renders them spends most of that budget idle and crosses
it under machine or CI-shard load, failing over the environment rather than
the code (#846, #1280). Ask what the fixture size is *for* before reaching for
a timeout: a property such as "past the grid's first window" needs a fixture
one step past that window, not hundreds of rows. Only where a case genuinely
needs the large fixture, give it an explicit `it(name, { timeout: N }, fn)`
with the measured cost and the multiplier in a comment. Never raise the global
default: it slows every genuinely hung test's failure to the new bound.

**A source scan cannot see a class that arrives in a variable.** A guard that
greps for `<Badge className="bg-…">` misses a background bound from
`statusColor` or `config.tint`. For class-list defects, render the component
and assert on `element.className`, and derive the guard's rule from the
component (which variants actually carry a `hover:bg-*`) rather than
hardcoding it.

**A response reaches the pane through two funnels, and a field added to one is
missing from the other.** `responseFromExecuteResult` (live `/execute` body)
and `responseFromRunResult` (a stored trace, from History) both build
`ResponseState` and neither knows about the other. When you add a field to
one, add it to both and assert they agree (`validation-funnels.test.ts` is the
shape: drive both with the same input, compare). The engine stores the *same*
object it returned rather than letting each side derive its own.

**Before measuring or changing a class, `rg` for it in the components.** A
conclusion about a combination the app never renders is not a finding.

## UI rules (enforced by tests - breaking one fails CI)

- **Status colours have three tokens:** `--status-*` (dot/icon/tint),
  `--status-*-text` (when the colour *is* the text), `--status-*-fill` (solid
  chip under a white label). Using the bare fill as a foreground is the most
  common colour bug here. → `status-color-tokens.test.ts`
- **`--primary` vs `--primary-fill`:** `--primary` is text/ring/chart and
  brightens in dark; `--primary-fill` is the solid button background and is one
  value in both themes. Do not unify them: pinning `--primary` drops accent text
  from APCA Lc 44-69 to 22-37.
- **No raw Tailwind palette** (`text-green-500`) in the request/response tree
  → `palette-tokens.test.ts`. Elsewhere only with an explicit `dark:` pair.
- **No chart series on `--primary`, `--accent` or `--chart-1`**: they track the
  user's accent and collide with a semantic series. The status-code chart
  resolves through the `--status-*` family. → `status-code-series.test.ts`
- **No bare `rounded`**: it ignores the Roundedness setting.
  → `radius-token.test.tsx`. **No radius class at all** is the same escape hatch
  pointing the other way: it pins the box at 0 for a user who chose Rounded. No
  source scan can flag it, because plenty of surfaces are square on purpose
  (header bars, tab strips, full-bleed editors); only the component knows which
  it is, so render it and read `element.className`.
  → `boxed-surfaces.test.tsx`, `KeyValueRow.test.tsx`
- **A drawer row's hit area needs two things, not one.** A row that carries a `⋯`
  menu cannot be one button, so it is an `h-8 items-center` container that
  paints the hover fill plus a narrower activator button holding the handler.
  That leaks clicks twice over: `items-center` leaves the button content-height,
  and the row's own box (indent, flex gaps, right padding) belongs to no child.
  The fix is `self-stretch` on the activator **plus** the row delegating clicks
  that land on itself (`e.target === e.currentTarget`, which keeps the chevron
  and `⋯` out and stops a double-fire on bubble). → `drawer-row-hit-area.test.tsx`.
  Assert the height as a `className`, not `offsetHeight`: jsdom has no layout
  and reports 0 for everything.
- **Inside a tooltip, every colour is a tint of `--primary-foreground`.**
  `TooltipContent` paints `bg-primary-fill`, where the canvas-tuned
  `--muted-foreground` measures 1.04-2.27:1, a disappearance rather than a
  de-emphasis. Secondary lines use the `TooltipHint` primitive, which holds the
  one tint. → `tooltip-hint-contrast.test.ts` (ratios per scheme, plus a scan of
  every tooltip block in `src`), `tooltip-icon-button.test.tsx` (the rendered
  class, which the scan cannot see)
- **A tooltip's value and the hint sourcing it stack; they never share a flex
  row.** `TooltipContent` is capped at `max-w-xs`, a `break-all` value has a
  min-content width of about one character, and a `shrink-0` hint keeps its
  intrinsic width, so one long source name leaves the value a vertical strip of
  letter fragments. Write `TooltipValue`, which holds the stacked shape.
  → `tooltip-value-layout.test.ts` (the same block scan, from
  `tooltip-blocks.testkit.ts`), plus rendered-class guards in `VariableInput/`
- **Adding an accent scheme:** `constants/color-schemes.ts` + `index.css`, both
  themes, nothing else. → `color-schemes.test.ts`
- **A `Badge` that paints its own `bg-` must be `variant="chip"`.** Every other
  variant pairs `bg-x` with `hover:bg-x/80`, and `cn()` (tailwind-merge)
  replaces `bg-*` but not `hover:bg-*`, so the caller's fill wins at rest and
  the variant's hover wins on hover. → `badge-hover.test.tsx`
- **`docs/design-system.md` values are checked against `index.css`**
  → `design-system-doc.test.ts`. Prose is not: if you change a value, read the
  sentence around it.
- **Accessibility has a section of its own** in `docs/design-system.md`
  ("Accessibility", after Focus & Interaction States): which check holds which
  rule, why a tooltip is not a name, why `outline-none` needs a replacement in
  the same class string, and the three `jsx-a11y` rules configured rather than
  obeyed as written. `eslint-plugin-jsx-a11y` recommended runs on every `.tsx`
  under `pnpm lint`, so a hand-rolled `role="button"` without a tab stop or a
  key handler fails CI at the line. The rules it cannot see are suppressed at
  the line, and that section enumerates every one of them: adding a suppression
  means adding it there, with its reason, and raising the ceiling (#1282).
  → `focus-indicator.test.ts`, `icon-button-labels.test.tsx`,
  `a11y-suppressions.test.ts`, plus the lint itself

## Borders: what a rule sits *on*, never what it is

**A border is invisible or not depending on what it sits *on*, never on what it
is.** `--border` is tuned for the canvas (1.14) and is the same colour as
`--card` in dark (1.00), so a rule inside a card is simply absent. A card's own
outline on `border-border` is correct, because that edge faces the canvas; both
read as `border border-border bg-card` in the source, so only the ancestry
tells them apart.

**Write `border-rule`, not a border token.** A surface class (`surface-card`,
`surface-sunken`) sets its background and declares the `--rule` that reads on
it; `border-rule` inherits the right value, per theme, including through
nesting. Card resolves to 1.304 light / 1.278 dark, sunken to 1.356 / 1.343,
parity a single token cannot give. On `--muted` / `--accent` no border token
works at all (`--border-strong` is weaker there than `--border` in dark, 1.11
vs 1.16, and the pair inverts in light), which is why sunken uses an alpha of
`--foreground`. Definitions in `index.css`, rationale in
`docs/design-system.md`.

The mistake is **enumerable, not impossible**: a `border-rule` under no
declared surface silently falls back to the invisible default. So guard the
*declarations* (`surface-rule.test.tsx`, `ImportModal.surface-rule.test.tsx`);
asserting `border-rule` is present proves nothing. The surface classes are in
use across the tree; a new surface declares one rather than picking a token.
On an element whose primitive already sets a background utility
(`DialogContent`'s `bg-background`), `surface-card` alone loses the cascade:
write the pair `bg-card surface-card` (see `docs/design-system.md`).

## Docs to keep in step

| Doc                                 | Update it when you change…                                   |
| ----------------------------------- | ------------------------------------------------------------ |
| `docs/design-system.md`             | Any token value, colour rule, radius, or shared UI primitive |
| `docs/app/COMPONENTS.md`            | Adding or moving a module / shared component                 |
| `docs/app/architecture.md`          | Renderer-side structural decisions                           |
| `docs/app/state-management.md`      | Adding a store, changing query keys or cache policy          |
| `docs/app/api-integration.md`       | Request/response shapes the renderer sends                   |
| `docs/app/variable-resolution.md`   | Resolution order, scopes, the resolver hook                  |
| `docs/app/import-collections/`      | Detectors, drafts, any format mapping                        |
| `docs/app/pm-api-compatibility.md`  | Which `pm.*` APIs the runtime supports                       |
| `docs/app/data-driven-runs.md`      | Data files, bound rows, `{{data.*}}`                         |
| `docs/app/graphql.md`               | The GraphQL body mode, schema explorer, GET transport        |
| `docs/app/openapi.md`               | Spec binding, sync, diff, export from the app's side         |
| `docs/app/file-name-conventions.md` | The naming conventions themselves                            |
| `docs/app/building.md`              | App build steps or tooling                                   |

**A test that reads a file outside `app/` registers it in
`src/lib/routed-inputs.testkit.ts`**: a page under `docs/` in
`DOC_READING_GUARDS`, an engine source or fixture in `ENGINE_READING_GUARDS`, a
repository-root file in `ROOT_READING_GUARDS`. CI routes only the paths named
there (every area filter excludes Markdown, `app` matches nothing under
`engine/`, and `install.sh` belongs to the installer's filters alone), so a
guard whose input is unrouted never runs on the edit that breaks it and fails
later on an unrelated change. Those lists and the `app_doc_fixtures` /
`app_engine_inputs` / `app_root_inputs` filters in `pr-tests.yml` are compared
by `routed-inputs.test.ts`, which fails if either side changes alone. Take the
path from the registry rather than spelling it again in the guard.

Module READMEs carry the *why* for their feature and are easy to miss:
`app/src/modules/README.md`, plus one each for `welcome/`, `request-builder/`
and `dashboard/`.
