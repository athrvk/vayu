# Build stage
FROM debian:bookworm-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    curl \
    zip \
    unzip \
    tar \
    git \
    pkg-config \
    linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

# Install vcpkg
ENV VCPKG_ROOT=/opt/vcpkg
RUN git clone https://github.com/microsoft/vcpkg.git $VCPKG_ROOT && \
    $VCPKG_ROOT/bootstrap-vcpkg.sh

# Set working directory
WORKDIR /build

# Copy vcpkg configuration
COPY vcpkg.json .

# Install dependencies (static linking)
# We use a dummy CMakeLists.txt to trigger vcpkg install without copying full source yet
RUN echo "cmake_minimum_required(VERSION 3.25)" > CMakeLists.txt && \
    echo "project(dummy)" >> CMakeLists.txt && \
    $VCPKG_ROOT/vcpkg install --triplet x64-linux-static

# Copy source code
COPY . .

# Build the application
RUN cmake -B build -S . \
    -DCMAKE_TOOLCHAIN_FILE=$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake \
    -DVCPKG_TARGET_TRIPLET=x64-linux-static \
    -DVAYU_BUILD_TESTS=OFF \
    -DVAYU_BUILD_CLI=OFF \
    -DVAYU_BUILD_ENGINE=ON \
    -DCMAKE_BUILD_TYPE=Release

RUN cmake --build build --target vayu-engine -j$(nproc)

# Runtime stage
FROM debian:bookworm-slim

# Install runtime dependencies (minimal)
# Since we linked statically, we mostly need libc and basic tools
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create necessary directories for the application
RUN mkdir -p engine/db engine/logs

# Copy the executable from the builder stage
COPY --from=builder /build/build/vayu-engine /usr/local/bin/vayu-engine

# Expose the port
EXPOSE 9876

# Set the entrypoint
ENTRYPOINT ["vayu-engine"]
CMD ["--port", "9876"]
