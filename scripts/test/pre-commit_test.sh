#!/usr/bin/env bash
#
# The pre-commit hook's clang-tidy version probe (issue #659 item 4).
#
# `engine/.clang-tidy` uses `ExcludeHeaderFilterRegex`, which landed in LLVM 19.
# An older clang-tidy rejects the whole config file, lints nothing, and still
# exits 0 - so the hook reported success while scanning an empty set, which is
# the same non-empty-scan discipline the C++ and vitest guards are held to.
# Ubuntu 24.04's default is 18, so this was most contributors' experience.
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

# A throwaway git repo with one staged C++ file, which is the only state the
# hook reads before it probes. Prints the directory.
make_repo() {
    local dir
    dir="$(mktemp -d)"
    git -C "$dir" init --quiet
    git -C "$dir" config user.email "test@example.com"
    git -C "$dir" config user.name "Test"
    printf 'int main() { return 0; }\n' > "$dir/main.cpp"
    git -C "$dir" add main.cpp
    echo "$dir"
}

# A `clang-tidy` on PATH reporting $1 as its version and doing nothing else.
# Prints the directory to prepend.
make_stub() {
    local version="$1" dir
    dir="$(mktemp -d)"
    cat > "$dir/clang-tidy" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then
    echo "Ubuntu LLVM version ${version}"
    echo "  Optimized build."
    exit 0
fi
echo "STUB_LINTED \$*"
exit 0
EOF
    chmod +x "$dir/clang-tidy"
    echo "$dir"
}

# Runs the hook in a fresh repo against a stubbed clang-tidy of $1. Prints the
# combined output; the hook is expected to exit 0 either way.
run_hook_with_version() {
    local version="$1" repo stub
    repo="$(make_repo)"
    stub="$(make_stub "$version")"
    (
        cd "$repo"
        PATH="$stub:$PATH" bash "$HOOK" 2>&1
    )
    rm -rf "$repo" "$stub"
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

echo
echo "passed: $PASSED, failed: $FAILED"
[ "$FAILED" -eq 0 ]
