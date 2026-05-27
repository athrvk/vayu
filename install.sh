#!/usr/bin/env bash
set -euo pipefail

REPO="athrvk/vayu"
APP_NAME="Vayu"
INSTALL_DIR="/Applications"
APP_PATH="${INSTALL_DIR}/${APP_NAME}.app"
SIDECAR_REL="Contents/Resources/bin/vayu-engine"

MODE="install"
PURGE=0

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
	version="$1"
	printf 'https://github.com/%s/releases/download/v%s/%s-%s-universal.zip' \
		"$REPO" "$version" "$APP_NAME" "$version"
}

main() {
	parse_args "$@"
	case "$MODE" in
		help) usage ;;
		*) printf 'mode=%s purge=%s (not yet implemented)\n' "$MODE" "$PURGE" ;;
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
