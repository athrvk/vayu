---
name: releasing
description: Cut a Vayu release - version bump, curated release notes, tagging, and what CI publishes (installers, install.sh, winget). Use when preparing or tagging a release, writing release notes, or changing install.sh or the release/winget workflows.
---

# Releasing Vayu

1. `python build.py --bump-version patch` - updates VERSION, CMakeLists.txt,
   version.hpp, package.json. (`patch` | `minor` | `major` | `x.y.z`; add
   `--dry-run` to preview.) It deliberately does **not** touch
   `engine/vcpkg.json`, and refuses to run if that file has grown a `version`
   field back: CI keys the vcpkg binary cache on the manifest's hash, so a
   version there made every release rebuild every C++ dependency from source.
2. Check the vcpkg baseline for staleness - `cd engine && vcpkg
   x-update-baseline --dry-run`. **The release window is the cadence**: nothing
   else owns baseline freshness, and #679 found cpp-httplib five minors behind
   with curl, openssl and sqlite3 each missing point releases, purely because
   the pin had gone unexamined since June. A bump is `builtin-baseline` in
   `engine/vcpkg.json` **and** `VCPKG_COMMIT` in `release.yml`, `pr-tests.yml`,
   `codeql.yml`, `cache-warm.yml`, `sanitizers.yml`, `engine-tidy-scan.yml`
   and `perf-measure.yml` - one SHA in eight places, and the `guard` job in
   `cache-warm.yml` fails the build if any of them drift. Read that job's
   `files=(...)` list rather than this sentence: it is the authority, and it
   has grown twice. Land a bump as
   **its own PR before the release commit**, never inside it: a dependency
   change and a version bump that break one platform together cannot be told
   apart. Before merging a bump, run it against a **deliberately stale clone**
   (issue #692) - every environment that has not updated since the last bump is
   about to be one, and the self-heal in `build.py` is what stands between them
   and an error that reads like a corrupt registry:

   ```bash
   git clone --depth=1 https://github.com/microsoft/vcpkg.git /tmp/stale-vcpkg
   git -C /tmp/stale-vcpkg fetch --depth=1 origin <a-sha-from-before-the-bump>
   git -C /tmp/stale-vcpkg reset --hard FETCH_HEAD
   /tmp/stale-vcpkg/bootstrap-vcpkg.sh -disableMetrics
   VCPKG_ROOT=/tmp/stale-vcpkg python build.py -e     # must self-heal, then build
   ```

   Expect the bump to be **work, not a rubber stamp**. `inbox.cpp` mirrors
   cpp-httplib's private `Server::process_and_close_socket` behind a
   `static_assert` on `CPPHTTPLIB_VERSION`, so any cpp-httplib move fails the
   build until the mirror is re-read against the new source and the assert
   updated (#1283 tracks retiring it; check first whether the release finally
   carries a public hook that can rewrite `Request::path` before routing). And
   `sanitizers/tsan.supp`'s `race:std::ctype<char>::narrow` entry is re-measured
   on every cpp-httplib move, not carried forward - 10 runs of
   `TransportPolicyPaths.LoadRunTraversesManualProxy` with the line and 10
   without, recorded in that file and in `docs/engine/building.md`.
3. Write the curated release notes to `.github/release-notes/vX.Y.Z.md` (Keep a
   Changelog format, see below).
4. Commit both: `git commit -m "chore(release): x.y.z"` (version bump + notes
   file together).
5. Tag: `git tag v$(cat VERSION) && git push origin --tags`. **First wait for the
   release merge's "Warm build cache" run to go green.** The version bump is in
   `cache-warm.yml`'s `push` paths, so merging the release PR fires a warm run
   that compiles the engine into the master sccache scope; the tag sits on that
   same merge commit, so a tag build started before the warm run finishes reads
   an empty scope and compiles cold (issue #700). The warm run is ~15-25 min per
   platform.
6. CI builds installers and publishes the GitHub Release, using
   `.github/release-notes/<tag>.md` as the release body automatically (no manual
   paste).
7. Read the sccache hit rate in the release run's log and expect **more than
   zero engine hits** (issues #659 item 5, #700). Two different causes produce a
   structural 0%, and they need different fixes:
   - **The warm scope was never populated for this commit** - the most likely
     cause now that the header is isolated. Either the release merge's "Warm
     build cache" run had not finished (or failed) before the tag was pushed, or
     the version bump did not trigger it. Check that run went green on the merge
     commit *before* tagging (step 5); re-run it and re-tag if it did not.
   - **A header regression.** A version bump used to edit a header every
     translation unit preprocessed, so every release compiled the engine cold by
     construction; `core/user_agent.hpp` keeps the version behind a declaration.
     Zero hits *with* a green warm run means something pulled `vayu/version.hpp`
     back into a widely included header, and `version_isolation_test.cpp` is the
     guard that should have caught it.

A release commit needs no test run - every edit is a version string or Markdown.
The version stamp is worth one cheap check (`./build/vayu-engine --help` prints
it) and nothing else.

**Tag *after* the release commit lands on the default branch.** When the version
bump goes through a pull request (the usual path), run steps 1-2 on the feature
branch so the bump merges with the PR, but do **not** tag the PR-branch commit.
A squash/rebase merge rewrites the commit hash, so a tag on the pre-merge commit
would point at a commit that never reaches the default branch. Wait for the PR to
merge, then tag the merged commit on the default branch
(`git checkout <default-branch> && git pull && git tag v$(cat VERSION) && git
push origin --tags`). The tag triggers the release build, so it must sit on the
canonical merged history.

## Release changelog

Release notes live on the [GitHub Releases](https://github.com/athrvk/vayu/releases)
page (there is no `CHANGELOG.md` in the repo). Write them in
[Keep a Changelog](https://keepachangelog.com) style so entries stay consistent
across versions:

- **Heading:** `## [X.Y.Z] - YYYY-MM-DD` (ISO date).
- **Lead paragraph:** what to read before updating, then a plain list of the
  headline changes. Two to four sentences. Do **not** name a "theme" and argue
  for it: "The **desktop integration release**. Until now Vayu was a window you
  had to be looking at ..." is a thesis statement, not an introduction.
- **Grouped sections, in this order, omitting any that are empty:** `### Added`,
  `### Changed`, `### Fixed`. Use `### Security` / `### Removed` /
  `### Deprecated` only when they apply.
- **Fold internal churn** (doc hygiene, refactors with no user-visible effect)
  into a single summary bullet rather than listing each commit.
- **Compare link footer:** `[X.Y.Z]: https://github.com/athrvk/vayu/compare/vPREV...vX.Y.Z`.
- **Version choice:** patch = fixes only; minor = new user-facing feature; major
  = breaking change (still `0.x`, so reserve major for a stable milestone).

### How the entries are written

The 0.26.0 notes were drafted from `git log` and came out at 3,880 words of
near-identical 80-to-120-word bullets, each re-narrating its commit message.
Rewritten to 1,890 without losing a fact. Two of the rules above were the cause
("lead with a bold headline, then the detail" made every bullet the same shape;
"naming the release theme" produced the thesis lead), so they are gone. What
replaces them:

- **Lead with the change, not the history of the defect.** "Every terminal state
  took the same close path, which said 'finished' without reading the status,
  so ..." is commit-message material. "A run that failed was reported as
  finished, so you got no failure notification and no error state on the
  taskbar" is the entry. Symptom, what it broke, one clause on the fix.
- **The test for a name or number: would the reader type or see this string in
  the product?** `X-Vayu-Request-Id`, `Accept-Encoding`, `stop_run` and
  `Keep awake during runs` stay - a user searches for or types those. `libcurl`,
  `allowWrites`, `tools/list`, `GET /request-defaults`, "completion frame",
  "the SSE client" and `7ch` do not. Settings, tabs, dialogs and buttons are
  nouns the user has; services, sockets, streams and frames are not.
- **Translate a clock, a timer or a thread into what it did to the numbers.**
  Not "measured on the monotonic clock ... an NTP step during a run", but "if
  the clock changed during a run (a time sync, for instance), the reported
  duration was wrong, and with it the RPS and throughput figures".
- **A number earns its place only against something the reader has.** Keep
  "below ~500 RPS" and "about 12,100 of the 30,500 tokens in the tool list".
  Cut "`7ch` to `5ch`" and "pairs ~3.1 ms apart instead of singles 2.5 ms
  apart" - nobody has measured a column in `ch`.
- **Bold marks the entries a reader must find**, not every bullet. Breaking
  changes and the four or five features people will search for. A one-line fix
  is plain text: "The application menu is reachable on Windows and Linux."
- **Vary the length.** Most entries are one or two sentences; some are half a
  line. An entry needing three sentences should be rare enough to notice.
- **Say "fixed" when the fix has no user-facing shape.** Describing the
  mechanism invites the reader to evaluate something they cannot see.
- **Do not argue for a default or a threshold.** "Off by default." not "Off by
  default, because a machine that refuses to sleep is your battery and not the
  app's decision." The reasoning belongs in the PR.
- **Cut the tail that restates the sentence's own premise** - "generated per
  transfer rather than per save", "rather than joining it". Keep `rather than`
  only where the contrast tells the reader something they act on.
- **No editorial asides about the reader**: "which is exactly the case where you
  are not looking at the window", "worth calling out". They carry no fact.
- **Tests, guards and conformance checks are never release-note material.** A
  test proves the change to the maintainer; the reader needs the change.
- **One mechanism sentence at most, and only if a contributor would act on it.**

**A change inside the same unreleased window is not a change.** Notes compare
against the last tag, not against last week's branch. 0.26.0 nearly shipped
"the keep-awake prompt triggers at ten minutes, not five" - both commits were
in the same window, so no user ever saw five.

**Re-read the draft against the diff before committing it.** Long re-narrated
bullets make it easy for two entries to describe one thing differently without
either looking wrong. 0.26.0's draft carried two such errors: the wake-lock
threshold said five in one section and ten in another, and an MCP entry claimed
a refusal "stays" when withholding the tools had taken it off the wire.

**Re-sync the notes on every rebase, not just the branch.** A release PR that
sits while master moves goes stale in content, not only in commits: each
re-sync of 0.26.0 added entries, and one caught a factual error.

**Release notes are published from a file - no manual paste.** On tag push,
`.github/workflows/release.yml` reads `.github/release-notes/<tag>.md` and sets
it as the GitHub Release body via `softprops/action-gh-release`'s `body_path`.
If that file is missing for the tag, the workflow falls back to GitHub's
automatically generated PR-based notes (`generate_release_notes`) so a release is
never published empty.

**Authoring the notes (Claude's job before tagging).** Derive them from
`git log vPREV..vX.Y.Z`, then rewrite - a first pass off the log reliably comes
out as one re-narrated commit message per bullet, which is what the rules above
exist to catch. Match `v0.26.0.md`, the first file written to them; **`v0.25.0`
and earlier are the pattern being corrected, not the voice to copy.** Because
the workflow resolves the file from the tagged commit's tree, the notes file
must be committed **before** the tag is pushed (i.e. it rides along in the
release PR). To correct a published release's notes after the fact, edit the
file, then either re-run the release workflow or update the release body by
hand.

## `install.sh` (repo root) installs *and updates*, on macOS and Linux

macOS: downloads the release zip, ad-hoc signs app + sidecar, strips quarantine,
`sudo`-installs to `/Applications`. Linux: AppImage + `.desktop` entry + icon +
a `vayu` symlink when `~/.local/bin` is on `PATH`, all under
`~/.local/share/vayu`, **no sudo**. Both share every decision and dispatch only
the actions, on `platform()` - a function wrapping `uname -s`, so tests can force
either branch on either host. Tested by `scripts/test/install_test.sh`
(`VAYU_DRYRUN=1`), shellchecked in CI on both. Published by the docs site:
`.github/hooks/install_script.py` registers the repo-root file at the site root,
which is why `install.sh` is in the `paths:` filters of `docs.yml` - without that
the published copy silently falls behind master. Documented as
`bash -c "$(curl …)"`, not `curl … | bash`, so the script is buffered before it
runs and stdin stays on the terminal.

Things about it that the code cannot tell you:

- **It is the macOS *update* path** - `resolveUpdateStrategy` returns `notify`
  there, since an ad-hoc signature gives Squirrel.Mac nothing to verify. So the
  app is usually *running* when the script starts, and `macInstallCommand()`
  (`app/electron/updater.ts`) must match the command README publishes;
  `updater.test.ts` asserts that by reading the README, because a template
  literal is invisible to a URL grep.
- **Never detect the running app by matching command lines.**
  `bash -c "$(curl …)"` puts the whole script - comments included - into its own
  argv, so a `pgrep -f` pattern appearing anywhere in the file matches the
  installer itself. That aborted every Linux install while the suite stayed
  green, because sourcing the file never populates argv. Linux reads
  `/proc/<pid>/exe`, both platforms filter by process group, and
  `install_test.sh` exercises the real `bash -c "$(cat install.sh)"` form.
- **A flag appended to the documented command lands in `$0`, not `$1`.**
  `bash -c "$(curl …)" --force` gives bash's `-c` its *name* argument, so `$#` is
  0 and the flag silently vanished - the run reported "already installed -
  nothing to do" while ignoring the `--force` it was handed. `parse_args` now
  recovers a `-`-prefixed `$0` back into `"$@"`, skipping a bare `--` (with the
  separator present bash puts *that* in `$0`, so a naive `-*` match turns a
  correct invocation into "Unknown option: --"). Sourcing can never reproduce
  this, so the coverage runs the real `bash -c "$(cat install.sh)"` form. Same
  family: a flag that parses but does nothing - `--purge` without `--uninstall`
  is now a usage error, and any hint the script prints must be a command that
  actually runs (`--uninstall --purge`, not `--purge`).
- **`electron/quit-signals.ts` is load-bearing.** Linux has no Apple Event, so
  the installer quits with `SIGTERM`, and Node's default would kill the process
  without running `before-quit` - losing pending saves and orphaning the engine.
  The app can also quit itself (`update:quitForUpdate`, the **Quit to update**
  button), the only quit needing no Automation consent.
- **The install target follows the existing copy.** `/Applications` is only the
  *fresh install* default; two copies are reported rather than silently picked
  between, and uninstall removes every copy. Resolution
  (`resolved_install_path`) prints and the single assignment lives in
  `adopt_install_target`, so nothing here is unsafe to call from a subshell.
- **The Linux version stamp (`~/.local/share/vayu/version`) has two writers**:
  the installer, and `electron/appimage-stamp.ts` at startup - the AppImage
  self-updates in place and would otherwise leave the stamp stale. That module
  duplicates `install.sh`'s path constants; move one, move both.
- **Every `sudo` goes through `privileged()`, which refuses to run before
  `authorize()`.** The ordering used to be a convention and the convention
  broke: `sweep_staging` deleted a bundle in `/Applications` *without* sudo two
  lines above one that used it, both before the password was ever asked for.
  `VAYU_SUDO` lets `install_e2e.sh` substitute a stub, which is the only way CI
  can see the privileged path at all - the runners have passwordless sudo and no
  terminal, which is where three bugs in a row hid.
- **Every release installer publishes a `.sha256`** (checksum steps in
  `release.yml`), so the installer's verification is real on all three platforms
  rather than dead code outside macOS. The `latest*.yml` feeds and the Windows
  `.exe.blockmap` are excluded: they are electron-updater's own metadata, and
  what it assembles from them is verified against the sha512 the feed carries,
  not against a sidecar nothing would fetch.
- **Errors go through `die()`, never `step || exit 1` at a call site.** Bash
  disables `errexit` for the whole body of a function invoked in an `||`
  context, so an unchecked command inside it falls through - that is how a failed
  download was once reported as success. A step that cannot continue says so
  itself. The cost: a dying function cannot be called in-process by a test, so
  `install_test.sh` wraps those calls in a subshell.
- **Two suites, two jobs.** `install_test.sh` is dry-run and owns the
  *decisions* (which version, which platform branch, which order, sudo or not -
  including the other platform's branch, which is why it stubs `platform()`).
  `scripts/test/install_e2e.sh` runs the installer for real against a local
  release in a temp root and owns the *effects*. Put a new assertion in whichever
  answers it; do not duplicate.
- **Release assets carry versions** (`Vayu-<v>-universal.zip`,
  `Vayu-<v>-x86_64.AppImage`) while `Vayu-x64.exe` and `Vayu-amd64.deb` do not,
  so `/releases/latest/download/<name>` **404s for macOS and Linux**. Link the
  installer or `/releases/latest`; never invent an unversioned asset URL.

## Windows updates are differential, and the `.exe.blockmap` is what makes them so

`resolveUpdateStrategy` gives Windows `silent`, so an update there is
electron-updater's own download rather than a trip to the releases page.
`NsisUpdater` asks for `<installer>.blockmap` twice - once for the release it is
installing, once for the release being upgraded from, the second URL derived by
substituting the old version into the new one's path - compares the two block
lists and range-requests only the blocks that differ. Both files have to exist
as release assets, which is why the Windows collect step in `release.yml` fails
when electron-builder produced no blockmap: through v0.24.0 none were ever
uploaded, so every Windows update pulled the whole 127MB installer and the only
trace was one error-level `Cannot download differentially, fallback to full
download` in the updater log.

Three things to know before reading a release for evidence:

- **The first release carrying a blockmap still updates in full.** The release
  it is upgrading from has none, so that fetch 404s and the fallback runs. The
  saving starts one release later.
- **`latest.yml` does not gain a `blockMapSize`, and does not need one.** That
  field is written only when the blockmap is appended to the artifact itself,
  which is the AppImage's arrangement - `blockMapSize` in `latest-linux.yml`,
  the map read back from the AppImage's own tail, no asset to upload. NSIS
  writes a sibling file instead and the updater finds it by name, so an absent
  `blockMapSize` on the exe is correct rather than a symptom.
- **macOS ships no blockmap on purpose.** Its strategy is `notify`, since an
  ad-hoc signature gives Squirrel.Mac nothing to verify, so the app never
  downloads an update there and a `.zip.blockmap` would be an asset with no
  reader.

## Windows also publishes to winget, automatically

The `publish-winget` job in `release.yml` submits `Vayu-x64.exe` to
`microsoft/winget-pkgs` after the release is built, so
`winget install athrvk.Vayu` follows each tag with no manual step. It runs only
on a tag push and only if the whole build matrix succeeded, and it skips silently
when the `WINGET_TOKEN` secret is absent - so a release can never fail because of
it.

It keeps the **five newest versions** on winget (`max-versions-to-keep`) and
drops older ones as each release is submitted. Unbounded, every version ever
released stays installable at an explicit `--version`, including 0.10.0, whose
engine cannot start without the Visual C++ redistributable. The manual workflow
below deliberately does *not* prune, because it exists partly to publish an
older tag and pruning keeps the *newest* N - it could delete the very version
being submitted. The next tagged release restores the cap on its own. Pruning
affects the winget index only; the GitHub Releases page keeps everything.

For anything the tag-triggered path does not cover - a release that predates the
automation, a re-submission after a winget-pkgs pull request was closed,
publishing an older tag - run the **Publish to winget (manual)** workflow
(`.github/workflows/winget-publish.yml`) from the Actions tab. It takes an
optional tag (defaulting to the latest release), validates that the release and
its `Vayu-x64.exe` asset exist, and submits only that - it builds nothing.
Unlike the automatic job it **fails** rather than skips when `WINGET_TOKEN` is
missing, because a manual run that published nothing while reporting success
would be worse than an error. `WINGET_TOKEN` must be a **classic** PAT with
`public_repo` scope; fine-grained PATs are not supported by the action.

### When winget publishing fails, suspect the fork before the token

**Every winget problem arrives as one opaque line.** An expired token, a
fine-grained token, a missing fork, an archived fork, a fork owned by another
account and a fork merely *out of date* all reach the log as
`<user> does not have the correct permissions to execute CreateRef` - and only
after komac has downloaded the installer and rendered all three manifests, so
the run reads as a success until its final line.

**The usual cause is the stale fork, and the message points at the token.**
v0.16.0 was spent minting tokens for that reason. komac branches at
*upstream's* head commit, so a fork that does not contain that commit cannot
have the ref created at it, and GitHub phrases the refusal as permissions.
Syncing the fork published immediately, with the token that had just "failed".
[komac#1142](https://github.com/russellbanks/Komac/issues/1142) reports the same
symptom and the same fix. Note also that REST write access is *not* evidence:
`POST /repos/<fork>/git/refs` returned 201 throughout, because it creates a ref
at a commit the fork already has, while komac's GraphQL `createRef` at
upstream's head was refused.

`.github/actions/winget-preflight` runs before komac in both publishing
workflows and covers all of it: the token authenticates, is classic
(`x-oauth-scopes` non-empty and carrying `public_repo`), owns a
`<token owner>/winget-pkgs` that is writable, unarchived and a real fork of
`microsoft/winget-pkgs`; then it **syncs that fork** via `merge-upstream`; then
it creates and deletes a throwaway branch through the same GraphQL mutation
komac uses. Each failure names itself, and the sync means the common one stops
happening rather than being diagnosed faster.

It is an action rather than a step in each workflow because both the
tag-triggered job and the manual one need it, and the copy not being debugged is
the copy that drifts.

Two things it deliberately does *not* do. It cannot repair a fork that has
**diverged** from upstream (`merge-upstream` answers 409): resetting the branch
would discard whatever was committed on top of it, so it stops and says so. And
it resolves the fork from the **token's** owner, not the repository's - a PAT
belonging to another account authenticates perfectly and is denied only at the
branch. `fork-user` defaults to the repository owner, so the two must be the
same account unless it is set explicitly.

To check a token by hand:
`curl -sI -H "Authorization: token $PAT" https://api.github.com/user | grep -i
x-oauth-scopes`. To check the fork, compare
`git ls-remote https://github.com/<you>/winget-pkgs master` against the same for
`microsoft/winget-pkgs`.
