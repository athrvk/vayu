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
LINUX_VERSION_FILE="$LINUX_APP_DIR/version"
LINUX_DESKTOP_FILE="$LINUX_DATA_HOME/applications/vayu.desktop"
LINUX_ICON_FILE="$LINUX_DATA_HOME/icons/hicolor/256x256/apps/vayu.png"
LINUX_BIN_LINK="${HOME:-}/.local/bin/vayu"
# Served by the docs site from shared/icon_png/ (see .github/hooks/brand_assets.py),
# so the launcher icon comes from the same source as the app's own. Downloading
# it beats `--appimage-extract`, which some runtimes answer by unpacking the
# whole 400MB image into the temp dir instead of the one file asked for.
LINUX_ICON_URL="https://athrvk.github.io/vayu/images/vayu-icon.png"

MODE="install"
PURGE=0
FORCE=0
KEEPALIVE_PID=""

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
	printf 'https://github.com/%s/releases/download/v%s/%s' \
		"$REPO" "$version" "$(asset_name "$version")"
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
	[ -n "${HOME:-}" ] && printf '%s\n' "$HOME/Applications"
	return 0
}

# Every Vayu.app found in those directories, in the same order.
existing_app_paths() {
	search_dirs | while IFS= read -r dir; do
		[ -d "$dir/${APP_NAME}.app" ] && printf '%s\n' "$dir/${APP_NAME}.app"
	done
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

# PIDs of everything running out of the install we are about to replace.
#
# macOS: the app, its Electron helpers and the vayu-engine sidecar all live
# inside the bundle, so one path prefix covers them. Matched on the path rather
# than the process name, so a Vayu installed somewhere else is left alone.
#
# Linux: the AppImage mounts itself under /tmp/.mount_Vayu* and the helpers run
# from there, so the installed path alone would only find the main process.
running_pids() {
	case "$(platform)" in
		Darwin)
			pgrep -f "${APP_PATH}/" 2>/dev/null | grep -vx -e "$$" -e "$PPID" || true
			;;
		*)
			{
				pgrep -f "$LINUX_APP_BIN" 2>/dev/null || true
				pgrep -f "/\.mount_${APP_NAME}" 2>/dev/null || true
			} | sort -u | grep -vx -e "$$" -e "$PPID" || true
			;;
	esac
}

# Wait for those processes to go away. Dry-run never quits anything, so it must
# not sit here for the timeout.
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
				[ -n "$pid" ] && run_quiet kill -TERM "$pid" || true
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
				[ -n "$pid" ] && run_quiet kill -KILL "$pid" || true
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
	[ "$force" = "1" ] && return 1
	[ -n "$installed" ] && [ "$installed" = "$target" ]
}

require_supported_os() {
	[ "${VAYU_DRYRUN:-0}" = "1" ] && return 0
	local tool
	case "$(platform)" in
		Darwin)
			for tool in curl unzip codesign xattr shasum; do
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
			[ -n "${HOME:-}" ] || { printf 'HOME is not set - the Linux installer needs it.\n' >&2; exit 1; }
			for tool in curl pgrep; do
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
	[ "${VAYU_DRYRUN:-0}" = "1" ] && return 0
	printf 'Vayu installs to %s and needs administrator access.\n' "$INSTALL_DIR"
	sudo -v || { printf 'Authorization failed - aborting.\n' >&2; return 1; }
	# The loop stops once sudo can no longer refresh non-interactively, i.e.
	# once this script has exited.
	( while true; do sleep 60; sudo -n true 2>/dev/null || exit; done ) &
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
	# Default curl meter (drop -s) shows %, size, speed and ETA on stderr.
	run curl -fL "$url" -o "$dest"

	[ "${VAYU_DRYRUN:-0}" = "1" ] && return 0
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
	run unzip -q -o "$workdir/vayu.zip" -d "$workdir"

	printf 'Signing (ad-hoc) and removing quarantine...\n'
	run codesign --force --sign - "$staged/$SIDECAR_REL"
	run codesign --force --deep --sign - "$staged"
	run xattr -cr "$staged"
}

place_macos() {
	local workdir="$1"
	printf 'Installing to %s...\n' "$INSTALL_DIR"
	run sudo rm -rf "$APP_PATH"
	run sudo ditto "$workdir/${APP_NAME}.app" "$APP_PATH"
}

# --- Linux install --------------------------------------------------------

stage_linux() {
	local workdir="$1"
	run chmod +x "$workdir/vayu.AppImage"
}

# The launcher entry. Written rather than lifted out of the AppImage so the Exec
# line points at the installed path instead of wherever it was unpacked, and so
# it stays correct when the AppImage is replaced by an update.
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
Exec=${LINUX_APP_BIN} %U
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
	# mv, not cp: replacing the file wholesale means a half-written AppImage can
	# never be left executable and launchable.
	run mv -f "$workdir/vayu.AppImage" "$LINUX_APP_BIN"
	printf '%s\n' "$INSTALL_VERSION" | write_file "$LINUX_VERSION_FILE"

	printf 'Registering the desktop entry...\n'
	desktop_entry | write_file "$LINUX_DESKTOP_FILE"

	# Best effort, both of them: a missing icon or an unrefreshed database is a
	# cosmetic problem, and neither is worth failing an install that otherwise
	# succeeded.
	run mkdir -p "$(dirname "$LINUX_ICON_FILE")"
	run_quiet curl -fsSL "$LINUX_ICON_URL" -o "$LINUX_ICON_FILE" \
		|| printf 'Could not fetch the launcher icon - Vayu will use a generic one.\n'
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
	if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
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

# Where the downloaded asset is staged inside the temp dir. Fixed names rather
# than the asset's own, so the staging functions do not need the version.
staged_asset_path() {
	case "$(platform)" in
		Darwin) printf '%s/vayu.zip' "$1" ;;
		*)      printf '%s/vayu.AppImage' "$1" ;;
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
		local version url workdir installed quit_by_installer=0
		version="$(resolve_version)"
		[ -n "$version" ] || { printf 'Could not determine version to install.\n' >&2; exit 1; }
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
		preauthorize || exit 1
		trap 'rm -rf "$workdir"; [ -n "$KEEPALIVE_PID" ] && kill "$KEEPALIVE_PID" 2>/dev/null' EXIT

		download_asset "$url" "$(staged_asset_path "$workdir")" || exit 1
		stage_download "$workdir"

		# The download and staging above take long enough for someone to open
		# Vayu again after quitting it. Replacing the files now would be the
		# exact thing the earlier prompt avoided, so ask once more.
		if [ -n "$(running_pids)" ]; then
			quit_running_app || exit 1
			quit_by_installer=1
		fi

		place_app "$workdir"

		if [ "$quit_by_installer" = "1" ]; then
			# It was running when the user started this, so put it back.
			printf 'Reopening Vayu...\n'
			launch_app
		else
			printf 'Done. Vayu %s is installed at %s\n' "$version" "$(installed_app_path)"
		fi
	)
}

do_uninstall() {
	require_supported_os
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
	# Only if it points at the install this script made - someone may well have
	# their own `vayu` on PATH, and deleting that would be a surprise.
	if [ -L "$LINUX_BIN_LINK" ] && [ "$(readlink "$LINUX_BIN_LINK")" = "$LINUX_APP_BIN" ]; then
		run rm -f "$LINUX_BIN_LINK"
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
