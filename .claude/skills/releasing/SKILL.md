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
2. Write the curated release notes to `.github/release-notes/vX.Y.Z.md` (Keep a
   Changelog format, see below).
3. Commit both: `git commit -m "chore(release): x.y.z"` (version bump + notes
   file together).
4. Tag: `git tag v$(cat VERSION) && git push origin --tags`
5. CI builds installers and publishes the GitHub Release, using
   `.github/release-notes/<tag>.md` as the release body automatically (no manual
   paste).

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
- **Lead paragraph:** 2-4 sentences naming the release theme and where the change
  concentrates (engine vs app), e.g. "The OAuth 2.0 release ... the bulk of the
  change is new C++ in the engine and new React/Electron surface in the app."
- **Grouped sections, in this order, omitting any that are empty:** `### Added`,
  `### Changed`, `### Fixed`. Use `### Security` / `### Removed` /
  `### Deprecated` only when they apply.
- **Bullets:** lead with a bold headline, then the detail, e.g. `- **OAuth 2.0
  auth mode.** A new \`oauth2\` mode in the request Auth panel and Collection
  Detail ...`. Prefer user-facing wording; reference files/endpoints only when
  they aid a contributor.
- **Fold internal churn** (doc hygiene, refactors with no user-visible effect)
  into a single summary bullet rather than listing each commit.
- **Compare link footer:** `[X.Y.Z]: https://github.com/athrvk/vayu/compare/vPREV...vX.Y.Z`.
- **Version choice:** patch = fixes only; minor = new user-facing feature; major
  = breaking change (still `0.x`, so reserve major for a stable milestone).

**Release notes are published from a file - no manual paste.** On tag push,
`.github/workflows/release.yml` reads `.github/release-notes/<tag>.md` and sets
it as the GitHub Release body via `softprops/action-gh-release`'s `body_path`.
If that file is missing for the tag, the workflow falls back to GitHub's
automatically generated PR-based notes (`generate_release_notes`) so a release is
never published empty.

**Authoring the notes (Claude's job before tagging).** Derive them from
`git log vPREV..vX.Y.Z`; read a recent entry to match voice. Because the workflow
resolves the file from the tagged commit's tree, the notes file must be committed
**before** the tag is pushed (i.e. it rides along in the release PR). To correct
a published release's notes after the fact, edit the file, then either re-run the
release workflow or update the release body by hand.

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
- **Every release artifact publishes a `.sha256`** (checksum steps in
  `release.yml`), so the installer's verification is real on all three platforms
  rather than dead code outside macOS.
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
