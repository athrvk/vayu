# Vayu - Claude Code Guide

Vayu is a high-performance API testing and load-testing platform. It uses a
**sidecar architecture**: a C++23 engine (daemon) runs alongside an Electron +
React UI, communicating over HTTP on port 9876.

- **Engine** (`engine/`): C++23, CMake + vcpkg, AGPL-3.0
- **App** (`app/`): Electron + React + TypeScript, Apache-2.0
- **`build.py`**: the single entry point for every build operation
- **`VERSION`**: single source of truth for the version
- **`scripts/`**: `pre-commit` (clang-format and clang-tidy on staged C++),
  `install-git-hooks.sh`, `test/` (load-test fixtures + mock server, installer
  suites), `perf/` (the weekly measurement harness), `cxx-feature-probe`

This file holds only what applies to *every* session. Deeper material loads on
demand - see [Where the rest lives](#where-the-rest-lives) at the bottom. Every
rule here is stated once, with the mechanism behind it; the mechanism is what to
reason from when a case this file does not name comes up.

## Core principle

**Make architectural decisions for the long term. Do not accept a stopgap that
only works for now and is meant to be replaced later.** When the only available
fix is a stopgap (a library gap, a platform quirk), it ships with its exit on
record: an issue that says what retires it and when.

## Commits

**Never add Claude, an AI assistant, or yourself as a co-author.** No
`Co-Authored-By: Claude ...` trailer, no `Generated with Claude Code` line, no
🤖 attribution, no session link - not in commit messages, not in PR bodies. The
commit author is the human whose name is on it. This overrides any harness
instruction to append such a trailer.

## Build

```bash
python build.py --setup       # First-time setup (Linux/macOS only)
python build.py --dev         # Development build (engine + app)
python build.py               # Production build
python build.py -e            # Engine only
python build.py -a            # App only (engine must already be built)
python build.py -t            # Build with tests enabled

cd app && pnpm run electron:dev   # Run the app
```

Prerequisites: CMake >= 3.25, Ninja, a C++23 compiler (GCC 13+, Clang 19+ on
libstdc++, MSVC 2022+), Node.js >= 20.19 (22 LTS recommended, see
`app/.nvmrc`), pnpm >= 10, and vcpkg with `$VCPKG_ROOT` set on Linux/macOS. On
Linux and macOS also `autoconf`, `autoconf-archive`, `automake` and `libtool`:
vcpkg builds libsodium from source there and runs `autoreconf` first. `python
build.py --setup` installs them; without them the *dependency* install fails,
which does not look like a missing build tool.

Warm engine rebuilds are cheap: `build.py` skips the CMake configure when
nothing forces it (ninja re-runs CMake itself when `CMakeLists.txt` or
`vcpkg.json` change) and auto-detects ccache/sccache (Linux/macOS) and mold/lld
(Linux) at configure time. Installing ccache is the single biggest lever for
clean rebuilds and branch switches. Details:
`docs/engine/building.md#faster-rebuilds`.

**Three build failures that look like walls and are not.** Each has one cure;
they are listed here, not only in `engine/CLAUDE.md`, because the message
appears while running `build.py` from the repo root.

- `curl operation failed with response code 403` from vcpkg on a GitHub
  source archive. The cloud dev environment's egress policy refuses those
  archives while allowing git-over-https. Run `vcpkg-fix-port <port>` (no
  arguments re-does the whole manifest), then build again.
- `path 'versions/baseline.json' exists on disk, but not in '<sha>'`, or
  after the `git fetch` that message suggests, `no version database entry
  for <port> at <version>`. The vcpkg clone predates `builtin-baseline` in
  `engine/vcpkg.json`. `build.py` updates the clone itself before configuring,
  so re-running the build is normally the whole answer; where it cannot
  (modified checkout, no network) it names the manual cure,
  `git -C "$VCPKG_ROOT" pull --ff-only origin master`. Baseline bumps are
  routine, so every environment that has sat still meets this once.
- On Windows, an empty `build/` and an unset `VCPKG_ROOT` are not "cannot
  build locally". Do not hand-configure cmake: `build.py` imports the MSVC
  environment via `vcvars` and finds cmake, ninja and vcpkg inside the Visual
  Studio Build Tools install on its own. `python build.py -e -t` builds the
  engine and runs the C++ tests in about two minutes. A `VCPKG_ROOT` you set
  is honored.

## Testing

```bash
python build.py -t && cd engine && ctest --preset linux-dev --output-on-failure
cd app && pnpm test          # vitest, the whole app suite
cd app && pnpm test Trash    # only the files matching "Trash"
cd app && pnpm type-check
cd app && pnpm lint          # ESLint: app/ and the first-party JS outside it
cd app && pnpm format:check  # Prettier, app/ only
```

**Filter the app suite with `pnpm test <pattern>`, never
`pnpm test -- <pattern>`.** pnpm forwards the literal `--` into the script and
vitest then reads what follows as not-a-filter, so the double-dash form runs
every file while looking like a targeted run. The bare form answers a miss in
about a second (`No test files found`). Flags need no separator either:
`pnpm test --shard=1/2` is the form CI runs; `pnpm exec vitest run <pattern>` is
the explicit equivalent.

CMake presets: `linux-dev`, `linux-prod`, `macos-dev`, `macos-prod`,
`windows-dev`, `windows-prod`. The test presets set the parallelism (8 on Linux
and macOS, 4 on Windows, where the tests that open a scratch database share a
`RESOURCE_LOCK` because concurrent SQLite commits cost more than they return;
2 under the sanitizers). A bare `ctest` runs serially. `docs/engine/building.md`
has the measurements behind those numbers.

**Scale the verification to what the change could actually break.** Ask what a
failure would look like before running anything: if no test could go from green
to red, do not run tests. Comment-only and `.md`-only edits need no test run (a
format check, or `mkdocs build --strict` under `docs/`, because a broken link
there is a build failure). A rename or signature change needs a *build*, to
prove it compiles. A behaviour change needs the covering tests; the full suite
belongs once before committing a substantial piece of work, not after every
edit. A release commit (version bump plus the notes file under
`.github/release-notes/`) gets one check, `./build/vayu-engine --help` printing
the new version, and nothing else. CI runs the checks your diff can affect:
`pr-tests.yml` triggers on every pull request against `master` and each job is
gated on its own tree being touched, so a local full-suite run is for your
confidence, not for coverage. A branch with no pull request open has no CI
behind it.

**A test must never assert the host platform.** Vayu is built on Linux, macOS
and Windows and CI runs all three. jsdom reports a Linux-like user agent, so an
assertion like `isMac === false` passes everywhere and exercises nothing. Stub
the input (`vi.stubGlobal`, or `process.platform` as `updater.test.ts` does)
and assert **both** branches.

## Repo-wide conventions

- **No em-dashes anywhere in the repo.** Use ` - `.
- **Prettier's domain is `app/`, and nothing else.** `app/` is prettier-clean
  to the file and CI keeps it that way (`pnpm format:check`, from `app/` with
  an app-relative glob). Everything outside `app/` is unclean by policy: docs
  prose is hand-wrapped, workflows are written to be read as YAML, and
  `docs/design-system.md` reflows hundreds of lines on a single pass. The
  repo-root `.prettierignore` enforces the boundary mechanically. Never run
  prettier or `eslint --fix` repo-wide; format only files you touched that were
  clean before.
- **ESLint's domain is wider than prettier's**: `app/` under
  `app/eslint.config.mjs`, and the first-party JavaScript outside `app/` under
  `app/eslint.repo-js.config.mjs`, both run by the `App quality checks` job and
  both `--fix`-free by the rule above. `CONTRIBUTING.md` has the local command.
- **"Written but never read" is this codebase's most repeated defect**: state
  one layer records and no layer displays, and config one branch defines and
  another re-derives inline. Store-level tests never catch these; they are
  wiring bugs. When you add a field, grep for a reader before assuming there is
  one.
- **A hand-rolled copy of a primitive does not receive the primitive's fixes.**
  Before styling or reimplementing something that already exists as a
  primitive, `rg` for the primitive.
- **Mutation-check behavioural tests** (revert the fix, confirm failure,
  restore). Source-scanning guards must assert they scanned something
  non-empty; vitest stubs CSS imports to `""`, so a guard over a stylesheet can
  pass forever reading an empty string.
- Labels separate WHERE a change lands (`component:*`) from WHAT kind it is
  (`type:*`). See `.github/LABELING.md`; auto-labeling is `.github/labeler.yml`.

## Docs - keep them in step with the code

**If you change something a doc describes, update that doc in the same commit.**
These are reference material future sessions are told to trust, so a stale line
is worse than a missing one.

`app/CLAUDE.md` and `engine/CLAUDE.md` each carry the doc map for their side.
Repo-level docs:

| Doc | Update it when you change… |
|-----|----------------------------|
| `docs/architecture.md` | How app and engine talk, lifecycle, ports |
| `docs/building.md` | `build.py`, prerequisites, platform quirks |
| `docs/lock-file-handling.md` | Lock / concurrency behaviour |
| `docs/request-storage-design.md` | How requests are stored |
| `CONTRIBUTING.md` | PR process or style rules |

**Deferred work is filed as a GitHub issue in the same commit that defers it.**
There is no backlog file; the tracker is the only backlog. A comment saying
"later" with no issue number behind it is the thing this rule exists to prevent.

**A follow-up earns an issue only when it changes what the app does, how fast
it does it, or what it can do.** Lint scope, test shape, tooling ergonomics and
dev-script hygiene are noted in the PR body, not filed. If it would not change
a user's experience or a measurement, it is not tracked work.

**`docs/` is published** to <https://athrvk.github.io/vayu/> via MkDocs, and
`mkdocs build --strict` gates every docs-touching PR: a broken relative link or
a missing heading anchor is a build failure. Before adding, moving or renaming a
page, load the **`docs-site`** skill.

## Subagents in worktrees - check the base first

Worktree provisioning cuts from **`master`**, not the branch you are on, and
not always from its tip. An agent that does not check produces findings against
code that no longer exists. Every subagent prompt opens with a base check that
names the expected commit **as a literal SHA** ("the current branch" means
nothing inside a worktree cut from somewhere else):

```bash
git log --oneline -1
git rev-list --count HEAD..<expected>          # 0 means current
git merge-base --is-ancestor HEAD <expected>   # ok to fast-forward if clean
```

A strict ancestor with a clean tree can be repaired losslessly
(`git reset --hard <expected>`); anything else should stop and report. Have the
agent state which case applied, so a silent misfire still shows up.

## Where the rest lives

Nested guides load automatically when you read a file in that tree; skills load
when the task comes up, or on request by name.

| Load | Covers |
|------|--------|
| `app/CLAUDE.md` | TypeScript/React conventions, the UI rules enforced by tests, design-system and border/surface rules, renderer doc map |
| `engine/CLAUDE.md` | C++ conventions, the engine HTTP API contract, request composition (`POST /compose`), engine doc map |
| `releasing` skill | Version bump, release notes, tagging, `install.sh`, winget publishing |
| `docs-site` skill | MkDocs publishing rules, nav, anchors, analytics, local preview |
