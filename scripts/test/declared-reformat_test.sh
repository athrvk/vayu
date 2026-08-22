#!/usr/bin/env bash
#
# `scripts/ci/declared-reformat.sh`: the reformatting-commit declaration that
# the clang-tidy gate reads out of `.git-blame-ignore-revs` (issue #916).
#
# The gate skips linting up to a commit the repository has declared to be pure
# reformatting. Nothing used to check that declaration, so any commit on a pull
# request's own branch could be listed and the gate would skip every change up
# to it - the mechanism built for #886's legitimate 149-file bulk format works
# identically for a commit that is not mechanical at all.
#
# What the script demands is that re-running the pinned clang-format over the
# declared commit's *parent* reproduces the commit byte for byte. Every case
# below is mutation-checked against that: drop the reproduce loop in
# `validate_commit` and the "changes code" case goes green; drop the
# `${#modified[@]} -eq 0` guard and the "reformats no engine source" case does;
# drop the `select_base` range and the "declared commit outside the range" case
# does.
#
# The fixtures are throwaway git repositories with a minimal `.clang-format` of
# their own, so the suite says nothing about this repository's style and does
# not move when that style does. It needs a real clang-format 19, which is why
# it runs in the `Engine formatting` job - the one that already pins one.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/ci/declared-reformat.sh"
CLANG_FORMAT="${CLANG_FORMAT:-clang-format-19}"

PASSED=0
FAILED=0
declare -a FIXTURES=()

pass() {
    echo "  ok - $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo "  FAIL - $1"
    echo "         $2"
    FAILED=$((FAILED + 1))
}

# The pin is asserted, not assumed: the script under test refuses any other
# major, so a suite running under one would be reporting on the refusal rather
# than on the declaration.
major="$("$CLANG_FORMAT" --version 2> /dev/null | sed -n 's/.*version \([0-9][0-9]*\).*/\1/p' | head -1)" || true
if [[ "$major" != "19" ]]; then
    echo "This suite needs clang-format 19 (found: ${major:-none}). Install clang-format-19, or set CLANG_FORMAT." >&2
    exit 1
fi

# A repository with one unformatted engine source committed, and the roots the
# gate reads. Prints the directory.
make_repo() {
    local dir
    dir="$(mktemp -d)"
    FIXTURES+=("$dir")
    git -C "$dir" init --quiet -b main
    git -C "$dir" config user.email "test@example.com"
    git -C "$dir" config user.name "Test"
    mkdir -p "$dir/engine/src"
    printf 'BasedOnStyle: LLVM\nColumnLimit: 80\n' > "$dir/.clang-format"
    printf 'int    main( ) {return   0;}\n' > "$dir/engine/src/main.cpp"
    printf '# declared reformatting commits\n\n' > "$dir/.git-blame-ignore-revs"
    git -C "$dir" add -A
    git -C "$dir" commit --quiet -m "initial"
    echo "$dir"
}

# Run the formatter over the tracked engine sources and commit the result: a
# genuine mechanical reformat. Prints its SHA.
commit_reformat() {
    local dir="$1"
    ( cd "$dir" && "$CLANG_FORMAT" --style=file -i engine/src/*.cpp )
    git -C "$dir" commit --quiet -a -m "style: reformat"
    git -C "$dir" rev-parse HEAD
}

# Declare a commit, the way a pull request does: a later commit that appends the
# SHA to the file the gate reads.
declare_commit() {
    local dir="$1" sha="$2"
    echo "$sha" >> "$dir/.git-blame-ignore-revs"
    git -C "$dir" commit --quiet -a -m "chore: declare $sha as reformatting"
}

# `$OUT` and `$STATUS` are what every case reads.
run() {
    local dir="$1"
    shift
    set +e
    OUT="$(cd "$dir" && bash "$SCRIPT" "$@" 2>&1)"
    STATUS=$?
    set -e
}

cleanup() {
    local dir
    for dir in ${FIXTURES[@]+"${FIXTURES[@]}"}; do
        rm -rf "$dir"
    done
}
trap cleanup EXIT

echo "declared-reformat.sh"

# --- base selection -------------------------------------------------------

repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
printf 'int main() { return 1; }\n' > "$repo/engine/src/main.cpp"
git -C "$repo" commit --quiet -a -m "feat: a real change"
run "$repo" base "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == "$base_before" ]]; then
    pass "base is the range start when the range declares nothing"
else
    fail "base with no declaration" "exit $STATUS: $OUT"
fi

repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
reformat="$(commit_reformat "$repo")"
declare_commit "$repo" "$reformat"
run "$repo" base "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == "$reformat" ]]; then
    pass "base is the declared commit when the range contains one"
else
    fail "base with a declaration" "exit $STATUS: $OUT"
fi

# Two declared commits: the newest wins, because a reformat rewrites whatever
# preceded it. Mutation-check: drop the `break`-on-first-match in `select_base`
# and this returns the older one.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
first="$(commit_reformat "$repo")"
declare_commit "$repo" "$first"
printf 'int    second( ) {return   2;}\n' > "$repo/engine/src/second.cpp"
git -C "$repo" add engine/src/second.cpp
git -C "$repo" commit --quiet -m "feat: a second source"
second="$(commit_reformat "$repo")"
declare_commit "$repo" "$second"
run "$repo" base "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == "$second" ]]; then
    pass "the newest declared commit in the range wins"
else
    fail "newest declaration wins" "exit $STATUS: $OUT"
fi

# A declared commit that is already in the base is not in the pull request, so
# it cannot move the gate's base - the one thing that stops a declaration from
# reaching backwards into history.
repo="$(make_repo)"
old_reformat="$(commit_reformat "$repo")"
declare_commit "$repo" "$old_reformat"
range_start="$(git -C "$repo" rev-parse HEAD)"
printf 'int main() { return 3; }\n' > "$repo/engine/src/main.cpp"
git -C "$repo" commit --quiet -a -m "feat: a change after the reformat"
run "$repo" base "$range_start" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == "$range_start" ]]; then
    pass "a declared commit outside the range does not move the base"
else
    fail "declaration outside the range" "exit $STATUS: $OUT"
fi

# The file is a comment-carrying list, and the real one is mostly comments.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
reformat="$(commit_reformat "$repo")"
{
    echo "# a comment naming $(git -C "$repo" rev-parse HEAD)"
    echo ""
    echo "0000000000000000000000000000000000000000"
    echo "  $reformat  # trailing comment"
} >> "$repo/.git-blame-ignore-revs"
git -C "$repo" commit --quiet -a -m "chore: declare with comments around it"
run "$repo" base "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == "$reformat" ]]; then
    pass "comments, blanks and an unknown SHA do not break the declaration list"
else
    fail "declaration list parsing" "exit $STATUS: $OUT"
fi

# --- check ----------------------------------------------------------------

repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
printf 'int main() { return 1; }\n' > "$repo/engine/src/main.cpp"
git -C "$repo" commit --quiet -a -m "feat: a real change"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == *"nothing to validate"* ]]; then
    pass "check is a no-op when the range declares nothing"
else
    fail "check with no declaration" "exit $STATUS: $OUT"
fi

repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
reformat="$(commit_reformat "$repo")"
declare_commit "$repo" "$reformat"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == *"reproduces exactly"* ]]; then
    pass "a genuine mechanical reformat is accepted"
else
    fail "genuine reformat accepted" "exit $STATUS: $OUT"
fi

# The hole this whole script exists to close: a declared commit that also
# changes code. It is format-clean - `clang-format --dry-run` on it reports
# nothing - which is why being format-clean is not the check.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
( cd "$repo" && "$CLANG_FORMAT" --style=file -i engine/src/main.cpp )
printf 'int main() { return 42; }\n' > "$repo/engine/src/main.cpp"
git -C "$repo" commit --quiet -a -m "style: reformat (and quietly change behaviour)"
sneaky="$(git -C "$repo" rev-parse HEAD)"
declare_commit "$repo" "$sneaky"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -ne 0 && "$OUT" == *"not purely mechanical"* \
    && "$OUT" == *"$(git -C "$repo" rev-parse --short "$sneaky")"* ]]; then
    pass "a declared commit that also changes code fails, named"
else
    fail "non-mechanical declaration fails" "exit $STATUS: $OUT"
fi

# Same shape, minus the formatting: a declaration that is purely a code change.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
printf 'int    main( ) {return   99;}\n' > "$repo/engine/src/main.cpp"
git -C "$repo" commit --quiet -a -m "feat: not a reformat at all"
declare_commit "$repo" "$(git -C "$repo" rev-parse HEAD)"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -ne 0 && "$OUT" == *"not purely mechanical"* ]]; then
    pass "a declaration that reformatted nothing at all fails"
else
    fail "code-only declaration fails" "exit $STATUS: $OUT"
fi

# A commit that touches no engine source still moves the base, so it would
# excuse every engine change before it in the pull request for nothing.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
printf 'int main() { return 4; }\n' > "$repo/engine/src/main.cpp"
git -C "$repo" commit --quiet -a -m "feat: a real engine change"
printf '# notes\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit --quiet -m "docs: nothing the gate lints"
declare_commit "$repo" "$(git -C "$repo" rev-parse HEAD)"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -ne 0 && "$OUT" == *"modifies no engine source"* ]]; then
    pass "a declaration that modifies no engine source fails"
else
    fail "engine-less declaration fails" "exit $STATUS: $OUT"
fi

# A reformat modifies files in place. Anything else - an added source riding
# along - is a change the parent's version cannot be compared against.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
( cd "$repo" && "$CLANG_FORMAT" --style=file -i engine/src/main.cpp )
printf 'int added() { return 0; }\n' > "$repo/engine/src/added.cpp"
git -C "$repo" add -A
git -C "$repo" commit --quiet -m "style: reformat, plus a new file"
declare_commit "$repo" "$(git -C "$repo" rev-parse HEAD)"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -ne 0 && "$OUT" == *"adds, deletes or renames"* ]]; then
    pass "a declaration that adds an engine source fails"
else
    fail "added-source declaration fails" "exit $STATUS: $OUT"
fi

# Files outside the three roots are not linted, so the declaration does not
# excuse them and cannot fail over them - but they are named, on this
# repository's no-silent-caps rule.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
( cd "$repo" && "$CLANG_FORMAT" --style=file -i engine/src/main.cpp )
printf '# notes\n' > "$repo/README.md"
git -C "$repo" add -A
git -C "$repo" commit --quiet -m "style: reformat, and a file the gate never reads"
declare_commit "$repo" "$(git -C "$repo" rev-parse HEAD)"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == *"README.md"* && "$OUT" == *"does not excuse"* ]]; then
    pass "files outside the linted roots are reported, not failed over"
else
    fail "outside-the-roots reporting" "exit $STATUS: $OUT"
fi

# The style a commit is reproduced under is the one that commit shipped, so a
# pull request that changes `.clang-format` and reformats to it in one commit
# validates against the new config rather than the old.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
printf 'BasedOnStyle: LLVM\nColumnLimit: 80\nIndentWidth: 8\n' > "$repo/.clang-format"
( cd "$repo" && "$CLANG_FORMAT" --style=file -i engine/src/main.cpp )
git -C "$repo" commit --quiet -a -m "style: new config, and the reformat to it"
declare_commit "$repo" "$(git -C "$repo" rev-parse HEAD)"
run "$repo" check "$base_before" HEAD
if [[ "$STATUS" -eq 0 && "$OUT" == *"reproduces exactly"* ]]; then
    pass "a config change and its reformat in one commit is reproduced under the new config"
else
    fail "config-changing reformat" "exit $STATUS: $OUT"
fi

# The pin, from the other side: a formatter of another major would report
# differences that are its own, so the script refuses rather than reporting them.
repo="$(make_repo)"
base_before="$(git -C "$repo" rev-parse HEAD)"
reformat="$(commit_reformat "$repo")"
declare_commit "$repo" "$reformat"
stub="$(mktemp -d)"
FIXTURES+=("$stub")
printf '#!/usr/bin/env bash\necho "clang-format version 18.1.3"\n' > "$stub/clang-format"
chmod +x "$stub/clang-format"
set +e
OUT="$(cd "$repo" && CLANG_FORMAT="$stub/clang-format" bash "$SCRIPT" check "$base_before" HEAD 2>&1)"
STATUS=$?
set -e
if [[ "$STATUS" -ne 0 && "$OUT" == *"is not the 19"* ]]; then
    pass "a clang-format of another major is refused, not believed"
else
    fail "formatter pin asserted" "exit $STATUS: $OUT"
fi

echo
echo "passed: $PASSED, failed: $FAILED"
[ "$FAILED" -eq 0 ]
