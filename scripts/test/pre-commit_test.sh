#!/usr/bin/env bash
#
# The pre-commit hook: its clang-tidy version probe (issue #659 item 4), its
# exit status (issue #885) and what it looks at (issue #902).
#
# `engine/.clang-tidy` uses `ExcludeHeaderFilterRegex`, which landed in LLVM 19.
# An older clang-tidy rejects the whole config file, lints nothing, and still
# exits 0 - so the hook reported success while scanning an empty set, which is
# the same non-empty-scan discipline the C++ and vitest guards are held to.
# Ubuntu 24.04's default is 18, so this was most contributors' experience.
#
# The second half is the hook's verdict. It used to discard clang-tidy's exit
# status at both call sites and end in an unconditional `exit 0`, so a
# contributor with the hook installed and a current clang-tidy could commit code
# it had just flagged. Reverting either half of the fix in `scripts/pre-commit` -
# the `|| STATUS=1` on the two invocations, or the `exit 1` at the end - reddens
# the cases below.
#
# The third is what it looks at: whole staged files (issue #946, the gate
# promotion that closed the #928 backlog paydown). The hook briefly gated the
# changed lines instead (#902), while a backlog older than any diff had to be
# quarantined; with that backlog at zero the scope is the whole of every staged
# file, and reintroducing a `--line-filter` reddens the scope cases below.
#
# The fourth is the formatting check (issue #908). The hook linted but never
# format-checked, so the whole-tree `Engine formatting` gate - two seconds of
# work - was reachable only after a push. It now runs clang-format 19 over the
# whole of every staged `engine/{src,include,tests}` source; dropping the
# `|| FORMAT_STATUS=1` that keeps its status, or widening the scope past those
# three roots, reddens the cases below.
#
# The fifth is where the binaries are looked for (issue #918). Both tools are
# packaged two ways - `apt install clang-tidy-19` leaves the plain name at
# Ubuntu's 18, Homebrew and the Windows installer use the plain name - and the
# hook knew that about clang-format only, so the clang-tidy half skipped on the
# setup CONTRIBUTING.md prescribes. One `find_llvm_tool` now answers for both,
# with the exact-vs-minimum comparison a parameter; reverting either call to a
# bare name reddens the discovery cases below.
#
# Everything here drives the real hook with a stubbed `clang-tidy` on PATH.
# Linux only: the hook prepends Homebrew's LLVM directory when it exists, which
# would shadow the stub on a Mac, and the probe itself has no platform-specific
# half worth running twice.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK="${REPO_ROOT}/scripts/pre-commit"

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

# A throwaway git repo with two staged C++ files, which is the only state the
# hook reads before it probes. Two rather than one so that a hook which stops at
# the first finding, or which only remembers the last file's status, is
# distinguishable from one that lints everything and accumulates. Prints the
# directory.
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

# A throwaway git repo with one *committed* four-line C++ file, of which line 3
# is then rewritten and staged. The shape the line filter exists for: findings on
# lines 1, 2 and 4 predate this commit, the finding on line 3 does not.
make_repo_with_history() {
    local dir
    dir="$(mktemp -d)"
    git -C "$dir" init --quiet
    git -C "$dir" config user.email "test@example.com"
    git -C "$dir" config user.name "Test"
    printf 'int a() { return 0; }\nint b() { return 0; }\nint c() { return 0; }\nint d() { return 0; }\n' > "$dir/legacy.cpp"
    git -C "$dir" add legacy.cpp
    git -C "$dir" commit --quiet -m "base"
    printf 'int a() { return 0; }\nint b() { return 0; }\nint c() { return 1; }\nint d() { return 0; }\n' > "$dir/legacy.cpp"
    git -C "$dir" add legacy.cpp
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

# A PATH tail holding only the tools the hook and the stubs call - and so, no
# clang-format at all. The cases about an absent clang-format need that to be a
# fact about the test rather than about whichever LLVM the machine happens to
# ship; the container this suite runs in has an 18 on PATH. Prints the directory.
make_sandbox_path() {
    local dir tool resolved
    dir="$(mktemp -d)"
    for tool in bash git grep awk head sed tr cat env; do
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
# goes in under **both** `clang-tidy` and `clang-tidy-19` - the shape of a
# Homebrew or Windows LLVM, where one install answers to both names, and the
# only way a case stays a statement about the hook now that it looks under the
# versioned name first (issue #918): a machine or runner image carrying a real
# `clang-tidy-19` would otherwise answer instead of the stub, exactly as
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
        cp "$dir/clang-tidy" "$dir/clang-tidy-19"
    elif [ "$only_name" != "clang-tidy" ]; then
        mv "$dir/clang-tidy" "$dir/$only_name"
    fi
    echo "$dir"
}

# Runs the hook in a fresh repo against a stubbed clang-tidy of $1 which flags
# files matching $2, at line $3 (default 1), in a repo built by $4 (default
# make_repo). Sets HOOK_OUTPUT and HOOK_STATUS - a global rather than a printed
# value, because the status has to survive the call and a command substitution
# would run this in a subshell.
#
# FORMAT_STUB_VERSION, when set, puts a clang-format stub of that version on
# PATH under FORMAT_STUB_NAME, reporting files matching FORMAT_STUB_DIRTY as
# unformatted. FORMAT_SANDBOX=1 replaces the machine's PATH with the curated one
# above, so no real clang-format can answer.
HOOK_OUTPUT=""
HOOK_STATUS=0
FORMAT_STUB_NAME="clang-format"
FORMAT_STUB_VERSION=""
FORMAT_STUB_DIRTY=""
FORMAT_SANDBOX=""
run_hook() {
    local version="$1" flagged="${2:-}" line="${3:-1}" factory="${4:-make_repo}"
    local repo stub tail fstub="" sandbox=""
    repo="$("$factory")"
    stub="$(make_stub "$version" "$flagged" "$line")"
    if [ -n "$FORMAT_SANDBOX" ]; then
        sandbox="$(make_sandbox_path)"
        tail="$sandbox"
    else
        tail="$PATH"
    fi
    if [ -n "$FORMAT_STUB_VERSION" ]; then
        fstub="$(make_format_stub "$FORMAT_STUB_NAME" "$FORMAT_STUB_VERSION" "$FORMAT_STUB_DIRTY")"
        tail="$fstub:$tail"
    fi
    set +e
    HOOK_OUTPUT="$(cd "$repo" && PATH="$stub:$tail" bash "$HOOK" 2>&1)"
    HOOK_STATUS=$?
    set -e
    rm -rf "$repo" "$stub" ${fstub:+"$fstub"} ${sandbox:+"$sandbox"}
}

# Runs the hook against a stub of $1 that flags nothing. Prints the combined
# output, for the probe cases below that only read text.
run_hook_with_version() {
    run_hook "$1"
    printf '%s' "$HOOK_OUTPUT"
}

echo "pre-commit clang-tidy version probe"

# --- The defect itself -------------------------------------------------------
# 18 must say so, by name, and must not claim to have linted anything.
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

# --- The other half: a usable toolchain still lints ---------------------------
# Without this, "skip everything, always" would pass the case above.
out="$(run_hook_with_version 19.1.0)"
if [[ "$out" == *"STUB_LINTED"* && "$out" == *"main.cpp"* ]]; then
    pass "clang-tidy 19 lints the staged file"
else
    fail "clang-tidy 19 lints the staged file" "got: $out"
fi

if [[ "$out" != *"NOTHING WAS LINTED"* ]]; then
    pass "clang-tidy 19 draws no warning"
else
    fail "clang-tidy 19 draws no warning" "got: $out"
fi

# A version well past the floor must not be read as older - a string compare
# would put "20" before "19".
out="$(run_hook_with_version 20.0.0)"
if [[ "$out" == *"STUB_LINTED"* && "$out" != *"NOTHING WAS LINTED"* ]]; then
    pass "clang-tidy 20 is newer than 19, not alphabetically before it"
else
    fail "clang-tidy 20 is accepted" "got: $out"
fi

# --- An unparseable --version is a refusal, not a pass ------------------------
repo="$(make_repo)"
stub="$(mktemp -d)"
printf '#!/usr/bin/env bash\necho "clang-tidy from somewhere"\nexit 0\n' > "$stub/clang-tidy"
chmod +x "$stub/clang-tidy"
# Both names, for the reason make_stub installs both: the hook looks under
# `clang-tidy-19` first, and a real one on PATH would answer this question.
cp "$stub/clang-tidy" "$stub/clang-tidy-19"
out="$(cd "$repo" && PATH="$stub:$PATH" bash "$HOOK" 2>&1)"
rm -rf "$repo" "$stub"
if [[ "$out" == *"NOTHING WAS LINTED"* ]]; then
    pass "a clang-tidy whose version cannot be read is refused, not assumed current"
else
    fail "an unreadable version is refused" "got: $out"
fi

# --- Where the binary is looked for (issue #918) ------------------------------
echo
echo "pre-commit clang-tidy discovery"

# Ubuntu 24.04's shape, on the half of the hook that had never been told about
# it: `apt install clang-tidy-19` - which is what the warning above, and
# CONTRIBUTING.md, tell you to run - installs `/usr/bin/clang-tidy-19` and
# leaves the plain `clang-tidy` at the distribution's 18. The hook probed the
# plain name alone, so following that instruction to the letter still linted
# nothing and printed the same instruction again.
#
# The 18 is placed *earlier* on PATH than the 19, so PATH order alone would find
# it: what is under test is that the versioned name is preferred by name.
#
# Mutation-check: revert the clang-tidy discovery to the plain name and both
# cases below redden, while the 18-skip cases above stay green.
repo="$(make_repo)"
plain="$(make_stub 18.1.3 "" 1 clang-tidy)"
versioned="$(make_stub 19.1.0 main.cpp 1 clang-tidy-19)"
set +e
out="$(cd "$repo" && PATH="$plain:$versioned:$(make_sandbox_path)" bash "$HOOK" 2>&1)"
status=$?
set -e
rm -rf "$repo" "$plain" "$versioned"
if [[ "$out" == *"Running clang-tidy-19 "* && "$out" == *"STUB_LINTED"* ]]; then
    pass "clang-tidy-19 is preferred over a plain clang-tidy that is 18"
else
    fail "clang-tidy-19 is found beside an 18" "exit $status: $out"
fi

# The half that makes the first one mean something: the 19 it found is the one
# that lints, and its finding is still a refusal. A hook that discovered the
# versioned binary and then invoked the plain name would satisfy the case above
# and gate nothing.
if [[ "$status" -ne 0 && "$out" != *"NOTHING WAS LINTED"* ]]; then
    pass "a finding from the versioned clang-tidy refuses the commit"
else
    fail "the versioned clang-tidy's finding refuses the commit" "exit $status: $out"
fi

# One lookup, not one per tool - the drift this issue exists to end, since the
# clang-format half learned about the packaging split and the clang-tidy half
# did not. A source scan, and it proves it read the hook first: a guard that
# counts matches in an empty string reports two of nothing and passes.
if [[ ! -s "$HOOK" ]]; then
    fail "scripts/pre-commit was read" "empty or missing: $HOOK"
else
    definitions="$(grep -cE '^find_llvm_tool\(\)' "$HOOK" || true)"
    calls="$(grep -cE '^[[:space:]]*find_llvm_tool ' "$HOOK" || true)"
    if [[ "$definitions" -eq 1 && "$calls" -eq 2 ]]; then
        pass "discovery is one helper, called by both the format and the lint pass"
    else
        fail "discovery is shared, not copied" \
             "definitions: $definitions, calls: $calls (want 1 and 2)"
    fi
fi

# --- The hook's verdict (issue #885) -----------------------------------------
echo
echo "pre-commit exit status"

# The half that must not become "always fail". Without it, propagating the
# status by returning 1 unconditionally would pass every case below.
run_hook 19.1.0
if [[ "$HOOK_STATUS" -eq 0 ]]; then
    pass "a clean lint lets the commit through"
else
    fail "a clean lint lets the commit through" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# The defect itself: clang-tidy said no, and the hook said yes anyway.
run_hook 19.1.0 main.cpp
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a clang-tidy finding refuses the commit"
else
    fail "a clang-tidy finding refuses the commit" "the hook exited 0: $HOOK_OUTPUT"
fi

if [[ "$HOOK_OUTPUT" == *"the commit was refused"* && "$HOOK_OUTPUT" == *"--no-verify"* ]]; then
    pass "the refusal says what happened and how to override it"
else
    fail "the refusal explains itself" "got: $HOOK_OUTPUT"
fi

# A finding on the *first* of two staged files. The second must still be linted
# - one bad file should not hide the rest - and the run must still fail, which
# is what separates accumulating the status from keeping only the last one.
run_hook 19.1.0 helper.cpp
if [[ "$HOOK_OUTPUT" == *"STUB_LINTED"*"main.cpp"* ]]; then
    pass "a finding in an earlier file does not stop the later ones being linted"
else
    fail "linting continues past a finding" "got: $HOOK_OUTPUT"
fi

if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a finding survives a clean file linted after it"
else
    fail "a finding survives a later clean file" "the hook exited 0: $HOOK_OUTPUT"
fi

# The skips stay skips: an absent or too-old toolchain must not start refusing
# commits now that a real failure can.
run_hook 18.1.3 main.cpp
if [[ "$HOOK_STATUS" -eq 0 ]]; then
    pass "an unusable clang-tidy still skips rather than refusing the commit"
else
    fail "clang-tidy 18 still skips" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# --- What the hook looks at (issue #946) -------------------------------------
echo
echo "pre-commit whole-file scope"

# The promotion: with the #928 backlog at zero tree-wide, the hook gates whole
# staged files - a finding anywhere in a file this commit stages refuses the
# commit, whether or not the diff touched its line. `legacy.cpp` has a finding
# on line 1, which this commit does not touch.
#
# Mutation-check: reintroduce a `--line-filter` built from the staged hunks in
# scripts/pre-commit and the stub, honouring it, reports nothing on line 1 -
# this case reddens.
run_hook 19.1.0 legacy.cpp 1 make_repo_with_history
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a finding on a line this commit did not touch still refuses the commit"
else
    fail "a whole-file finding refuses the commit" "the hook exited 0: $HOOK_OUTPUT"
fi

# No filter is passed at all - asserted on the invocation rather than inferred
# from the verdict, so a filter that happened to cover line 1 could not pass
# the case above while narrowing the scope.
if [[ "$HOOK_OUTPUT" != *"--line-filter"* ]]; then
    pass "the invocation carries no line filter"
else
    fail "the invocation carries no line filter" "got: $HOOK_OUTPUT"
fi

# A finding on a changed line, for completeness of the promotion: whole-file
# scope is a superset of the old changed-lines scope.
run_hook 19.1.0 legacy.cpp 3 make_repo_with_history
if [[ "$HOOK_STATUS" -ne 0 ]]; then
    pass "a finding on a line this commit changes refuses the commit"
else
    fail "a finding on a changed line refuses the commit" "the hook exited 0: $HOOK_OUTPUT"
fi

# A deletion-only staged change still lints the whole file: removing a line can
# create a finding on the lines that remain, and whole-file scope has no
# nothing-new-to-lint case.
repo="$(make_repo_with_history)"
printf 'int a() { return 0; }\nint b() { return 0; }\n' > "$repo/legacy.cpp"
git -C "$repo" add legacy.cpp
stub="$(make_stub 19.1.0 legacy.cpp 1)"
set +e
out="$(cd "$repo" && PATH="$stub:$PATH" bash "$HOOK" 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub"
if [[ "$status" -ne 0 && "$out" == *"STUB_LINTED"*"legacy.cpp"* ]]; then
    pass "a deletion-only staged change still lints the whole file"
else
    fail "a deletion-only change lints the whole file" "exit $status: $out"
fi

# --- Where the PCH flag lives (issue #912) -----------------------------------
echo
echo "pre-commit PCH flag placement"

# `-Wno-ignored-gch` is this hook's alone. It used to sit in engine/.clang-tidy,
# which CI reads too, and there it failed every pull request that touched a
# header: compile_commands.json holds no entry for a `.hpp`, so clang-tidy
# synthesises a command and the ExtraArgs entry arrives in input position
# ("no such file or directory: '-Wno-ignored-gch'"), which WarningsAsErrors
# turns into a failed job. Both halves are pinned below - the flag being on the
# hook's command line, and it being absent from the shared config. Either one
# alone would pass while the bug was still live.
#
# The cases above all take the hook's *fallback* branch, because make_repo
# builds no compile database. This one supplies one, which is the branch the
# flag is on.
repo="$(make_repo)"
mkdir -p "$repo/engine/build"
printf '[]\n' > "$repo/engine/build/compile_commands.json"
stub="$(make_stub 19.1.0)"
out="$(cd "$repo" && PATH="$stub:$PATH" bash "$HOOK" 2>&1)"
rm -rf "$repo" "$stub"

if [[ "$out" == *"STUB_LINTED"*"-p engine/build"* ]]; then
    pass "a compile database is used when present, so the flag's branch is the one under test"
else
    fail "the compile-database branch is taken" "got: $out"
fi

if [[ "$out" == *"--extra-arg=-Wno-ignored-gch"* ]]; then
    pass "the hook passes -Wno-ignored-gch on its own command line"
else
    fail "the hook passes -Wno-ignored-gch itself" "got: $out"
fi

# The other half, as a source scan - and it proves it read something first,
# because vitest-style empty-string reads are how a guard like this rots.
tidy_config="${REPO_ROOT}/engine/.clang-tidy"
if [[ ! -s "$tidy_config" ]]; then
    fail "engine/.clang-tidy was read" "empty or missing: $tidy_config"
elif grep -qE '^[[:space:]]*ExtraArgs:' "$tidy_config"; then
    fail "engine/.clang-tidy declares no ExtraArgs" \
         "found: $(grep -nE '^[[:space:]]*ExtraArgs:' "$tidy_config")"
else
    pass "engine/.clang-tidy declares no ExtraArgs, so CI's header path stays clean"
fi

# --- The formatting check (issue #908) ---------------------------------------
echo
echo "pre-commit clang-format check"

# The defect: `Engine formatting` is a two-second check that only a push could
# reach, so a formatting slip cost a CI round trip and a fixup commit.
#
# Mutation-check: drop the `|| FORMAT_STATUS=1` from the clang-format
# invocation in scripts/pre-commit, or the `-Werror` that gives it a status to
# keep, and this case reddens.
#
# Every case here runs on the sandbox PATH, so the only clang-format in reach is
# the stub: a machine that happens to have a real 19 installed - a contributor's
# laptop, a runner image that grows one - would otherwise answer these questions
# instead of the stub, and the suite would be testing its LLVM.
FORMAT_SANDBOX=1
FORMAT_STUB_VERSION="19.1.7"
FORMAT_STUB_DIRTY="engine.cpp"
run_hook 19.1.0 "" 1 make_repo_engine
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
run_hook 19.1.0 "" 1 make_repo_engine
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
run_hook 19.1.0 "" 1 make_repo_engine
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
run_hook 19.1.0 "" 1 make_repo_engine
if [[ "$HOOK_STATUS" -eq 0 && "$HOOK_OUTPUT" == *"NOTHING WAS FORMAT-CHECKED"* ]]; then
    pass "an absent clang-format skips loudly rather than passing silently"
else
    fail "an absent clang-format skips loudly" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

# ...but only when there was something to check. A commit that stages no engine
# source must not hear about the C++ formatter at all, whatever is installed.
run_hook 19.1.0
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
stub="$(make_stub 19.1.0)"
versioned="$(make_format_stub clang-format-19 19.1.7 engine.cpp)"
plain="$(make_format_stub clang-format 18.1.3 "")"
set +e
out="$(cd "$repo" && PATH="$stub:$plain:$versioned:$(make_sandbox_path)" bash "$HOOK" 2>&1)"
status=$?
set -e
rm -rf "$repo" "$stub" "$versioned" "$plain"
if [[ "$status" -ne 0 && "$out" == *"clang-format-19"* ]]; then
    pass "clang-format-19 is preferred over a plain clang-format that is not 19"
else
    fail "clang-format-19 is found beside an 18" "exit $status: $out"
fi

# The formatting verdict has to survive every exit the clang-tidy half takes -
# an absent or old clang-tidy is a reason to skip linting, not a reason to
# forget that clang-format already refused this commit. Mutation-check: turn
# either `exit "$FORMAT_STATUS"` in scripts/pre-commit back into `exit 0`.
FORMAT_STUB_VERSION="19.1.7"
FORMAT_STUB_DIRTY="engine.cpp"
run_hook 18.1.3 "" 1 make_repo_engine
FORMAT_STUB_VERSION=""
FORMAT_STUB_DIRTY=""
FORMAT_SANDBOX=""
if [[ "$HOOK_STATUS" -ne 0 && "$HOOK_OUTPUT" == *"NOTHING WAS LINTED"* ]]; then
    pass "a formatting refusal survives a clang-tidy the hook had to skip"
else
    fail "the formatting verdict survives a tidy skip" "exit $HOOK_STATUS: $HOOK_OUTPUT"
fi

echo
echo "passed: $PASSED, failed: $FAILED"
[ "$FAILED" -eq 0 ]
