#!/usr/bin/env bash
#
# The pre-commit hook: its clang-tidy version probe (issue #659 item 4) and its
# exit status (issue #885).
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

# A `clang-tidy` on PATH reporting $1 as its version. A lint invocation exits 0,
# except for a file whose path contains $2 (empty = none), where it prints a
# diagnostic and exits 1 - a stand-in for a real finding under
# `WarningsAsErrors: '*'`. Prints the directory to prepend.
make_stub() {
    local version="$1" flagged="${2:-}" dir
    dir="$(mktemp -d)"
    cat > "$dir/clang-tidy" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
    echo "Ubuntu LLVM version ${version}"
    echo "  Optimized build."
    exit 0
fi
echo "STUB_LINTED \$*"
if [ -n "${flagged}" ]; then
    for arg in "\$@"; do
        case "\$arg" in
            *"${flagged}"*)
                echo "\$arg:1:1: error: stub finding [stub-check]"
                exit 1
                ;;
        esac
    done
fi
exit 0
EOF
    chmod +x "$dir/clang-tidy"
    echo "$dir"
}

# Runs the hook in a fresh repo against a stubbed clang-tidy of $1 which flags
# files matching $2. Sets HOOK_OUTPUT and HOOK_STATUS - a global rather than a
# printed value, because the status has to survive the call and a command
# substitution would run this in a subshell.
HOOK_OUTPUT=""
HOOK_STATUS=0
run_hook() {
    local version="$1" flagged="${2:-}" repo stub
    repo="$(make_repo)"
    stub="$(make_stub "$version" "$flagged")"
    set +e
    HOOK_OUTPUT="$(cd "$repo" && PATH="$stub:$PATH" bash "$HOOK" 2>&1)"
    HOOK_STATUS=$?
    set -e
    rm -rf "$repo" "$stub"
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
out="$(cd "$repo" && PATH="$stub:$PATH" bash "$HOOK" 2>&1)"
rm -rf "$repo" "$stub"
if [[ "$out" == *"NOTHING WAS LINTED"* ]]; then
    pass "a clang-tidy whose version cannot be read is refused, not assumed current"
else
    fail "an unreadable version is refused" "got: $out"
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

echo
echo "passed: $PASSED, failed: $FAILED"
[ "$FAILED" -eq 0 ]
