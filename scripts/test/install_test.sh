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
echo "$out" | grep -q "xattr -cr ${APP_PATH}" \
	|| fail "install should strip quarantine"

printf 'PASS: install dry-run\n'

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
