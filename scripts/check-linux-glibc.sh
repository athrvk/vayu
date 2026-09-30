#!/usr/bin/env bash
# Assert that every ELF binary given on the command line starts on the oldest
# Linux the release supports: it may ask the system for nothing newer than the
# glibc of the oldest supported Ubuntu LTS, and for no C++ runtime at all.
#
# The failure this exists to catch is silent at build time and fatal at launch,
# the Linux twin of scripts/check-macos-min-version.sh: a binary linked on a
# newer distribution picks up versioned glibc symbols (fmod@GLIBC_2.38, the
# C23 strtol family) that an older loader cannot resolve, and the process dies
# with "version `GLIBC_2.38' not found" before main. Nothing in the build, the
# tests or the packaging notices, because CI runs on the new distribution.
# 0.37.0 shipped exactly that. The floor is the glibc of the Ubuntu release
# release.yml builds on; raise the two together. See docs/engine/building.md.
set -euo pipefail

floor="${VAYU_LINUX_GLIBC_FLOOR:-2.35}"

if [ $# -eq 0 ]; then
	echo "usage: $0 <elf binary> [...]" >&2
	exit 2
fi

# Whether version $1 is newer than version $2, compared field by field.
newer_than() {
	[ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

status=0
for binary in "$@"; do
	if [ ! -f "$binary" ]; then
		echo "FAIL $binary: not found" >&2
		status=1
		continue
	fi

	# The shared libraries the loader will look for. An empty list means this
	# is not a dynamically linked ELF at all, and every check below would pass
	# having read nothing.
	needed=$( (readelf -d "$binary" 2>/dev/null || true) | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p')
	if [ -z "$needed" ]; then
		echo "FAIL $binary: no NEEDED entries - not a dynamically linked ELF?" >&2
		status=1
		continue
	fi

	# The C++ runtime has to be linked in (engine/CMakeLists.txt, vayu_runtime):
	# libstdc++ versions its symbols by compiler, so the system's copy on an
	# older distribution is too old for the GCC the release is built with.
	failed=0
	runtime=$(printf '%s\n' "$needed" | grep -E '^(libstdc\+\+|libgcc_s)\.so' || true)
	if [ -n "$runtime" ]; then
		echo "FAIL $binary: links the C++ runtime from the system: $(echo "$runtime" | tr '\n' ' ')" >&2
		failed=1
	fi

	symbols=$(objdump -T "$binary")
	# binutils prints a version tag with or without parentheses depending on
	# whether it is the symbol's default version, so match both spellings.
	versions=$(printf '%s\n' "$symbols" | grep -oE '(^|[[:space:](])GLIBC_[0-9]+(\.[0-9]+)+' \
		| sed 's/.*GLIBC_//' | sort -Vu)
	if [ -z "$versions" ]; then
		echo "FAIL $binary: found no versioned glibc symbols - the scan read nothing" >&2
		status=1
		continue
	fi

	newest=$(printf '%s\n' "$versions" | tail -1)
	if newer_than "$newest" "$floor"; then
		echo "FAIL $binary: needs glibc $newest, above the $floor floor. Symbols over it:" >&2
		for version in $versions; do
			if newer_than "$version" "$floor"; then
				printf '%s\n' "$symbols" | grep -E "[[:space:](]GLIBC_${version//./\\.}[)[:space:]]" \
					| awk '{print "       " $NF " (GLIBC_'"$version"')"}' >&2
			fi
		done
		failed=1
	fi

	if [ "$failed" -ne 0 ]; then
		status=1
		continue
	fi
	echo "ok   $binary: newest glibc symbol $newest (floor $floor), C++ runtime linked in"
done

exit $status
