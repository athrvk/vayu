#!/usr/bin/env bash
set -euo pipefail

# Source the installer (at repo root) in test mode so main() does not run.
VAYU_TEST=1
# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")/../.." && pwd)/install.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

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

# download_url: builds the GitHub release asset URL from a version
got="$(download_url 0.1.3)"
want="https://github.com/athrvk/vayu/releases/download/v0.1.3/Vayu-0.1.3-universal.zip"
[ "$got" = "$want" ] || fail "download_url mismatch: $got"

printf 'PASS: version + url\n'

# do_install in dry-run prints the key steps without touching the system
out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
echo "$out" | grep -q "codesign --force --sign - .*${APP_NAME}.app/Contents/Resources/bin/vayu-engine" \
	|| fail "install should ad-hoc sign the sidecar"
echo "$out" | grep -q "codesign --force --deep --sign - .*${APP_NAME}.app" \
	|| fail "install should ad-hoc sign the app bundle"
echo "$out" | grep -q "xattr -cr .*${APP_NAME}.app" \
	|| fail "install should strip quarantine on the staged app"
echo "$out" | grep -q "sudo ditto .*${APP_NAME}.app ${APP_PATH}" \
	|| fail "install should ditto the signed app into /Applications"

printf 'PASS: install dry-run\n'

# should_skip_install: re-running the command is how people update, so the
# same-version case has to be a no-op rather than a 150MB round trip.
should_skip_install 0.1.3 0.1.3 0 || fail "same version should skip"
if should_skip_install 0.1.3 0.1.3 1; then fail "--force should reinstall the same version"; fi
if should_skip_install 0.1.2 0.1.3 0; then fail "an older install should not skip"; fi
if should_skip_install 0.1.4 0.1.3 0; then fail "a different version should not skip"; fi
if should_skip_install "" 0.1.3 0; then fail "a fresh install should not skip"; fi

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

printf 'PASS: update safety\n'

# uninstall (no purge): removes the app, keeps + reports data dirs
out="$(VAYU_DRYRUN=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf ${APP_PATH}" || fail "uninstall should remove the app bundle"
echo "$out" | grep -q "Application Support/vayu-client" || fail "uninstall should mention the data dir"
echo "$out" | grep -qi "kept" || fail "uninstall (no purge) should say data was kept"

# uninstall --purge: also removes data dirs
out="$(VAYU_DRYRUN=1 PURGE=1 do_uninstall 2>&1)"
echo "$out" | grep -q "rm -rf .*Application Support/vayu-client" || fail "purge should remove the data dir"
echo "$out" | grep -q "rm -f .*com.vayu.client.plist" || fail "purge should remove prefs"

printf 'PASS: uninstall dry-run\n'

# --- running-app guard -------------------------------------------------------
# Last, because these stub out running_pids/confirm and the stubs would leak
# into anything after them.
#
# Detection itself needs a live macOS app, but the invariant it exists for -
# never delete the bundle out from under a running process - is testable, and it
# is the whole reason the update path is safe.
running_pids() { printf '99999\n'; }

out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"
echo "$out" | grep -q "Quitting Vayu" || fail "a running app should be quit before it is replaced"
echo "$out" | grep -q "osascript" \
	|| fail "quit should go through an Apple Event, so the app flushes saves and stops the engine"
echo "$out" | grep -q "sudo ditto" || fail "install should still proceed after the app quits"
echo "$out" | grep -q "open ${APP_PATH}" || fail "an app quit by the installer should be reopened"

# Declining leaves the install untouched: no delete, no copy, non-zero exit.
confirm() { return 1; }
if out="$(VAYU_DRYRUN=1 VAYU_VERSION=0.1.3 do_install 2>&1)"; then
	fail "declining the quit should abort the install"
fi
if echo "$out" | grep -q "sudo rm -rf ${APP_PATH}"; then
	fail "declining the quit must not delete the running app"
fi
if echo "$out" | grep -q "ditto"; then
	fail "declining the quit must not replace the bundle"
fi

printf 'PASS: running-app guard\n'
