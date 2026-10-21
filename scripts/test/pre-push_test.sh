#!/bin/bash

# The pre-push hook: clang-tidy over the whole of every C++ file a push changes.
# It was the clang-tidy half of the pre-commit hook until a whole-file lint at
# 20-90s a file made every commit of a C++ change take minutes; its cases moved
# here with it.
#
# - Which files a push carries: the commits no remote-tracking ref reaches,
#   for every pushed ref but a deletion or a tag.
# - The version probe (#659): `engine/.clang-tidy` needs clang-tidy 19, and an
#   older one rejects the config, lints nothing and still exits 0.
# - Discovery (#918): `apt install clang-tidy-19` leaves the plain name at 18.
# - The verdict (#885): every file's status is kept, and any finding refuses.
# - The scope (#946): whole files, never a line filter.
# - The PCH flag (#912): on the hook's command line, never in the shared config.
# - The sequential fallback when xargs is missing (#1544).
#
# Everything here drives the real hook with a stubbed `clang-tidy` on PATH.
# Linux only: the shared helper prepends Homebrew's LLVM directory when it
# exists, which would shadow the stub on a Mac.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="${REPO_ROOT}/scripts/pre-push"
ZERO_SHA=0000000000000000000000000000000000000000

# shellcheck source=scripts/test/hook_test_lib.sh
source "${REPO_ROOT}/scripts/test/hook_test_lib.sh"

# A throwaway repo whose remote-tracking `origin/master` holds a base commit,
# with one commit on top adding two C++ files - the shape of a branch about to
# be pushed. Two files rather than one so that a hook which stops at the first
# finding, or which only remembers the last file's status, is distinguishable
# from one that lints everything and accumulates. Prints the directory.
new_repo() {
    local dir
    dir="$(mktemp -d)"
    git -C "$dir" init --quiet
    git -C "$dir" config user.email "test@example.com"
    git -C "$dir" config user.name "Test"
    echo "$dir"
}

make_repo() {
    local dir
    dir="$(new_repo)"
    printf 'base\n' > "$dir/README"
    git -C "$dir" add README
    git -C "$dir" commit --quiet -m "base"
    git -C "$dir" update-ref refs/remotes/origin/master HEAD
    printf 'int helper() { return 0; }\n' > "$dir/helper.cpp"
    printf 'int main() { return 0; }\n' > "$dir/main.cpp"
    git -C "$dir" add helper.cpp main.cpp
    git -C "$dir" commit --quiet -m "add sources"
    echo "$dir"
}

# A four-line file already on the remote, of which line 3 is then rewritten and
# committed: findings on lines 1, 2 and 4 predate the push, line 3's does not.
make_repo_with_history() {
    local dir
    dir="$(new_repo)"
    printf 'int a() { return 0; }\nint b() { return 0; }\nint c() { return 0; }\nint d() { return 0; }\n' > "$dir/legacy.cpp"
    git -C "$dir" add legacy.cpp
    git -C "$dir" commit --quiet -m "base"
    git -C "$dir" update-ref refs/remotes/origin/master HEAD
    printf 'int a() { return 0; }\nint b() { return 0; }\nint c() { return 1; }\nint d() { return 0; }\n' > "$dir/legacy.cpp"
    git -C "$dir" add legacy.cpp
    git -C "$dir" commit --quiet -m "change line 3"
    echo "$dir"
}

# The line git hands the hook for pushing the checked-out branch of $1.
push_line() {
    echo "refs/heads/master $(git -C "$1" rev-parse HEAD) refs/heads/master ${ZERO_SHA}"
}

# Runs the hook in a fresh repo built by $4 (default make_repo), pushing its
# branch, against a stubbed clang-tidy of $1 which flags files matching $2 at
# line $3 (default 1). Sets HOOK_OUTPUT and HOOK_STATUS - globals rather than a
# printed value, because the status has to survive the call.
HOOK_OUTPUT=""
HOOK_STATUS=0
run_hook() {
    local version="$1" flagged="${2:-}" line="${3:-1}" factory="${4:-make_repo}"
    local repo stub
    repo="$("$factory")"
    stub="$(make_stub "$version" "$flagged" "$line")"
    set +e
    HOOK_OUTPUT="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
    HOOK_STATUS=$?
    set -e
    rm -rf "$repo" "$stub"
}

run_hook_with_version() {
    run_hook "$1"
    printf '%s' "$HOOK_OUTPUT"
}

# --- What a push carries ------------------------------------------------------
echo "pre-push scope: the commits no remote has"

# A file the remote already has is not linted again, even when it carries a
# finding: an earlier push linted it. Only the commit being pushed counts.
# Mutation-check: drop `--not --remotes` from the `git log` in scripts/pre-push
# and old.cpp is linted and refuses the push.
repo="$(new_repo)"
printf 'int old() { return 0; }\n' > "$repo/old.cpp"
git -C "$repo" add old.cpp
git -C "$repo" commit --quiet -m "base"
git -C "$repo" update-ref refs/remotes/origin/master HEAD
printf 'int fresh() { return 0; }\n' > "$repo/fresh.cpp"
git -C "$repo" add fresh.cpp
git -C "$repo" commit --quiet -m "fresh"
stub="$(make_stub 19.1.0 old.cpp)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -eq 0 && "$out" == *"STUB_LINTED"*"fresh.cpp"* && "$out" != *"old.cpp"* ]]; then
    pass "only the files the pushed commits change are linted"
else
    fail "files already on the remote are not linted again" "exit $status: $out"
fi

# Every commit the push carries, not just its tip: a branch of two commits, the
# first touching a file the second does not.
repo="$(make_repo)"
printf 'int later() { return 0; }\n' > "$repo/later.cpp"
git -C "$repo" add later.cpp
git -C "$repo" commit --quiet -m "later"
stub="$(make_stub 19.1.0 helper.cpp)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -ne 0 && "$out" == *"STUB_LINTED"*"later.cpp"* ]]; then
    pass "a finding in an earlier commit of the push still refuses it"
else
    fail "every commit of the push is linted" "exit $status: $out"
fi

# A header is linted directly - the one thing this hook covers that CI's
# translation-unit lint does not.
repo="$(make_repo)"
printf '#pragma once\nint header_fn();\n' > "$repo/api.hpp"
git -C "$repo" add api.hpp
git -C "$repo" commit --quiet -m "header"
stub="$(make_stub 19.1.0)"
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
rm -rf "$repo" "$stub"
if [[ "$out" == *"STUB_LINTED"*"api.hpp"* ]]; then
    pass "a header the push changes is linted directly"
else
    fail "a pushed header is linted" "got: $out"
fi

# A push that changes no C++ says nothing about clang-tidy at all.
repo="$(new_repo)"
printf 'base\n' > "$repo/README"
git -C "$repo" add README
git -C "$repo" commit --quiet -m "base"
git -C "$repo" update-ref refs/remotes/origin/master HEAD
printf 'more\n' >> "$repo/README"
git -C "$repo" commit --quiet -am "docs"
stub="$(make_stub 18.1.3)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -eq 0 && -z "$out" ]]; then
    pass "a push that changes no C++ file is silent"
else
    fail "no C++, no output" "exit $status: $out"
fi

# A branch deletion and a tag carry no new code.
repo="$(make_repo)"
stub="$(make_stub 19.1.0 main.cpp)"
sha="$(git -C "$repo" rev-parse HEAD)"
set +e
out="$(cd "$repo" && printf '(delete) %s refs/heads/gone %s\nrefs/tags/v1 %s refs/tags/v1 %s\n' \
    "$ZERO_SHA" "$sha" "$sha" "$ZERO_SHA" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -eq 0 && "$out" != *"STUB_LINTED"* ]]; then
    pass "a branch deletion and a tag lint nothing"
else
    fail "deletions and tags lint nothing" "exit $status: $out"
fi

# The hook runs as `.git/hooks/pre-push`, a symlink, and must still find the
# helper it sources next to the real script.
repo="$(make_repo)"
stub="$(make_stub 19.1.0)"
mkdir -p "$repo/.git/hooks"
ln -sf "$HOOK" "$repo/.git/hooks/pre-push"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash .git/hooks/pre-push origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -eq 0 && "$out" == *"STUB_LINTED"* ]]; then
    pass "run through its .git/hooks symlink, the hook finds its shared helper"
else
    fail "the hook resolves its own directory through a symlink" "exit $status: $out"
fi

# --- The version probe (#659) -------------------------------------------------
echo
echo "pre-push clang-tidy version probe"

out="$(run_hook_with_version 18.1.3)"
if [[ "$out" == *"NOTHING WAS LINTED"* && "$out" == *"18.1.3"* && "$out" == *">= 19"* ]]; then
    pass "clang-tidy 18 is refused loudly, naming the version and the requirement"
else
    fail "clang-tidy 18 is refused loudly" "got: $out"
fi

if [[ "$out" != *"STUB_LINTED"* ]]; then
    pass "clang-tidy 18 lints nothing, rather than pretending to"
else
    fail "clang-tidy 18 lints nothing" "the hook invoked clang-tidy anyway: $out"
fi

out="$(run_hook_with_version 19.1.0)"
if [[ "$out" == *"STUB_LINTED"* && "$out" == *"main.cpp"* && "$out" != *"NOTHING WAS LINTED"* ]]; then
    pass "clang-tidy 19 lints the pushed file, with no warning"
else
    fail "clang-tidy 19 lints the pushed file" "got: $out"
fi

# A string compare would put "20" before "19".
out="$(run_hook_with_version 20.0.0)"
if [[ "$out" == *"STUB_LINTED"* && "$out" != *"NOTHING WAS LINTED"* ]]; then
    pass "clang-tidy 20 is newer than 19, not alphabetically before it"
else
    fail "clang-tidy 20 is accepted" "got: $out"
fi

# An unparseable --version is a refusal, not a pass. Both names, because the
# hook looks under `clang-tidy-19` first and a real one on PATH would answer.
repo="$(make_repo)"
stub="$(mktemp -d)"
printf '#!/usr/bin/env bash\necho "clang-tidy from somewhere"\nexit 0\n' > "$stub/clang-tidy"
chmod +x "$stub/clang-tidy"
cp "$stub/clang-tidy" "$stub/clang-tidy-19"
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
rm -rf "$repo" "$stub"
if [[ "$out" == *"NOTHING WAS LINTED"* ]]; then
    pass "a clang-tidy whose version cannot be read is refused, not assumed current"
else
    fail "an unreadable version is refused" "got: $out"
fi

# --- Discovery (#918) ---------------------------------------------------------
echo
echo "pre-push clang-tidy discovery"

# Ubuntu 24.04's shape: the plain name is an 18, placed *earlier* on PATH than
# the versioned 19, so what is under test is preferring the versioned name.
# Mutation-check: revert the clang-tidy discovery to the plain name and both
# cases below redden.
repo="$(make_repo)"
plain="$(make_stub 18.1.3 "" 1 clang-tidy)"
versioned="$(make_stub 19.1.0 main.cpp 1 clang-tidy-19)"
sandbox="$(make_sandbox_path)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$plain:$versioned:$sandbox" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$plain" "$versioned" "$sandbox"
if [[ "$out" == *"Running clang-tidy-19 "* && "$out" == *"STUB_LINTED"* ]]; then
    pass "clang-tidy-19 is preferred over a plain clang-tidy that is 18"
else
    fail "clang-tidy-19 is found beside an 18" "exit $status: $out"
fi

if [[ "$status" -ne 0 && "$out" != *"NOTHING WAS LINTED"* ]]; then
    pass "a finding from the versioned clang-tidy refuses the push"
else
    fail "the versioned clang-tidy's finding refuses the push" "exit $status: $out"
fi

# --- The verdict (#885) -------------------------------------------------------
echo
echo "pre-push exit status"

run_hook 19.1.0
if [[ "$HOOK_STATUS" -eq 0 ]]; then
    pass "a clean lint lets the push through"
else
    fail "a clean lint lets the push through" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

run_hook 19.1.0 main.cpp
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a clang-tidy finding refuses the push"
else
    fail "a clang-tidy finding refuses the push" "the hook exited 0: $HOOK_OUTPUT"
fi

if [[ "$HOOK_OUTPUT" == *"the push was refused"* && "$HOOK_OUTPUT" == *"git push --no-verify"* ]]; then
    pass "the refusal says what happened and how to override it"
else
    fail "the refusal explains itself" "got: $HOOK_OUTPUT"
fi

# A finding on the first of two files: the second is still linted, and the run
# still fails - accumulating the status, not keeping only the last one.
run_hook 19.1.0 helper.cpp
if [[ "$HOOK_OUTPUT" == *"STUB_LINTED"*"main.cpp"* && "$HOOK_STATUS" -ne 0 ]]; then
    pass "a finding in one file neither stops the others nor is lost"
else
    fail "linting continues past a finding and keeps it" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# An absent or too-old toolchain skips rather than refusing the push.
run_hook 18.1.3 main.cpp
if [[ "$HOOK_STATUS" -eq 0 ]]; then
    pass "an unusable clang-tidy skips rather than refusing the push"
else
    fail "clang-tidy 18 still skips" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# --- Whole-file scope (#946) --------------------------------------------------
echo
echo "pre-push whole-file scope"

# Mutation-check: pass a `--line-filter` built from the pushed hunks and the
# stub, honouring it, reports nothing on line 1 - this case reddens.
run_hook 19.1.0 legacy.cpp 1 make_repo_with_history
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a finding on a line the push did not touch still refuses it"
else
    fail "a whole-file finding refuses the push" "the hook exited 0: $HOOK_OUTPUT"
fi

if [[ "$HOOK_OUTPUT" != *"--line-filter"* ]]; then
    pass "the invocation carries no line filter"
else
    fail "the invocation carries no line filter" "got: $HOOK_OUTPUT"
fi

run_hook 19.1.0 legacy.cpp 3 make_repo_with_history
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a finding on a line the push changes refuses it"
else
    fail "a finding on a changed line refuses the push" "the hook exited 0: $HOOK_OUTPUT"
fi

# Removing lines can create a finding on the ones that remain.
repo="$(make_repo_with_history)"
git -C "$repo" reset --quiet --hard HEAD~1
printf 'int a() { return 0; }\nint b() { return 0; }\n' > "$repo/legacy.cpp"
git -C "$repo" commit --quiet -am "delete lines"
stub="$(make_stub 19.1.0 legacy.cpp 1)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -ne 0 && "$out" == *"STUB_LINTED"*"legacy.cpp"* ]]; then
    pass "a deletion-only change still lints the whole file"
else
    fail "a deletion-only change lints the whole file" "exit $status: $out"
fi

# --- The PCH flag (#912) ------------------------------------------------------
echo
echo "pre-push PCH flag placement"

# The cases above take the hook's fallback branch, because make_repo builds no
# compile database. This one supplies one, which is the branch the flag is on.
repo="$(make_repo)"
mkdir -p "$repo/engine/build"
printf '[]\n' > "$repo/engine/build/compile_commands.json"
stub="$(make_stub 19.1.0)"
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$PATH" bash "$HOOK" origin url 2>&1)"
rm -rf "$repo" "$stub"

if [[ "$out" == *"STUB_LINTED"*"-p engine/build"* && "$out" == *"--extra-arg=-Wno-ignored-gch"* ]]; then
    pass "with a compile database, the hook passes -Wno-ignored-gch on its own command line"
else
    fail "the hook passes -Wno-ignored-gch itself" "got: $out"
fi

# The other half: never in the config CI reads too. It proves it read the file.
tidy_config="${REPO_ROOT}/engine/.clang-tidy"
if [[ ! -s "$tidy_config" ]]; then
    fail "engine/.clang-tidy was read" "empty or missing: $tidy_config"
elif grep -qE '^[[:space:]]*ExtraArgs:' "$tidy_config"; then
    fail "engine/.clang-tidy declares no ExtraArgs" \
         "found: $(grep -nE '^[[:space:]]*ExtraArgs:' "$tidy_config")"
else
    pass "engine/.clang-tidy declares no ExtraArgs, so CI's header path stays clean"
fi

# --- Without xargs (#1544) ----------------------------------------------------
echo
echo "pre-push lint without xargs"

# make_sandbox_path has no xargs. Mutation-check: remove the `command -v xargs`
# branch in scripts/pre-push and both cases redden with "command not found".
repo="$(make_repo)"
stub="$(make_stub 19.1.0)"
sandbox="$(make_sandbox_path)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$sandbox" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub" "$sandbox"
if [[ "$status" -eq 0 && "$out" == *"STUB_LINTED"*"helper.cpp"* && "$out" == *"STUB_LINTED"*"main.cpp"* ]]; then
    pass "without xargs, every pushed file is still linted sequentially"
else
    fail "the sequential fallback still lints everything" "exit $status: $out"
fi

repo="$(make_repo)"
stub="$(make_stub 19.1.0 main.cpp)"
sandbox="$(make_sandbox_path)"
set +e
out="$(cd "$repo" && push_line "$repo" | PATH="$stub:$sandbox" bash "$HOOK" origin url 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub" "$sandbox"
if [[ "$status" -ne 0 && "$out" != *"command not found"* ]]; then
    pass "without xargs, a finding still refuses the push"
else
    fail "the sequential fallback still gates on a finding" "exit $status: $out"
fi

echo
echo "passed: $PASSED, failed: $FAILED"
[ "$FAILED" -eq 0 ]
