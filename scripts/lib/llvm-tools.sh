#!/bin/bash
# shellcheck shell=bash
# LLVM_TOOL and LLVM_TOOL_NEAREST are set here and read by the hooks that
# source this file, which a check of this file alone cannot see.
# shellcheck disable=SC2034

# Sourced, never run: the LLVM tool discovery both git hooks share
# (`scripts/pre-commit` for clang-format, `scripts/pre-push` for clang-tidy).
# One copy, because two copies of this lookup drifted apart once already (#918).

# Add common Homebrew paths for LLVM on macOS to ensure clang-tidy and
# clang-format are found - one LLVM install carries both.
if [ -d "/opt/homebrew/opt/llvm/bin" ]; then
    export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
elif [ -d "/usr/local/opt/llvm/bin" ]; then
    export PATH="/usr/local/opt/llvm/bin:$PATH"
fi

# Finds the binary for a pinned LLVM tool, which is not simply its plain name.
# `apt install clang-format-19` - what CONTRIBUTING.md tells an Ubuntu
# contributor to run - installs `/usr/bin/clang-format-19` and leaves the plain
# `clang-format` at the distribution's 18, while Homebrew's LLVM 19 and the
# Windows installer both use the plain name. Only apt splits them, so both names
# are tried, versioned first.
#
# One helper rather than a copy per tool (issue #918). The clang-tidy pass used
# to look under the plain name alone, so a contributor who followed that install
# instruction to the letter still got the 18, was told to install a 19, and
# linted nothing - the very packaging split the clang-format pass had already
# been taught about. A second copy of the lookup would drift from the first the
# next time either pin moved.
#
# $1 tool, $2 the major it is pinned to, $3 how to compare: `exact` for
# clang-format, where another major is a wrong answer rather than a missing one,
# or `minimum` for clang-tidy, whose pin is the floor that can parse the config.
# The comparison is a parameter because it is the only thing the two lookups do
# not share.
#
# Sets LLVM_TOOL to the binary that satisfied the pin, empty when none did, and
# LLVM_TOOL_NEAREST to a "name version" for the last candidate that did not -
# which is what lets the warning name what you have instead of repeating what to
# install. A candidate whose `--version` prints nothing numeric is rejected, not
# assumed current.
find_llvm_tool() {
    local tool="$1" want="$2" mode="$3"
    local candidate version major accepted
    LLVM_TOOL=
    LLVM_TOOL_NEAREST=
    for candidate in "${tool}-${want}" "$tool"; do
        if ! command -v "$candidate" &> /dev/null; then
            continue
        fi
        # The tolerant of the two regexes this replaces: it also matches a
        # two-component `19.1`, which some builds report.
        version=$("$candidate" --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)
        major=${version%%.*}
        accepted=
        case "$mode" in
            exact) [ "$major" = "$want" ] && accepted=1 ;;
            minimum) [ -n "$major" ] && [ "$major" -ge "$want" ] 2>/dev/null && accepted=1 ;;
            # Reachable only by editing this file wrongly, and silent if it were
            # tolerated: an unknown mode would accept nothing and every pass
            # would skip, which is the failure this hook exists to stop being.
            *)
                echo "pre-commit: find_llvm_tool got an unknown comparison mode '$mode'" >&2
                exit 1
                ;;
        esac
        if [ -n "$accepted" ]; then
            LLVM_TOOL="$candidate"
            return 0
        fi
        LLVM_TOOL_NEAREST="$candidate ${version:-(unknown version)}"
    done
    return 1
}
