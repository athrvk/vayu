#!/usr/bin/env bash
#
# Install the clang-tidy CI lints the engine with, and print its path.
#
# One copy for every consumer: the `Lint changed engine sources` gate in
# `pr-tests.yml`, the whole-tree `engine-tidy-scan.yml`, and `build.py --setup`,
# which installs it on a Linux machine for the pre-push hook. Every leg takes
# the LLVM project's own build of one release, so a finding on one leg alone
# is a platform difference, never a version one.
#
#   Linux    `clang-tidy-22` from apt.llvm.org, the LLVM project's apt
#            repository (hosted by the LLVM Foundation, packaged by Debian's
#            LLVM team). Its signing key is checked against the published
#            fingerprint before apt trusts it. apt.llvm.org carries only the
#            newest patch of a branch, so Linux asserts the major and prints
#            the patch it got.
#   Windows  The LLVM release installer, pinned by SHA-256. The hash is the
#            subject digest of the SLSA provenance LLVM's release workflow
#            attests for the tag (`LLVM-<v>-win64.exe.jsonl` beside the asset),
#            so it names the bytes the LLVM project built. Only clang-tidy and
#            clang's builtin headers are extracted: clang-tidy finds
#            `stddef.h` and the intrinsics headers at `../lib/clang/<major>/`
#            from its own binary, and the MSVC headers come from the compile
#            commands. The runner image's own LLVM is a different version
#            that the image moves on its own schedule.
#
# Usage: tidy="$(bash scripts/install-clang-tidy.sh)"
# Progress goes to stderr; stdout is the binary's path and nothing else.
#
# CLANG_TIDY_HOME (Windows) is where the extracted tree lives, default
# `$RUNNER_TEMP/clang-tidy`. A tree already there at the pinned version is
# used as is, which is what lets a workflow cache the directory.

set -euo pipefail

# CLANG_TIDY_MAJOR, shared with the pre-push hook's floor.
# shellcheck source=scripts/lib/llvm-tools.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/llvm-tools.sh"

# The exact release, which pins the Windows download. Its major is the shared
# one; the check below stops the two disagreeing.
CLANG_TIDY_VERSION=22.1.8

APT_LLVM_KEY_URL=https://apt.llvm.org/llvm-snapshot.gpg.key
APT_LLVM_KEY_FINGERPRINT=6084F3CF814B57C1CF12EFD515CF4D18AF4F7421

WINDOWS_INSTALLER=LLVM-${CLANG_TIDY_VERSION}-win64.exe
WINDOWS_INSTALLER_SHA256=16e5709785fef73c854646241c4a92c5cd574318d1b33c63330dd7721903e55c

log () { echo "install-clang-tidy: $*" >&2; }
die () { echo "::error::install-clang-tidy: $*" >&2; exit 1; }

[[ "${CLANG_TIDY_VERSION%%.*}" == "$CLANG_TIDY_MAJOR" ]] ||
    die "CLANG_TIDY_VERSION $CLANG_TIDY_VERSION is not major $CLANG_TIDY_MAJOR (scripts/lib/llvm-tools.sh)"

# The version a binary reports, as `22.1.8`.
version_of () {
    "$1" --version | sed -n 's/.*LLVM version \([0-9][0-9.]*\).*/\1/p' | head -1
}

install_linux () {
    local tidy=clang-tidy-${CLANG_TIDY_MAJOR} got

    # Already there, from this script or by hand: nothing to fetch. What
    # `build.py --setup` meets on every run after its first.
    if command -v "$tidy" >/dev/null 2>&1; then
        got="$(version_of "$tidy")"
        if [[ "${got%%.*}" == "$CLANG_TIDY_MAJOR" ]]; then
            log "clang-tidy $got already installed"
            command -v "$tidy"
            return
        fi
    fi

    # shellcheck source=/dev/null
    . /etc/os-release
    [[ -n "${VERSION_CODENAME:-}" ]] || die "no VERSION_CODENAME in /etc/os-release"

    local keyring=/usr/share/keyrings/apt-llvm.gpg
    local key fingerprints
    key="$(mktemp)"
    curl -fsSL --retry 3 "$APT_LLVM_KEY_URL" -o "$key"
    # The primary key's fingerprint, read from the downloaded file itself, so
    # a key swapped on the server is refused before apt ever trusts it.
    fingerprints="$(gpg --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10 }')"
    if ! grep -qx "$APT_LLVM_KEY_FINGERPRINT" <<<"$fingerprints"; then
        die "apt.llvm.org key fingerprint is not $APT_LLVM_KEY_FINGERPRINT (got: $(tr '\n' ' ' <<<"$fingerprints"))"
    fi
    sudo gpg --batch --yes --dearmor -o "$keyring" "$key"
    rm -f "$key"

    local list=/etc/apt/sources.list.d/apt-llvm-${CLANG_TIDY_MAJOR}.list
    echo "deb [signed-by=$keyring] https://apt.llvm.org/${VERSION_CODENAME}/ llvm-toolchain-${VERSION_CODENAME}-${CLANG_TIDY_MAJOR} main" \
        | sudo tee "$list" >/dev/null
    # Only the new list is refreshed first: both CI jobs ran `apt-get update`
    # in their system-dependencies step, and re-reading every mirror costs
    # most of a minute. `clang-tidy-22` also needs `libz3-4` from the
    # distribution's own lists, so where those are stale (a workstation, a
    # container image) the install fails, and is retried after a full update.
    sudo apt-get update -qq -o Dir::Etc::sourcelist="$list" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >&2
    if ! sudo apt-get install -y -qq --no-install-recommends "clang-tidy-${CLANG_TIDY_MAJOR}" >&2; then
        log "retrying after a full apt-get update"
        sudo apt-get update -qq >&2
        sudo apt-get install -y -qq --no-install-recommends "clang-tidy-${CLANG_TIDY_MAJOR}" >&2
    fi

    got="$(version_of "$tidy")"
    [[ "${got%%.*}" == "$CLANG_TIDY_MAJOR" ]] || die "$tidy reports ${got:-no version}, not $CLANG_TIDY_MAJOR"
    log "clang-tidy $got from apt.llvm.org (pinned major $CLANG_TIDY_MAJOR)"
    command -v "$tidy"
}

install_windows () {
    local home=${CLANG_TIDY_HOME:-${RUNNER_TEMP:?}/clang-tidy}
    # `RUNNER_TEMP` is a `D:\a\_temp` path. Bash's own file tests want the
    # POSIX spelling and 7-Zip, a native program, the Windows one; each is
    # converted explicitly rather than left to MSYS's argument guessing.
    home="$(cygpath -u "$home")"
    local tidy=$home/bin/clang-tidy.exe

    if [[ -x "$tidy" && "$(version_of "$tidy")" == "$CLANG_TIDY_VERSION" ]]; then
        log "clang-tidy $CLANG_TIDY_VERSION already at $home"
        echo "$tidy"
        return
    fi

    local sevenzip
    sevenzip="$(command -v 7z || true)"
    [[ -n "$sevenzip" ]] || sevenzip="/c/Program Files/7-Zip/7z.exe"
    [[ -x "$sevenzip" ]] || die "7-Zip not found; it extracts the LLVM installer"

    local download installer
    download="$(mktemp -d)"
    installer=$download/$WINDOWS_INSTALLER
    log "downloading $WINDOWS_INSTALLER"
    curl -fsSL --retry 3 -o "$installer" \
        "https://github.com/llvm/llvm-project/releases/download/llvmorg-${CLANG_TIDY_VERSION}/${WINDOWS_INSTALLER}"
    local sum
    sum="$(sha256sum "$installer" | cut -d' ' -f1)"
    [[ "$sum" == "$WINDOWS_INSTALLER_SHA256" ]] || die "$WINDOWS_INSTALLER is $sum, not the pinned $WINDOWS_INSTALLER_SHA256"

    rm -rf "$home"
    "$sevenzip" x -y -o"$(cygpath -w "$home")" "$(cygpath -w "$installer")" \
        bin/clang-tidy.exe "lib/clang/${CLANG_TIDY_MAJOR}/include" >&2
    rm -rf "$download"

    [[ -f "$home/lib/clang/${CLANG_TIDY_MAJOR}/include/stddef.h" ]] || die "the builtin headers did not extract"
    local got
    got="$(version_of "$tidy")"
    [[ "$got" == "$CLANG_TIDY_VERSION" ]] || die "$tidy reports ${got:-no version}, not $CLANG_TIDY_VERSION"
    log "clang-tidy $got from the LLVM release, at $home"
    echo "$tidy"
}

case "${RUNNER_OS:-$(uname -s)}" in
    Linux) install_linux ;;
    Windows | MINGW* | MSYS*) install_windows ;;
    *) die "no clang-tidy recipe for ${RUNNER_OS:-$(uname -s)}" ;;
esac
