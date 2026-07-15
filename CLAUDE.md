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
│   ├── vendor/            # Vendored deps (QuickJS etc.)
│   ├── CMakeLists.txt
│   ├── CMakePresets.json
│   └── vcpkg.json         # curl, nlohmann-json, cpp-httplib, gtest, sqlite3, sqlite-orm
├── app/
│   ├── src/               # React + TypeScript UI
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
- Node.js ≥ 20.19 (22 LTS recommended - see `.nvmrc`), pnpm ≥ 10

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
- App UI is feature-organized: `app/src/modules/<feature>/` (request-builder, collections, dashboard, history, variables, settings, welcome); shared shell + primitives in `app/src/components/` (layout, ui, shared, status). See `docs/app/COMPONENTS.md`.
- Import parsers: `app/src/services/importers/` (factory → ordered detectors → drafts → orchestrator); per-format docs in `docs/app/import-collections/`.
- State: Zustand for UI state, TanStack Query for server state
- Styling: Tailwind CSS v4 - all colors via CSS custom properties; see `docs/design-system.md`
- **Design system:** `docs/design-system.md` - tokens, elevation, typography, component patterns. Read this before touching any UI file.

## Engine HTTP API

The engine daemon listens on `http://127.0.0.1:9876`. Key endpoints:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/run` | Start a load test run |
| GET | `/metrics/live/:runId` | SSE stream of live metrics |
| GET | `/stats/:runId` | Historical stats for a run |
| POST | `/oauth2/token` | Acquire/return a cached OAuth 2.0 token (auth resolved engine-side) |
| GET | `/health` | Health check |

See `docs/engine/api-reference.md` for full reference.

## Releasing

1. `python build.py --bump-version patch` - updates VERSION, CMakeLists.txt, vcpkg.json, package.json
2. Commit: `git commit -m "chore(release): x.y.z"`
3. Tag: `git tag v$(cat VERSION) && git push origin --tags`
4. CI builds and uploads installers automatically.

macOS also ships a one-command installer: `install.sh` (repo root) downloads the release zip, ad-hoc signs the app + sidecar on-device, and strips quarantine (no Apple Developer cert). Unit-tested via `scripts/test/install_test.sh` (set `VAYU_DRYRUN=1`), shellchecked in CI on Linux + macOS.

## Key Docs

- `docs/architecture.md` - sidecar pattern details
- `docs/building.md` - platform-specific build notes
- `docs/design-system.md` - UI tokens, elevation, component patterns, typography
- `docs/app/COMPONENTS.md` - React component architecture (`modules/` + `components/`)
- `docs/app/import-collections/` - import parser pipeline + per-format mapping (Postman/Insomnia/OpenAPI)
- `docs/engine/api-reference.md` - engine HTTP API
- `CONTRIBUTING.md` - PR process and code style
