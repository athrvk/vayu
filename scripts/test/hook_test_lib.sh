#!/bin/bash
# shellcheck shell=bash

# Sourced by the two git-hook suites (pre-commit_test.sh, pre-push_test.sh):
# the result counters and the stubbed LLVM tools both drive the hooks with.

PASSED=0
FAILED=0

pass() {
    echo "  ok - $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo "  FAIL - $1"
    echo "         $2"
    FAILED=$((FAILED + 1))
}

# A clang-format on PATH under the binary name $1, reporting $2 as its version.
# Under `--dry-run -Werror` it exits 1 for any file whose path contains $3
# (empty = none) and 0 for the rest. Prints the directory to prepend.
#
# `-Werror` is honoured rather than assumed: real clang-format prints the
# replacements it would make and still exits 0 without it, which is the shape of
# the discarded-status defect issue #885 fixed for clang-tidy. A stub that
# failed regardless would pass whether or not the hook asked for a verdict.
make_format_stub() {
    local name="$1" version="$2" dirty="${3:-}" dir
    dir="$(mktemp -d)"
    cat > "$dir/$name" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
    echo "Ubuntu clang-format version ${version} (1ubuntu1)"
    exit 0
fi
echo "STUB_FORMATTED \$*"

werror=
for arg in "\$@"; do
    case "\$arg" in
        -Werror) werror=1 ;;
    esac
done

if [ -n "${dirty}" ] && [ -n "\$werror" ]; then
    for arg in "\$@"; do
        case "\$arg" in
            -*) continue ;;
            *"${dirty}"*)
                echo "\$arg:1:1: error: code should be clang-formatted [-Wclang-format-violations]" >&2
                exit 1
                ;;
        esac
    done
fi
exit 0
EOF
    chmod +x "$dir/$name"
    echo "$dir"
}

# A PATH tail holding only the tools the hooks and the stubs call - and so, no
# clang-format, no clang-tidy and no xargs at all. The cases about an absent clang-format need that to be a
# fact about the test rather than about whichever LLVM the machine happens to
# ship; the container this suite runs in has an 18 on PATH. Prints the directory.
make_sandbox_path() {
    local dir tool resolved
    dir="$(mktemp -d)"
    for tool in bash git grep awk head sed tr cat env dirname readlink sort; do
        resolved="$(command -v "$tool" 2>/dev/null)" || continue
        [ -n "$resolved" ] && ln -s "$resolved" "$dir/$tool"
    done
    echo "$dir"
}

# A `clang-tidy` on PATH reporting $1 as its version. A lint invocation exits 0,
# except for a file whose path contains $2 (empty = none), where it prints a
# diagnostic at line $3 (default 1) and exits 1 - a stand-in for a real finding
# under `WarningsAsErrors: '*'`. Prints the directory to prepend.
#
# The stub honours `--line-filter` the way clang-tidy does, because that is the
# behaviour under test: a diagnostic is reported only if its line falls inside a
# range the filter lists for that file, and a run with no filter at all reports
# every line. Emulated rather than mocked away - a stub that ignored the filter
# would pass whether or not the hook computed one, which is the whole question.
#
# $4, when given, is the single binary name to install it under. By default it
# goes in under **both** `clang-tidy` and `clang-tidy-22` - the shape of a
# Homebrew or Windows LLVM, where one install answers to both names, and the
# only way a case stays a statement about the hook now that it looks under the
# versioned name first (issue #918): a machine or runner image carrying a real
# `clang-tidy-22` would otherwise answer instead of the stub, exactly as
# `make_sandbox_path` keeps a real clang-format out of the format cases.
make_stub() {
    local version="$1" flagged="${2:-}" line="${3:-1}" only_name="${4:-}" dir
    dir="$(mktemp -d)"
    cat > "$dir/clang-tidy" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
    echo "Ubuntu LLVM version ${version}"
    echo "  Optimized build."
    exit 0
fi
echo "STUB_LINTED \$*"

filter=
for arg in "\$@"; do
    case "\$arg" in
        --line-filter=*) filter="\${arg#--line-filter=}" ;;
    esac
done

# Is line ${line} of \$1 a line this commit changed? With no filter every line
# is, which is what whole-file linting means.
in_scope() {
    [ -z "\$filter" ] && return 0
    local entry ranges range low high
    entry="\$(printf '%s' "\$filter" | tr '{' '\n' | grep -F "\"name\":\"\$1\"")" || return 1
    ranges="\$(printf '%s' "\$entry" | grep -oE '\[[0-9]+,[0-9]+\]')"
    for range in \$ranges; do
        range="\${range#[}"
        range="\${range%]}"
        low="\${range%,*}"
        high="\${range#*,}"
        if [ "${line}" -ge "\$low" ] && [ "${line}" -le "\$high" ]; then
            return 0
        fi
    done
    return 1
}

if [ -n "${flagged}" ]; then
    for arg in "\$@"; do
        case "\$arg" in
            -*) continue ;;
            *"${flagged}"*)
                if in_scope "\$arg"; then
                    echo "\$arg:${line}:1: error: stub finding [stub-check]"
                    exit 1
                fi
                ;;
        esac
    done
fi
exit 0
EOF
    chmod +x "$dir/clang-tidy"
    if [ -z "$only_name" ]; then
        cp "$dir/clang-tidy" "$dir/clang-tidy-22"
    elif [ "$only_name" != "clang-tidy" ]; then
        mv "$dir/clang-tidy" "$dir/$only_name"
    fi
    echo "$dir"
}

