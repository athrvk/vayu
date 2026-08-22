# Vayu - Claude Code Guide

Vayu is a high-performance API testing and load-testing platform. It uses a
**sidecar architecture**: a C++20 engine (daemon) runs alongside an Electron +
React UI, communicating over HTTP on port 9876.

- **Engine** (`engine/`): C++20, CMake + vcpkg, AGPL-3.0
- **App** (`app/`): Electron + React + TypeScript, Apache-2.0
- **`build.py`**: the single entry point for every build operation
- **`VERSION`**: single source of truth for the version
- **`scripts/`**: `pre-commit` (clang-format and clang-tidy on staged C++),
  `install-git-hooks.sh`,
  and `test/` (load-test fixtures + mock server, installer suites)

This file holds only what applies to *every* session. Deeper material loads on
demand - see [Where the rest lives](#where-the-rest-lives) at the bottom.

## Core principle

**Make architectural decisions for the long term. Do not accept a stopgap that
only works for now and is meant to be replaced later.**

## Commits

**Never add Claude, an AI assistant, or yourself as a co-author.** No
`Co-Authored-By: Claude ...` trailer, no `Generated with Claude Code` line, no
🤖 attribution - not in commit messages, not in PR bodies. The commit author is
the human whose name is on it.

This **overrides the default instruction** to append that trailer, which some
harnesses inject automatically. If you find yourself writing a `Co-Authored-By`
line naming a model, delete it before committing.

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

Prerequisites: CMake >= 3.25, Ninja, a C++20 compiler, Node.js >= 20.19 (22 LTS
recommended, see `app/.nvmrc`), pnpm >= 10, and vcpkg with `$VCPKG_ROOT` set on
Linux/macOS. On Linux and macOS also `autoconf`, `autoconf-archive`, `automake`
and `libtool` - vcpkg builds libsodium from source there and runs `autoreconf`
first. `python build.py --setup` installs them; without them the *dependency*
install fails, which does not look like a missing build tool.

**A `403` from vcpkg on a GitHub source archive is not a dependency you cannot
have.** In the cloud dev environment the egress policy refuses those archives
while allowing git-over-https, so a port fetched by `vcpkg_from_github` dies on
a cold cache with `curl operation failed with response code 403` - which reads
like a wall and is one command: `vcpkg-fix-port <port>` (no arguments re-does
the whole manifest), then build again. It is repeated here rather than left in
`engine/CLAUDE.md` alone because the message appears while running `build.py`
from the repo root, and a session that has not opened a file under `engine/`
never loads that file - one did, read the 403 as policy, and abandoned a phase
of #625 over it. Full note there.

**A vcpkg clone older than the pinned baseline is not a corrupt registry.** It
fails once per dependency with `path 'versions/baseline.json' exists on disk,
but not in '<sha>'`, and - once someone runs the `git fetch` that error
suggests - with `no version database entry for <port> at <version>`. Both mean
the clone predates `builtin-baseline` in `engine/vcpkg.json`; the second is the
half-cured state, because vcpkg reads the baseline map out of that commit but
the version database out of the *worktree*. `build.py` now updates the clone
itself before configuring, so re-running the build is normally the whole answer;
where it cannot (modified checkout, no network) it names the manual cure,
`git -C "$VCPKG_ROOT" pull --ff-only origin master`. Baseline bumps are routine
by design - the releasing cadence examines the pin every release - so this is on
the path of every environment that has sat still, which is why it is written
down next to the 403 rather than left to be rediscovered.

**On Windows, do not hand-configure cmake or set `VCPKG_ROOT` - just run
`build.py`.** It imports the MSVC environment via `vcvars` and finds cmake,
ninja and vcpkg inside the Visual Studio Build Tools install
(`...\BuildTools\VC\vcpkg`) on its own, so an unset `VCPKG_ROOT` is fine. Poking
at the build tree directly (empty `build/`, no `VCPKG_ROOT`) looks like "can't
build locally" when `python build.py -e -t` builds the engine and runs the C++
tests in ~2 min. If you keep vcpkg elsewhere, set `VCPKG_ROOT` and it is honored.

## Testing

```bash
python build.py -t && cd engine && ctest --preset linux-dev --output-on-failure
cd app && pnpm test          # vitest
cd app && pnpm type-check
cd app && pnpm lint          # ESLint (TS/TSX)
cd app && pnpm format:check  # Prettier
```

CMake presets: `linux-dev`, `linux-prod`, `macos-dev`, `macos-prod`,
`windows-dev`, `windows-prod`.

**Scale the verification to what the change could actually break.** Comment-only
and `.md`-only edits need no test run at all - a format check, or nothing. A
rename or signature change needs a *build*, to prove it still compiles. Only a
behaviour change needs the covering tests, and the full suite belongs once
before committing a substantial piece of work, not after every edit.

The engine suite now runs multi-process on every platform - the test presets
pass `ctest -j8`, cutting its wall time on Linux and macOS to roughly a fifth
(each ctest test runs in its own process under a private scratch directory, so
`-j` is safe; `ctest -jN` overrides). **Windows runs `-j4` with the tests that
open a scratch database sharing a CTest `RESOURCE_LOCK`** - a plain `-j` there
measured ~6x *slower* than serial, because concurrent SQLite commits cost more
than the concurrency returns, so those tests never overlap while the rest of the
suite does. They are 81% of the serial wall, so Windows lands near its old
serial time rather than at a fifth of it - the lock makes `-j4` survivable
there, it does not make it fast; see `docs/engine/building.md`. A
rebuild ~2.5min; the app suite ~90s. Running
both after retouching a doc comment reads as diligence and is just latency. Ask
what a failure would even look like before running anything: **if no test could
possibly go from green to red, do not run tests.** CI runs the full matrix on
every push, so a local full-suite run is for *your* confidence, not for coverage.

Concrete cases where the answer is simply "don't":

- **A release commit** (version bump plus the notes file under
  `.github/release-notes/`). Every edit is a version string or Markdown. The
  version stamp is worth one cheap check - `./build/vayu-engine --help` prints
  it - and nothing else. Do not rebuild the engine or run either suite.
- **Adding or rewording a doc, a comment, or a commit-adjacent file.**
  `mkdocs build --strict` if the change is under `docs/`, because a broken
  relative link is a *build* failure; no suites.
- **A rename with no behaviour change.** A build, to prove it compiles. Not the
  suites.

The distinction is whether a test could plausibly change colour, not how large
the diff looks. A 400-line docs commit is still a docs commit; a two-character
edit to a comparison operator is not.

**A test must never assert the host platform.** Vayu is built on Linux, macOS
and Windows and CI runs all three. `platform.test.ts` asserted `isMac === false`
and called that "the test environment"; it was true only because jsdom reports
a Linux-ish user-agent, so the macOS branch was never exercised anywhere. Stub
the input (`vi.stubGlobal`, or `process.platform` as `updater.test.ts` does) and
assert **both** branches.

## Repo-wide conventions

- **No em-dashes anywhere in the repo.** Use ` - `.
- **Never run prettier or `eslint --fix` repo-wide**, and never format
  `docs/design-system.md` - a run reflows ~480 lines of it. The split is not
  "most of the tree isn't clean": `app/` is prettier-clean to the file and CI
  keeps it that way (`pnpm format:check`, from `app/` with an app-relative
  glob), while everything *outside* `app/` is unclean by policy - 64 of the 71
  Markdown and workflow files there fail a check. The repo-root
  `.prettierignore` now enforces that boundary mechanically: prettier's domain
  is `app/`, so a root-resolved run or an editor's format-on-save cannot reflow
  a doc. Format only files you touched that were clean before.
- **"Written but never read" is this codebase's most repeated defect** - found
  nine times: state one layer records and no layer displays (SSE errors,
  save-failure reasons, an import phase, parsed cookie attributes), and config
  one branch defines and another re-derives inline (`SCOPE_CONFIG.global`).
  Store-level tests never catch these; they are wiring bugs. When you add a
  field, grep for a reader before assuming there is one.
- **A hand-rolled copy of a primitive does not receive the primitive's fixes.**
  Before styling or reimplementing something that already exists as a primitive,
  `rg` for the primitive.
- **Mutation-check behavioural tests** (revert the fix, confirm failure,
  restore). Source-scanning guards must assert they scanned something non-empty
  - one passed for weeks reading an empty string, since vitest stubs CSS imports
  to `""`.
- Labels separate WHERE a change lands (`component:*`) from WHAT kind it is
  (`type:*`). See `.github/LABELING.md`; auto-labeling is `.github/labeler.yml`.

## Docs - keep them in step with the code

**If you change something a doc describes, update that doc in the same commit.**
These are reference material future sessions are told to trust, so a stale line
is worse than a missing one - the design-system doc had drifted five separate
ways before anyone checked.

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
There is no backlog file - the tracker is the only backlog (#694 retired the
last one, every entry having shipped, moved to an issue, or been answered). A
comment saying "later" with no issue number behind it is the thing this rule
exists to prevent.

**`docs/` is published** to <https://athrvk.github.io/vayu/> via MkDocs, and
`mkdocs build --strict` gates every docs-touching PR - a broken relative link or
a missing heading anchor is a build failure. Before adding, moving or renaming a
page, load the **`docs-site`** skill.

## Subagents in worktrees - check the base first

Worktree provisioning cuts from **`master`**, not the branch you are on, and it
does so inconsistently - in one batch of four agents, three were 113 commits
behind and one was current. An agent that does not check will produce findings
against code that no longer exists; a previous round lost five agents' work this
way, ~190 commits behind.

Every subagent prompt must open with a base check naming the expected commit,
pinned **as a literal SHA** ("the current branch" means nothing inside a
worktree cut from somewhere else):

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
