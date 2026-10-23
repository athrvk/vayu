#!/usr/bin/env bash
# Prints one line naming the toolchain vcpkg's binary archives were built
# with, for the CI vcpkg cache key.
#
# vcpkg keys every archive on a package ABI hash that covers the compiler and
# the build tools it finds, so a runner image update can retire every archive
# while `engine/vcpkg.json` and the vcpkg commit stay the same. A cache key
# without this component kept restoring the retired archives, vcpkg rebuilt
# every dependency, and actions/cache never saved the result because the key
# already existed.
#
# - GitHub-hosted runner: the image name and version the runner exports.
# - Job container (no image variables inside it): the container's OS release
#   and a hash of the compiler binary $CXX names, since the toolchain there
#   comes from packages installed at job time, not from the image.
#
# Fails instead of printing an empty or partial id: a key that silently lost
# this component would bring the stale-archive cache back.
set -euo pipefail

sanitize() { tr -c 'A-Za-z0-9._-' '_'; }

if [ -n "${ImageOS:-}" ] && [ -n "${ImageVersion:-}" ]; then
  printf '%s-%s' "$ImageOS" "$ImageVersion" | sanitize
  echo
  exit 0
fi

if [ -r /etc/os-release ] && [ -n "${CXX:-}" ]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  compiler=$(command -v "$CXX") || {
    echo "vcpkg-toolchain-id: CXX='$CXX' is not on PATH" >&2
    exit 1
  }
  compiler=$(readlink -f "$compiler")
  digest=$(sha256sum "$compiler" | cut -c1-16)
  printf '%s%s-%s-%s' "${ID:-unknown}" "${VERSION_ID:-}" "$(basename "$compiler")" "$digest" | sanitize
  echo
  exit 0
fi

echo "vcpkg-toolchain-id: no ImageOS/ImageVersion (hosted runner) and no /etc/os-release with CXX set (container); cannot name the toolchain" >&2
exit 1
