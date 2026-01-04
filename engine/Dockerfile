FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# 1. Install system dependencies
# These layers will be cached unless the package list changes
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    zip \
    unzip \
    tar \
    git \
    pkg-config \
    ninja-build \
    python3 \
    python3-pip \
    linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

# 2. Install CMake
RUN pip3 install cmake --upgrade

# 3. Install vcpkg
ENV VCPKG_ROOT=/opt/vcpkg
ENV PATH="${VCPKG_ROOT}:${PATH}"
# Set VCPKG_BINARY_SOURCES to clear it, ensuring we don't try to use nuget or other sources by default if not configured
ENV VCPKG_BINARY_SOURCES=clear

RUN git clone https://github.com/microsoft/vcpkg.git ${VCPKG_ROOT} \
    && ${VCPKG_ROOT}/bootstrap-vcpkg.sh

# Set up workspace
WORKDIR /app/engine

# 4. Install vcpkg dependencies
# We copy ONLY the manifest file first.
# This ensures that 'vcpkg install' is only re-run if vcpkg.json changes.
COPY engine/vcpkg.json .

# Install dependencies for the target triplet
# This creates the vcpkg_installed directory which CMake will later use
# Use a cache mount for vcpkg downloads and binary cache to speed up builds
RUN --mount=type=cache,target=/root/.cache/vcpkg/archives \
    --mount=type=cache,target=/root/.cache/vcpkg/downloads \
    vcpkg install --triplet x64-linux

# 5. Copy the rest of the source code
# This layer is invalidated whenever any file in 'engine/' changes
COPY engine .

# Create database directory
RUN mkdir -p db

# Patch server to listen on 0.0.0.0 instead of 127.0.0.1
# Also remove -Werror from CMakeLists.txt to prevent build failures on warnings
RUN sed -i 's/server_.listen("127.0.0.1", port_);/server_.listen("0.0.0.0", port_);/g' src/http/server.cpp && \
    sed -i 's/Listening on http:\/\/127.0.0.1:/Listening on http:\/\/0.0.0.0:/g' src/http/server.cpp && \
    sed -i 's/-Werror//g' CMakeLists.txt

# 6. Build
# We point CMake to the vcpkg toolchain. It will detect the pre-installed packages in vcpkg_installed.
RUN cmake -S . -B build -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE=${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake \
    -DVCPKG_TARGET_TRIPLET=x64-linux \
    -DVCPKG_MANIFEST_MODE=OFF \
    && cmake --build build --target vayu-engine

# Expose the port
EXPOSE 9876

# Set the entrypoint
ENTRYPOINT ["./build/vayu-engine", "-v", "2"]
