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
- vcpkg with `$VCPKG_ROOT` set
- Node.js ≥ 20.19 (22 LTS recommended - see `app/.nvmrc`), pnpm ≥ 10

Run `python build.py --setup` to install all prerequisites automatically (Linux/macOS only).

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

### Type checking

```bash
cd app && pnpm type-check
```

### Linting

```bash
cd app && pnpm lint                # ESLint (TS/TSX)
cd app && pnpm format:check        # Prettier
```

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

## Engine HTTP API

The engine daemon listens on `http://127.0.0.1:9876`. Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/request` | Send a single request (auth resolved engine-side) |
| POST | `/run` | Start a load test run |
| GET | `/metrics/live/:runId` | SSE stream of live metrics |
| GET | `/stats/:runId` | Historical stats for a run |
| POST | `/oauth2/token` | Acquire/return a cached OAuth 2.0 token (auth resolved engine-side) |
| GET | `/health` | Health check |

See `docs/engine/api-reference.md` for full reference.

## Request composition (known duplication — do not add a third copy)

Preparing a request before it executes — resolving `{{variables}}`, resolving
`inherit` auth via the collection-chain walk, and composing the collection-chain +
request pre/post scripts — happens **client-side** today, and is therefore
**duplicated** across the two engine clients:

- **Renderer:** `app/src/hooks/useVariableResolver.ts` + inline in
  `app/src/modules/request-builder/index.tsx` + `utils/auth-mapping.ts`.
- **MCP:** `app/electron/mcp/resolve.ts`.

The engine does the rest of execution (loads variables for script context, applies
concrete auth incl. OAuth2, runs scripts) but intentionally does **no** `{{var}}`
interpolation and drops `{"mode":"inherit"}` as "resolved app-side". If you change
resolution/auth/script semantics, **change both client copies together** and keep
them in sync (guarded by `app/electron/mcp/resolve.test.ts`). **Do not add a third
copy** — a new engine client should reuse `resolve.ts`. The intended long-term fix
(consolidate composition into the engine) is deferred and documented in
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

**Release notes are published from a file — no manual paste.** Curated notes for each version live in the repo at `.github/release-notes/vX.Y.Z.md`, committed alongside the version bump (Releasing step 2). On tag push, `.github/workflows/release.yml` reads `.github/release-notes/<tag>.md` and sets it as the GitHub Release body via `softprops/action-gh-release`'s `body_path`. If that file is missing for the tag, the workflow falls back to GitHub's automatically generated PR-based notes (`generate_release_notes`) so a release is never published empty.

**Authoring the notes (Claude's job before tagging).** When preparing a release, write `.github/release-notes/vX.Y.Z.md` in the format above, derived from `git log vPREV..vX.Y.Z`; read a recent entry to match voice. The file *is* the release body, so it needs no tooling to publish — CI handles it. Because the workflow resolves the file from the tagged commit's tree, the notes file must be committed **before** the tag is pushed (i.e., it rides along in the release PR). To correct a published release's notes after the fact, edit the file, then either re-run the release workflow or update the release body by hand.

## Key Docs

- `docs/architecture.md` - sidecar pattern details
- `docs/building.md` - platform-specific build notes
- `docs/design-system.md` - UI tokens, elevation, component patterns, typography
- `docs/app/COMPONENTS.md` - React component architecture (`modules/` + `components/`)
- `docs/app/import-collections/` - import parser pipeline + per-format mapping (Postman/Insomnia/OpenAPI)
- `docs/engine/api-reference.md` - engine HTTP API
- `docs/engine/architecture.md` - engine internals, incl. engine-side auth resolution (bearer/basic/apikey/oauth2)
- `docs/engine/db-schema.md` - SQLite tables and JSON shapes (runs, metrics, oauth_tokens)
- `CONTRIBUTING.md` - PR process and code style
