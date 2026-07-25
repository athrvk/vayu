# Vayu Repository Labels

This document describes the labeling system used in the athrvk/vayu repository. Labels help categorize issues and pull requests, making it easier to navigate, filter, and prioritize work.

## Quick Reference

```
Component (Auto-Applied) - WHERE            Type (Manual, pick one) - WHAT
  component:app       🔵  UI                  type:bug           🔴  Broken behavior
  component:engine    🟦  Engine core          type:feature       🟢  New capability
  component:database  🟪  Storage              type:enhancement   🔵  Improvement
  component:ci        ⚪  CI config            type:perf          🟧  Speed/resource
  component:build     ⚫  Build system         type:test          🟦  Tests/benchmarks

Area (engine sub-areas, auto-applied)        Status (PRs, manual)
  area:http       HTTP server, SSE             status:needs-review  🟧  Awaiting review
  area:auth       OAuth2, authentication        status:blocked       🔴  Waiting on something
  area:metrics    Metrics, statistics           status:ready-merge   🟢  Approved

                                              Priority (issues, manual)
Special                                        priority:critical  🔴  Blocks other work
  documentation      🔵  Docs, guides           priority:high      🟧  Important
  good first issue   🟦  Newcomer-friendly      priority:low       🟢  Nice-to-have
  help wanted        🟪  Needs expertise
  severity:blocking  🔴  Breaking change
  dependencies       ⚪  Dependency updates
```

## Label Categories

### Component Labels (`component:*`)

These labels indicate **where** in the codebase a change lands. **Applied automatically** by path-based rules in `.github/labeler.yml`. Component labels use **cool/neutral colors** (blue, teal, purple, gray) to visually distinguish them from type labels.

| Label | Color | Description | Auto-applied when |
|-------|-------|-------------|------------------|
| `component:app` | Blue (#3498DB) | Electron + React UI | Changes in `app/**` |
| `component:engine` | Teal (#16A085) | C++20 engine (daemon, HTTP, scripting) | Changes in `engine/**` |
| `component:database` | Purple (#8E44AD) | Database schema, SQLite persistence | Changes in `engine/src/db/**`, `engine/tests/db_test.cpp`, etc. |
| `component:ci` | Gray (#95A5A6) | GitHub Actions, CI configuration | Changes in `.github/**` |
| `component:build` | Dark Gray (#7F8C8D) | CMake, vcpkg, version, build script | Changes to `build.py`, `VERSION`, etc. |

**Note:** `component:database` is a subset of `component:engine`, so database changes earn both labels.

### Area Labels (`area:*`)

These labels narrow down sub-areas **within the engine**. Useful for routing engine changes to appropriate reviewers. These are path-based and not manually applied.

| Label | Description | Applies to |
|-------|-------------|-----------|
| `area:http` | HTTP server, routes, SSE, request/response handling | `engine/src/http/**` |
| `area:auth` | Authentication, OAuth2, authorization | `auth_resolver*`, `oauth*` files under `engine/src/http/` and `engine/include/vayu/http/` - also matches `area:http`, since auth lives there |
| `area:metrics` | Metrics collection, statistics, measurement | `metrics_collector*`, `metrics_helper*` files (src, include, and the HTTP metrics route) |
| `area:scripting` | QuickJS runtime, script execution, pm.* API | `engine/src/runtime/**` |

### Type Labels (`type:*`)

These labels describe the **kind of change** (the WHAT). **Applied manually**—they describe intent, not just what files were touched. Pick the single most appropriate type. Type labels use **semantic colors** (red for problems, green for features, blue for improvements, amber for warnings/optimization) to visually distinguish them from component labels.

| Label | Color | Description | Use when |
|-------|-------|-------------|----------|
| `type:bug` | Red (#E74C3C) | Bug fix | Fixing broken behavior |
| `type:feature` | Green (#27AE60) | New user-facing feature | Adding a new capability users can see |
| `type:enhancement` | Blue (#3498DB) | Enhancement to existing feature | Improving an existing feature |
| `type:perf` | Amber (#F39C12) | Performance optimization | Improving speed, latency, or resource use |
| `type:test` | Teal (#16A085) | Tests, benchmarks, test infrastructure | Adding or improving tests |

### Status Labels (`status:*`)

These labels track the **workflow state** of a pull request. Applied manually by reviewers.

| Label | Color | Meaning | Use when |
|-------|-------|---------|----------|
| `status:needs-review` | Amber (#F39C12) | Awaiting review | PR is ready but hasn't been reviewed yet |
| `status:blocked` | Dark red (#C0392B) | Blocked | PR is waiting on something external (another PR, CI fix, decision) |
| `status:ready-merge` | Green (#27AE60) | Ready to merge | PR is approved and ready to go in |

### Priority Labels (`priority:*`)

These labels indicate **urgency**. Apply manually based on impact and timeline.

| Label | Color | Meaning |
|-------|-------|---------|
| `priority:critical` | Dark red (#C0392B) | Needs immediate attention; blocks other work |
| `priority:high` | Amber (#F39C12) | Important, should be tackled soon |
| `priority:low` | Green (#27AE60) | Nice-to-have, can wait |

### Severity Labels

| Label | Color | Meaning | Use when |
|-------|-------|---------|----------|
| `severity:blocking` | Red (#E74C3C) | Breaking change or blocking issue | Change breaks existing behavior or API |
| `breaking-change` | Red (#E74C3C) | Major version bump required | Synonym for severity:blocking |

### Special Labels

| Label | Color | Description | Use when |
|-------|-------|-------------|----------|
| `documentation` | Blue (#3498DB) | Documentation, guides, examples | Changes to docs or a PR needs doc updates |
| `good first issue` | Teal (#16A085) | Good for newcomers to tackle | Issue suitable for a first-time contributor |
| `help wanted` | Purple (#8E44AD) | Extra attention or help needed | Issue is in scope but we need outside expertise |
| `dependencies` | Gray (#95A5A6) | Dependency updates | Updating packages or dependencies |
| `duplicate` | Light gray (#BBBFC4) | This issue or PR already exists | Close as duplicate |
| `wontfix` | Light gray (#BBBFC4) | This will not be worked on | Close issue that won't be addressed |
| `invalid` | Light gray (#BBBFC4) | Invalid or incomplete | Close issue that's not applicable |
| `question` | Gold (#D4AF37) | Further information is requested | Issue needs clarification |
| `github_actions` | Gray (#95A5A6) | GitHub Actions related | Workflows or action-specific issues |
| `flaky` | Amber (#F39C12) | Flaky test or unreliable behavior | Test intermittently fails |
| `memory-leak` | Red (#E74C3C) | Memory leak detected | Suspected or confirmed memory leak |
| `performance` | Amber (#F39C12) | Performance-related issue | Used for tracking perf problems (use `type:perf` for PRs) |
| `scripting` | Gray (#95A5A6) | QuickJS scripting engine | Runtime or script-related |
| `build` | Gray (#95A5A6) | Build-related | Used manually; path-based label is `component:build` |
| `ci` | Gray (#95A5A6) | CI/CD related | Used manually; path-based label is `component:ci` |
| `correctness` | Red (#E74C3C) | Correctness issue | Logic error or incorrect behavior |

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
- **`component:database`** → `engine/src/db/**`, `engine/include/vayu/db/**`, `engine/tests/db_test.cpp`, `engine/tests/db_concurrency_test.cpp`
- **`component:ci`** → `.github/**`
- **`component:build`** → `build.py`, `VERSION`, CMake files, vcpkg.json, `app/package.json`, `scripts/**`, etc.
- **`documentation`** → `docs/**`, `**/*.md`
- **`area:http`** → `engine/src/http/**`
- **`area:auth`** → `auth_resolver*`, `oauth*` files under `engine/src/http/`
- **`area:metrics`** → `metrics_collector*`, `metrics_helper*` files
- **`area:scripting`** → `engine/src/runtime/**`

`component:database` and `area:*` rules are kept strictly inside `engine/**` -
a `docs/engine/*.md` change earns `documentation`, not a component/area label
for code it never touched.

If a PR changes files in multiple categories, it gets all matching labels. A release PR touching `app/`, `engine/`, and build files will earn `component:app`, `component:engine`, and `component:build`.

## Label Colors and Semantics

Colors follow a **two-part strategy** for semantic clarity:

### Component Labels (WHERE) — Cool/Neutral Colors
Component labels use **cool and neutral colors** to describe where changes land:
- **Blue (#3498DB):** App (Electron + React UI)
- **Teal (#16A085):** Engine (C++20 core)
- **Purple (#8E44AD):** Database (storage)
- **Gray (#95A5A6, #7F8C8D):** Infrastructure (CI, build)

### Type Labels (WHAT) — Semantic Colors
Type labels use **semantic colors** to describe what kind of change:
- **Red (#E74C3C):** Bug (problem/breaking)
- **Green (#27AE60):** Feature (new/success)
- **Blue (#3498DB):** Enhancement (improvement)
- **Amber (#F39C12):** Performance/Warning (optimization/caution)
- **Teal (#16A085):** Test (quality)

### Status/Priority — Action Colors
Status and priority labels use semantic colors for workflow clarity:
- **Red (#C0392B, #E74C3C):** Blocking, critical, urgent
- **Amber (#F39C12):** Waiting, high priority
- **Green (#27AE60):** Ready, low priority, success

**Why this separation matters:** When scanning a PR, component colors (cool/neutral) instantly show WHERE changes land, while type colors (semantic) show WHAT kind of work. This visual separation makes label intent unmistakable at a glance—for example, `component:engine` (teal) and `type:bug` (red) no longer look alike.

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

- Auto-labels: `component:engine`, `area:http`, `area:auth` (auth code lives under `engine/src/http/`, so both area labels apply)
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

## Applying Labels to the Repository

There is no script in this repo for creating/updating GitHub labels—label colors and descriptions above must be applied directly in the repository's label settings (**Settings → Labels**) or via the GitHub API/CLI (`gh label create` / `gh label edit`) by someone with write access. Existing labels not covered above (manual `priority:*`, `status:*`, etc.) are created on first use.
