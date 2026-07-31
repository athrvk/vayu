#!/usr/bin/env bash
set -euo pipefail

REPO="athrvk/vayu"
APP_NAME="Vayu"

# ---------------------------------------------------------------------------
# Platform
#
# macOS and Linux share everything about *deciding* what to do - which version,
# whether it is already installed, whether the app has to be quit first - and
# almost nothing about *doing* it. macOS unpacks a zip, ad-hoc signs it past
# Gatekeeper and dittos a bundle into /Applications; Linux drops one AppImage
# under ~/.local and registers a desktop entry so it shows up in the launcher.
# So the shared machinery is written once and the per-platform half lives behind
# the small set of functions that dispatch on this.
#
# A function, not a constant, so a test can force either branch on either host.
# ---------------------------------------------------------------------------
platform() { uname -s; }

# --- macOS layout ---
# Where a fresh install goes. Both are re-pointed by resolve_install_target when
# Vayu is already installed somewhere else.
DEFAULT_INSTALL_DIR="/Applications"
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
SIDECAR_REL="Contents/Resources/bin/vayu-engine"

# --- Linux layout ---
# Everything under $HOME, which is why the Linux path never asks for a password:
# nothing it writes needs root. XDG_DATA_HOME is honoured because the people who
# set it are exactly the people who notice when a program ignores it.
LINUX_DATA_HOME="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
LINUX_APP_DIR="$LINUX_DATA_HOME/vayu"
LINUX_APP_BIN="$LINUX_APP_DIR/${APP_NAME}.AppImage"
# The AppImage carries no version anywhere readable without mounting it, so the
# installer records what it wrote. Losing this file only means the next run
# re-downloads rather than skipping - it is a cache, not state.
#
# The app writes it too, at startup, from electron/appimage-stamp.ts. It has to:
# the Linux AppImage updates itself in place (electron-updater, the "silent"
# strategy), so after a self-update this file would still name the version the
# installer put there and the next run would re-download 160MB for nothing. Both
# writers agree on the format - the version, one line, trailing newline - and
# this side trims whitespace when reading.
LINUX_VERSION_FILE="$LINUX_APP_DIR/version"
LINUX_DESKTOP_FILE="$LINUX_DATA_HOME/applications/vayu.desktop"
LINUX_ICON_FILE="$LINUX_DATA_HOME/icons/hicolor/256x256/apps/vayu.png"
LINUX_BIN_LINK="${HOME:-}/.local/bin/vayu"
# Served by the docs site from shared/icon_png/ (see .github/hooks/brand_assets.py),
# so the launcher icon comes from the same source as the app's own. Downloading
# it beats `--appimage-extract`, which some runtimes answer by unpacking the
# whole 400MB image into the temp dir instead of the one file asked for.
LINUX_ICON_URL="https://athrvk.github.io/vayu/images/vayu-icon.png"

# --- seams for the end-to-end test ---
# Not user-facing options. They exist so scripts/test/install_e2e.sh can perform
# a real install - download, extract, place, relaunch, uninstall - against a
# local release and a temporary root, instead of the tests only ever reading the
# commands a dry run would have run. Every one of them defaults to the real
# thing, so an ordinary run is unaffected.
VAYU_RELEASE_BASE="${VAYU_RELEASE_BASE:-https://github.com/$REPO/releases/download}"
VAYU_TTY="${VAYU_TTY:-/dev/tty}"
if [ -n "${VAYU_ROOT:-}" ]; then
	DEFAULT_INSTALL_DIR="$VAYU_ROOT/Applications"
	INSTALL_DIR="$DEFAULT_INSTALL_DIR"
	APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
fi

MODE="install"
PURGE=0
FORCE=0
KEEPALIVE_PID=""
# The version being installed, read by place_linux for its version stamp.
# Declared here rather than only inside do_install so `set -u` cannot bite a
# direct call to the place_* functions.
INSTALL_VERSION=""

# What a dry run prints for a command. Arguments containing whitespace are
# quoted, because "$*" alone renders `mv -f "/a b" /c` and `mv -f /a "b /c"`
# identically - and the tests read these lines.
dry_run_line() {
	local rendered="" arg
	for arg in "$@"; do
		case "$arg" in
			*[[:space:]]*) rendered="$rendered '$arg'" ;;
			*) rendered="$rendered $arg" ;;
		esac
	done
	printf '[dry-run]%s\n' "$rendered"
}

# Run a command, or just print it when VAYU_DRYRUN=1.
run() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		dry_run_line "$@"
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
		dry_run_line "$@"
	else
		"$@" >/dev/null 2>&1
	fi
}

# Write stdin to a file, or say so in a dry run. Used for the files this script
# generates rather than downloads (the desktop entry, the version stamp).
write_file() {
	local path="$1"
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		printf '[dry-run] write %s\n' "$path"
		cat >/dev/null
	else
		mkdir -p "$(dirname "$path")"
		cat >"$path"
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
			*)
				printf 'Unknown option: %s\n' "$1" >&2
				printf 'Run with --help to see what this script accepts.\n' >&2
				return 2
				;;
		esac
		shift
	done
}

resolve_version() {
	if [ -n "${VAYU_VERSION:-}" ]; then
		# Leading v stripped the same way the tag lookup below strips it, so
		# VAYU_VERSION=v0.12.0 does not build a /download/vv0.12.0/ URL.
		printf '%s' "${VAYU_VERSION#v}"
		return 0
	fi
	curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
		| grep '"tag_name"' \
		| head -1 \
		| sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/'
}

# The release asset for this platform. Both names are what electron-builder
# actually publishes (artifactName in app/electron-builder.json), version
# included - there is no unversioned alias to point at, which is why nothing
# here uses the /releases/latest/download/ form.
asset_name() {
	local version="$1"
	case "$(platform)" in
		Darwin) printf '%s-%s-universal.zip' "$APP_NAME" "$version" ;;
		*)      printf '%s-%s-x86_64.AppImage' "$APP_NAME" "$version" ;;
	esac
}

download_url() {
	local version="$1"
	printf '%s/v%s/%s' "$VAYU_RELEASE_BASE" "$version" "$(asset_name "$version")"
}

# Directories an existing Vayu could be in, most authoritative first.
#
# The second is what dragging the app out of the DMG into your own Applications
# folder produces. A copy there was invisible to this script, which always wrote
# /Applications - so the update landed on a bundle the user never launched, and
# the copy they did launch kept offering the same update forever.
#
# A function rather than a list so paths with spaces survive, and so tests can
# point it somewhere harmless. macOS only: the Linux layout is a single path
# this script owns, so there is nowhere else for a copy to hide.
search_dirs() {
	printf '%s\n' "$DEFAULT_INSTALL_DIR"
	if [ -n "${HOME:-}" ]; then
		printf '%s\n' "$HOME/Applications"
	fi
	return 0
}

# Every Vayu.app found in those directories, in the same order.
#
# Written with an `if` rather than `[ -d … ] && printf`: the latter makes the
# loop - and so the pipeline - exit non-zero whenever the *last* search dir has
# no bundle, which is the common case. The `return 0` below never runs then, and
# under `set -euo pipefail` the only reason this has not aborted is that every
# caller wraps it in `$(…)`, where bash ignores errexit. Do not lean on that.
# Deduplicated, keeping order: the two search directories collapse to one path
# whenever $HOME is the root of the Applications directory, and the same bundle
# listed twice reads as "installed in more than one place" and gets removed
# twice on uninstall.
existing_app_paths() {
	search_dirs | while IFS= read -r dir; do
		if [ -d "$dir/${APP_NAME}.app" ]; then
			printf '%s\n' "$dir/${APP_NAME}.app"
		fi
	done | awk '!seen[$0]++'
	return 0
}

# Point the install at the copy that already exists, so an update replaces the
# app the user actually opens. A fresh install keeps the default.
#
# `sudo` is used either way on macOS, including for a copy under $HOME that
# would not need it: one code path is worth more here than skipping a password
# prompt the script already asks for.
resolve_install_target() {
	local first others
	[ "$(platform)" = "Darwin" ] || return 0

	first="$(existing_app_paths | head -1)"
	[ -n "$first" ] || return 0

	APP_PATH="$first"
	INSTALL_DIR="$(dirname "$first")"

	# Two copies is the state this whole function exists to stop repeating.
	# Updating one of them silently is what leaves someone launching a stale
	# build while the installer reports success, so say it out loud.
	others="$(existing_app_paths | tail -n +2)"
	[ -n "$others" ] || return 0
	printf 'Vayu is installed in more than one place:\n'
	printf '%s\n' "$others" | while IFS= read -r path; do
		printf '  %s\n' "$path"
	done
	printf 'Updating %s - remove the other copy, or it will keep launching an old build.\n' "$APP_PATH"
	return 0
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
	if [ "${VAYU_DRYRUN:-0}" = "1" ] || [ "${VAYU_ASSUME_YES:-0}" = "1" ]; then
		return 0
	fi
	[ -r "$VAYU_TTY" ] || return 0
	# Appended, not truncating. On a terminal the two are identical - it is a
	# character device - but VAYU_TTY lets the tests point this at a file, and
	# `>` would erase the answer before the read below could see it.
	printf '%s [Y/n] ' "$prompt" >>"$VAYU_TTY"
	read -r reply <"$VAYU_TTY" || return 0
	if reply_is_no "$reply"; then
		return 1
	fi
	return 0
}

# Split out of confirm() because confirm() needs a terminal to reach its own
# parsing - so in every test it either returns early or is stubbed away, and the
# answer that aborts an install was never actually parsed by a test.
reply_is_no() {
	case "$1" in
		[nN]*) return 0 ;;
		*) return 1 ;;
	esac
}

# PIDs of everything running out of the install we are about to replace.
#
# The hazard here is subtle and cost this script an outage: the documented
# invocation is `bash -c "$(curl ...)"`, which puts this entire file - comments
# and all - into the installer's own argv. Any `pgrep -f` pattern that appears
# literally anywhere in this source matches the installer itself, and every
# subshell it forks (running_pids is always called as `$(running_pids)`, and a
# fork inherits the argv with a new PID). An earlier version of this function
# had a comment naming the AppImage's mount directory directly above a pattern
# matching it, so on Linux it always found "Vayu" running, always failed to
# quit it, and aborted every install on every machine.
#
# So: Linux asks the kernel what each process is actually executing instead of
# reading command lines, and both platforms drop the installer's own process
# group. Keep it that way - do not reintroduce a cmdline match on Linux, and
# keep the macOS bundle path out of this file's text.
running_pids() {
	case "$(platform)" in
		Darwin) macos_running_pids ;;
		*)      linux_running_pids ;;
	esac
}

# The app, its Electron helpers and the vayu-engine sidecar all live inside the
# bundle, so one path prefix covers them - and matching the path rather than the
# process name leaves a Vayu installed elsewhere alone.
macos_running_pids() {
	pgrep -f "${APP_PATH}/" 2>/dev/null | exclude_own_processes
}

# /proc/<pid>/exe, not the command line. The AppImage runtime executes the
# .AppImage file itself; everything it starts executes out of the directory the
# runtime mounts under /tmp. Once the file has been replaced the link reads
# "<path> (deleted)", which still means the old install is running.
linux_running_pids() {
	local proc exe
	for proc in /proc/[0-9]*; do
		exe="$(readlink "$proc/exe" 2>/dev/null)" || continue
		case "$exe" in
			"$LINUX_APP_BIN"|"$LINUX_APP_BIN "*) ;;
			/tmp/.mount_"$APP_NAME"*) ;;
			*) continue ;;
		esac
		printf '%s\n' "${proc#/proc/}"
	done | exclude_own_processes
}

# Drop the installer's own processes. $$ and $PPID are not enough on their own:
# every caller runs this inside a command substitution, and that subshell has a
# PID of its own. The process group covers the whole tree in one comparison.
exclude_own_processes() {
	local own pid pgid
	own="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
	while IFS= read -r pid; do
		[ -n "$pid" ] || continue
		pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
		if [ -n "$own" ] && [ "$pgid" = "$own" ]; then
			continue
		fi
		printf '%s\n' "$pid"
	done
	return 0
}

# Wait for those processes to go away. Dry-run never quits anything, so it must
# not sit here for the timeout.
wait_for_exit() {
	local limit="$1" waited=0
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	while [ -n "$(running_pids)" ]; do
		if [ "$waited" -ge "$limit" ]; then
			return 1
		fi
		sleep 1
		waited=$((waited + 1))
	done
	return 0
}

# Ask the running app to quit, the gentlest way this platform offers.
#
# macOS: an Apple Event, because Electron handles it exactly like Cmd-Q - the
# before-quit hook flushes pending renderer saves and stops the engine and MCP
# server first. macOS may ask you to allow the terminal to control Vayu the
# first time (Automation consent); denying it just falls through to the signal.
#
# Linux: there is no equivalent, so SIGTERM is the polite form - and it is
# polite only because main.ts installs a handler for it (see
# electron/quit-signals.ts). Without that, Node's default would kill the process
# where it stands and lose exactly the saves this is trying to protect.
request_quit() {
	case "$(platform)" in
		Darwin)
			run_quiet osascript -e "tell application \"${APP_NAME}\" to quit" || true
			;;
		*)
			printf '%s\n' "$(running_pids)" | while IFS= read -r pid; do
				if [ -n "$pid" ]; then
					run_quiet kill -TERM "$pid" || true
				fi
			done
			;;
	esac
	return 0
}

# The harder stop, once the polite one has been ignored.
force_quit() {
	case "$(platform)" in
		Darwin)
			run_quiet pkill -f "${APP_PATH}/" || true
			;;
		*)
			printf '%s\n' "$(running_pids)" | while IFS= read -r pid; do
				if [ -n "$pid" ]; then
					run_quiet kill -KILL "$pid" || true
				fi
			done
			;;
	esac
	return 0
}

# Quit a running Vayu before its files are replaced.
#
# macOS deletes a running app happily: the process keeps the handles it already
# has while everything it loads lazily disappears underneath it. Overwriting a
# running AppImage is worse - the file is mounted, and writing through it can
# fault the live process outright. Since re-running this script *is* how both
# platforms update outside the AppImage's own updater, a running app is the
# normal case here, not the exception.
#
# Returns 0 when nothing is running or it quit, 1 when the user said no.
quit_running_app() {
	[ -n "$(running_pids)" ] || return 0

	printf 'Vayu is running, and cannot be replaced while it is.\n'
	if ! confirm 'Quit Vayu now?'; then
		printf 'Not quitting - aborting so the running app is not replaced underneath itself.\n' >&2
		printf 'Quit Vayu and re-run this command.\n' >&2
		return 1
	fi

	printf 'Quitting Vayu...\n'
	request_quit
	wait_for_exit 15 && return 0

	printf 'Vayu did not respond - stopping it.\n'
	force_quit
	wait_for_exit 5 && return 0

	printf 'Could not stop Vayu. Quit it manually and re-run this command.\n' >&2
	return 1
}

# Version of the installed app, or nothing if Vayu is not installed.
#
# macOS reads the bundle's own Info.plist with plutil rather than `defaults
# read`, which caches plists and can answer stale. Linux reads the stamp this
# script writes, because an AppImage's version is inside a squashfs image and
# the only ways to it are mounting it or running it.
installed_version() {
	case "$(platform)" in
		Darwin)
			[ -f "$APP_PATH/Contents/Info.plist" ] || return 1
			/usr/bin/plutil -extract CFBundleShortVersionString raw -o - \
				"$APP_PATH/Contents/Info.plist" 2>/dev/null
			;;
		*)
			[ -x "$LINUX_APP_BIN" ] || return 1
			[ -f "$LINUX_VERSION_FILE" ] || return 1
			tr -d '[:space:]' <"$LINUX_VERSION_FILE"
			;;
	esac
}

# Kept pure so it can be tested anywhere. Re-running the command is how people
# update, and it is also what someone does when they are not sure whether they
# already updated - answering "you are on it already" beats re-downloading
# 150MB to arrive at the same bundle. --force is the escape hatch for a repair.
should_skip_install() {
	local installed="$1" target="$2" force="$3"
	if [ "$force" = "1" ]; then
		return 1
	fi
	[ -n "$installed" ] && [ "$installed" = "$target" ]
}

require_supported_os() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	local tool
	# Both platforms read $HOME - macOS for the data directories it reports on
	# uninstall, Linux for everything - and `set -u` turns an unset one into a
	# bare "unbound variable" halfway through.
	[ -n "${HOME:-}" ] || { printf 'HOME is not set - the installer needs it.\n' >&2; exit 1; }
	case "$(platform)" in
		Darwin)
			# ditto, plutil, osascript and sudo are used as surely as the rest;
			# they were missing from this list, which is how a missing tool
			# turned into a failure partway through an install instead of a
			# refusal to start one.
			for tool in curl codesign xattr shasum ditto plutil osascript sudo; do
				command -v "$tool" >/dev/null 2>&1 || { printf 'Required tool missing: %s\n' "$tool" >&2; exit 1; }
			done
			;;
		Linux)
			# Only x86_64 AppImages are published, so an arm64 Linux box would
			# otherwise download a 404 page and chmod +x it.
			case "$(uname -m)" in
				x86_64|amd64) ;;
				*) printf 'Vayu publishes x86_64 Linux builds only (this machine is %s).\n' "$(uname -m)" >&2; exit 1 ;;
			esac
			# No pgrep: the running-app check reads /proc directly, on purpose.
			for tool in curl ps; do
				command -v "$tool" >/dev/null 2>&1 || { printf 'Required tool missing: %s\n' "$tool" >&2; exit 1; }
			done
			;;
		*)
			printf 'Vayu installer supports macOS and Linux. Windows: winget install athrvk.Vayu\n' >&2
			exit 1
			;;
	esac
}

# macOS copies into /Applications, so it needs a password. Asked up front rather
# than after the download, and refreshed in the background so a slow connection
# cannot let it expire mid-install. Linux writes only under $HOME - nothing to
# authorize, and asking would be a password prompt for nothing.
preauthorize() {
	[ "$(platform)" = "Darwin" ] || return 0
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	printf 'Vayu installs to %s and needs administrator access.\n' "$INSTALL_DIR"
	sudo -v || { printf 'Authorization failed - aborting.\n' >&2; return 1; }
	# Tied to this script's lifetime explicitly. Each `sudo -n true` *refreshes*
	# the timestamp, so a loop left running would sustain passwordless sudo for
	# this terminal indefinitely - the EXIT trap normally kills it, but an
	# untrapped death (a closed terminal) would orphan it.
	( while kill -0 "$$" 2>/dev/null; do sleep 60; sudo -n true 2>/dev/null || exit; done ) &
	KEEPALIVE_PID=$!
	return 0
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

# Fetch the release asset, and verify it when the release publishes a checksum
# beside it (macOS does; the Linux artifacts do not, so this simply skips).
download_asset() {
	local url="$1" dest="$2" expected actual
	printf 'Downloading %s\n' "$url"
	# The status has to be checked by hand rather than left to `set -e`. This
	# function is called as `download_asset ... || exit 1`, and bash disables
	# errexit for the *whole body* of a function invoked in an || context - so
	# without this an interrupted transfer (curl exit 18, the likely failure for
	# a 150MB download) fell through, reported success, and got installed. On
	# Linux that overwrote a working AppImage with a fragment and then stamped
	# the version beside it, so the next run said "already installed".
	# Default curl meter (drop -s) shows %, size, speed and ETA on stderr.
	if ! run curl -fL "$url" -o "$dest"; then
		printf 'Download failed - nothing was installed.\n' >&2
		return 1
	fi

	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	# Best effort by design: only the macOS zip publishes a .sha256, so a
	# missing sidecar is the normal Linux case and cannot be told apart from a
	# failed fetch. A sidecar that *is* fetched and disagrees is fatal.
	curl -fsSL "$url.sha256" -o "$dest.sha256" 2>/dev/null || return 0
	expected="$(awk '{print $1}' "$dest.sha256")"
	actual="$(sha256_of "$dest")"
	[ "$expected" = "$actual" ] || { printf 'Checksum mismatch - aborting.\n' >&2; return 1; }
	printf 'Checksum verified.\n'
	return 0
}

# --- macOS install --------------------------------------------------------

# Unpack, ad-hoc sign and de-quarantine in the temp dir, so a failure never
# leaves a broken bundle in /Applications. No sudo needed for any of it.
stage_macos() {
	local workdir="$1" staged="$1/${APP_NAME}.app"
	printf 'Extracting...\n'
	# ditto, not unzip: this is an .app bundle, and ditto is Apple's own
	# extractor for these archives - it preserves the symlinks and permissions
	# inside Contents/Frameworks that unzip has a long history of mangling. It
	# is already a dependency (the install step below uses it), and it is what
	# electron-updater uses to unpack the same zip.
	run ditto -x -k "$workdir/vayu.zip" "$workdir"

	printf 'Signing (ad-hoc) and removing quarantine...\n'
	run codesign --force --sign - "$staged/$SIDECAR_REL"
	run codesign --force --deep --sign - "$staged"
	run xattr -cr "$staged"
}

place_macos() {
	local workdir="$1" incoming="${APP_PATH}.new"
	printf 'Installing to %s...\n' "$INSTALL_DIR"
	# Copy in beside the installed bundle and swap, rather than deleting first.
	# rm-then-ditto leaves the user with no Vayu at all if the copy dies partway
	# - a full disk, a Ctrl-C between the two lines, a read error in the staged
	# bundle - having started from a working one. The swap is a rename on the
	# same volume, so the window where neither exists is as short as it gets.
	run sudo rm -rf "$incoming"
	run sudo ditto "$workdir/${APP_NAME}.app" "$incoming"
	run sudo rm -rf "$APP_PATH"
	run sudo mv "$incoming" "$APP_PATH"
}

# --- Linux install --------------------------------------------------------

stage_linux() {
	run chmod +x "$(staged_asset_path "$1")"
}

# The launcher entry. Written rather than lifted out of the AppImage so the Exec
# line points at the installed path instead of wherever it was unpacked, and so
# it stays correct when the AppImage is replaced by an update.
#
# Exec is quoted because the Desktop Entry spec word-splits the value: with a
# space anywhere in $HOME or $XDG_DATA_HOME an unquoted path makes the launcher
# try to run the first word, and the menu entry silently does nothing.
#
# StartupWMClass matches the window class Electron sets from productName -
# without it the running window is a second, nameless icon in the dock or task
# switcher instead of the one that launched it.
desktop_entry() {
	cat <<EOF
[Desktop Entry]
Type=Application
Name=Vayu
GenericName=API Client
Comment=API testing and load testing with a native engine
Exec="${LINUX_APP_BIN}" %U
Icon=vayu
Terminal=false
Categories=Development;WebDevelopment;
Keywords=api;rest;graphql;http;load testing;
StartupWMClass=Vayu
EOF
}

place_linux() {
	local workdir="$1"
	printf 'Installing to %s...\n' "$LINUX_APP_DIR"
	run mkdir -p "$LINUX_APP_DIR"
	# A rename within one directory, so the AppImage is either the old one or
	# the new one and never a half-written file that is executable and
	# launchable. See staged_asset_path for why it is staged where it is.
	run mv -f "$(staged_asset_path "$workdir")" "$LINUX_APP_BIN"
	printf '%s\n' "$INSTALL_VERSION" | write_file "$LINUX_VERSION_FILE"

	printf 'Registering the desktop entry...\n'
	desktop_entry | write_file "$LINUX_DESKTOP_FILE"

	# Best effort, both of them: a missing icon or an unrefreshed database is a
	# cosmetic problem, and neither is worth failing an install that otherwise
	# succeeded.
	run mkdir -p "$(dirname "$LINUX_ICON_FILE")"
	# Downloaded to a temp name and moved: curl creates the output file before
	# it sees the response status, so fetching straight to the destination
	# leaves a zero-byte vayu.png behind on a 404 - which the desktop
	# environment then caches as the app's icon.
	if run_quiet curl -fsSL "$LINUX_ICON_URL" -o "$LINUX_ICON_FILE.part"; then
		run mv -f "$LINUX_ICON_FILE.part" "$LINUX_ICON_FILE"
	else
		run rm -f "$LINUX_ICON_FILE.part"
		printf 'Could not fetch the launcher icon - Vayu will use a generic one.\n'
	fi
	if command -v update-desktop-database >/dev/null 2>&1; then
		run_quiet update-desktop-database "$(dirname "$LINUX_DESKTOP_FILE")" || true
	fi

	# A `vayu` on PATH for people who launch from a terminal. Skipped rather
	# than forced if ~/.local/bin is not on PATH, since a link nothing can find
	# is just a file to clean up later.
	if [ -n "${HOME:-}" ]; then
		case ":${PATH}:" in
			*":$HOME/.local/bin:"*)
				run mkdir -p "$HOME/.local/bin"
				run ln -sf "$LINUX_APP_BIN" "$LINUX_BIN_LINK"
				;;
			*)
				printf 'Note: %s is not on PATH, so no vayu command was linked.\n' "$HOME/.local/bin"
				;;
		esac
	fi

	# The single most common "the AppImage does not start" report for any
	# Electron app, and it is not something an installer can fix - but being
	# told beforehand beats a launcher icon that does nothing.
	# ldconfig lives in /sbin, which is not on a non-root PATH on Debian, so
	# `command -v` alone would skip the check for exactly the desktop users who
	# need it.
	local ldconfig_bin=""
	if command -v ldconfig >/dev/null 2>&1; then
		ldconfig_bin="ldconfig"
	elif [ -x /sbin/ldconfig ]; then
		ldconfig_bin="/sbin/ldconfig"
	fi
	if [ -n "$ldconfig_bin" ] && ! "$ldconfig_bin" -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
		printf 'Note: libfuse2 was not found. If Vayu does not start, install it\n'
		printf '      (Debian/Ubuntu: sudo apt install libfuse2) or run it with\n'
		printf '      APPIMAGE_EXTRACT_AND_RUN=1.\n'
	fi
}

# --- dispatch -------------------------------------------------------------

stage_download() {
	case "$(platform)" in
		Darwin) stage_macos "$1" ;;
		*)      stage_linux "$1" ;;
	esac
}

place_app() {
	case "$(platform)" in
		Darwin) place_macos "$1" ;;
		*)      place_linux "$1" ;;
	esac
}

# Where the downloaded asset is staged. Fixed names rather than the asset's own,
# so the staging functions do not need the version.
#
# Linux stages *beside the destination*, not in the temp dir, for two reasons.
# /tmp is tmpfs on most systemd distros, so a 160MB download would go into RAM
# and can ENOSPC on a small machine. More importantly `mv` across filesystems is
# not a rename - coreutils copies through the destination path and unlinks the
# source afterwards - so an interrupt would leave exactly the half-written
# executable that moving the file is supposed to make impossible. Same
# filesystem, real rename.
staged_asset_path() {
	case "$(platform)" in
		Darwin) printf '%s/vayu.zip' "$1" ;;
		*)      printf '%s/.%s.AppImage.part' "$LINUX_APP_DIR" "$APP_NAME" ;;
	esac
}

launch_app() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		printf '[dry-run] launch %s\n' "$(installed_app_path)"
		return 0
	fi
	case "$(platform)" in
		Darwin) open "$APP_PATH" ;;
		# Detached, so the app outlives the terminal the installer ran in.
		*)      nohup "$LINUX_APP_BIN" >/dev/null 2>&1 & ;;
	esac
	return 0
}

installed_app_path() {
	case "$(platform)" in
		Darwin) printf '%s' "$APP_PATH" ;;
		*)      printf '%s' "$LINUX_APP_BIN" ;;
	esac
}

do_install() {
	require_supported_os
	resolve_install_target
	(
		local version url workdir staged installed quit_by_installer=0
		# `version="$(resolve_version)"` on its own would abort the subshell at
		# the assignment under `set -e` whenever the lookup failed - taking the
		# message below with it, so a rate-limited or offline run exited 1 in
		# silence. Both failures now reach the same explanation.
		if ! version="$(resolve_version)" || [ -z "$version" ]; then
			printf 'Could not determine which version to install.\n' >&2
			printf 'Check your connection, or pin one with VAYU_VERSION=x.y.z\n' >&2
			exit 1
		fi
		url="$(download_url "$version")"
		# Read by place_linux for the version stamp; exported through a global
		# because this subshell is the only thing that ever sets it.
		INSTALL_VERSION="$version"

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
		# before the files are replaced, in case it was relaunched meanwhile.
		if [ -n "$(running_pids)" ]; then
			quit_running_app || exit 1
			quit_by_installer=1
		fi

		workdir="$(mktemp -d)"
		staged="$(staged_asset_path "$workdir")"
		# Installed *before* preauthorize, and on the signals too: a Ctrl-C, a
		# closed terminal, or a declined password would otherwise leave the temp
		# dir, a part-downloaded file beside the app, and a sudo keep-alive
		# holding a passwordless timestamp open for this terminal.
		trap 'rm -rf "$workdir"; rm -f "$staged"; if [ -n "$KEEPALIVE_PID" ]; then kill "$KEEPALIVE_PID" 2>/dev/null || true; fi' EXIT
		trap 'exit 130' INT TERM HUP
		preauthorize || exit 1

		run mkdir -p "$(dirname "$staged")"
		download_asset "$url" "$staged" || exit 1
		stage_download "$workdir"

		# The download and staging above take long enough for someone to open
		# Vayu again after quitting it. Replacing the files now would be the
		# exact thing the earlier prompt avoided, so ask once more.
		if [ -n "$(running_pids)" ]; then
			quit_running_app || exit 1
			quit_by_installer=1
		fi

		place_app "$workdir"

		# Said on both paths: the update case - app running, so it gets
		# reopened - is the common one, and it was the one that never confirmed
		# which version had actually landed.
		printf 'Done. Vayu %s is installed at %s\n' "$version" "$(installed_app_path)"
		if [ "$quit_by_installer" = "1" ]; then
			# It was running when the user started this, so put it back.
			printf 'Reopening Vayu...\n'
			launch_app
		fi
	)
}

do_uninstall() {
	require_supported_os
	# Point at the copy that actually exists before looking for its processes,
	# and quit it for the same reason the install path does: deleting files out
	# from under a live app leaves it half-working until someone notices. On
	# Linux it is deleting the AppImage backing a live mount.
	resolve_install_target
	quit_running_app || exit 1
	case "$(platform)" in
		Darwin) uninstall_macos ;;
		*)      uninstall_linux ;;
	esac
}

uninstall_macos() {
	local support prefs logs caches savedstate paths
	# Every copy, not just the default one: leaving the other behind is how
	# "I uninstalled it" turns into an app that still launches. Falls back to
	# the default path so a nothing-installed run still says what it looked for.
	paths="$(existing_app_paths)"
	[ -n "$paths" ] || paths="$APP_PATH"
	support="$HOME/Library/Application Support/vayu-client"
	prefs="$HOME/Library/Preferences/com.vayu.client.plist"
	logs="$HOME/Library/Logs/vayu-client"
	caches="$HOME/Library/Caches/com.vayu.client"
	savedstate="$HOME/Library/Saved Application State/com.vayu.client.savedState"

	printf 'Removing Vayu (you may be prompted for your password)...\n'
	printf '%s\n' "$paths" | while IFS= read -r path; do
		printf '  %s\n' "$path"
		run sudo rm -rf "$path"
	done

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

uninstall_linux() {
	local config cache
	# Electron derives these from the package name, not productName, which is
	# why they are vayu-client and not vayu.
	config="${XDG_CONFIG_HOME:-$HOME/.config}/vayu-client"
	cache="${XDG_CACHE_HOME:-$HOME/.cache}/vayu-client"

	printf 'Removing Vayu...\n'
	printf '  %s\n' "$LINUX_APP_DIR"
	run rm -rf "$LINUX_APP_DIR"
	run rm -f "$LINUX_DESKTOP_FILE"
	run rm -f "$LINUX_ICON_FILE"
	# Only if it points at an install this script made - someone may well have
	# their own `vayu` on PATH, and deleting that would be a surprise. Matched on
	# the layout rather than on $LINUX_APP_BIN as computed right now, because
	# XDG_DATA_HOME may have been set when the link was created and not when it
	# is being removed, which used to leave it behind.
	if [ -L "$LINUX_BIN_LINK" ]; then
		case "$(readlink "$LINUX_BIN_LINK")" in
			*/vayu/"${APP_NAME}.AppImage") run rm -f "$LINUX_BIN_LINK" ;;
		esac
	fi
	if command -v update-desktop-database >/dev/null 2>&1; then
		run_quiet update-desktop-database "$(dirname "$LINUX_DESKTOP_FILE")" || true
	fi

	if [ "${PURGE:-0}" = "1" ]; then
		printf 'Purging user data...\n'
		run rm -rf "$config"
		run rm -rf "$cache"
		printf 'Vayu and its data have been removed.\n'
	else
		printf 'Vayu removed. User data was kept at:\n'
		printf '  %s\n' "$config"
		printf '  %s\n' "$cache"
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
Vayu installer - macOS and Linux (x86_64)
  install:        bash -c "\$(curl -fsSL $url)"
  update:         same command - it replaces the app in place and keeps your data
  pin version:    VAYU_VERSION=x.y.z bash -c "\$(curl -fsSL $url)"
  reinstall:      bash -c "\$(curl -fsSL $url)" -- --force
  uninstall:      bash -c "\$(curl -fsSL $url)" -- --uninstall [--purge]

macOS installs the app bundle to /Applications (or over an existing copy
elsewhere) and ad-hoc signs it. Linux installs the AppImage under
~/.local/share/vayu with a launcher entry, and needs no root at all.

Updating quits a running Vayu first (it asks). Set VAYU_ASSUME_YES=1 to skip
the prompt. Re-running when the latest version is already installed does
nothing unless --force is given.
EOF
}

if [ "${VAYU_TEST:-0}" != "1" ]; then
	main "$@"
fi
