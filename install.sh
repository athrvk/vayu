#!/usr/bin/env bash
set -euo pipefail

REPO="athrvk/vayu"
APP_NAME="Vayu"
INSTALL_DIR="/Applications"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
SIDECAR_REL="Contents/Resources/bin/vayu-engine"

MODE="install"
PURGE=0
FORCE=0

# Run a command, or just print it when VAYU_DRYRUN=1.
run() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		printf '[dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

# run(), for commands whose own output is noise we handle ourselves - osascript
# prints an error when the app is not scriptable or Automation consent was
# denied, and both just fall through to the signal path. Redirecting the run()
# call itself would silence the dry-run line too, which is the only way these
# steps are visible to the tests.
run_quiet() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		printf '[dry-run] %s\n' "$*"
	else
		"$@" >/dev/null 2>&1
	fi
}

parse_args() {
	MODE="install"
	PURGE=0
	FORCE=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--uninstall) MODE="uninstall" ;;
			--purge) PURGE=1 ;;
			--force) FORCE=1 ;;
			--help|-h) MODE="help" ;;
			*) printf 'Unknown option: %s\n' "$1" >&2; return 2 ;;
		esac
		shift
	done
}

resolve_version() {
	if [ -n "${VAYU_VERSION:-}" ]; then
		printf '%s' "$VAYU_VERSION"
		return 0
	fi
	curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
		| grep '"tag_name"' \
		| head -1 \
		| sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/'
}

download_url() {
	local version="$1"
	printf 'https://github.com/%s/releases/download/v%s/%s-%s-universal.zip' \
		"$REPO" "$version" "$APP_NAME" "$version"
}

# Ask a yes/no question, defaulting to yes.
#
# Reads /dev/tty rather than stdin. The documented command is
# `bash -c "$(curl ...)"`, which leaves stdin on the terminal, but someone
# piping `curl ... | bash` puts the *script* on stdin and a read there would
# swallow the rest of it. With no terminal at all - CI, a cron job - there is
# nobody to ask, so the default stands and the caller says what it is doing.
confirm() {
	local prompt="$1" reply=""
	[ "${VAYU_DRYRUN:-0}" = "1" ] && return 0
	[ "${VAYU_ASSUME_YES:-0}" = "1" ] && return 0
	[ -r /dev/tty ] || return 0
	printf '%s [Y/n] ' "$prompt" >/dev/tty
	read -r reply </dev/tty || return 0
	case "$reply" in
		[nN]*) return 1 ;;
		*) return 0 ;;
	esac
}

# PIDs of everything running out of the bundle we are about to replace: the app,
# its Electron helpers, and the vayu-engine sidecar. Matched on the bundle path,
# not the process name, so a Vayu installed somewhere else is left alone.
running_pids() {
	pgrep -f "${APP_PATH}/" 2>/dev/null | grep -vx -e "$$" -e "$PPID" || true
}

# Wait for the bundle's processes to go away. Dry-run never quits anything, so
# it must not sit here for the timeout.
wait_for_exit() {
	local limit="$1" waited=0
	[ "${VAYU_DRYRUN:-0}" = "1" ] && return 0
	while [ -n "$(running_pids)" ]; do
		[ "$waited" -ge "$limit" ] && return 1
		sleep 1
		waited=$((waited + 1))
	done
	return 0
}

# Quit a running Vayu before its bundle is replaced.
#
# macOS happily deletes a running app: the process keeps the file handles it
# already has while everything it loads lazily disappears underneath it, so an
# update over a running Vayu can crash it or leave it half-working until
# relaunch. Since re-running this script *is* how macOS updates (the app is
# ad-hoc signed, so Squirrel.Mac cannot verify an in-place update and the app
# only notifies), a running app is the normal case here, not the exception.
#
# `quit` goes through AppleScript because that is a real Apple Event: Electron
# handles it like Cmd-Q, so the app's before-quit hook flushes pending saves and
# shuts down the engine and MCP server first. A signal skips all of that, so it
# is only the fallback. Note macOS may ask you to allow the terminal to control
# Vayu the first time (Automation consent) - denying it just falls through to
# the signal path.
#
# Returns 0 when nothing is running or it quit, 1 when the user said no.
quit_running_app() {
	[ -n "$(running_pids)" ] || return 0

	printf 'Vayu is running, and cannot be replaced while it is.\n'
	if ! confirm 'Quit Vayu now?'; then
		printf 'Not quitting - aborting so the running app is not deleted underneath itself.\n' >&2
		printf 'Quit Vayu and re-run this command.\n' >&2
		return 1
	fi

	printf 'Quitting Vayu...\n'
	run_quiet osascript -e "tell application \"${APP_NAME}\" to quit" || true
	wait_for_exit 15 && return 0

	printf 'Vayu did not respond - stopping it.\n'
	run_quiet pkill -f "${APP_PATH}/" || true
	wait_for_exit 5 && return 0

	printf 'Could not stop Vayu. Quit it manually and re-run this command.\n' >&2
	return 1
}

# Version of the installed bundle, or nothing if Vayu is not installed.
# plutil rather than `defaults read`, which caches plists and can answer stale.
installed_version() {
	[ -f "$APP_PATH/Contents/Info.plist" ] || return 1
	/usr/bin/plutil -extract CFBundleShortVersionString raw -o - \
		"$APP_PATH/Contents/Info.plist" 2>/dev/null
}

# Kept pure so it can be tested off macOS. Re-running the command is how people
# update, and it is also what someone does when they are not sure whether they
# already updated - answering "you are on it already" beats re-downloading 150MB
# to arrive at the same bundle. --force is the escape hatch for a repair.
should_skip_install() {
	local installed="$1" target="$2" force="$3"
	[ "$force" = "1" ] && return 1
	[ -n "$installed" ] && [ "$installed" = "$target" ]
}

require_macos() {
	[ "${VAYU_DRYRUN:-0}" = "1" ] && return 0
	[ "$(uname -s)" = "Darwin" ] || { printf 'Vayu installer supports macOS only.\n' >&2; exit 1; }
	for tool in curl unzip codesign xattr shasum; do
		command -v "$tool" >/dev/null 2>&1 || { printf 'Required tool missing: %s\n' "$tool" >&2; exit 1; }
	done
}

do_install() {
	require_macos
	(
		local version url workdir zip expected actual staged keepalive_pid=""
		local installed quit_by_installer=0
		version="$(resolve_version)"
		[ -n "$version" ] || { printf 'Could not determine version to install.\n' >&2; exit 1; }
		url="$(download_url "$version")"

		installed="$(installed_version || true)"
		if should_skip_install "$installed" "$version" "$FORCE"; then
			printf 'Vayu %s is already installed - nothing to do.\n' "$version"
			printf 'Re-run with --force to reinstall it anyway.\n'
			exit 0
		fi

		if [ -n "$installed" ]; then
			printf 'Updating Vayu %s to %s...\n' "$installed" "$version"
		else
			printf 'Installing Vayu %s...\n' "$version"
		fi

		# Before the download, so declining costs nothing. Checked again just
		# before the bundle is replaced, in case it was relaunched meanwhile.
		if [ -n "$(running_pids)" ]; then
			quit_running_app || exit 1
			quit_by_installer=1
		fi

		workdir="$(mktemp -d)"

		# Authorize the privileged copy into /Applications up front, so the
		# password prompt appears immediately instead of after the download.
		if [ "${VAYU_DRYRUN:-0}" != "1" ]; then
			printf 'Vayu installs to %s and needs administrator access.\n' "$INSTALL_DIR"
			sudo -v || { printf 'Authorization failed - aborting.\n' >&2; exit 1; }
			# Refresh the sudo timestamp in the background so it does not expire
			# during a slow download; the loop stops once sudo can no longer
			# refresh non-interactively (i.e. after the script exits).
			( while true; do sleep 60; sudo -n true 2>/dev/null || exit; done ) &
			keepalive_pid=$!
		fi
		trap 'rm -rf "$workdir"; [ -n "$keepalive_pid" ] && kill "$keepalive_pid" 2>/dev/null' EXIT
		zip="$workdir/vayu.zip"

		printf 'Downloading %s\n' "$url"
		# Default curl meter (drop -s) shows %, size, speed and ETA on stderr.
		run curl -fL "$url" -o "$zip"

		# Optional integrity check if the release publishes a .sha256
		if [ "${VAYU_DRYRUN:-0}" != "1" ] && curl -fsSL "$url.sha256" -o "$zip.sha256" 2>/dev/null; then
			expected="$(awk '{print $1}' "$zip.sha256")"
			actual="$(shasum -a 256 "$zip" | awk '{print $1}')"
			[ "$expected" = "$actual" ] || { printf 'Checksum mismatch - aborting.\n' >&2; exit 1; }
			printf 'Checksum verified.\n'
		fi

		printf 'Extracting...\n'
		run unzip -q -o "$zip" -d "$workdir"
		staged="$workdir/${APP_NAME}.app"

		# Ad-hoc sign + de-quarantine in the temp dir first, so a failure
		# never leaves a broken bundle in /Applications. No sudo needed here.
		printf 'Signing (ad-hoc) and removing quarantine...\n'
		run codesign --force --sign - "$staged/$SIDECAR_REL"
		run codesign --force --deep --sign - "$staged"
		run xattr -cr "$staged"

		# The download and signing above take long enough for someone to open
		# Vayu again after quitting it. Deleting the bundle now would be the
		# exact thing the earlier prompt avoided, so ask once more.
		if [ -n "$(running_pids)" ]; then
			quit_running_app || exit 1
			quit_by_installer=1
		fi

		printf 'Installing to %s...\n' "$INSTALL_DIR"
		run sudo rm -rf "$APP_PATH"
		run sudo ditto "$staged" "$APP_PATH"

		if [ "$quit_by_installer" = "1" ]; then
			# It was running when the user started this, so put it back.
			printf 'Reopening Vayu...\n'
			run open "$APP_PATH"
		else
			printf 'Done. Launch Vayu from Launchpad/Spotlight, or run: open "%s"\n' "$APP_PATH"
		fi
	)
}

do_uninstall() {
	require_macos
	local support prefs logs caches savedstate
	support="$HOME/Library/Application Support/vayu-client"
	prefs="$HOME/Library/Preferences/com.vayu.client.plist"
	logs="$HOME/Library/Logs/vayu-client"
	caches="$HOME/Library/Caches/com.vayu.client"
	savedstate="$HOME/Library/Saved Application State/com.vayu.client.savedState"

	printf 'Removing %s (you may be prompted for your password)...\n' "$APP_PATH"
	run sudo rm -rf "$APP_PATH"

	if [ "${PURGE:-0}" = "1" ]; then
		printf 'Purging user data...\n'
		run rm -rf "$support"
		run rm -f "$prefs"
		run rm -rf "$logs"
		run rm -rf "$caches"
		run rm -rf "$savedstate"
		printf 'Vayu and its data have been removed.\n'
	else
		printf 'Vayu removed. User data was kept at:\n'
		printf '  %s\n' "$support"
		printf '  %s\n' "$prefs"
		printf '  %s\n' "$logs"
		printf 'Re-run with --purge to remove these too.\n'
	fi
}

main() {
	parse_args "$@"
	case "$MODE" in
		help) usage ;;
		install) do_install ;;
		uninstall) do_uninstall ;;
	esac
}

usage() {
	# The docs site serves this very script at that URL (published from the repo
	# root by .github/hooks/install_script.py), so the lines below are the exact
	# commands README.md and docs/index.md give.
	local url="https://athrvk.github.io/vayu/install.sh"
	cat <<EOF
Vayu installer
  install:        bash -c "\$(curl -fsSL $url)"
  update:         same command - it replaces the app in place and keeps your data
  pin version:    VAYU_VERSION=x.y.z bash -c "\$(curl -fsSL $url)"
  reinstall:      bash -c "\$(curl -fsSL $url)" -- --force
  uninstall:      bash -c "\$(curl -fsSL $url)" -- --uninstall [--purge]

Updating quits a running Vayu first (it asks). Set VAYU_ASSUME_YES=1 to skip
the prompt. Re-running when the latest version is already installed does
nothing unless --force is given.
EOF
}

if [ "${VAYU_TEST:-0}" != "1" ]; then
	main "$@"
fi
