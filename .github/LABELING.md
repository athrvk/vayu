# Vayu Repository Labels

This document describes the labeling system used in the athrvk/vayu repository. Labels help categorize issues and pull requests, making it easier to navigate, filter, and prioritize work.

## Label Categories

### Component Labels (`component:*`)

These labels indicate where in the codebase a change lands. **Applied automatically** by path-based rules in `.github/labeler.yml`.

| Label | Color | Description | Auto-applied when |
|-------|-------|-------------|------------------|
| `component:app` | Blue | Electron + React UI | Changes in `app/**` |
| `component:engine` | Orange | C++20 engine (daemon, HTTP, scripting) | Changes in `engine/**` |
| `component:database` | Red-orange | Database schema, SQLite persistence | Changes in `engine/src/db/**`, `engine/tests/db_test.cpp`, etc. |
| `component:ci` | Gray | GitHub Actions, CI configuration | Changes in `.github/**` |
| `component:build` | Gray | CMake, vcpkg, version, build script | Changes to `build.py`, `VERSION`, etc. |

**Note:** `component:database` is a subset of `component:engine`, so database changes earn both labels.

### Area Labels (`area:*`)

These labels narrow down sub-areas **within the engine**. Useful for routing engine changes to appropriate reviewers. These are path-based and not manually applied.

| Label | Description | Applies to |
|-------|-------------|-----------|
| `area:http` | HTTP server, routes, SSE, request/response handling | `engine/src/http/**` |
| `area:auth` | Authentication, OAuth2, authorization | Auth-related engine code |
| `area:metrics` | Metrics collection, statistics, measurement | `metrics_collector*` files |
| `area:scripting` | QuickJS runtime, script execution, pm.* API | `engine/src/runtime/**` |

### Type Labels (`type:*`)

These labels describe the **kind of change**. **Applied manually**—they describe intent, not just what files were touched. Pick the single most appropriate type.

| Label | Color | Description | Use when |
|-------|-------|-------------|----------|
| `type:bug` | Red | Bug fix | Fixing broken behavior |
| `type:feature` | Purple | New user-facing feature | Adding a new capability users can see |
| `type:enhancement` | Blue | Enhancement to existing feature | Improving an existing feature |
| `type:perf` | Orange | Performance optimization | Improving speed, latency, or resource use |
| `type:test` | Teal | Tests, benchmarks, test infrastructure | Adding or improving tests |

### Status Labels (`status:*`)

These labels track the **workflow state** of a pull request. Applied manually by reviewers.

| Label | Color | Meaning | Use when |
|-------|-------|---------|----------|
| `status:needs-review` | Amber | Awaiting review | PR is ready but hasn't been reviewed yet |
| `status:blocked` | Dark red | Blocked | PR is waiting on something external (another PR, CI fix, decision) |
| `status:ready-merge` | Green | Ready to merge | PR is approved and ready to go in |

### Priority Labels (`priority:*`)

These labels indicate **urgency**. Apply manually based on impact and timeline.

| Label | Color | Meaning |
|-------|-------|---------|
| `priority:critical` | Dark red | Needs immediate attention; blocks other work |
| `priority:high` | Amber | Important, should be tackled soon |
| `priority:low` | Green | Nice-to-have, can wait |

### Severity Labels

| Label | Color | Meaning | Use when |
|-------|-------|---------|----------|
| `severity:blocking` | Red | Breaking change or blocking issue | Change breaks existing behavior or API |
| `breaking-change` | Red | Major version bump required | Synonym for severity:blocking |

### Special Labels

| Label | Color | Description | Use when |
|-------|-------|-------------|----------|
| `documentation` | Blue | Documentation, guides, examples | Changes to docs or a PR needs doc updates |
| `good first issue` | Teal | Good for newcomers to tackle | Issue suitable for a first-time contributor |
| `help wanted` | Purple | Extra attention or help needed | Issue is in scope but we need outside expertise |
| `dependencies` | Gray | Dependency updates | Updating packages or dependencies |
| `duplicate` | Light gray | This issue or PR already exists | Close as duplicate |
| `wontfix` | Light gray | This will not be worked on | Close issue that won't be addressed |
| `invalid` | Light gray | Invalid or incomplete | Close issue that's not applicable |
| `question` | Gold | Further information is requested | Issue needs clarification |
| `github_actions` | Gray | GitHub Actions related | Workflows or action-specific issues |
| `flaky` | Orange | Flaky test or unreliable behavior | Test intermittently fails |
| `memory-leak` | Red | Memory leak detected | Suspected or confirmed memory leak |
| `performance` | Orange | Performance-related issue | Used for tracking perf problems (use `type:perf` for PRs) |
| `scripting` | Gray | QuickJS scripting engine | Runtime or script-related |
| `build` | Gray | Build-related | Used manually; path-based label is `component:build` |
| `ci` | Gray | CI/CD related | Used manually; path-based label is `component:ci` |
| `correctness` | Red | Correctness issue | Logic error or incorrect behavior |

## Labeling Guidelines

### For Issues

1. **Component:** Add one `component:*` label to indicate where the issue lives. This may be auto-applied if the issue references a specific file.
2. **Type:** Add one `type:*` label to indicate what kind of work it is.
3. **Priority:** Add one `priority:*` label if it's urgent.
4. **Area (engine only):** Add an `area:*` label if it's an engine issue that fits a sub-area.
5. **Special:** Add special labels as needed (`good first issue`, `help wanted`, `documentation`, etc.).

### For Pull Requests

1. **Component:** Auto-applied based on changed files. Override if the labeler got it wrong.
2. **Type:** Applied manually to describe the kind of change.
3. **Area (engine only):** Auto-applied for engine files in a sub-area.
4. **Status:** Apply `status:needs-review` when ready, update to `status:ready-merge` when approved.
5. **Special:** Add as needed.

**Note:** `priority:*` and `severity:*` labels are usually for issues, not PRs. If a PR is urgent, that's what merge urgency is for.

## Automated Labeling

The `.github/labeler.yml` file defines path-based rules that automatically apply component and area labels to pull requests when they touch certain files. The labeler runs on every PR open/update via `.github/workflows/labeler.yml`.

### Current Auto-Labeling Rules

- **`component:app`** → `app/**`
- **`component:engine`** → `engine/**`
- **`component:database`** → `engine/src/db/**`, `engine/include/vayu/db/**`, `engine/tests/db_test.cpp`, `docs/engine/db-schema.md`
- **`component:ci`** → `.github/**`
- **`component:build`** → `build.py`, `VERSION`, CMake files, vcpkg.json, `app/package.json`, etc.
- **`documentation`** → `docs/**`, `**/*.md`
- **`area:http`** → `engine/src/http/**`
- **`area:auth`** → Auth-related engine code
- **`area:metrics`** → Metrics-related engine code
- **`area:scripting`** → `engine/src/runtime/**`

If a PR changes files in multiple categories, it gets all matching labels. A release PR touching `app/`, `engine/`, and build files will earn `component:app`, `component:engine`, and `component:build`.

## Setting Up Labels

### Initial Setup

To create all labels in a new repository:

```bash
python3 .github/scripts/setup-labels.py
```

This script:
- Creates new labels according to the schema above
- Updates existing labels if colors or descriptions have changed
- Requires `GITHUB_TOKEN` with `repo` scope

### Keeping Labels in Sync

The label schema is defined in `.github/scripts/setup-labels.py`. When the schema changes:

1. Update `setup-labels.py` with the new definitions
2. Run the script to sync the repository

## Label Colors and Semantics

Colors are chosen for **semantic meaning**, not just aesthetics:

- **Warm colors (orange, red):** Critical issues, core components, performance, blocking
- **Cool colors (blue):** App, UI, general features
- **Gray:** Infrastructure, sub-areas, build, CI
- **Green:** Ready, success, low priority
- **Purple:** Features, help wanted
- **Teal:** Testing, good first issues

This makes scanning a list of labels quick: warm labels jump out as urgent or important, cool labels indicate app work, gray indicates infrastructure.

## Migration from Old Labels

This labeling system represents a migration from simpler, flat labels:

- Old `app`, `engine`, `database` → New `component:app`, `component:engine`, `component:database`
- Old `ci`, `build` → New `component:ci`, `component:build`
- Manual type/priority labels remain but are now organized into named categories

Existing issues and PRs keep their old labels; they are not retroactively updated. New work uses the new schema.

## Examples

### A bug fix in the app's dashboard

- Auto-labels: `component:app`
- Manual labels: `type:bug`

### A new OAuth 2.0 feature in the engine

- Auto-labels: `component:engine`, `area:auth`
- Manual labels: `type:feature`, `priority:high`, `status:needs-review`

### A database schema migration

- Auto-labels: `component:engine`, `component:database`
- Manual labels: `type:enhancement`, `documentation` (if adding schema docs)

### A performance improvement to the request scheduler

- Auto-labels: `component:engine`, `area:http`
- Manual labels: `type:perf`, `priority:high`

### A test for the QuickJS sandbox

- Auto-labels: `component:engine`, `area:scripting`
- Manual labels: `type:test`
