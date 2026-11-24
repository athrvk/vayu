# Vayu - Claude Code Guide

Vayu is a high-performance API testing and load-testing platform. It uses a
**sidecar architecture**: a C++23 engine (daemon) runs alongside an Electron +
React UI, communicating over HTTP on port 9876.

- **Engine** (`engine/`): C++23, CMake + vcpkg, AGPL-3.0
- **App** (`app/`): Electron + React + TypeScript, Apache-2.0
- **`build.py`**: the single entry point for every build operation
- **`VERSION`**: single source of truth for the version
- **`scripts/`**: `pre-commit` (clang-format on staged C++), `pre-push`
  (clang-tidy on the C++ a push changes), `install-git-hooks.sh`, `test/`
  (load-test fixtures + mock server, installer and hook suites), `perf/` (the
  weekly measurement harness), `cxx-feature-probe`, `vendor-js/` (rebuilds a
  vendored script library from its npm tarballs), `docs-split/` (the committed
  script of a doc split, with its no-loss proof), `docs-lint.py`,
  `comment-lint.py` and `test-size-lint.py` (the budget lints, each with a
  ceilings or exceptions file that only goes down)

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

**One logical change per commit**: a fix, a feature step, a refactor - split
where a reviewer (or `git bisect`) would want a seam, and don't pile a
multi-part task into one commit. A commit is cheap: the pre-commit hook only
runs clang-format (under a second). clang-tidy (20-90s a file) runs in the
pre-push hook, once per push over every C++ file the push changes, so batch
pushes rather than commits, and expect a C++ push to take minutes. Both hooks
mirror CI gates; `--no-verify` skips them and CI still runs both checks.

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
libstdc++, MSVC 2022+), Node.js >= 22 (the LTS line, see `app/.nvmrc`;
`concurrently` 10, which `pnpm type-check` runs, declares `node >= 22`, and the
20 line went end-of-life on 2026-04-30), pnpm >= 11, and vcpkg with `$VCPKG_ROOT` set on Linux/macOS. On
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

**The cloud box has a ceiling.** Two engine builds fit on its 16 GB at once;
three do not, and the one the OOM killer takes fails with no compiler error.
`build.py -e -t` also compiles the test suite, so when only the binary is
wanted run `ninja -C engine/build vayu-engine`, and `-j3` beside another
build. Writable disk is a per-session allowance: two build trees plus a
worktree's `node_modules` reach it, and a full disk fails a *link*, not a
compile. `/opt/vcpkg/buildtrees` and a finished worktree's `node_modules` are
the safe things to delete. After a `builtin-baseline` bump, objects compiled
against the old headers still link and then crash at startup (a library type
gained members); delete `engine/build` rather than bisecting.

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

**A test must not depend on how fast the runner is.** CI runs on shared runners
that are nothing like an idle dev box. macOS runs the engine suite at `-j3` on
three vCPUs. Windows ticks its timers every 15.6ms, refuses a closed port only
after about two seconds, and runs the app suite 3-4x slower than Linux. The
sanitizer legs are about 10x slower. A test that passes idle and fails there
costs a 20-30 minute re-run on every pull request that meets it, and it teaches
people to retry red CI instead of reading it. Before writing or reviewing a
test that touches time, threads, sockets or a large render, check these rules:

- **Wait on the condition, never on a duration.** "Sleep 300ms, then assert X
  happened (or has not yet)" is a race the runner decides. Use
  `vayu::tests::wait_until` in the engine (`engine/tests/wait_until.hpp`), and
  `waitFor` / `findBy*` in the app. Use fake timers when the code under test
  owns the delay. A real-timer poll inside the code (a 100ms refetch) can land
  between two assertions: hold the mock's answer behind a promise the test
  releases (`queries/health.test.ts`). To stop something "mid-run", wait for
  the first sign it started (a request the mock received), not a fixed delay.
- **A wall-clock bound sits between the healthy reading and the broken one.**
  Name both numbers in the comment. An upper bound is the side that flakes; a
  lower bound cannot fail slow. If the gap is too narrow for one sample, widen
  it (a longer injected delay, as in `mock_server_routes_test.cpp`), take the
  best of N (a stall lands in one attempt, a regression in all of them), or
  assert a recorded value instead of the clock (an element's `waitedMs`).
- **A budget is a hang detector, not a speed check.** The app's per-test and
  `waitFor` budgets live in `app/src/test/timeouts.ts`, sized for the slowest
  leg. `timeouts.guard.test.ts` refuses a numeric `timeout:` in a test file.
  Render cost is held down by fixture size (`app/CLAUDE.md`), never by a clock.
- **No fixed ports and no public internet.** Use port 0 / `bind_to_any_port`
  in the engine, and `freePort()` (`app/electron/mcp/free-port.testkit.ts`) in
  the app. The one test that needs a public host
  (`tls_verification_test.cpp`) skips on every failure that is not its
  subject.
- **Fix a flake, never retry it.** No vitest `retry`, no
  `ctest --repeat until-pass`, no "re-run and see". A test that failed on CI
  and passed on retry broke one of the rules above. Find the job log (the
  `Run engine tests` / `Run frontend tests` step names the case) and fix that
  rule in the same pull request that meets it.

**A test ceiling is a constant the owner sets, and its measured value appears
only in the failure message.** A ceiling that follows the code is a budget the
diff sets for itself. The constant (`CEILING`, a `*_CEILING`, a `maxBytes:` row)
carries a docblock that states the rule - fixed, remove rather than raise - and
no number and no list of raises: each raise was an edit every open branch
conflicted on (22 times on one MCP test). The failure prints the measured value
and the ceiling. `app/src/test/ceiling-docblock.guard.test.ts` fails a docblock
that carries a digit run of three or more, two issue numbers or a verb that
narrates a raise. `a11y-suppressions.test.ts` and `tool-list-budget.test.ts`
are the exemplars.

**A test file is capped at 1,500 lines.** Past that a suite is a conflict
magnet and a single slow lint unit. Split it by suite (engine, keeping the suite
names) or by source module (app) and move the shared setup to a header or a
`*.testkit.ts`. `scripts/test-size-lint.py` runs as `Test file size` on every
pull request that touches `app/` or `engine/`. The files over the cap when it
was set are listed in `scripts/test-size-exceptions.json` with the size each
had, and the list only shrinks: a file over its recorded size fails, a file now
within the cap fails as stale, and CI compares the list with the base branch's
so an entry is never added or raised. `CONTRIBUTING.md` has the local command.

## Repo-wide conventions

- **No em-dashes anywhere in the repo.** Use ` - `.
- **Prettier's domain is `app/`, and nothing else.** `app/` is prettier-clean
  to the file and CI keeps it that way (`pnpm format:check`, from `app/` with
  an app-relative glob). Everything outside `app/` is unclean by policy: docs
  prose is hand-wrapped, workflows are written to be read as YAML, and
  `docs/design-system/` reflows hundreds of lines on a single pass. The
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
- **The platform before a dependency, a dependency before new code.** Before
  adding a package or hand-building a control, check whether the platform
  already covers it: an HTML input type, CSS, `Intl`, a DB constraint, the
  STL. A dependency taken on for what a native feature already does is a
  permanent maintenance cost bought for a one-time convenience.
- **Mutation-check behavioural tests** (revert the fix, confirm failure,
  restore). Source-scanning guards must assert they scanned something
  non-empty; vitest stubs CSS imports to `""`, so a guard over a stylesheet can
  pass forever reading an empty string.
- Labels separate WHERE a change lands (`component:*`) from WHAT kind it is
  (`type:*`). See `.github/LABELING.md`; auto-labeling is `.github/labeler.yml`.

## Comments - the constraint, in the present tense

A comment states what the code cannot: a constraint, an invariant, a unit, who owns or locks what, a platform or compiler quirk, a measurement, why not the obvious way. It says what is, not what was: the history is the issue's, so the comment keeps `(#NNNN)` and one sentence of constraint. `scripts/comment-lint.py` counts history phrasing (`used to`, `until #N`, `since #N`, `#N added ...`) in non-test source against per-file ceilings that only go down.

A comment that restates the name or the next line is deleted. A `file:line` in a comment is written as a symbol, because the line moves.

Suppression reasons and directives are never trimmed: `NOLINT`, `eslint-disable`, `@ts-expect-error`, `@deliberate` (clang-tidy reads it in an empty catch), license headers. `a11y-suppressions.test.ts` parses the reason itself.

A comment-only change proves itself: the comment-stripped files are identical before and after, the directive counts are unchanged, and the suites that read source text pass. Before deleting a whole block, `rg` for comments and docs that cite it.

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
| `docs/compare/*.md` | Any capability claim a comparison page makes: timers, correlation, controllers, import formats, scripting |

**A doc page stays within a size and shape budget.** 600 lines a page (1,000
for a reference page), 400 characters a line, 200 a table cell, a front-matter
`description:`. `scripts/docs-lint.py` holds it in the `Docs site` workflow. A
page already over a budget has a ceiling in `scripts/docs-lint-ceilings.json`
that may only be lowered: CI compares the file with the base branch's copy, and
a ceiling whose page is now within budget fails as stale. Split or trim the
page instead of raising a ceiling; pages split out of one that is gone may
together hold its ceilings and no more. `CONTRIBUTING.md` has the local
command.

**A doc states what is, not what was.** `used to`, `until #N`, `since #N
landed`, `formerly`, `previously`, `was renamed|moved|removed|replaced` and an
issue number in a heading are counted per page by the same lint, against a
ceiling that only goes down; every page is at zero now. Rationale is allowed: the
constraint that explains why stays, the story of the change goes to git.

**One fact has one home, and every other page links it.** Two pages that state
the same thing drift, and the reader trusts the one they opened. The home of
each kind of fact:

| A fact about | Its home |
|--------------|----------|
| An HTTP route, payload or status code | `docs/engine/api-reference/` |
| A table, a migration, stored JSON | `docs/engine/db-schema/` |
| A script global, hook or sandbox limit | `docs/engine/scripting/` |
| An MCP tool, resource or prompt | `docs/engine/mcp/` (the tool table is generated) |
| A token, a color or type rule, a UI pattern | `docs/design-system/` |
| A renderer store, query key or hook | `docs/app/state-management/` |
| What the renderer sends the engine | `docs/app/api-integration/` |
| What a component does | `docs/app/COMPONENTS/` |
| A rule for how to work, and what holds it | the nearest `CLAUDE.md`, as a rule and a link |

The mechanism is the pair of guards that read a page against its owner (a token
value against `index.css`, a tool count against the registry; the list is
`DOC_READING_GUARDS` in `app/src/lib/routed-inputs.testkit.ts`) and the line
budget on the guides below, which is what stops a guide from restating a page.

**A table or count derived from a registry is generated, never kept by hand.**
The MCP tool table and the one line that states how many tools, resources and
prompts exist are rendered from the registries into
`docs/engine/mcp/tools.md`. `tools-doc.fresh.test.ts` fails when the committed
page differs from the render and names the command that rewrites it
(`pnpm docs:mcp-tools`, from `app/`); `tool-count-docs.test.ts` fails any other
page that states a count. A new tool changes its `*.tools.ts` file and the
generated page, and no prose page.

**A `CLAUDE.md` holds rules, not reference.** A rule, the mechanism that holds
it, and a link to the page with the detail; a payload, a column list or an
argument table is a page under `docs/` (the home table above). Each of the three
guides (this file, `app/CLAUDE.md`, `engine/CLAUDE.md`) is held to 400 lines by
`scripts/docs-lint.py`, with the same ceilings file and the same rule that a
ceiling only goes down. A guide at the limit takes a rule by moving a
contract it restates to a page and linking it.

**Deferred work is filed as a GitHub issue in the same commit that defers it.**
There is no backlog file; the tracker is the only backlog. A comment saying
"later" with no issue number behind it is the thing this rule exists to prevent.

**A follow-up earns an issue only when it changes what the app does, how fast
it does it, or what it can do.** Lint scope, test shape, tooling ergonomics and
dev-script hygiene are noted in the PR body, not filed. If it would not change
a user's experience or a measurement, it is not tracked work.

**An issue is written for the session that will implement it without this
conversation.** Problem with `file:line` anchors at a named master SHA, Fix
pathway, App changes, Tests with the mutation check named, Docs to update in
the same commit, Sequencing against the open issues it touches, Acceptance
criteria a fresh checkout can verify. Phased work is a parent with sub-issues
and a landing order. A closure is verified against those criteria, not against
the PR's description; a PARTIAL reopens with exactly what is missing.

**`docs/` is published** to <https://athrvk.github.io/vayu/> via MkDocs, and
`mkdocs build --strict` gates every docs-touching PR: a broken relative link or
a missing heading anchor is a build failure. Before adding, moving or renaming a
page, load the **`docs-site`** skill.

## Subagents in worktrees - check the base, own the worktree

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

**One worktree per agent, never a shared one**, cut by the orchestrator
(`git -C /home/user/vayu worktree add <scratch>/<name> <sha>`) and removed by
the agent at the end (`git worktree remove --force`, then `git worktree list`
to confirm). A shared tree mixes one agent's mutation check or stray test file
into another's findings. Each agent picks its own engine and vite ports, kills
what it started by saved PID (never `pkill -f`: another agent's engine has the
same name), reverts every mutation check with `git checkout -- <file>`, and
ends with `git status --short` empty.

## Where the rest lives

Nested guides load automatically when you read a file in that tree; skills load
when the task comes up, or on request by name.

| Load | Covers |
|------|--------|
| `app/CLAUDE.md` | TypeScript/React conventions, the UI rules enforced by tests, design-system and border/surface rules, renderer doc map |
| `engine/CLAUDE.md` | C++ conventions, the rules to design the HTTP API and `POST /compose` around (each links its page under `docs/engine/api-reference/`), engine doc map |
| `releasing` skill | Version bump, release notes, tagging, `install.sh`, winget publishing |
| `docs-site` skill | MkDocs publishing rules, nav, anchors, analytics, local preview |
| `pr-description` skill | Writing this repo's PR titles/descriptions - lead with why, scale to diff size, flag risk vs. safe-to-skip, the screenshot-commit-then-drop workflow for visual changes |
| `.claude/agents/` | Role subagents a session or routine dispatches - `vayu-reviewer` (Fable, read-only, files issues), `vayu-researcher`, `vayu-implementer`, `vayu-visual-verifier` - and the thin orchestrator prompts that drive them (`.claude/agents/README.md`) |
