# Use the official Microsoft C++ Dev Container image (Debian 12 Bookworm)
# Debian 12 includes CMake 3.25.1+, meeting our requirement without manual upgrades.
FROM mcr.microsoft.com/devcontainers/cpp:1-debian-12

# Set environment variables for vcpkg
ENV VCPKG_ROOT=/usr/local/vcpkg
ENV PATH="${VCPKG_ROOT}:${PATH}"
# Clear binary sources to avoid configuration conflicts
ENV VCPKG_BINARY_SOURCES=clear

# Set up workspace
WORKDIR /app/engine

# 1. Install vcpkg dependencies
# We copy ONLY the manifest file first to leverage Docker layer caching.
# This step will only re-run if vcpkg.json changes.
COPY engine/vcpkg.json .

# Install dependencies for the target triplet
# We use cache mounts to speed up downloads and binary caching across builds
RUN --mount=type=cache,target=/root/.cache/vcpkg/archives \
    --mount=type=cache,target=/root/.cache/vcpkg/downloads \
    # Ensure vcpkg is up to date or usable (the image might have an older version, but it's stable)
    # We just run install. The vcpkg executable is already in PATH.
    vcpkg install --triplet x64-linux

# 2. Copy the rest of the source code
# This layer is invalidated whenever any file in 'engine/' changes
COPY engine .

# Create database directory
RUN mkdir -p db

# Patch server to listen on 0.0.0.0 instead of 127.0.0.1
# Also remove -Werror from CMakeLists.txt to prevent build failures on warnings
RUN sed -i 's/server_.listen("127.0.0.1", port_);/server_.listen("0.0.0.0", port_);/g' src/http/server.cpp && \
    sed -i 's/Listening on http:\/\/127.0.0.1:/Listening on http:\/\/0.0.0.0:/g' src/http/server.cpp && \
    sed -i 's/-Werror//g' CMakeLists.txt

# 3. Build
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
