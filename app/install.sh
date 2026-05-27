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
