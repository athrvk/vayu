#!/usr/bin/env bash
set -euo pipefail

REPO="athrvk/vayu"
APP_NAME="Vayu"
INSTALL_DIR="/Applications"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
SIDECAR_REL="Contents/Resources/bin/vayu-engine"

MODE="install"
PURGE=0

# Run a command, or just print it when VAYU_DRYRUN=1.
run() {
	if [ "${VAYU_DRYRUN:-0}" = "1" ]; then
		printf '[dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

parse_args() {
	MODE="install"
	PURGE=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--uninstall) MODE="uninstall" ;;
			--purge) PURGE=1 ;;
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
		version="$(resolve_version)"
		[ -n "$version" ] || { printf 'Could not determine version to install.\n' >&2; exit 1; }
		url="$(download_url "$version")"
		printf 'Installing Vayu %s...\n' "$version"

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

		printf 'Installing to %s...\n' "$INSTALL_DIR"
		run sudo rm -rf "$APP_PATH"
		run sudo ditto "$staged" "$APP_PATH"

		printf 'Done. Launch Vayu from Launchpad/Spotlight, or run: open "%s"\n' "$APP_PATH"
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
	cat <<EOF
Vayu installer
  install:        bash -c "\$(curl -fsSL <url>)"
  pin version:    VAYU_VERSION=x.y.z bash -c "\$(curl -fsSL <url>)"
  uninstall:      bash -c "\$(curl -fsSL <url>)" -- --uninstall [--purge]
EOF
}

if [ "${VAYU_TEST:-0}" != "1" ]; then
	main "$@"
fi
