# Vayu - Claude Code Guide

Vayu is a high-performance API testing and load-testing platform. It uses a **sidecar architecture**: a C++20 engine (daemon) runs alongside an Electron + React UI, communicating over HTTP on port 9876.

- **Engine** (`/engine`): C++20, CMake + vcpkg, licensed AGPL-3.0
- **App** (`/app`): Electron + React + TypeScript, licensed Apache-2.0
- **Build script**: `build.py` is the single entry point for all build operations

## Project Structure

```
vayu/
├── engine/
│   ├── src/
│   │   ├── core/          # load_strategy, metrics_collector, run_manager
│   │   ├── http/          # HTTP server, SSE, routes, thread_pool, rate_limiter
│   │   ├── db/            # SQLite persistence
│   │   ├── runtime/       # QuickJS scripting engine
│   │   └── utils/
│   ├── include/vayu/      # Public headers
│   ├── tests/             # Google Test suite
│   ├── vendor/            # Vendored deps: quickjs-ng, picosha2 (PKCE/SHA-256), hdrhistogram
│   ├── CMakeLists.txt
│   ├── CMakePresets.json
│   └── vcpkg.json         # curl, nlohmann-json, cpp-httplib, gtest, sqlite3, sqlite-orm
├── app/
│   ├── src/               # React + TS UI (modules, components, services, queries, stores, hooks)
│   ├── electron/          # Electron main process
│   └── package.json
├── scripts/
│   ├── pre-commit         # clang-tidy on staged C++ files
│   ├── install-git-hooks.sh
│   └── test/              # Load test fixtures + mock server
├── build.py               # Unified build script (all platforms)
└── VERSION                # Single source of truth for version
```

## Prerequisites

- CMake ≥ 3.25, Ninja, C++20 compiler (g++ or clang++)
- vcpkg with `$VCPKG_ROOT` set (Linux/macOS; on Windows it is auto-detected - see below)
- Node.js ≥ 20.19 (22 LTS recommended - see `app/.nvmrc`), pnpm ≥ 10

Run `python build.py --setup` to install all prerequisites automatically (Linux/macOS only).

**On Windows, do not hand-configure cmake or set `VCPKG_ROOT` - just run
`build.py`.** It imports the MSVC environment via `vcvars` and finds cmake,
ninja and vcpkg inside the Visual Studio Build Tools install
(`...\BuildTools\VC\vcpkg`) on its own, so an unset `VCPKG_ROOT` is fine. Poking
at the build tree directly (empty `build/`, no `VCPKG_ROOT`) looks like "can't
build locally" when `python build.py -e -t` builds the engine and runs the C++
tests in ~2 min. If you keep vcpkg elsewhere, set `VCPKG_ROOT` and it is honored.

## Build Commands

```bash
# First-time setup (Linux/macOS)
python build.py --setup

# Development build (engine + app)
python build.py --dev

# Production build
python build.py

# Engine only
python build.py -e

# App only (requires engine already built)
python build.py -a

# Build with tests enabled
python build.py -t

# Bump version (patch | minor | major | x.y.z)
python build.py --bump-version patch --dry-run   # preview
python build.py --bump-version patch             # apply
```

## Running the App

```bash
cd app && pnpm run electron:dev
```

## Testing

### Engine (C++ / Google Test)

```bash
# Build with tests, then run via ctest
python build.py -t
cd engine && ctest --preset linux-dev --output-on-failure
```

CMake presets: `linux-dev`, `linux-prod`, `macos-dev`, `macos-prod`, `windows-dev`, `windows-prod`.

### Frontend

```bash
cd app && pnpm test
```

**A test must never assert the host platform.** Vayu is built on Linux, macOS
and Windows and CI runs all three. `platform.test.ts` asserted `isMac === false`
and called that "the test environment"; it was true only because jsdom reports
a Linux-ish user-agent, so the macOS branch was never exercised anywhere. Moving
to `node` removed the accident - Node has a real global `navigator` - and only
the macOS runner failed. Stub the input (`vi.stubGlobal`, or `process.platform`
as `updater.test.ts` does) and assert **both** branches.

**Tests default to the `node` environment.** A DOM costs ~2s per file and half
the suite never touches one. If your test renders, or reaches `document` /
`window` / `localStorage` (zustand `persist` does, without naming it), start the
file with:

```ts
/**
 * @vitest-environment jsdom
 */
```

Forgetting it fails loudly (`document is not defined`), never silently.

**Scale the verification to what the change could actually break.** Comment-only
and `.md`-only edits need no test run at all - a format check, or nothing. A
rename or signature change needs a *build*, to prove it still compiles. Only a
behaviour change needs the covering tests, and the full suite belongs once
before committing a substantial piece of work, not after every edit.

The engine suite takes ~110s and a rebuild ~2.5min; the app suite ~90s. Running
both after retouching a doc comment reads as diligence and is just latency. Ask
what a failure would even look like before running anything: if no test could
possibly go from green to red, do not run tests.

### Type checking

```bash
cd app && pnpm type-check
```

### Linting

```bash
cd app && pnpm lint                # ESLint (TS/TSX)
cd app && pnpm format:check        # Prettier
```

## Commits

**Never add Claude, an AI assistant, or yourself as a co-author.** No
`Co-Authored-By: Claude ...` trailer, no `Generated with Claude Code` line, no
🤖 attribution - not in commit messages, not in PR bodies. The commit author is
the human whose name is on it.

This **overrides the default instruction** to append that trailer, which some
harnesses inject automatically. If you find yourself writing a `Co-Authored-By`
line naming a model, delete it before committing.

## Code Conventions

### C++ (engine)

- Standard: C++20, `-Wall -Wextra -Wpedantic`
- Formatter: clang-format (`.clang-format` at root)
- Linter: clang-tidy (`.clang-tidy` configs in `engine/`, `engine/src/runtime/`, `engine/tests/`)
- Install git pre-commit hook: `bash scripts/install-git-hooks.sh`
- vcpkg manages all C++ dependencies - do not add deps without updating `engine/vcpkg.json`

### TypeScript / React (app)

- Strict TypeScript - no `any`, no `@ts-ignore` without justification
- Component files: PascalCase `.tsx`; utilities: camelCase `.ts`
- App UI is feature-organized: `app/src/modules/<feature>/` (request-builder, collections, dashboard, history, variables, settings, welcome); shared shell + primitives in `app/src/components/` (layout, shared, ui). See `docs/app/COMPONENTS.md`.
- Import parsers: `app/src/services/importers/` (factory → ordered detectors → drafts → orchestrator); per-format docs in `docs/app/import-collections/`.
- State: Zustand for UI state, TanStack Query for server state
- Styling: Tailwind CSS v4 - all colors via CSS custom properties; see `docs/design-system.md`
- **Design system:** `docs/design-system.md` - tokens, elevation, typography, component patterns. Read this before touching any UI file.

## UI rules (enforced by tests - breaking one fails CI)

- **Status colours have three tokens:** `--status-*` (dot/icon/tint),
  `--status-*-text` (when the colour *is* the text), `--status-*-fill` (solid
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
  clicks twice over: `items-center` leaves the button *content*-height (18px in a
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
  `bg-*` but *not* `hover:bg-*` - so the caller's fill won at rest and the
  variant's hover won on hover. Status chips turned the accent colour under the
  pointer. → `badge-hover.test.tsx`
- **No em-dashes anywhere in the repo.** Use ` - `.
- **`docs/design-system.md` values are checked against `index.css`**
  → `design-system-doc.test.ts`. Prose is not - if you change a value, read the
  sentence around it.

**A border is invisible or not depending on what it sits *on*, never on what it
is.** `--border` is tuned for the canvas (1.14) and is the *same colour* as
`--card` in dark (1.00), so a rule inside a card is simply absent. A card's own
outline on `border-border` is correct, though, because that edge faces the
canvas - and both read as `border border-border bg-card` in the source, so only
the ancestry tells them apart. This was found and fixed one component at a time
about ten times before it was centralised.

**Write `border-rule`, not a border token.** A surface class (`surface-card`,
`surface-sunken`) sets its background *and* declares the `--rule` that reads on
it; `border-rule` inherits the right value, per theme, including through
nesting. Card resolves to 1.304 light / 1.278 dark, sunken to 1.356 / 1.343 -
parity a single token cannot give, since `--border` is invisible in dark and
`--border-strong` overshoots light. On `--muted` / `--accent` no border token
works at all: `--border-strong` is *weaker* there than `--border` in dark
(1.11 vs 1.16) and the pair inverts in light, which is why sunken uses an alpha
of `--foreground`. Definitions in `index.css`, rationale in
`docs/design-system.md`.

The mistake is now **enumerable, not impossible**: a `border-rule` under no
declared surface silently falls back to the invisible default. So guard the
*declarations* (`surface-rule.test.tsx`, `ImportModal.surface-rule.test.tsx`) -
asserting `border-rule` is present proves nothing. Adopted by the
response-viewer family and the import dialog; elsewhere still uses explicit
tokens, migrate as you touch. On an element whose primitive already sets a
background utility (`DialogContent`'s `bg-background`), `surface-card` alone
loses the cascade - write the pair `bg-card surface-card`
(see `docs/design-system.md`).

**"Written but never read" is this codebase's most repeated defect** - found
nine times: state one layer records and no layer displays (SSE errors,
save-failure reasons, an import phase, parsed cookie attributes), and config one
branch defines and another re-derives inline (`SCOPE_CONFIG.global`). Store-level
tests never catch these; they are wiring bugs. When you add a field, grep for a
reader before assuming there is one.

**A hand-rolled copy of a primitive does not receive the primitive's fixes.**
The script panels printed `scope[0].toUpperCase()` in a plain `Badge` instead of
using `VariableScopeBadge`, so the scope-colour fix that landed in the primitive
never reached them and all three scopes stayed grey. Before styling something
that already exists as a primitive, `rg` for the primitive.

**Before measuring or changing a class, `rg` for it in the components.** Twice a
conclusion was drawn about a combination the app never renders (`bg-border-strong`
only existed behind a `data-[state=]` variant; white-on-`--primary` never occurs
because fills use `--primary-fill`).

**Never run prettier/`eslint --fix` repo-wide, and never format
`docs/design-system.md`** - most of the tree isn't prettier-clean and formatting
that file reflows ~480 lines. Format only files you touched that were clean before.

**Mutation-check behavioural tests** (revert the fix, confirm failure, restore).
Source-scanning guards must assert they scanned something non-empty - one passed
for weeks reading an empty string, since vitest stubs CSS imports to `""`.

**A source scan cannot see a class that arrives in a variable.** The badge-hover
guard scanned for `<Badge className="bg-…">` and missed both real instances,
because each got its background from a `statusColor` / `config.tint` binding;
reverting the fix left the scan green. For class-list defects, render the
component and assert on `element.className`. Derive a guard's rule from the
component (e.g. which variants actually carry a `hover:bg-*`) rather than
hardcoding it - a hardcoded version flagged `variant="outline"`, which owns no
background and cannot collide.

## Subagents in worktrees - check the base first

Worktree provisioning cuts from **`master`**, not the branch you are on, and it
does so inconsistently - in one batch of four agents, three were 113 commits
behind and one was current. An agent that does not check will produce findings
against code that no longer exists; a previous round lost five agents' work this
way, ~190 commits behind.

Every subagent prompt must open with a base check naming the expected commit:

```bash
git log --oneline -1
git rev-list --count HEAD..<expected>          # 0 means current
git merge-base --is-ancestor HEAD <expected>   # ok to fast-forward if clean
```

A strict ancestor with a clean tree can be repaired losslessly
(`git reset --hard <expected>`); anything else should stop and report. Have the
agent state which case applied, so a silent misfire still shows up.

Also pin the base **in the prompt as a literal SHA**. "The current branch" means
nothing inside a worktree that was cut from somewhere else.

## Engine HTTP API

The engine daemon listens on `http://127.0.0.1:9876`. Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/execute` | Send a single request (auth resolved engine-side) |
| POST | `/runs` | Start a load test run |
| GET | `/runs/:runId/live` | SSE stream of live metrics |
| GET | `/runs/:runId/metrics` | Historical time-series (JSON) for a run |
| POST | `/oauth2/token` | Acquire/return a cached OAuth 2.0 token (auth resolved engine-side) |
| GET | `/health` | Health check |
| POST | `/import/apply` | Persist a whole parsed import atomically; returns a temp-id -> real-id map |
| POST | `/collections`, `/requests`, `/environments` | **Create only** - 409 on an existing id |
| PUT | `/collections/:id`, `/requests/:id`, `/environments/:id` | **Update only** (merge-patch) - 404 on a missing id |

The pre-consolidation paths (`POST /request`, `POST /run`, `GET /run/:id[/report|/stop]`,
`DELETE /run/:id`, `GET /metrics/live/:runId`, `GET /stats/:runId?format=json`) still
work as **deprecated aliases** and will be removed in a future minor release; `GET
/stats/:runId` in its SSE mode is retained wholesale. See `docs/engine/api-reference.md`
(Deprecated aliases) for full reference.

Three things worth knowing before you design around them:

- **POST creates, PUT updates - they are not interchangeable.** `POST
  /<resource>` on an id that already exists is a `409`, and `PUT
  /<resource>/:id` on one that does not is a `404`; POST-as-upsert is gone
  (issue #95). One null-vs-absent rule covers all three resources: on create
  absent and `null` both mean "use the default", on update absent means "keep"
  and `null` means "reset to the default", and a field with no default (a
  collection's / environment's `name`, a request's `collectionId` / `name` /
  `method` / `url`) rejects `null` with a `400` instead of ignoring the write.
  The rule lives in one place per side - `apply_*_field` in
  `engine/include/vayu/http/routes.hpp`, and `apiService.updateX` in
  `app/src/services/api.ts` - so add fields there rather than re-deriving the
  rule per handler. A client-supplied `id` on **create** is still accepted, but
  nothing in the app sends one any more: import goes through **`POST
  /import/apply`** (#96), which takes opaque `tempId`s, generates every real id
  engine-side, returns the `idMap`, and writes the whole tree in one transaction
  (a rejected payload persists nothing, so the old client-side rollback is gone).
  #97 then rejects the `id` field outright. The same per-resource field appliers
  back both paths - `apply_collection_fields` / `apply_request_fields` /
  `apply_environment_fields`, declared in `routes.hpp` - so add a field there and
  bulk import gets it too.
- **`GET /requests/:id` is a single-request lookup.** `useRequestQuery` uses it
  to load a restored request tab or a design-run copy on cold start - one round
  trip, not the old scan of every collection's list. A `404` means the request
  was genuinely deleted; anything else (a `5xx`, an unreachable engine) is a
  transport failure, and callers (`DesignRunView`) must keep those apart - only
  a real 404 becomes `RequestNotFoundError`. `GET /requests?collectionId=` still
  lists a collection's requests.
- **`followRedirects` / `maxRedirects` are per-request and stored** (request
  builder → **Settings** tab, `requests.follow_redirects` / `max_redirects`).
  Both clients send them on *every* execute and load test rather than eliding
  the defaults, because the engine's `follow_redirects` defaults to **true** -
  an omitted `false` would silently follow the 3xx the user asked to see.
  **`verifySSL` is still engine-only**; it was deliberately not exposed.

## Request composition (known duplication - do not add a third copy)

Preparing a request before it executes - resolving `{{variables}}` and resolving
`inherit` auth via the collection-chain walk - happens **client-side** today, and
is therefore **duplicated** across the two engine clients:

- **Renderer:** `app/src/hooks/useVariableResolver.ts` + inline in
  `app/src/modules/request-builder/index.tsx` + `utils/auth-resolution.ts`.
- **MCP:** `app/electron/mcp/resolve.ts`.

Composing the collection-chain + request pre/post scripts is **no longer** part
of that duplication: both clients now collect an ordered list of `ScriptPart`s
(root-to-leaf chain, then the request's own, each naming its origin) and send
the list as `preRequestScripts` / `postRequestScripts` on `POST /execute` - and
the **engine** joins them with `"\n\n"` and runs the result. The renderer's load
path sends the same kind of list as `tests` on `POST /runs`; MCP's
`start_load_run` sends it as `postRequestScripts` when given a `requestId`
(`tools.ts::composeLoadRunRequest`, reusing `composeSavedRequest`), or an
agent-supplied ad-hoc `tests` string for a URL-only run. **Both names reach the
same script**: `read_post_request_script` (`engine/src/http/script_parts.cpp`)
owns every spelling the post-request script answers to - stored as
`postRequestScript`, `postRequestScript(s)` on `/execute`, `tests` on `/runs` -
and both routes read through it, so a payload composed for one endpoint can
start the other kind of run unchanged. Add a spelling to that table, never to a
route. Each client still builds its own script-part list itself (the
`scriptParts` helper in
`app/src/modules/request-builder/utils/script-parts.ts` and in
`app/electron/mcp/resolve.ts` - the same intentional duplication, since MCP
cannot import from `app/src/`), so a change to the list-building rule (e.g. what
counts as blank) still needs both copies changed together.

The endpoint names above are the canonical ones (`POST /execute`, `POST /runs`);
the old `POST /request` / `POST /run` still work as deprecated aliases.

The engine does the rest of execution (loads variables for script context, applies
concrete auth incl. OAuth2, joins and runs the script parts) but intentionally
does **no** `{{var}}` interpolation and drops `{"mode":"inherit"}` as "resolved
app-side". If you change resolution/auth/script-list-building semantics, **change
both client copies together** and keep them in sync (guarded by
`app/electron/mcp/resolve.test.ts`). **Do not add a third copy** - a new engine
client should reuse `resolve.ts`. The intended long-term fix (consolidate the
remaining variable/auth resolution into the engine) is deferred and documented in
`docs/plans/pending-backlog.md` → **A1**; do not start it without explicit ask.

## Releasing

1. `python build.py --bump-version patch` - updates VERSION, CMakeLists.txt, vcpkg.json, package.json
2. Write the curated release notes to `.github/release-notes/vX.Y.Z.md` (Keep a Changelog format, see below).
3. Commit both: `git commit -m "chore(release): x.y.z"` (version bump + notes file together).
4. Tag: `git tag v$(cat VERSION) && git push origin --tags`
5. CI builds installers and publishes the GitHub Release, using `.github/release-notes/<tag>.md` as the release body automatically (no manual paste).

**Tag *after* the release commit lands on the default branch.** When the version bump goes through a pull request (the usual path), run steps 1-2 on the feature branch so the bump merges with the PR, but do **not** tag the PR-branch commit. A squash/rebase merge rewrites the commit hash, so a tag on the pre-merge commit would point at a commit that never reaches the default branch. Wait for the PR to merge, then run step 3 against the merged commit on the default branch (`git checkout <default-branch> && git pull && git tag v$(cat VERSION) && git push origin --tags`). The tag triggers the release build, so it must sit on the canonical merged history.

macOS also ships a one-command installer: `install.sh` (repo root) downloads the release zip, ad-hoc signs the app + sidecar on-device, and strips quarantine (no Apple Developer cert). Unit-tested via `scripts/test/install_test.sh` (set `VAYU_DRYRUN=1`), shellchecked in CI on Linux + macOS.

### Release changelog

Release notes live on the [GitHub Releases](https://github.com/athrvk/vayu/releases) page (there is no `CHANGELOG.md` in the repo). Write them in [Keep a Changelog](https://keepachangelog.com) style so entries stay consistent across versions:

- **Heading:** `## [X.Y.Z] - YYYY-MM-DD` (ISO date).
- **Lead paragraph:** 2-4 sentences naming the release theme and where the change concentrates (engine vs app), e.g. "The OAuth 2.0 release ... the bulk of the change is new C++ in the engine and new React/Electron surface in the app."
- **Grouped sections, in this order, omitting any that are empty:** `### Added`, `### Changed`, `### Fixed`. Use `### Security` / `### Removed` / `### Deprecated` only when they apply.
- **Bullets:** lead with a bold headline, then the detail, e.g. `- **OAuth 2.0 auth mode.** A new \`oauth2\` mode in the request Auth panel and Collection Detail ...`. Prefer user-facing wording; reference files/endpoints only when they aid a contributor.
- **Fold internal churn** (doc hygiene, refactors with no user-visible effect) into a single summary bullet rather than listing each commit.
- **Compare link footer:** `[X.Y.Z]: https://github.com/athrvk/vayu/compare/vPREV...vX.Y.Z`.
- **Version choice:** patch = fixes only; minor = new user-facing feature; major = breaking change (still `0.x`, so reserve major for a stable milestone). See the [prior releases](https://github.com/athrvk/vayu/releases) for worked examples.

**Release notes are published from a file - no manual paste.** Curated notes for each version live in the repo at `.github/release-notes/vX.Y.Z.md`, committed alongside the version bump (Releasing step 2). On tag push, `.github/workflows/release.yml` reads `.github/release-notes/<tag>.md` and sets it as the GitHub Release body via `softprops/action-gh-release`'s `body_path`. If that file is missing for the tag, the workflow falls back to GitHub's automatically generated PR-based notes (`generate_release_notes`) so a release is never published empty.

**Authoring the notes (Claude's job before tagging).** When preparing a release, write `.github/release-notes/vX.Y.Z.md` in the format above, derived from `git log vPREV..vX.Y.Z`; read a recent entry to match voice. The file *is* the release body, so it needs no tooling to publish - CI handles it. Because the workflow resolves the file from the tagged commit's tree, the notes file must be committed **before** the tag is pushed (i.e., it rides along in the release PR). To correct a published release's notes after the fact, edit the file, then either re-run the release workflow or update the release body by hand.

## Labels and Issue Organization

Repository labels are organized by semantic purpose with a color strategy that separates WHERE changes land (`component:*`, cool/neutral colors) from WHAT kind of change they are (`type:*`, semantic colors) - e.g. `component:engine` (teal) and `type:bug` (red) no longer look alike. **See `.github/LABELING.md` for the full category breakdown, color table, and auto-labeling rules** (driven by `.github/labeler.yml`).

## Docs - keep them in step with the code

**If you change something a doc describes, update that doc in the same commit.**
These are reference material future sessions are told to trust, so a stale line
is worse than a missing one - the design-system doc had drifted five separate
ways before anyone checked.

| Doc | Covers | Update it when you change… |
|-----|--------|----------------------------|
| `docs/architecture.md` | Sidecar pattern, process model | How app and engine talk, lifecycle, ports |
| `docs/building.md` | Cross-platform build notes | `build.py`, prerequisites, platform quirks |
| `docs/design-system.md` | UI tokens, elevation, type, component patterns | Any token value, colour rule, radius, or shared UI primitive |
| `docs/app/COMPONENTS.md` | React structure (`modules/` + `components/`) | Adding or moving a module / shared component |
| `docs/app/architecture.md` | Renderer architecture | Renderer-side structural decisions |
| `docs/app/state-management.md` | Zustand stores + TanStack Query | Adding a store, changing query keys or cache policy |
| `docs/app/api-integration.md` | Renderer ↔ engine calls | Request/response shapes the renderer sends |
| `docs/app/variable-resolution.md` | `{{var}}` resolution + scope precedence | Resolution order, scopes, the resolver hook |
| `docs/app/import-collections/` | Import pipeline + per-format mapping | Detectors, drafts, any format mapping |
| `docs/app/pm-api-compatibility.md` | `pm.*` scripting API surface | Which `pm.*` APIs the runtime supports |
| `docs/app/file-name-conventions.md` | Naming rules | The conventions themselves |
| `docs/app/building.md` | App build | App build steps or tooling |
| `docs/engine/architecture.md` | Engine internals, engine-side auth | Core engine structure, auth resolution |
| `docs/engine/api-reference.md` | Engine HTTP API | **Any** endpoint, payload, or status code |
| `docs/engine/db-schema.md` | SQLite tables + JSON shapes | Schema, migrations, stored JSON |
| `docs/engine/scripting.md` | QuickJS runtime + script API | Script globals, hooks, sandbox limits |
| `docs/engine/mcp.md` | MCP server surface | MCP tools or their schemas |
| `docs/engine/cli.md` | Engine CLI | Flags or subcommands |
| `docs/engine/benchmarks.md` | Perf numbers + method | Load generation or measurement |
| `docs/engine/building.md` | Engine build | CMake presets, vcpkg deps |
| `docs/lock-file-handling.md` | Lock-file strategy | Lock / concurrency behaviour |
| `docs/request-storage-design.md` | Request persistence design | How requests are stored |
| `docs/plans/pending-backlog.md` | Deferred work (e.g. A1) | Deferring something, or picking it up |
| `CONTRIBUTING.md` | PR process, code style | Process or style rules |

Module READMEs carry the *why* for their feature and are easy to miss:
`app/src/modules/README.md`, plus one each for `welcome/`, `request-builder/`
and `dashboard/`.

Release notes live in `.github/release-notes/vX.Y.Z.md` - see **Releasing**.

### `docs/` is published, so a broken link is a build failure

`docs/` ships to <https://athrvk.github.io/vayu/> via MkDocs Material
(`.github/mkdocs.yml`, `.github/workflows/docs.yml`, deps pinned in
`requirements-docs.txt`). `mkdocs build --strict` runs on every docs-touching
pull request and fails on an unresolvable relative `.md` link or a missing
heading anchor, so:

- **Add a new page to the `nav:` in `.github/mkdocs.yml`** in the same commit. Off-nav
  pages build and are reachable by URL, but never appear in the sidebar.
- **Do not rename or move a doc file** without checking for readers. Tests read
  doc paths (`app/src/design-system-doc.test.ts` reads `docs/design-system.md`),
  and every relative cross-link is validated by the build.
- **Anchors follow GitHub's slug rules** (`pymdownx.slugs.slugify` is configured
  for exactly this), so one anchor form works both in GitHub's markdown view and
  on the site. Heading punctuation counts: `## Shared Auth Fields
  (components/shared/AuthFields/)` is `#shared-auth-fields-componentssharedauthfields`.
- **Links out of `docs/`** (`SECURITY.md`, `LICENSE`, `CONTRIBUTING.md`) must be
  absolute `https://github.com/athrvk/vayu/blob/master/...` URLs - those files
  are outside the published tree.
- **Analytics is on the published site only, and only when it has an ID.** The
  GA4 measurement ID comes from the `GOOGLE_ANALYTICS_KEY` Actions *repository
  variable* (Settings -> Secrets and variables -> Actions -> Variables), read by
  `extra.analytics.property` via `!ENV`. With it unset - every fork, every
  pull-request preview, every local `mkdocs serve` - `.github/hooks/analytics.py`
  strips `extra.analytics`, `extra.consent` and the footer's "Cookie settings"
  link, so those builds ship no tracker and no banner. `!ENV` alone does **not**
  do this: Material emits its gtag snippet even for an empty property, which is
  the whole reason that hook exists. On the published site GA is consent-gated -
  the snippet is defined but only runs once the visitor accepts. **This is the
  docs website, not the app**; `no telemetry` in `docs/index.md` and `README.md`
  is a claim about the app and stays true, so keep the two apart when editing
  either.
- **Jekyll is not an option here** and the workflow says why: Pages' default
  Jekyll build runs Liquid over page content, and these docs contain 40+
  `{{variable}}` examples (rendered as empty strings) plus `{% ... %}` (an
  unknown tag, which fails the build). MkDocs never templates page content.

Preview locally with `pip install -r requirements-docs.txt && mkdocs serve -f
.github/mkdocs.yml`. The `-f` is required - the config is not at the repo root -
and the site serves under `/vayu/`. The favicon/logo are not files under `docs/`:
`.github/hooks/brand_assets.py` pulls `shared/icon_png/vayu_icon_256x256.png`
into the build, so do not add a copy.
