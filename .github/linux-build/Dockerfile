# The image the Linux release is built in (#2634): Ubuntu 22.04 with the
# build tools and GCC 13 already installed, so no CI job contacts Launchpad.
# Ubuntu 22.04 holds the glibc 2.35 floor; docs/engine/building.md has why.
#
# Rebuilt by .github/workflows/linux-build-image.yml when this file changes.
# The jobs reference the result by digest, so a rebuild reaches them only
# through a reviewed change to those digests.

# Pinned by digest so the base moves only when this line does.
FROM ubuntu:22.04@sha256:e0f80c829509ef4df9e76bd8944eb7b8ec25cbb379b112a7f9448b2c77a77c9b

LABEL org.opencontainers.image.source="https://github.com/athrvk/vayu"
LABEL org.opencontainers.image.description="Vayu Linux release toolchain: Ubuntu 22.04 with GCC 13"

ENV DEBIAN_FRONTEND=noninteractive

# What the runner image used to provide and the Linux jobs use: vcpkg's
# bootstrap and ports (curl, zip, unzip, tar, pkg-config, perl, the autotools
# for libsodium), .deb packaging (xz-utils), the glibc check (binutils, via
# build-essential), and git and zstd, which must exist before the first
# checkout and cache step.
#
# 22.04 ships GCC 12, which cannot build the engine (C++23), so GCC 13 comes
# from the Ubuntu toolchain PPA. Launchpad answers 5xx now and then; the image
# build is the one place that depends on it, and a failed build leaves the
# pinned image in use.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        autoconf autoconf-archive automake build-essential ca-certificates \
        curl git gnupg libtool perl pkg-config python3 \
        software-properties-common tar unzip xz-utils zip zstd; \
    for attempt in 1 2 3 4 5; do \
        if add-apt-repository -y ppa:ubuntu-toolchain-r/test \
            && apt-get update \
            && apt-get install -y --no-install-recommends gcc-13 g++-13; then \
            break; \
        fi; \
        [ "$attempt" -lt 5 ] || { echo "GCC 13 install failed after $attempt attempts" >&2; exit 1; }; \
        sleep "$((attempt * 30))"; \
    done; \
    g++-13 --version | head -1; \
    rm -rf /var/lib/apt/lists/*
