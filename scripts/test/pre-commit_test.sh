#!/bin/bash

# The pre-commit hook: clang-format 19 over the whole of every staged
# `engine/{src,include,tests}` source (issue #908), mirroring CI's
# `Engine formatting` gate. Dropping the `|| FORMAT_STATUS=1` that keeps its
# status, or widening the scope past those three roots, reddens the cases below.
#
# Also pinned here: the hook never runs clang-tidy, which costs minutes and
# moved to the pre-push hook (scripts/test/pre-push_test.sh), and both hooks
# share one LLVM tool lookup (#918), in scripts/lib/llvm-tools.sh.
#
# Everything here drives the real hook with a stubbed `clang-format` on PATH.
# Linux only: the shared helper prepends Homebrew's LLVM directory when it
# exists, which would shadow the stub on a Mac.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="${REPO_ROOT}/scripts/pre-commit"

# shellcheck source=scripts/test/hook_test_lib.sh
source "${REPO_ROOT}/scripts/test/hook_test_lib.sh"

# A throwaway git repo with two staged C++ files outside the engine roots: the
# commit the format check has nothing to say about. Prints the directory.
make_repo() {
    local dir
    dir="$(mktemp -d)"
    git -C "$dir" init --quiet
    git -C "$dir" config user.email "test@example.com"
    git -C "$dir" config user.name "Test"
    printf 'int helper() { return 0; }\n' > "$dir/helper.cpp"
    printf 'int main() { return 0; }\n' > "$dir/main.cpp"
    git -C "$dir" add helper.cpp main.cpp
    echo "$dir"
}

# A throwaway git repo whose staged set spans the two scopes the format check
# distinguishes: one source under `engine/src`, which it must check, and two
# files outside `engine/{src,include,tests}` which it must not. `engine/vendor/`
# is the one that matters - it carries a `DisableFormat: true` config CI's gate
# never reaches either, so a hook that formatted it would be answering a
# question CI does not ask.
make_repo_engine() {
    local dir
    dir="$(mktemp -d)"
    git -C "$dir" init --quiet
    git -C "$dir" config user.email "test@example.com"
    git -C "$dir" config user.name "Test"
    mkdir -p "$dir/engine/src" "$dir/engine/vendor"
    printf 'int engine_fn() { return 0; }\n' > "$dir/engine/src/engine.cpp"
    printf 'int vendored() { return 0; }\n' > "$dir/engine/vendor/vendored.cpp"
    printf 'int scratch() { return 0; }\n' > "$dir/scratch.cpp"
    git -C "$dir" add engine/src/engine.cpp engine/vendor/vendored.cpp scratch.cpp
    echo "$dir"
}

# Runs the hook in a repo built by $1 (default make_repo), always on the
# sandbox PATH, so the only clang-format in reach is the stub: a machine with a
# real 19 installed would otherwise answer instead. FORMAT_STUB_VERSION, when
# set, puts a clang-format stub of that version on PATH under FORMAT_STUB_NAME,
# reporting files matching FORMAT_STUB_DIRTY as unformatted. Sets HOOK_OUTPUT
# and HOOK_STATUS.
HOOK_OUTPUT=""
HOOK_STATUS=0
FORMAT_STUB_NAME="clang-format"
FORMAT_STUB_VERSION=""
FORMAT_STUB_DIRTY=""
run_hook() {
    local factory="${1:-make_repo}"
    local repo sandbox tail fstub=""
    repo="$("$factory")"
    sandbox="$(make_sandbox_path)"
    tail="$sandbox"
    if [ -n "$FORMAT_STUB_VERSION" ]; then
        fstub="$(make_format_stub "$FORMAT_STUB_NAME" "$FORMAT_STUB_VERSION" "$FORMAT_STUB_DIRTY")"
        tail="$fstub:$tail"
    fi
    set +e
    HOOK_OUTPUT="$(cd "$repo" && PATH="$tail" bash "$HOOK" 2>&1)"
    HOOK_STATUS=$?
    set -e
    rm -rf "$repo" "$sandbox" ${fstub:+"$fstub"}
}

echo "pre-commit clang-format check"

# The defect: `Engine formatting` is a two-second check that only a push could
# reach, so a formatting slip cost a CI round trip and a fixup commit.
#
# Mutation-check: drop the `|| FORMAT_STATUS=1` from the clang-format
# invocation in scripts/pre-commit, or the `-Werror` that gives it a status to
# keep, and this case reddens.
FORMAT_STUB_VERSION="19.1.7"
FORMAT_STUB_DIRTY="engine.cpp"
run_hook make_repo_engine
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a staged engine source clang-format would rewrite refuses the commit"
else
    fail "an unformatted staged source refuses the commit" "the hook exited 0: $HOOK_OUTPUT"
fi

if [[ "$HOOK_OUTPUT" == *"the commit was refused"* && "$HOOK_OUTPUT" == *"--style=file -i"* ]]; then
    pass "the formatting refusal says what happened and how to fix it"
else
    fail "the formatting refusal explains itself" "got: $HOOK_OUTPUT"
fi

# The scope, named rather than inferred: whole files (no line filter), and only
# the three roots CI's gate walks. Widening the `case` in scripts/pre-commit to
# `engine/*` reddens the second half - `engine/vendor/` has a `DisableFormat`
# config of its own and formatting it would be a rule CI does not have.
if [[ "$HOOK_OUTPUT" == *"STUB_FORMATTED"*"--style=file --dry-run -Werror"*"engine/src/engine.cpp"* ]]; then
    pass "the check runs clang-format the way CI does, over the whole staged file"
else
    fail "the check matches CI's invocation" "got: $HOOK_OUTPUT"
fi

format_line="$(printf '%s\n' "$HOOK_OUTPUT" | grep -F "STUB_FORMATTED" || true)"
if [[ -n "$format_line" && "$format_line" != *"vendor"* && "$format_line" != *"scratch.cpp"* ]]; then
    pass "files outside engine/{src,include,tests} are never format-checked"
else
    fail "the format scope is the three engine roots" "got: $format_line"
fi

# The other half. Without it, "refuse everything" would pass the cases above.
FORMAT_STUB_DIRTY=""
run_hook make_repo_engine
if [[ "$HOOK_STATUS" -eq 0 && "$HOOK_OUTPUT" == *"STUB_FORMATTED"* ]]; then
    pass "a format-clean staged source is checked and commits through"
else
    fail "a clean source commits through" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# The pin is 19 *exactly*: 39 of the 285 engine sources format differently under
# 18, so an 18 that reported "clean" would be a wrong answer rather than a
# missing one. It must skip, loudly, and check nothing - and still let the
# commit through, because CI is the gate and a local toolchain is a convenience.
FORMAT_STUB_VERSION="18.1.3"
FORMAT_STUB_DIRTY="engine.cpp"
run_hook make_repo_engine
if [[ "$HOOK_STATUS" -eq 0 && "$HOOK_OUTPUT" == *"NOTHING WAS FORMAT-CHECKED"* && "$HOOK_OUTPUT" == *"18.1.3"* ]]; then
    pass "clang-format 18 is refused loudly, naming the version, and does not refuse the commit"
else
    fail "clang-format 18 skips loudly" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

if [[ "$HOOK_OUTPUT" != *"STUB_FORMATTED"* ]]; then
    pass "clang-format 18 checks nothing, rather than pretending to"
else
    fail "clang-format 18 checks nothing" "the hook ran it anyway: $HOOK_OUTPUT"
fi

# The same branch, reached the other way. The sandbox PATH is what makes this a
# statement about the hook rather than about the runner's LLVM.
FORMAT_STUB_VERSION=""
FORMAT_STUB_DIRTY=""
run_hook make_repo_engine
if [[ "$HOOK_STATUS" -eq 0 && "$HOOK_OUTPUT" == *"NOTHING WAS FORMAT-CHECKED"* ]]; then
    pass "an absent clang-format skips loudly rather than passing silently"
else
    fail "an absent clang-format skips loudly" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# ...but only when there was something to check. A commit that stages no engine
# source must not hear about the C++ formatter at all, whatever is installed.
run_hook make_repo
if [[ "$HOOK_STATUS" -eq 0 && "$HOOK_OUTPUT" != *"FORMAT-CHECKED"* ]]; then
    pass "a commit staging no engine source says nothing about clang-format"
else
    fail "no engine source, no formatter message" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# Ubuntu 24.04's shape, and the reason the hook looks under two names: `apt
# install clang-format-19` leaves plain `clang-format` at the distribution's 18,
# so a hook that probed only the plain name would skip on the very setup
# CONTRIBUTING.md tells contributors to build.
repo="$(make_repo_engine)"
versioned="$(make_format_stub clang-format-19 19.1.7 engine.cpp)"
plain="$(make_format_stub clang-format 18.1.3 "")"
sandbox="$(make_sandbox_path)"
set +e
out="$(cd "$repo" && PATH="$plain:$versioned:$sandbox" bash "$HOOK" 2>&1)"
status=$?
set -e
rm -rf "$repo" "$versioned" "$plain" "$sandbox"
if [[ "$status" -ne 0 && "$out" == *"clang-format-19"* ]]; then
    pass "clang-format-19 is preferred over a plain clang-format that is not 19"
else
    fail "clang-format-19 is found beside an 18" "exit $status: $out"
fi

FORMAT_STUB_VERSION=""
FORMAT_STUB_DIRTY=""

# --- clang-tidy is not this hook's (it is pre-push's) -------------------------
echo
echo "pre-commit runs no clang-tidy"

# Whole-file clang-tidy costs 20-90s a file, so at commit time it made every
# commit of a C++ change take minutes. A clang-tidy that would flag everything
# is on PATH here, and the commit still goes through without it being run.
# Mutation-check: put a clang-tidy invocation back in scripts/pre-commit.
repo="$(make_repo_engine)"
tidy="$(make_stub 19.1.0 .cpp)"
fstub="$(make_format_stub clang-format 19.1.7 "")"
sandbox="$(make_sandbox_path)"
set +e
out="$(cd "$repo" && PATH="$tidy:$fstub:$sandbox" bash "$HOOK" 2>&1)"
status=$?
set -e
rm -rf "$repo" "$tidy" "$fstub" "$sandbox"
if [[ "$status" -eq 0 && "$out" != *"STUB_LINTED"* && "$out" == *"STUB_FORMATTED"* ]]; then
    pass "a commit is format-checked and never linted"
else
    fail "the pre-commit hook leaves clang-tidy to pre-push" "exit $status: $out"
fi

# Run as `.git/hooks/pre-commit`, a symlink, it must still find its helper.
repo="$(make_repo_engine)"
fstub="$(make_format_stub clang-format 19.1.7 "")"
sandbox="$(make_sandbox_path)"
mkdir -p "$repo/.git/hooks"
ln -sf "$HOOK" "$repo/.git/hooks/pre-commit"
set +e
out="$(cd "$repo" && PATH="$fstub:$sandbox" bash .git/hooks/pre-commit 2>&1)"
status=$?
set -e
rm -rf "$repo" "$fstub" "$sandbox"
if [[ "$status" -eq 0 && "$out" == *"STUB_FORMATTED"* ]]; then
    pass "run through its .git/hooks symlink, the hook finds its shared helper"
else
    fail "the hook resolves its own directory through a symlink" "exit $status: $out"
fi

# --- One lookup for both hooks (#918) -----------------------------------------
echo
echo "shared LLVM tool discovery"

# The clang-format half once knew about apt's versioned names and the clang-tidy
# half did not. One definition, in the shared helper, called once by each hook.
# A source scan that proves it read the files first: counting matches in an
# empty string reports none of everything and passes.
lib="${REPO_ROOT}/scripts/lib/llvm-tools.sh"
push_hook="${REPO_ROOT}/scripts/pre-push"
if [[ ! -s "$lib" || ! -s "$HOOK" || ! -s "$push_hook" ]]; then
    fail "the hooks and their helper were read" "empty or missing: $lib $HOOK $push_hook"
else
    definitions="$(cat "$lib" "$HOOK" "$push_hook" | grep -cE '^find_llvm_tool\(\)' || true)"
    commit_calls="$(grep -cE '^[[:space:]]*find_llvm_tool clang-format ' "$HOOK" || true)"
    push_calls="$(grep -cE '^[[:space:]]*find_llvm_tool clang-tidy ' "$push_hook" || true)"
    if [[ "$definitions" -eq 1 && "$commit_calls" -eq 1 && "$push_calls" -eq 1 ]]; then
        pass "discovery is one helper, called by the format and the lint hook"
    else
        fail "discovery is shared, not copied" \
             "definitions: $definitions, calls: $commit_calls + $push_calls (want 1, 1 + 1)"
    fi
fi

echo
echo "passed: $PASSED, failed: $FAILED"
[ "$FAILED" -eq 0 ]
