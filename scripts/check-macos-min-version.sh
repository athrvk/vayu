#!/usr/bin/env bash
# Assert that every Mach-O binary given on the command line was built for the
# deployment target the repo promises, on every architecture inside it.
#
# The failure this exists to catch is silent at build time and fatal at launch:
# a binary built on a newer macOS than it targets links libc++ symbols that do
# not exist in the older dylib, and dyld aborts the process on the user's Mac
# with "Symbol not found". Nothing in the build, the tests or the installer
# notices - only a user on an older macOS does. See engine/CMakeLists.txt.
set -euo pipefail

expected="${VAYU_MACOS_DEPLOYMENT_TARGET:-13.3}"

if [ $# -eq 0 ]; then
	echo "usage: $0 <mach-o binary> [...]" >&2
	exit 2
fi

status=0
for binary in "$@"; do
	if [ ! -f "$binary" ]; then
		echo "FAIL $binary: not found" >&2
		status=1
		continue
	fi

	# `vtool -show-build` prints one build-version block per architecture in a
	# universal binary, so a slice built against the wrong SDK cannot hide
	# behind a correct one.
	found=$(vtool -show-build "$binary" | awk '/^ *minos /{print $2}')
	if [ -z "$found" ]; then
		echo "FAIL $binary: no LC_BUILD_VERSION/LC_VERSION_MIN load command" >&2
		status=1
		continue
	fi

	for minos in $found; do
		if [ "$minos" != "$expected" ]; then
			echo "FAIL $binary: minos $minos, expected $expected" >&2
			status=1
		fi
	done
	echo "ok   $binary: minos $(echo "$found" | tr '\n' ' ')"
done

exit $status
