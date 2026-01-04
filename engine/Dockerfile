FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install build dependencies
# - build-essential: GCC/G++ and standard tools
# - curl, zip, unzip, tar: Required by vcpkg
# - git: Required by vcpkg
# - pkg-config: Helper for library path resolution
# - ninja-build: Fast build system
# - cmake: Build configuration
# - python3: Required by some vcpkg ports
# - linux-libc-dev: System headers
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    zip \
    unzip \
    tar \
    git \
    pkg-config \
    ninja-build \
    cmake \
    python3 \
    linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

# Set up workspace
WORKDIR /app

# Install vcpkg
RUN git clone https://github.com/microsoft/vcpkg.git /opt/vcpkg
RUN /opt/vcpkg/bootstrap-vcpkg.sh
ENV VCPKG_ROOT=/opt/vcpkg
ENV PATH="${VCPKG_ROOT}:${PATH}"

# Copy engine source
COPY engine /app/engine

# Create database directory
RUN mkdir -p /app/engine/db

# Patch server to listen on 0.0.0.0 instead of 127.0.0.1
# This is critical for Docker networking as 127.0.0.1 is loopback only
RUN sed -i 's/server_.listen("127.0.0.1", port_);/server_.listen("0.0.0.0", port_);/g' /app/engine/src/http/server.cpp && \
    sed -i 's/Listening on http:\/\/127.0.0.1:/Listening on http:\/\/0.0.0.0:/g' /app/engine/src/http/server.cpp

# Configure and build
WORKDIR /app/engine

# 1. Configure CMake (this will also trigger vcpkg to install dependencies)
# 2. Build the 'vayu-engine' target
RUN cmake -S . -B build -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE=${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake \
    -DVCPKG_TARGET_TRIPLET=x64-linux \
    && cmake --build build --target vayu-engine

# Expose the port
EXPOSE 9876

# Set the entrypoint
# The binary is typically located in build/ or build/bin/ depending on configuration
# We use a shell form to ensure we can find it, or just point to it.
# Standard CMake add_executable puts it in build/ unless CMAKE_RUNTIME_OUTPUT_DIRECTORY is set.
ENTRYPOINT ["./build/vayu-engine", "-v", "2"]
