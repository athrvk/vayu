#!/usr/bin/env bash
# Shellchecked in CI alongside install.sh. Two rules cannot see through the way
# this file works, and are disabled file-wide here rather than at 15 call sites.
# The directives must precede the first command to apply to the whole file.
# shellcheck disable=SC2034  # VAYU_TEST and VAYU_VERSION are read by the sourced installer
# shellcheck disable=SC2329,SC2317  # the stubs below are called by the installer, not from this file
#   (the two codes are the same finding: 0.9/0.10 report it as SC2317, 0.11 as SC2329)
set -euo pipefail

# Source the installer (at repo root) in test mode so main() does not run.
VAYU_TEST=1
# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")/../.." && pwd)/install.sh"

INSTALLER="$(cd "$(dirname "$0")/../.." && pwd)/install.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# Sandbox before anything runs. Every path the installer reads or writes is
# redirected into a temp tree, so the suite cannot see - or report on - a real
# Vayu on the machine running it. Without this the macOS section below asked the
# host about /Applications/Vayu.app and its live processes, which is green on a
# clean CI runner and answers differently on a developer Mac with Vayu open.
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
mkdir -p "$TMPROOT/system" "$TMPROOT/home" "$TMPROOT/data"

DEFAULT_INSTALL_DIR="$TMPROOT/system"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
APP_PATH="$INSTALL_DIR/${APP_NAME}.app"
search_dirs() { printf '%s\n%s\n' "$TMPROOT/system" "$TMPROOT/home"; }

LINUX_APP_DIR="$TMPROOT/data/vayu"
LINUX_APP_BIN="$LINUX_APP_DIR/${APP_NAME}.AppImage"
LINUX_VERSION_FILE="$LINUX_APP_DIR/version"
LINUX_DESKTOP_FILE="$TMPROOT/data/applications/vayu.desktop"
LINUX_ICON_FILE="$TMPROOT/data/icons/hicolor/256x256/apps/vayu.png"
LINUX_BIN_LINK="$TMPROOT/bin/vayu"

# The installer decides everything about *what* to do the same way on both
# platforms and almost nothing about *how*, so every test below states which
# platform it is exercising by stubbing platform(). CI runs this file on Linux
# and macOS; without the stub each host would silently skip the other's half.

# --- shared ------------------------------------------------------------------

# parse_args: default
parse_args
[ "$MODE" = "install" ] || fail "default MODE should be install, got $MODE"
[ "$PURGE" = "0" ] || fail "default PURGE should be 0, got $PURGE"

# parse_args: uninstall + purge
parse_args --uninstall --purge
[ "$MODE" = "uninstall" ] || fail "MODE should be uninstall, got $MODE"
[ "$PURGE" = "1" ] || fail "PURGE should be 1, got $PURGE"

# parse_args: help
parse_args --help
[ "$MODE" = "help" ] || fail "MODE should be help, got $MODE"

# parse_args: --force, and that it resets between calls
parse_args --force
[ "$FORCE" = "1" ] || fail "FORCE should be 1, got $FORCE"
parse_args
[ "$FORCE" = "0" ] || fail "FORCE should reset to 0, got $FORCE"

# parse_args: unknown -> non-zero
if parse_args --bogus 2>/dev/null; then fail "unknown arg should fail"; fi

printf 'PASS: parse_args\n'

# resolve_version: pinned via env (no network)
VAYU_VERSION=0.1.2
[ "$(resolve_version)" = "0.1.2" ] || fail "pinned version should be 0.1.2, got $(resolve_version)"
unset VAYU_VERSION

# should_skip_install: re-running the command is how people update, so the
# same-version case has to be a no-op rather than a 150MB round trip.
should_skip_install 0.1.3 0.1.3 0 || fail "same version should skip"
if should_skip_install 0.1.3 0.1.3 1; then fail "--force should reinstall the same version"; fi
if should_skip_install 0.1.2 0.1.3 0; then fail "an older install should not skip"; fi
if should_skip_install 0.1.4 0.1.3 0; then fail "a different version should not skip"; fi
if should_skip_install "" 0.1.3 0; then fail "a fresh install should not skip"; fi

printf 'PASS: version + skip logic\n'

# --- macOS -------------------------------------------------------------------
platform() { printf 'Darwin\n'; }

# download_url: the release asset electron-builder actually publishes. Both
# names carry the version, which is why nothing uses /releases/latest/download/.
got="$(download_url 0.1.3)"
want="https://github.com/athrvk/vayu/releases/download/v0.1.3/Vayu-0.1.3-universal.zip"
[ "$got" = "$want" ] || fail "macOS download_url mismatch: $got"

# do_install in dry-run prints the key steps without touching the system
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
echo "$out" | grep -q "codesign --force --sign - .*${APP_NAME}.app/Contents/Resources/bin/vayu-engine" \
	|| fail "install should ad-hoc sign the sidecar"
echo "$out" | grep -q "codesign --force --deep --sign - .*${APP_NAME}.app" \
	|| fail "install should ad-hoc sign the app bundle"
echo "$out" | grep -q "xattr -cr .*${APP_NAME}.app" \
	|| fail "install should strip quarantine on the staged app"
# ditto, not unzip: Apple's own extractor for these archives, and the one that
# preserves the symlinks and permissions inside an .app bundle.
echo "$out" | grep -q "ditto -x -k .*vayu.zip" || fail "the zip should be extracted with ditto"
# Copied in beside the installed bundle and swapped, never deleted first: a
# rm-then-copy that dies partway leaves the user with no Vayu at all, having
# started from a working one.
echo "$out" | grep -q "sudo ditto .*${APP_NAME}.app ${APP_PATH}.new" \
	|| fail "install should ditto the signed app in beside the existing one"
echo "$out" | grep -q "sudo mv ${APP_PATH}.new ${APP_PATH}$" \
	|| fail "install should swap the new bundle into place"
[ "$(echo "$out" | grep -c "sudo rm -rf ${APP_PATH}$")" = "1" ] \
	|| fail "the installed bundle should be removed exactly once, immediately before the swap"

printf 'PASS: macOS install dry-run\n'

# installed_version: absent bundle answers nothing rather than erroring out,
# because do_install feeds its output straight into should_skip_install.
APP_PATH_SAVED="$APP_PATH"
APP_PATH="/nonexistent/Vayu.app"
[ -z "$(installed_version || true)" ] || fail "installed_version should be empty when not installed"
APP_PATH="$APP_PATH_SAVED"

# running_pids: must not report the test process itself. `pgrep -f` matches the
# whole command line, so a script that mentioned the bundle path literally would
# match itself and then try to quit its own shell.
[ -z "$(running_pids)" ] || fail "running_pids matched something with no app installed: $(running_pids)"

# uninstall (no purge): removes the app, keeps + reports data dirs
out="$(VAYU_DRYRUN=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf ${APP_PATH}" || fail "uninstall should remove the app bundle"
echo "$out" | grep -q "Application Support/vayu-client" || fail "uninstall should mention the data dir"
echo "$out" | grep -qi "kept" || fail "uninstall (no purge) should say data was kept"

# uninstall --purge: also removes data dirs
out="$(VAYU_DRYRUN=1 PURGE=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf .*Application Support/vayu-client" || fail "purge should remove the data dir"
echo "$out" | grep -q "rm -f .*com.vayu.client.plist" || fail "purge should remove prefs"

printf 'PASS: macOS uninstall dry-run\n'

# --- macOS install target resolution -----------------------------------------
# An update has to land on the copy the user actually launches. Dragging the app
# out of the DMG into ~/Applications used to leave the installer writing
# /Applications forever, updating a bundle nobody opened.
INSTALL_DIR_SAVED="$INSTALL_DIR"
APP_PATH_SAVED="$APP_PATH"

# Nothing installed: the default stands.
resolve_install_target
[ "$APP_PATH" = "$APP_PATH_SAVED" ] || fail "a fresh install should keep the default path, got $APP_PATH"

# Installed only in the home folder: update that one, not /Applications.
mkdir -p "$TMPROOT/home/${APP_NAME}.app"
resolve_install_target
[ "$APP_PATH" = "$TMPROOT/home/${APP_NAME}.app" ] || fail "should target the existing copy, got $APP_PATH"
[ "$INSTALL_DIR" = "$TMPROOT/home" ] || fail "INSTALL_DIR should follow the target, got $INSTALL_DIR"

# Installed in both: the first search dir wins and the other is reported, since
# silently updating one of two copies is how a stale build keeps launching.
mkdir -p "$TMPROOT/system/${APP_NAME}.app"
# Redirected to a file rather than captured with $(): a command substitution
# runs in a subshell, so the APP_PATH it resolves would not survive the call.
# do_install calls it outside its own subshell for the same reason.
resolve_install_target >"$TMPROOT/resolve.out" 2>&1
out="$(cat "$TMPROOT/resolve.out")"
[ "$APP_PATH" = "$TMPROOT/system/${APP_NAME}.app" ] || fail "the first search dir should win, got $APP_PATH"
echo "$out" | grep -q "more than one place" || fail "a second copy should be reported"
echo "$out" | grep -q "$TMPROOT/home/${APP_NAME}.app" || fail "the report should name the other copy"

# do_install has to actually resolve the target - computing the right path and
# then installing over the default one would pass every assertion above.
#
# Reset the globals first, or this proves nothing: the direct calls above
# already left APP_PATH resolved, so do_install would inherit the right answer
# without ever asking for it.
INSTALL_DIR="$INSTALL_DIR_SAVED"
APP_PATH="$APP_PATH_SAVED"
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
echo "$out" | grep -q "sudo ditto .* $TMPROOT/system/${APP_NAME}.app" \
	|| fail "do_install should install to the resolved target, not the default"

# Uninstall clears every copy it can find, not just the default one.
out="$(VAYU_DRYRUN=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf $TMPROOT/system/${APP_NAME}.app" || fail "uninstall should remove the system copy"
echo "$out" | grep -q "rm -rf $TMPROOT/home/${APP_NAME}.app" || fail "uninstall should remove the home copy"

INSTALL_DIR="$INSTALL_DIR_SAVED"
APP_PATH="$APP_PATH_SAVED"

printf 'PASS: macOS install target resolution\n'

# --- Linux -------------------------------------------------------------------
platform() { printf 'Linux\n'; }

got="$(download_url 0.1.3)"
want="https://github.com/athrvk/vayu/releases/download/v0.1.3/Vayu-0.1.3-x86_64.AppImage"
[ "$got" = "$want" ] || fail "Linux download_url mismatch: $got"

# resolve_install_target is macOS-only: Linux owns a single path, so there is
# nowhere for a second copy to hide and nothing to resolve.
APP_PATH_SAVED="$APP_PATH"
resolve_install_target
[ "$APP_PATH" = "$APP_PATH_SAVED" ] || fail "resolve_install_target should be a no-op on Linux"

# installed_version: the AppImage keeps its version inside a squashfs image, so
# the installer stamps what it wrote. Both the binary and the stamp have to be
# there - a stamp beside a deleted AppImage would skip an install that is needed.
[ -z "$(installed_version || true)" ] || fail "installed_version should be empty when not installed"
mkdir -p "$LINUX_APP_DIR"
printf '0.1.3\n' >"$LINUX_VERSION_FILE"
[ -z "$(installed_version || true)" ] || fail "a stamp with no AppImage should not count as installed"
touch "$LINUX_APP_BIN" && chmod +x "$LINUX_APP_BIN"
[ "$(installed_version)" = "0.1.3" ] || fail "installed_version should read the stamp, got $(installed_version || true)"

# Same version -> no download at all.
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
echo "$out" | grep -q "already installed" || fail "a matching version should skip the install"
if echo "$out" | grep -q "curl -fL"; then fail "a skipped install should not download anything"; fi

# --force reinstalls the same version.
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 FORCE=1 do_install 2>&1)"
echo "$out" | grep -q "curl -fL" || fail "--force should download even at the same version"

# A newer version updates, and says so.
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.2.0 do_install 2>&1)"
echo "$out" | grep -q "Updating Vayu 0.1.3 to 0.2.0" || fail "an existing install should be reported as an update"
echo "$out" | grep -q "chmod +x ${LINUX_APP_DIR}/\\.${APP_NAME}.AppImage.part" \
	|| fail "the AppImage has to be made executable"
# Staged in the destination directory, not the temp dir: a cross-filesystem mv
# copies through the destination instead of renaming, so an interrupt would
# leave the half-written executable the rename exists to prevent.
echo "$out" | grep -q "mv -f ${LINUX_APP_DIR}/\\.${APP_NAME}.AppImage.part ${LINUX_APP_BIN}" \
	|| fail "the AppImage should be renamed into place from beside its destination"
echo "$out" | grep -q "write ${LINUX_VERSION_FILE}" || fail "the installed version should be stamped"
echo "$out" | grep -q "write ${LINUX_DESKTOP_FILE}" || fail "a desktop entry should be registered"

# Nothing on Linux touches root: everything it writes is under $HOME. A sudo
# here would be a password prompt for no reason, and on a machine without sudo
# it would fail the install outright.
# Matches a command the script would run, not the libfuse advice below, which
# legitimately tells the user to run apt with sudo themselves.
if echo "$out" | grep -q '^\[dry-run\] sudo'; then fail "the Linux install must not run sudo"; fi

printf 'PASS: Linux install dry-run\n'

# The desktop entry is what makes Vayu appear in the launcher at all - the
# AppImage on its own is a file in ~/Downloads with no icon and no menu entry.
entry="$(desktop_entry)"
# Quoted: the Desktop Entry spec word-splits Exec, so an unquoted path with a
# space anywhere in $HOME makes the launcher try to run the first word and the
# menu entry silently does nothing.
echo "$entry" | grep -q "^Exec=\"${LINUX_APP_BIN}\" %U$" \
	|| fail "Exec should be the quoted path to the installed AppImage"
echo "$entry" | grep -q "^Type=Application$" || fail "desktop entry needs a Type"
echo "$entry" | grep -q "^Categories=Development;" || fail "desktop entry should be filed under Development"
# Without this the running window is a second, nameless icon in the dock rather
# than the one that launched it.
echo "$entry" | grep -q "^StartupWMClass=Vayu$" || fail "desktop entry needs StartupWMClass"

# The `vayu` command is linked only when ~/.local/bin is somewhere the shell
# will look - a link nothing can find is just a file to clean up later.
HOME_SAVED="$HOME"
PATH_SAVED="$PATH"
HOME="$TMPROOT"
LINUX_BIN_LINK="$HOME/.local/bin/vayu"
PATH="$HOME/.local/bin:$PATH_SAVED"
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.2.0 do_install 2>&1)"
echo "$out" | grep -q "ln -sf ${LINUX_APP_BIN} ${LINUX_BIN_LINK}" || fail "should link vayu when ~/.local/bin is on PATH"
PATH="$PATH_SAVED"
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.2.0 do_install 2>&1)"
if echo "$out" | grep -q "ln -sf"; then fail "should not link vayu when ~/.local/bin is not on PATH"; fi
echo "$out" | grep -q "not on PATH" || fail "should say why no command was linked"
HOME="$HOME_SAVED"
PATH="$PATH_SAVED"

printf 'PASS: Linux desktop integration\n'

# Uninstall removes what the install created, and nothing else.
out="$(VAYU_DRYRUN=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf ${LINUX_APP_DIR}" || fail "uninstall should remove the AppImage directory"
echo "$out" | grep -q "rm -f ${LINUX_DESKTOP_FILE}" || fail "uninstall should remove the desktop entry"
echo "$out" | grep -q "rm -f ${LINUX_ICON_FILE}" || fail "uninstall should remove the icon"
echo "$out" | grep -qi "kept" || fail "uninstall (no purge) should say data was kept"
if echo "$out" | grep -q '^\[dry-run\] sudo'; then fail "Linux uninstall must not run sudo"; fi

out="$(VAYU_DRYRUN=1 PURGE=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf .*/vayu-client" || fail "purge should remove the config dir"

# A `vayu` on PATH that someone else put there must survive an uninstall.
mkdir -p "$TMPROOT/bin"
LINUX_BIN_LINK="$TMPROOT/bin/vayu"
ln -sf /bin/true "$LINUX_BIN_LINK"
out="$(VAYU_DRYRUN=1 do_uninstall 2>&1)"
if echo "$out" | grep -q "rm -f ${LINUX_BIN_LINK}"; then
	fail "uninstall must not remove a vayu link pointing somewhere else"
fi
ln -sf "$LINUX_APP_BIN" "$LINUX_BIN_LINK"
out="$(VAYU_DRYRUN=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -f ${LINUX_BIN_LINK}" || fail "uninstall should remove its own vayu link"

printf 'PASS: Linux uninstall dry-run\n'

# --- invoked the way users invoke it -----------------------------------------
# Everything above sources install.sh, which is not how anyone runs it. The
# documented command is `bash -c "$(curl ...)"`, and that puts the entire file -
# comments included - into the installer's own argv. A `pgrep -f` pattern that
# matches any text in this script therefore matches the installer itself and
# every subshell it forks, and no amount of sourcing-based testing can see it.
#
# That is not theoretical: a comment naming the AppImage's mount directory sat
# directly above a pattern matching it, so running_pids always reported Vayu as
# running, quit_running_app always failed to stop it, and every Linux install
# aborted. This is the only test that would have caught it.
for os in Linux Darwin; do
	got="$(VAYU_TEST=1 bash -c "$(cat "$INSTALLER")
platform() { printf '$os\n'; }
printf 'PIDS[%s]' \"\$(running_pids | tr '\n' ' ')\"")"
	[ "$got" = "PIDS[]" ] \
		|| fail "$os: running_pids matched the installer's own process: $got"
done

printf 'PASS: no self-match when run from argv\n'

# --- download integrity ------------------------------------------------------
# Real curl against file:// URLs - no network, no stubs, and it exercises the
# actual failure handling rather than a mock of it.
payload="$TMPROOT/asset.bin"
dest="$TMPROOT/downloaded.bin"
printf 'pretend this is 150MB of AppImage\n' >"$payload"

# A failed transfer must not be reported as success. download_asset is called as
# `download_asset ... || exit 1`, and bash disables errexit for the whole body
# of a function invoked that way - so an unchecked curl fell straight through
# and the caller installed whatever was, or was not, on disk.
if download_asset "file://$TMPROOT/does-not-exist" "$dest" >/dev/null 2>&1; then
	fail "a failed download must not report success"
fi

# A published checksum that matches verifies...
printf '%s  asset.bin\n' "$(sha256_of "$payload")" >"$payload.sha256"
download_asset "file://$payload" "$dest" >/dev/null 2>&1 \
	|| fail "a matching checksum should verify"

# ...and one that disagrees aborts rather than installing the file.
printf '%s  asset.bin\n' "deadbeef" >"$payload.sha256"
if download_asset "file://$payload" "$dest" >/dev/null 2>&1; then
	fail "a mismatched checksum must abort the install"
fi
rm -f "$payload.sha256"

printf 'PASS: download integrity\n'

# --- version resolution ------------------------------------------------------
# Only the VAYU_VERSION shortcut was covered, so the parsing that every
# unpinned install depends on had no test at all.
unset VAYU_VERSION
curl() {
	cat <<'JSON'
{ "url": "https://api.github.com/repos/athrvk/vayu/releases/1", "tag_name": "v9.9.9",
  "name": "v9.9.9", "body": "tag_name is mentioned in this body too" }
JSON
}
[ "$(resolve_version)" = "9.9.9" ] || fail "resolve_version should read the tag, got $(resolve_version)"
unset -f curl

# A pinned version is normalised the same way, so VAYU_VERSION=v0.1.3 does not
# build a /download/vv0.1.3/ URL.
VAYU_VERSION=v0.1.3
[ "$(resolve_version)" = "0.1.3" ] || fail "a leading v should be stripped, got $(resolve_version)"
unset VAYU_VERSION

printf 'PASS: version resolution\n'

# --- host checks -------------------------------------------------------------
# require_supported_os returns early under VAYU_DRYRUN, which every other test
# sets - so its real checks had never run.
uname() { case "${1:-}" in -m) printf 'aarch64\n' ;; *) printf 'Linux\n' ;; esac; }
if (VAYU_DRYRUN=0 require_supported_os) >/dev/null 2>&1; then
	fail "an arm64 Linux machine should be refused, not sent a 404 to chmod +x"
fi
uname() { case "${1:-}" in -m) printf 'x86_64\n' ;; *) printf 'Linux\n' ;; esac; }
(VAYU_DRYRUN=0 require_supported_os) >/dev/null 2>&1 \
	|| fail "x86_64 Linux should be accepted"
if (VAYU_DRYRUN=0 HOME='' require_supported_os) >/dev/null 2>&1; then
	fail "an unset HOME should be refused before anything is written"
fi
unset -f uname

printf 'PASS: host checks\n'

# --- the answer that aborts an install ---------------------------------------
# confirm() cannot reach its own parsing without a terminal, so every test above
# either returns early (VAYU_DRYRUN) or stubs it out - meaning "n" had never
# been parsed by anything. The parsing lives in reply_is_no for that reason.
for answer in n N no NO nope "No thanks"; do
	reply_is_no "$answer" || fail "'$answer' should decline"
done
for answer in y Y yes "" maybe later; do
	if reply_is_no "$answer"; then fail "'$answer' should not decline"; fi
done

# The two shortcuts have to mean yes, or an unattended run would hang or abort.
(VAYU_DRYRUN=1 confirm 'unused') || fail "a dry run should never block on a prompt"
(VAYU_DRYRUN=0 VAYU_ASSUME_YES=1 confirm 'unused') || fail "VAYU_ASSUME_YES should mean yes"

# And the prompt itself, end to end. confirm() reads $VAYU_TTY rather than
# stdin, so that the documented `bash -c "$(curl …)"` form works and a
# `curl … | bash` cannot have its own script swallowed by the read - which also
# makes the terminal substitutable here.
printf 'n\n' >"$TMPROOT/answer-no"
if (VAYU_DRYRUN=0 VAYU_TTY="$TMPROOT/answer-no" confirm 'Quit Vayu now?') then
	fail "typing n at the prompt should decline"
fi
printf 'y\n' >"$TMPROOT/answer-yes"
(VAYU_DRYRUN=0 VAYU_TTY="$TMPROOT/answer-yes" confirm 'Quit Vayu now?') \
	|| fail "typing y at the prompt should accept"
# Enter on its own is the documented default.
printf '\n' >"$TMPROOT/answer-empty"
(VAYU_DRYRUN=0 VAYU_TTY="$TMPROOT/answer-empty" confirm 'Quit Vayu now?') \
	|| fail "an empty answer should take the default"
# And the question has to actually reach the terminal.
(VAYU_DRYRUN=0 VAYU_TTY="$TMPROOT/answer-yes" confirm 'Quit Vayu now?') >/dev/null 2>&1
grep -q 'Quit Vayu now? \[Y/n\]' "$TMPROOT/answer-yes" || fail "the prompt should be written to the terminal"

printf 'PASS: confirm parsing\n'

# --- dry-run rendering -------------------------------------------------------
# The tests read these lines, so an argument with a space in it must not render
# the same as two arguments - a $HOME with a space would otherwise let an
# assertion match a command the installer never ran.
got="$(dry_run_line mv -f "/a b" /c)"
[ "$got" = "[dry-run] mv -f '/a b' /c" ] || fail "spaces in an argument should be quoted, got: $got"

printf 'PASS: dry-run rendering\n'

# --- running-app guard -------------------------------------------------------
# Last, because these stub out running_pids/confirm and the stubs would leak
# into anything after them.
#
# Detection itself needs a live app, but the invariant it exists for - never
# replace files out from under a running process - is testable, and it is the
# whole reason the update path is safe.
platform() { printf 'Darwin\n'; }
running_pids() { printf '99999\n'; }

out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
echo "$out" | grep -q "Quitting Vayu" || fail "a running app should be quit before it is replaced"
echo "$out" | grep -q "osascript" \
	|| fail "quit should go through an Apple Event, so the app flushes saves and stops the engine"
echo "$out" | grep -q "sudo ditto" || fail "install should still proceed after the app quits"
echo "$out" | grep -q "launch ${APP_PATH}" || fail "an app quit by the installer should be reopened"

# Linux has no Apple Event, so the polite form is a signal - and it is only
# polite because main.ts handles SIGTERM (electron/quit-signals.ts). SIGKILL
# first would lose exactly the saves the quit is protecting.
platform() { printf 'Linux\n'; }
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.2.0 do_install 2>&1)"
echo "$out" | grep -q "kill -TERM 99999" || fail "Linux should ask the app to quit with SIGTERM"
if echo "$out" | grep -q "kill -KILL"; then fail "SIGKILL should only follow an ignored SIGTERM"; fi
echo "$out" | grep -q "launch ${LINUX_APP_BIN}" || fail "an app quit by the installer should be reopened"

# That last assertion is weaker than it looks on its own: wait_for_exit returns
# immediately under VAYU_DRYRUN, so the escalation is unreachable in every other
# test and deleting it outright would keep the suite green. Force the "app
# ignored the request" path to cover it for real.
wait_for_exit() { return 1; }
if out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.2.0 do_install 2>&1)"; then
	fail "an app that will not quit should abort the install"
fi
echo "$out" | grep -q "kill -TERM 99999" || fail "the polite signal should come first"
echo "$out" | grep -q "kill -KILL 99999" || fail "an ignored SIGTERM should escalate to SIGKILL"
echo "$out" | grep -q "Could not stop Vayu" || fail "a Vayu that will not die should say so"
if echo "$out" | grep -q "mv -f"; then fail "nothing should be replaced when the app is still running"; fi
unset -f wait_for_exit

# Declining leaves the install untouched: nothing replaced, non-zero exit.
confirm() { return 1; }
if out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.2.0 do_install 2>&1)"; then
	fail "declining the quit should abort the install"
fi
if echo "$out" | grep -q "mv -f"; then
	fail "declining the quit must not replace the AppImage"
fi
platform() { printf 'Darwin\n'; }
if out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"; then
	fail "declining the quit should abort the install"
fi
if echo "$out" | grep -q "sudo rm -rf ${APP_PATH}"; then
	fail "declining the quit must not delete the running app"
fi
if echo "$out" | grep -q "ditto"; then
	fail "declining the quit must not replace the bundle"
fi

# Two guards, not one: the first spares you a download you would abandon, the
# second covers the app being reopened while a slow download ran. A single
# guard passes every assertion above, so count and place them explicitly.
platform() { printf 'Darwin\n'; }
unset -f confirm
quit_running_app() { printf 'QUIT-MARK\n'; return 0; }
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
[ "$(echo "$out" | grep -c 'QUIT-MARK')" = "2" ] \
	|| fail "the app should be checked twice: before the download and before the swap"
first_quit="$(echo "$out" | grep -n 'QUIT-MARK' | head -1 | cut -d: -f1)"
download="$(echo "$out" | grep -n 'Downloading' | head -1 | cut -d: -f1)"
last_quit="$(echo "$out" | grep -n 'QUIT-MARK' | tail -1 | cut -d: -f1)"
swap="$(echo "$out" | grep -n 'sudo ditto' | head -1 | cut -d: -f1)"
[ "$first_quit" -lt "$download" ] || fail "the first check belongs before the download"
if [ "$last_quit" -ge "$swap" ] || [ "$last_quit" -le "$download" ]; then
	fail "the second check belongs after the download and before the bundle is replaced"
fi

printf 'PASS: running-app guard\n'
