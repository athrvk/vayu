#!/usr/bin/env bash
#
# The reformatting-commit declaration, in one place.
#
# `.git-blame-ignore-revs` is how this repository declares that a commit changed
# formatting and nothing else. `git blame` reads it, and so does the clang-tidy
# gate in `.github/workflows/pr-tests.yml`: a declared commit inside a pull
# request becomes the base that gate diffs from, because a reformat rewrites a
# line in every file it touches and would otherwise widen the line filter to
# nearly the whole tree - #886's 149-file bulk format asked the gate for 152
# translation units and killed the job at its timeout.
#
# That makes the declaration load-bearing for a gate rather than only for blame,
# so it is checked rather than trusted (#916). Two subcommands, deliberately in
# one file: the rule that picks the base and the rule that validates it are the
# same rule, and two copies of it would drift.
#
#   base  <range-start> <head>   print the commit the lint gate should diff from
#   check <range-start> <head>   prove that commit is a mechanical reformat
#
# What `check` demands is that re-running the pinned formatter over the commit's
# *parent* reproduces the commit byte for byte, for every engine source it
# touched. That is what "purely mechanical reformatting" means, and it is
# strictly more than "the commit is format-clean": the `Engine formatting` job
# already proves every pull request's tip clean, so an author who runs the
# formatter satisfies that much while changing behaviour freely.
#
# Needs the pinned clang-format ($CLANG_FORMAT, default `clang-format-19`) and a
# clone deep enough to contain the pull request's own commits (`fetch-depth: 0`).

set -euo pipefail

# The roots the clang-tidy gate lints, and therefore the only files a
# declaration can excuse. `engine/vendor/` is outside them and carries a
# `DisableFormat: true` config of its own besides.
ROOTS=(engine/src engine/include engine/tests)
SOURCE_RE='\.(c|cpp|h|hpp)$'

# 19, the major every other formatting gate here pins - `Engine formatting`,
# `scripts/pre-commit` and CONTRIBUTING.md. Not decoration: 39 of the 285 engine
# sources format differently under 18, so a validation run under another major
# would report mismatches that say nothing about the commit.
CLANG_FORMAT=${CLANG_FORMAT:-clang-format-19}
CLANG_FORMAT_MAJOR=19

# How many files to name before summarising the rest. The count is always
# printed, so a long list is never a silently truncated one.
PRINT_LIMIT=20

die() {
    echo "::error::$*" >&2
    exit 1
}

# Echoed for whoever reads the log, and appended to the job summary when there
# is one, so the answer survives the log's fold.
summary() {
    echo "$*"
    if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
        echo "$*" >> "$GITHUB_STEP_SUMMARY"
    fi
}

# Every commit the file declares, resolved to a full SHA. An entry naming no
# commit in this clone is skipped rather than fatal: it can match nothing in the
# range either way, which is how `git blame` treats it too.
declared_shas() {
    [[ -f $ignore_file ]] || return 0
    local line sha
    # `|| [[ -n $line ]]` so a final line with no trailing newline is still read.
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%%#*}
        line=${line//[[:space:]]/}
        [[ -n $line ]] || continue
        sha=$(git rev-parse --verify --quiet "${line}^{commit}") || continue
        printf '%s\n' "$sha"
    done < "$ignore_file"
}

# The newest declared commit in the range, because a reformat rewrites whatever
# preceded it; the range start when there is none. `--no-merges` because HEAD is
# the merge commit actions/checkout leaves for a `pull_request` event, and a
# merge authors no lines of its own.
select_base() {
    local range_start="$1" head="$2" rev declared
    declared=$(declared_shas)
    if [[ -n $declared ]]; then
        for rev in $(git rev-list --no-merges "$range_start..$head"); do
            if printf '%s\n' "$declared" | grep -qxF "$rev"; then
                printf '%s\n' "$rev"
                return 0
            fi
        done
    fi
    printf '%s\n' "$range_start"
}

# Asserted rather than trusted, on the pattern both CI gates use: an answer from
# another major is a wrong answer rather than a missing one.
assert_formatter() {
    local major
    "$CLANG_FORMAT" --version > /dev/null 2>&1 \
        || die "$CLANG_FORMAT is not runnable - this check needs the pinned clang-format $CLANG_FORMAT_MAJOR"
    major=$("$CLANG_FORMAT" --version | sed -n 's/.*version \([0-9][0-9]*\).*/\1/p' | head -1)
    if [[ $major != "$CLANG_FORMAT_MAJOR" ]]; then
        die "clang-format ${major:-(version unreadable)} is not the $CLANG_FORMAT_MAJOR this repository pins - differences it reported would be the formatter's, not the commit's"
    fi
}

# The check itself: for every engine source the commit modified, format the
# parent's version of that file and require the result to be exactly what the
# commit holds.
validate_commit() {
    local commit="$1"
    local resolved short parent_count status file worktree_root worktree outside_list
    local -a modified=() irregular=() mismatched=() outside=()

    resolved=$(git rev-parse --verify --quiet "${commit}^{commit}") \
        || die "$ignore_name declares $commit, which is not a commit in this clone"
    short=$(git rev-parse --short "$resolved")

    # An ordinary commit, so that "the parent's version of this file" names one
    # thing. A merge has two parents and a root commit none.
    parent_count=$(( $(git rev-list --parents -n 1 "$resolved" | wc -w) - 1 ))
    if [[ $parent_count -ne 1 ]]; then
        die "declared reformatting commit $short has $parent_count parents - a reformat is an ordinary commit with exactly one"
    fi

    git cat-file -e "$resolved:.clang-format" 2> /dev/null \
        || die "declared reformatting commit $short has no .clang-format at its root, so there is no style to reproduce it with"

    while IFS=$'\t' read -r status file; do
        case "$status" in
            M) modified+=("$file") ;;
            *) irregular+=("$status $file") ;;
        esac
    done < <(git diff --name-status "$resolved^" "$resolved" -- "${ROOTS[@]}" \
        | grep -E "$SOURCE_RE" || true)

    # Everything else the commit touched. Not a failure - clang-tidy reads none
    # of it, so the skip cannot excuse it - but named, because a declaration
    # quietly carrying a second kind of change is what a reviewer is looking for.
    while IFS= read -r file; do
        outside+=("$file")
    done < <(git diff --name-only "$resolved^" "$resolved" \
        | grep -vE "^(${ROOTS[0]}|${ROOTS[1]}|${ROOTS[2]})/.*$SOURCE_RE" || true)

    if [[ ${#irregular[@]} -gt 0 ]]; then
        printf '  %s\n' "${irregular[@]}" >&2
        die "declared reformatting commit $short adds, deletes or renames the engine source(s) above - a reformat only modifies files in place"
    fi

    # The non-empty-scan proof this repository asks of every source-scanning
    # guard, and here it also closes the cheapest evasion: a commit that
    # reformatted no engine source still moves the lint base, which would excuse
    # every engine change before it in the pull request for nothing.
    if [[ ${#modified[@]} -eq 0 ]]; then
        die "declared reformatting commit $short modifies no engine source under ${ROOTS[*]}, so it cannot be the base the engine lint gate diffs from - a reformat of other trees belongs in its own pull request"
    fi

    assert_formatter

    # A worktree at the commit rather than formatting through
    # `--assume-filename`, so `--style=file` resolves the `.clang-format` that
    # commit shipped. A pull request that changes the config and reformats to it
    # in one commit is exactly the shape this has to get right.
    worktree_root=$(mktemp -d)
    worktree="$worktree_root/tree"
    # shellcheck disable=SC2064  # expanded now on purpose: the paths must outlive this function
    trap "git worktree remove --force '$worktree' > /dev/null 2>&1 || true; rm -rf '$worktree_root'" EXIT
    git worktree add --detach --quiet "$worktree" "$resolved"

    for file in "${modified[@]}"; do
        git show "$resolved^:$file" > "$worktree/$file"
    done
    ( cd "$worktree" && "$CLANG_FORMAT" --style=file -i "${modified[@]}" )

    # One diff for the whole set: whatever still differs from what the commit
    # holds is a change the formatter did not make.
    while IFS= read -r file; do
        mismatched+=("$file")
    done < <(git -C "$worktree" diff --name-only -- "${modified[@]}")

    if [[ ${#mismatched[@]} -gt 0 ]]; then
        printf '  %s\n' "${mismatched[@]:0:$PRINT_LIMIT}" >&2
        if [[ ${#mismatched[@]} -gt $PRINT_LIMIT ]]; then
            echo "  ... and $(( ${#mismatched[@]} - PRINT_LIMIT )) more" >&2
        fi
        die "declared reformatting commit $short changed ${#mismatched[@]} of ${#modified[@]} engine source(s) in ways clang-format $CLANG_FORMAT_MAJOR does not reproduce from their parent versions - it is not purely mechanical, and the lint gate must not take it as a base"
    fi

    summary "- reformatting declaration: \`$short\` reproduces exactly under clang-format $CLANG_FORMAT_MAJOR for all **${#modified[@]}** engine source(s) it modifies, so the clang-tidy gate takes it as its base"
    if [[ ${#outside[@]} -gt 0 ]]; then
        outside_list=$(printf '%s ' "${outside[@]:0:$PRINT_LIMIT}")
        summary "  - (it also touches **${#outside[@]}** file(s) the engine lint gate never reads, which the declaration does not excuse: \`${outside_list% }\`)"
    fi
}

usage() {
    echo "usage: $0 base|check <range-start> <head>" >&2
    exit 2
}

[[ $# -eq 3 ]] || usage

cd "$(git rev-parse --show-toplevel)"
ignore_name=.git-blame-ignore-revs
ignore_file="$PWD/$ignore_name"

command="$1"
range_start="$2"
head="$3"

case "$command" in
    base)
        select_base "$range_start" "$head"
        ;;
    check)
        base=$(select_base "$range_start" "$head")
        if [[ $base == "$range_start" ]]; then
            echo "No commit in $range_start..$head is declared in $ignore_name - nothing to validate."
            exit 0
        fi
        validate_commit "$base"
        ;;
    *)
        usage
        ;;
esac
