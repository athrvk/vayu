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
# Where a fresh install goes. Both are re-pointed by adopt_install_target when
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

# Everything this script says goes through these three, so "did it explain
# itself" is answerable by reading them rather than by auditing 40 printfs, and
# so a failure always exits the same way.
#
# die() is the important one. Every fallible step used to be written as
# `step || exit 1` at the call site, which reads like error handling and is not:
# bash disables errexit for the entire body of a function invoked in an ||
# context, so an unchecked command *inside* that function fell through silently.
# That is precisely how a failed download came to be reported as success. A step
# that cannot continue now says so itself, here, rather than trusting each
# caller to remember a suffix.
log()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die()  { die_with "$EXIT_FAILED" "$@"; }

# Exit codes, because things wrap this script - the app's own update
# notification hands it to a user, and a fleet tool may run it unattended. "It
# exited 1" cannot tell those callers apart: a refused password, an unsupported
# machine and a failed download all need different reactions, and "already
# installed" is not a failure at all.
EXIT_OK=0
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_DECLINED=3
EXIT_UNSUPPORTED=4
EXIT_INTERRUPTED=130

die_with() {
	local code="$1"
	shift
	printf '%s\n' "$*" >&2
	exit "$code"
}

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

	# The documented command is `bash -c "$(curl …)"`, and bash assigns the
	# first word *after* the script text to $0 rather than $1. So a flag
	# appended without the `--` separator - `bash -c "$(curl …)" --force` -
	# never reaches "$@" at all, and used to be dropped in silence: the run
	# reported "already installed - nothing to do" while ignoring the --force
	# it had just been handed. Putting it back is the whole fix; the `--` form
	# stays correct and is still what the docs show.
	#
	# `--` itself must not be recovered - with the separator present bash puts
	# *that* in $0 and the real flags in "$@", so prepending it would turn a
	# correct invocation into "Unknown option: --".
	case "$0" in
		--) ;;
		-*) set -- "$0" "$@" ;;
	esac

	while [ "$#" -gt 0 ]; do
		case "$1" in
			--uninstall) MODE="uninstall" ;;
			--purge) PURGE=1 ;;
			--force) FORCE=1 ;;
			--help|-h) MODE="help" ;;
			*)
				printf 'Unknown option: %s\n' "$1" >&2
				warn 'Run with --help to see what this script accepts.'
				return "$EXIT_USAGE"
				;;
		esac
		shift
	done

	# --purge only means anything while removing things. Accepting it on an
	# install and then ignoring it is the same silent-drop defect as above.
	if [ "$PURGE" = "1" ] && [ "$MODE" != "uninstall" ]; then
		warn '--purge removes your Vayu data and only applies to --uninstall.'
		return "$EXIT_USAGE"
	fi
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

# One installer at a time.
#
# Two runs at once - a double-paste, or an update starting while another is
# mid-flight - both download and both swap, and the loser can overwrite the
# winner's install with an older version. `mkdir` is the lock: it is atomic on
# every filesystem this runs on, needs no flock (which macOS's shell lacks),
# and leaves a directory whose mtime says how old the claim is.
lock_dir() {
	printf '%s/.vayu-install.lock' "${TMPDIR:-/tmp}"
}

acquire_lock() {
	local lock
	lock="$(lock_dir)"
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	if mkdir "$lock" 2>/dev/null; then
		return 0
	fi
	# A lock older than an hour is a crashed run, not a live one: the longest
	# thing here is a 160MB download, and nothing waits on user input while
	# holding it.
	if [ -n "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
		warn 'Ignoring a stale install lock left by an earlier run.'
		rm -rf "$lock"
		mkdir "$lock" 2>/dev/null && return 0
	fi
	die 'Another Vayu install is already running. Wait for it to finish, or remove '"$lock"
}

release_lock() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	rm -rf "$(lock_dir)"
}

# Anything a killed run left half-written. Nothing else removes these: they sit
# beside the install, they are invisible in a file manager, and the next run
# would otherwise copy over one of them.
sweep_staging() {
	case "$(platform)" in
		Darwin)
			privileged rm -rf "${APP_PATH}.new"
			# .old is only ever a bundle mid-swap, so its presence means a run
			# died between two renames - and the install it belongs to is
			# whichever of the two exists.
			if [ -d "${APP_PATH}.old" ] && [ ! -d "$APP_PATH" ]; then
				warn 'A previous install was interrupted - restoring the version it replaced.'
				privileged mv "${APP_PATH}.old" "$APP_PATH"
			else
				privileged rm -rf "${APP_PATH}.old"
			fi
			;;
		*)
			run rm -f "$LINUX_APP_DIR/.${APP_NAME}.AppImage.part"
			run rm -f "$LINUX_ICON_FILE.part"
			;;
	esac
	return 0
}

# The bundle an install should replace: the copy that already exists, so an
# update lands on the app the user actually opens, or the default for a fresh
# install. Prints rather than assigning - a function that reached in and changed
# APP_PATH could not be called from a subshell, and that rule had to be written
# down in three places because the code could not express it.
#
# `sudo` is used either way on macOS, including for a copy under $HOME that
# would not need it: one code path is worth more here than skipping a password
# prompt the script already asks for.
resolved_install_path() {
	local first=""
	if [ "$(platform)" = "Darwin" ]; then
		first="$(existing_app_paths | head -1)"
	fi
	if [ -n "$first" ]; then
		printf '%s' "$first"
	else
		printf '%s' "$APP_PATH"
	fi
}

# Two copies is the state this exists to stop repeating: updating one of them
# silently is what leaves someone launching a stale build while the installer
# reports success. Separate from the resolution above so that neither has to
# both compute and narrate.
report_extra_installs() {
	local chosen="$1" others
	others="$(existing_app_paths | grep -vxF "$chosen" || true)"
	[ -n "$others" ] || return 0
	log 'Vayu is installed in more than one place:'
	printf '%s\n' "$others" | while IFS= read -r path; do
		log "  $path"
	done
	log "Updating $chosen - remove the other copy, or it will keep launching an old build."
}

# Point the globals at the resolved bundle. The assignment is here, at one call
# site each in do_install and do_uninstall, rather than hidden inside a function.
adopt_install_target() {
	APP_PATH="$(resolved_install_path)"
	INSTALL_DIR="$(dirname "$APP_PATH")"
	report_extra_installs "$APP_PATH"
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

	log 'Vayu is running, and cannot be replaced while it is.'
	if ! confirm 'Quit Vayu now?'; then
		warn 'Not quitting - aborting so the running app is not replaced underneath itself.'
		die_with "$EXIT_DECLINED" 'Quit Vayu and re-run this command.'
	fi

	log 'Quitting Vayu...'
	request_quit
	wait_for_exit 15 && return 0

	log 'Vayu did not respond - stopping it.'
	force_quit
	wait_for_exit 5 && return 0

	die 'Could not stop Vayu. Quit it manually and re-run this command.'
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
	[ -n "${HOME:-}" ] || die 'HOME is not set - the installer needs it.'
	case "$(platform)" in
		Darwin)
			# ditto, plutil, osascript and sudo are used as surely as the rest;
			# they were missing from this list, which is how a missing tool
			# turned into a failure partway through an install instead of a
			# refusal to start one.
			for tool in curl codesign xattr shasum ditto plutil osascript sudo; do
				command -v "$tool" >/dev/null 2>&1 || die "Required tool missing: $tool"
			done
			;;
		Linux)
			# Only x86_64 AppImages are published, so an arm64 Linux box would
			# otherwise download a 404 page and chmod +x it.
			case "$(uname -m)" in
				x86_64|amd64) ;;
				*) die_with "$EXIT_UNSUPPORTED" "Vayu publishes x86_64 Linux builds only (this machine is $(uname -m))." ;;
			esac
			# No pgrep: the running-app check reads /proc directly, on purpose.
			for tool in curl ps; do
				command -v "$tool" >/dev/null 2>&1 || die "Required tool missing: $tool"
			done
			;;
		*)
			die_with "$EXIT_UNSUPPORTED" 'Vayu installer supports macOS and Linux. Windows: winget install athrvk.Vayu'
			;;
	esac
}

# macOS copies into /Applications, so it needs a password. Asked up front rather
# than after the download, and refreshed in the background so a slow connection
# cannot let it expire mid-install. Linux writes only under $HOME - nothing to
# authorize, and asking would be a password prompt for nothing.
# Every privileged command in this script goes through here, and nothing may run
# before authorize() has been called.
#
# The rule used to be a convention, and conventions here have a record: an
# earlier sweep_staging deleted a bundle in /Applications *without* sudo two
# lines above one that used it, and ran both before the password was ever asked
# for - so a standard user got a silent failure and everyone else got an
# unexplained prompt. Neither is reviewable by eye. Now the ordering is a
# precondition: privileged() refuses to run un-authorized, so the mistake is a
# loud abort during development rather than a surprise on someone's machine.
#
# VAYU_SUDO exists so scripts/test/install_e2e.sh can substitute a stub that
# records what was run and can refuse - the interactive and privileged paths are
# invisible to CI otherwise, because the runners have passwordless sudo and no
# terminal, which is exactly where the last three bugs lived.
SUDO="${VAYU_SUDO:-sudo}"
AUTHORIZED=0

privileged() {
	if [ "$(platform)" != "Darwin" ]; then
		# Linux writes only under $HOME. A privileged call there is a bug, not a
		# case to handle.
		die "Internal error: privileged $1 attempted on $(platform), which needs no root."
	fi
	if [ "$AUTHORIZED" != "1" ]; then
		die "Internal error: privileged $1 attempted before authorize()."
	fi
	run "$SUDO" "$@"
}

# Ask for the password once, up front, with the reason attached. Idempotent, so
# a second caller costs nothing.
authorize() {
	[ "$(platform)" = "Darwin" ] || return 0
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		AUTHORIZED=1
		return 0
	fi
	if [ "$AUTHORIZED" = "1" ]; then
		return 0
	fi
	log "Vayu installs to $INSTALL_DIR and needs administrator access."
	"$SUDO" -v || die_with "$EXIT_DECLINED" 'Authorization failed - aborting.'
	AUTHORIZED=1
	return 0
}

# Sudo's timestamp can expire during a slow download, so it is renewed once
# immediately before the only steps that need it.
#
# This replaced a background loop that refreshed every 60 seconds, which was the
# wrong shape three ways over: each refresh *extends* passwordless sudo rather
# than merely preserving it, so a loop that outlived the script - a closed
# terminal, an untrapped signal - held that window open for the terminal; the
# loop had to be killed from a trap, which meant carrying its PID around and
# returning it through a command substitution that the loop itself then blocked;
# and killing the loop still left its current `sleep` orphaned, which is what
# the CI runner kept reporting. One `sudo -v` at the point of use needs none of
# that. If the timestamp did expire, this is where the password is asked for
# again, which is the honest moment to ask.
refresh_sudo() {
	[ "$(platform)" = "Darwin" ] || return 0
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	"$SUDO" -v || die 'Authorization expired and could not be renewed - nothing was installed.'
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
	# --retry, because this is 160MB over whatever connection the user has and a
	# transient failure is the common one. curl retries on transport errors and
	# 5xx, not on a 404, so a genuinely missing asset still fails immediately.
	if ! run curl -fL --retry 3 --retry-delay 2 --retry-connrefused "$url" -o "$dest"; then
		die 'Download failed - nothing was installed.'
	fi

	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		return 0
	fi
	# Every release artifact publishes a .sha256 (see the checksum steps in
	# .github/workflows/release.yml). A missing one means an old release, or a
	# fetch that failed - both worth saying, neither worth refusing over, since
	# the alternative is telling someone their working install cannot proceed
	# because a 65-byte file did not arrive.
	if ! curl -fsSL "$url.sha256" -o "$dest.sha256" 2>/dev/null; then
		warn 'No checksum published for this download - skipping verification.'
		return 0
	fi
	expected="$(awk '{print $1}' "$dest.sha256")"
	actual="$(sha256_of "$dest")"
	[ "$expected" = "$actual" ] || die 'Checksum mismatch - aborting.'
	log 'Checksum verified.'
	return 0
}

# --- macOS install --------------------------------------------------------

# Unpack, ad-hoc sign and de-quarantine in the temp dir, so a failure never
# leaves a broken bundle in /Applications. No sudo needed for any of it.
stage_macos() {
	local workdir="$1" staged="$1/${APP_NAME}.app"
	log 'Extracting...'
	# ditto, not unzip: this is an .app bundle, and ditto is Apple's own
	# extractor for these archives - it preserves the symlinks and permissions
	# inside Contents/Frameworks that unzip has a long history of mangling. It
	# is already a dependency (the install step below uses it), and it is what
	# electron-updater uses to unpack the same zip.
	run ditto -x -k "$workdir/vayu.zip" "$workdir"

	log 'Signing (ad-hoc) and removing quarantine...'
	run codesign --force --sign - "$staged/$SIDECAR_REL"
	run codesign --force --deep --sign - "$staged"
	run xattr -cr "$staged"
}

place_macos() {
	local workdir="$1" incoming="${APP_PATH}.new" previous="${APP_PATH}.old"
	# $2 is the version; macOS reads it back out of the bundle, so it is unused.
	log "Installing to $INSTALL_DIR..."
	# Copy in beside the installed bundle, move the old one aside, swap, and only
	# then delete it. Deleting first leaves the user with no Vayu at all if
	# anything goes wrong afterwards - a full disk, a Ctrl-C, a read error in the
	# staged bundle - having started from a working one. Every step here is a
	# rename on one volume, so there is no moment at which neither bundle exists.
	privileged rm -rf "$incoming" "$previous"
	privileged ditto "$workdir/${APP_NAME}.app" "$incoming"
	if [ -d "$APP_PATH" ]; then
		privileged mv "$APP_PATH" "$previous"
	fi
	if ! privileged mv "$incoming" "$APP_PATH"; then
		if [ -d "$previous" ]; then
			warn 'Install failed - putting the previous version back.'
			privileged mv "$previous" "$APP_PATH"
		fi
		die 'Could not move the new version into place.'
	fi
	privileged rm -rf "$previous"
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
	local workdir="$1" version="$2"
	printf 'Installing to %s...\n' "$LINUX_APP_DIR"
	run mkdir -p "$LINUX_APP_DIR"
	# A rename within one directory, so the AppImage is either the old one or
	# the new one and never a half-written file that is executable and
	# launchable. See staged_asset_path for why it is staged where it is.
	run mv -f "$(staged_asset_path "$workdir")" "$LINUX_APP_BIN"
	printf '%s\n' "$version" | write_file "$LINUX_VERSION_FILE"

	log 'Registering the desktop entry...'
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
		log 'Could not fetch the launcher icon - Vayu will use a generic one.'
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
		log 'Note: libfuse2 was not found. If Vayu does not start, install it'
		log '      (Debian/Ubuntu: sudo apt install libfuse2) or run it with'
		log '      APPIMAGE_EXTRACT_AND_RUN=1.'
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
		Darwin) place_macos "$1" "$2" ;;
		*)      place_linux "$1" "$2" ;;
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
	acquire_lock
	trap release_lock EXIT
	adopt_install_target
	# Authorization first, because the sweep below is privileged on macOS - it
	# deletes and restores bundles in /Applications. This is the ordering that
	# privileged() now enforces rather than asks for.
	authorize
	# A leftover .new or .part is what a killed run leaves, and on macOS a lone
	# .old means the previous version still needs putting back.
	sweep_staging
	(
		local version url workdir staged installed quit_by_installer=0
		# `version="$(resolve_version)"` on its own would abort the subshell at
		# the assignment under `set -e` whenever the lookup failed - taking the
		# message below with it, so a rate-limited or offline run exited 1 in
		# silence. Both failures now reach the same explanation.
		if ! version="$(resolve_version)" || [ -z "$version" ]; then
			warn 'Could not determine which version to install.'
			die 'Check your connection, or pin one with VAYU_VERSION=x.y.z'
		fi
		url="$(download_url "$version")"

		installed="$(installed_version || true)"
		if should_skip_install "$installed" "$version" "$FORCE"; then
			printf 'Vayu %s is already installed - nothing to do.\n' "$version"
			log 'Re-run with --force to reinstall it anyway.'
			exit "$EXIT_OK"
		fi

		if [ -n "$installed" ]; then
			printf 'Updating Vayu %s to %s...\n' "$installed" "$version"
		else
			printf 'Installing Vayu %s...\n' "$version"
		fi

		# Before the download, so declining costs nothing. Checked again just
		# before the files are replaced, in case it was relaunched meanwhile.
		if [ -n "$(running_pids)" ]; then
			quit_running_app
			quit_by_installer=1
		fi

		workdir="$(mktemp -d)"
		staged="$(staged_asset_path "$workdir")"
		# Installed *before* preauthorize, and on the signals too: a Ctrl-C, a
		# closed terminal, or a declined password would otherwise leave the temp
		# dir, a part-downloaded file beside the app, and a sudo keep-alive
		# holding a passwordless timestamp open for this terminal.
		trap 'rm -rf "$workdir"; rm -f "$staged"' EXIT
		trap 'exit "$EXIT_INTERRUPTED"' INT TERM HUP

		run mkdir -p "$(dirname "$staged")"
		download_asset "$url" "$staged"
		stage_download "$workdir"

		# The download and staging above take long enough for someone to open
		# Vayu again after quitting it. Replacing the files now would be the
		# exact thing the earlier prompt avoided, so ask once more.
		if [ -n "$(running_pids)" ]; then
			quit_running_app
			quit_by_installer=1
		fi

		# The download sits between the password prompt and here.
		refresh_sudo
		place_app "$workdir" "$version"

		# Said on both paths: the update case - app running, so it gets
		# reopened - is the common one, and it was the one that never confirmed
		# which version had actually landed.
		printf 'Done. Vayu %s is installed at %s\n' "$version" "$(installed_app_path)"
		if [ "$quit_by_installer" = "1" ]; then
			# It was running when the user started this, so put it back.
			log 'Reopening Vayu...'
			launch_app
		fi
	)
}

do_uninstall() {
	require_supported_os
	acquire_lock
	trap release_lock EXIT
	# Point at the copy that actually exists before looking for its processes,
	# and quit it for the same reason the install path does: deleting files out
	# from under a live app leaves it half-working until someone notices. On
	# Linux it is deleting the AppImage backing a live mount.
	adopt_install_target
	# Uninstalling deletes bundles in /Applications, so it needs the same
	# authorization the install path takes - it used to reach sudo without ever
	# asking, which is how an uninstall produced an unexplained prompt.
	authorize
	sweep_staging
	quit_running_app
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

	log 'Removing Vayu (you may be prompted for your password)...'
	printf '%s\n' "$paths" | while IFS= read -r path; do
		printf '  %s\n' "$path"
		privileged rm -rf "$path"
	done

	if [ "${PURGE:-0}" = "1" ]; then
		log 'Purging user data...'
		run rm -rf "$support"
		run rm -f "$prefs"
		run rm -rf "$logs"
		run rm -rf "$caches"
		run rm -rf "$savedstate"
		log 'Vayu and its data have been removed.'
	else
		log 'Vayu removed. User data was kept at:'
		printf '  %s\n' "$support"
		printf '  %s\n' "$prefs"
		printf '  %s\n' "$logs"
		log 'Re-run with --uninstall --purge to remove these too.'
	fi
}

uninstall_linux() {
	local config cache
	# Electron derives these from the package name, not productName, which is
	# why they are vayu-client and not vayu.
	config="${XDG_CONFIG_HOME:-$HOME/.config}/vayu-client"
	cache="${XDG_CACHE_HOME:-$HOME/.cache}/vayu-client"

	log 'Removing Vayu...'
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
		log 'Purging user data...'
		run rm -rf "$config"
		run rm -rf "$cache"
		log 'Vayu and its data have been removed.'
	else
		log 'Vayu removed. User data was kept at:'
		printf '  %s\n' "$config"
		printf '  %s\n' "$cache"
		log 'Re-run with --uninstall --purge to remove these too.'
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
  this help:      bash -c "\$(curl -fsSL $url)" -- --help

The \`--\` above is the conventional way to separate bash's arguments from the
script's, and is what the docs show. Leaving it out works too - the flag lands
in \$0 rather than \$1 and the script picks it up from there.

macOS installs the app bundle to /Applications (or over an existing copy
elsewhere) and ad-hoc signs it. Linux installs the AppImage under
~/.local/share/vayu with a launcher entry, and needs no root at all.

Updating quits a running Vayu first (it asks). Set VAYU_ASSUME_YES=1 to skip
the prompt. Re-running when the latest version is already installed does
nothing unless --force is given.

Exit codes: 0 done (including "already installed"), 1 failed, 2 bad usage,
3 declined (you said no, or the password was refused), 4 unsupported machine,
130 interrupted.
EOF
}

if [ "${VAYU_TEST:-0}" != "1" ]; then
	main "$@"
fi
