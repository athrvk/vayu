#!/usr/bin/env bash
set -euo pipefail

# End-to-end installer test: runs install.sh for real.
#
# Everything in install_test.sh is a dry run, which means it asserts on the
# commands the installer *would* have run - the exact strings, in the order they
# are printed. That is refactor-hostile (rename a flag and a test breaks though
# nothing changed) and, worse, it cannot see anything that only goes wrong when a
# command actually executes. Two of the bugs in this script's history were of
# exactly that kind: a `pgrep` pattern that matched the installer's own process,
# and a download failure that was reported as success.
#
# So this one performs a real install from a local release into a temporary root
# and then looks at the filesystem: the binary is there and executable, the
# desktop entry points where it should, the version stamp says what was
# installed, re-running is a no-op, an update replaces it, and uninstall leaves
# nothing behind.
#
# Run directly: bash scripts/test/install_e2e.sh
# CI runs it on Linux and macOS; the two do different work and share the flow.

INSTALLER="$(cd "$(dirname "$0")/../.." && pwd)/install.sh"
OS="$(uname -s)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ROOT="$WORK/root"
RELEASES="$WORK/releases"
mkdir -p "$ROOT" "$ROOT/sys/Applications" "$RELEASES"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# The installer runs with $HOME and the macOS Applications directory both inside
# the temp tree, so a real install cannot touch the machine running this.
# VAYU_TTY keeps the quit prompt away from the terminal, VAYU_ASSUME_YES answers
# it, and VAYU_RELEASE_BASE points the download at the local release below.
installer() {
	env \
		HOME="$ROOT" \
		XDG_DATA_HOME="$ROOT/.local/share" \
		XDG_CONFIG_HOME="$ROOT/.config" \
		XDG_CACHE_HOME="$ROOT/.cache" \
		VAYU_ROOT="$ROOT/sys" \
		VAYU_RELEASE_BASE="file://$RELEASES" \
		VAYU_ASSUME_YES=1 \
		VAYU_TTY=/dev/null \
		PATH="$PATH" \
		bash "$INSTALLER" "$@"
}

# --- build a release to install ----------------------------------------------

make_linux_release() {
	local version="$1" dir
	dir="$RELEASES/v$version"
	mkdir -p "$dir"
	# A stand-in for the 160MB AppImage. The installer never looks inside it.
	printf '#!/bin/sh\necho "Vayu %s"\n' "$version" >"$dir/Vayu-$version-x86_64.AppImage"
}

make_macos_release() {
	local version="$1" dir staging
	dir="$RELEASES/v$version"
	staging="$WORK/staging-$version"
	mkdir -p "$dir" "$staging/Vayu.app/Contents/MacOS" "$staging/Vayu.app/Contents/Resources/bin"
	# codesign needs a real Mach-O as the bundle's main executable, so borrow
	# one rather than writing a script it would refuse to sign.
	cp /bin/echo "$staging/Vayu.app/Contents/MacOS/Vayu"
	cp /bin/echo "$staging/Vayu.app/Contents/Resources/bin/vayu-engine"
	cat >"$staging/Vayu.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>Vayu</string>
	<key>CFBundleIdentifier</key><string>com.vayu.client</string>
	<key>CFBundleName</key><string>Vayu</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$version</string>
	<key>CFBundleVersion</key><string>$version</string>
</dict>
</plist>
PLIST
	# ditto -c -k is how the release zip is built, so the test archive is the
	# same shape the installer will meet in production.
	(cd "$staging" && ditto -c -k --keepParent "Vayu.app" "$dir/Vayu-$version-universal.zip")
}

installed_binary() {
	case "$OS" in
		Darwin) printf '%s/sys/Applications/Vayu.app' "$ROOT" ;;
		*)      printf '%s/.local/share/vayu/Vayu.AppImage' "$ROOT" ;;
	esac
}

make_release() {
	case "$OS" in
		Darwin) make_macos_release "$1" ;;
		*)      make_linux_release "$1" ;;
	esac
}

# --- install -----------------------------------------------------------------

make_release 1.0.0
out="$(VAYU_VERSION=1.0.0 installer 2>&1)" || fail "install failed: $out"
printf '%s\n' "$out" | sed 's/^/  | /'

target="$(installed_binary)"
[ -e "$target" ] || fail "nothing was installed at $target"

case "$OS" in
	Darwin)
		[ -x "$target/Contents/MacOS/Vayu" ] || fail "the bundle's executable is missing or not executable"
		[ -f "$target/Contents/Info.plist" ] || fail "the bundle has no Info.plist"
		# The extraction really ran, and really produced a signed bundle: this is
		# the step no dry run can exercise.
		codesign --verify --deep "$target" 2>/dev/null || fail "the installed bundle is not ad-hoc signed"
		[ -e "$target.new" ] && fail "the staging bundle should not survive the swap"
		version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist")"
		[ "$version" = "1.0.0" ] || fail "installed version reads as $version"
		;;
	*)
		[ -x "$target" ] || fail "the AppImage is not executable"
		[ "$(cat "$ROOT/.local/share/vayu/version")" = "1.0.0" ] \
			|| fail "version stamp says $(cat "$ROOT/.local/share/vayu/version")"
		desktop="$ROOT/.local/share/applications/vayu.desktop"
		[ -f "$desktop" ] || fail "no desktop entry was registered"
		grep -q "^Exec=\"$target\" %U$" "$desktop" \
			|| fail "Exec does not point at the installed AppImage: $(grep '^Exec=' "$desktop")"
		# The launcher entry has to be valid, not merely present - a malformed
		# one is ignored by the desktop environment with no error anywhere.
		if command -v desktop-file-validate >/dev/null 2>&1; then
			desktop-file-validate "$desktop" || fail "the desktop entry is not valid"
		fi
		[ -e "$ROOT/.local/share/vayu/.Vayu.AppImage.part" ] \
			&& fail "the staging file should not survive the install"
		;;
esac

printf 'PASS: real install\n'

# --- re-running is a no-op ---------------------------------------------------

before="$(ls -l "$target" 2>/dev/null)"
out="$(VAYU_VERSION=1.0.0 installer 2>&1)" || fail "re-run failed: $out"
printf '%s\n' "$out" | grep -q "already installed" || fail "re-running the same version should say so"
[ "$(ls -l "$target" 2>/dev/null)" = "$before" ] || fail "a no-op run should not have rewritten the install"

printf 'PASS: same version is a no-op\n'

# --- update ------------------------------------------------------------------

make_release 1.1.0
out="$(VAYU_VERSION=1.1.0 installer 2>&1)" || fail "update failed: $out"
printf '%s\n' "$out" | grep -q "Updating Vayu 1.0.0 to 1.1.0" || fail "an update should be reported as one"

case "$OS" in
	Darwin)
		version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist")"
		[ "$version" = "1.1.0" ] || fail "after the update the bundle still reads $version"
		codesign --verify --deep "$target" 2>/dev/null || fail "the updated bundle is not signed"
		;;
	*)
		[ "$(cat "$ROOT/.local/share/vayu/version")" = "1.1.0" ] \
			|| fail "the stamp was not updated"
		grep -q "Vayu 1.1.0" "$target" || fail "the AppImage itself was not replaced"
		;;
esac

printf 'PASS: real update\n'

# --- a broken download changes nothing ---------------------------------------
# The failure that silently installed a truncated AppImage. A missing asset is
# the same code path as a transfer that dies partway: curl exits non-zero and
# the installer must leave the working install alone.

if out="$(VAYU_VERSION=9.9.9 installer 2>&1)"; then
	fail "installing a version that does not exist should fail, not succeed"
fi
case "$OS" in
	Darwin)
		version="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$target/Contents/Info.plist")"
		[ "$version" = "1.1.0" ] || fail "a failed download damaged the install (now $version)"
		;;
	*)
		[ "$(cat "$ROOT/.local/share/vayu/version")" = "1.1.0" ] \
			|| fail "a failed download rewrote the version stamp"
		grep -q "Vayu 1.1.0" "$target" || fail "a failed download replaced the working AppImage"
		;;
esac

printf 'PASS: a failed download leaves the install intact\n'

# --- uninstall ---------------------------------------------------------------

mkdir -p "$ROOT/.config/vayu-client" "$ROOT/Library/Application Support/vayu-client"
out="$(installer --uninstall 2>&1)" || fail "uninstall failed: $out"
[ -e "$target" ] && fail "uninstall left the app at $target"

case "$OS" in
	Darwin)
		[ -d "$ROOT/Library/Application Support/vayu-client" ] \
			|| fail "a plain uninstall must keep user data"
		;;
	*)
		[ -e "$ROOT/.local/share/applications/vayu.desktop" ] && fail "the desktop entry survived uninstall"
		[ -d "$ROOT/.config/vayu-client" ] || fail "a plain uninstall must keep user data"
		;;
esac

out="$(installer --uninstall --purge 2>&1)" || fail "purge failed: $out"
case "$OS" in
	Darwin) [ -d "$ROOT/Library/Application Support/vayu-client" ] && fail "purge should remove user data" ;;
	*)      [ -d "$ROOT/.config/vayu-client" ] && fail "purge should remove user data" ;;
esac

printf 'PASS: real uninstall\n'
printf 'e2e: all checks passed on %s\n' "$OS"
