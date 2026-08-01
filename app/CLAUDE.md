# App (Electron + React + TypeScript)

Renderer and Electron main process for Vayu. Apache-2.0. See the repo root
`CLAUDE.md` for build commands, commit rules and repo-wide conventions.

## Conventions

- Strict TypeScript - no `any`, no `@ts-ignore` without justification. `pnpm lint`
  runs in CI (zero errors _and_ zero warnings) alongside `pnpm format:check`, so a
  rule that genuinely cannot be met is suppressed on the one line, with the reason
  in a comment
- Component files: PascalCase `.tsx`; utilities: camelCase `.ts`
- Feature-organized: `app/src/modules/<feature>/` (request-builder, collections,
  dashboard, history, variables, settings, welcome); shared shell + primitives in
  `app/src/components/` (layout, shared, ui). See `docs/app/COMPONENTS.md`.
- Import parsers: `app/src/services/importers/` (factory → ordered detectors →
  drafts → orchestrator); per-format docs in `docs/app/import-collections/`.
- State: Zustand for UI state, TanStack Query for server state
- Styling: Tailwind CSS v4 - all colors via CSS custom properties
- **Design system: `docs/design-system.md`** - tokens, elevation, typography,
  component patterns. **Read this before touching any UI file.**

## Tests default to the `node` environment

A DOM costs ~2s per file and half the suite never touches one. If your test
renders, or reaches `document` / `window` / `localStorage` (zustand `persist`
does, without naming it), start the file with:

```ts
/**
 * @vitest-environment jsdom
 */
```

Forgetting it fails loudly (`document is not defined`), never silently.

**A source scan cannot see a class that arrives in a variable.** The badge-hover
guard scanned for `<Badge className="bg-…">` and missed both real instances,
because each got its background from a `statusColor` / `config.tint` binding;
reverting the fix left the scan green. For class-list defects, render the
component and assert on `element.className`. Derive a guard's rule from the
component (e.g. which variants actually carry a `hover:bg-*`) rather than
hardcoding it - a hardcoded version flagged `variant="outline"`, which owns no
background and cannot collide.

**A hand-rolled copy of a primitive does not receive the primitive's fixes.**
The script panels printed `scope[0].toUpperCase()` in a plain `Badge` instead of
using `VariableScopeBadge`, so the scope-colour fix that landed in the primitive
never reached them and all three scopes stayed grey. Before styling something
that already exists as a primitive, `rg` for the primitive.

**Before measuring or changing a class, `rg` for it in the components.** Twice a
conclusion was drawn about a combination the app never renders
(`bg-border-strong` only existed behind a `data-[state=]` variant;
white-on-`--primary` never occurs because fills use `--primary-fill`).

## UI rules (enforced by tests - breaking one fails CI)

- **Status colours have three tokens:** `--status-*` (dot/icon/tint),
  `--status-*-text` (when the colour _is_ the text), `--status-*-fill` (solid
  chip under a white label). Using the bare fill as a foreground is the most
  common colour bug here. → `status-color-tokens.test.ts`
- **`--primary` vs `--primary-fill`:** `--primary` is text/ring/chart and
  brightens in dark; `--primary-fill` is the solid button background and is one
  value in both themes. Do not unify them - pinning `--primary` drops accent text
  from APCA Lc 44–69 to 22–37.
- **No raw Tailwind palette** (`text-green-500`) in the request/response tree
  → `palette-tokens.test.ts`. Elsewhere only with an explicit `dark:` pair.
- **No chart series on `--primary`/`--chart-1`** - both track the user's accent
  and can collide with a semantic series. Use `categorical`.
  → `status-code-series.test.ts`
- **No bare `rounded`** - it ignores the Roundedness setting. → `radius-token.test.tsx`.
  **No radius class at all** is the same escape hatch pointing the other way: it
  pins the box at 0 for a user who chose Rounded. No source scan can flag it,
  because plenty of surfaces are square on purpose (header bars, tab strips,
  full-bleed editors) - only the component knows which it is, so render it and
  read `element.className`. Seven boxes in the request builder were stuck square
  this way. → `boxed-surfaces.test.tsx`, `KeyValueRow.test.tsx`
- **A drawer row's hit area needs two things, not one.** A row that carries a `⋯`
  menu cannot be one button, so it is an `h-8 items-center` container that paints
  the hover fill plus a narrower activator button holding the handler. That leaks
  clicks twice over: `items-center` leaves the button _content_-height (18px in a
  collection or environment row, so 7px above and below are dead), and the row's
  own box - the `paddingLeft` indent, the flex gaps, the right padding - belongs
  to no child at all. Measured in the running app, a collection row responded
  over **41%** of the area that looked clickable, a request row 51%, an
  environment row 36%. The fix is `self-stretch` on the activator **plus** the row
  delegating clicks that land on itself (`e.target === e.currentTarget`, which
  keeps the chevron and `⋯` out and stops a double-fire on bubble). The indent
  cannot simply move onto the activator - on a collection row the chevron sits
  between them. → `drawer-row-hit-area.test.tsx`. Assert the height as a
  `className`, not `offsetHeight`: jsdom has no layout and reports 0 for
  everything, so an `offsetHeight` guard passes while measuring nothing.
- **Adding an accent scheme:** `constants/color-schemes.ts` + `index.css`, both
  themes, nothing else. → `color-schemes.test.ts`
- **A `Badge` that paints its own `bg-` must be `variant="chip"`.** Every other
  variant pairs `bg-x` with `hover:bg-x/80`, and `cn()` (tailwind-merge) replaces
  `bg-*` but _not_ `hover:bg-*` - so the caller's fill won at rest and the
  variant's hover won on hover. Status chips turned the accent colour under the
  pointer. → `badge-hover.test.tsx`
- **`docs/design-system.md` values are checked against `index.css`**
  → `design-system-doc.test.ts`. Prose is not - if you change a value, read the
  sentence around it.

## Borders: what a rule sits _on_, never what it is

**A border is invisible or not depending on what it sits _on_, never on what it
is.** `--border` is tuned for the canvas (1.14) and is the _same colour_ as
`--card` in dark (1.00), so a rule inside a card is simply absent. A card's own
outline on `border-border` is correct, though, because that edge faces the
canvas - and both read as `border border-border bg-card` in the source, so only
the ancestry tells them apart. This was found and fixed one component at a time
about ten times before it was centralised.

**Write `border-rule`, not a border token.** A surface class (`surface-card`,
`surface-sunken`) sets its background _and_ declares the `--rule` that reads on
it; `border-rule` inherits the right value, per theme, including through
nesting. Card resolves to 1.304 light / 1.278 dark, sunken to 1.356 / 1.343 -
parity a single token cannot give, since `--border` is invisible in dark and
`--border-strong` overshoots light. On `--muted` / `--accent` no border token
works at all: `--border-strong` is _weaker_ there than `--border` in dark
(1.11 vs 1.16) and the pair inverts in light, which is why sunken uses an alpha
of `--foreground`. Definitions in `index.css`, rationale in
`docs/design-system.md`.

The mistake is now **enumerable, not impossible**: a `border-rule` under no
declared surface silently falls back to the invisible default. So guard the
_declarations_ (`surface-rule.test.tsx`, `ImportModal.surface-rule.test.tsx`) -
asserting `border-rule` is present proves nothing. Adopted by the
response-viewer family and the import dialog; elsewhere still uses explicit
tokens, migrate as you touch. On an element whose primitive already sets a
background utility (`DialogContent`'s `bg-background`), `surface-card` alone
loses the cascade - write the pair `bg-card surface-card`
(see `docs/design-system.md`).

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
| `docs/app/file-name-conventions.md` | The naming conventions themselves                            |
| `docs/app/building.md`              | App build steps or tooling                                   |

Module READMEs carry the _why_ for their feature and are easy to miss:
`app/src/modules/README.md`, plus one each for `welcome/`, `request-builder/`
and `dashboard/`.
