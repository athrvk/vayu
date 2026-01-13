#!/bin/bash

# Vayu Engine Build Script for Windows Production
# This script builds the vayu-engine binary for bundling with the Electron app
# Note: This script should be run in WSL2 or MSYS2/Git Bash on Windows
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENGINE_DIR="$PROJECT_ROOT/engine"
BUILD_DIR="$ENGINE_DIR/build-release"
OUTPUT_DIR="$PROJECT_ROOT/app/resources/bin"

# Helper functions
info() { echo -e "${BLUE}==>${NC} $1"; }
warn() { echo -e "${YELLOW}Warning:${NC} $1"; }
error() { echo -e "${RED}Error:${NC} $1" >&2; exit 1; }
success() { echo -e "${GREEN}✓${NC} $1"; }

# Check if running on Windows (WSL or native)
check_platform() {
    if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "win32" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        info "Running on Windows (native)"
        IS_WSL=false
    elif grep -q Microsoft /proc/version 2>/dev/null; then
        info "Running on Windows (WSL2)"
        IS_WSL=true
    else
        error "This script is for Windows only (WSL2, MSYS2, or Git Bash)"
    fi
}

# Check vcpkg
check_vcpkg() {
    if ! command -v vcpkg &>/dev/null; then
        error "vcpkg not found. Install: https://vcpkg.io/en/getting-started.html"
    fi
    VCPKG_ROOT="$(dirname "$(which vcpkg)")"
    info "Using vcpkg: $VCPKG_ROOT"

    # Detect architecture
    ARCH=$(uname -m)
    if [[ "$ARCH" == "x86_64" ]] || [[ "$ARCH" == "amd64" ]]; then
        TRIPLET="x64-windows"
    elif [[ "$ARCH" == "aarch64" ]] || [[ "$ARCH" == "arm64" ]]; then
        TRIPLET="arm64-windows"
    else
        TRIPLET="x64-windows"
    fi
    info "Building for: $TRIPLET"
}

# Install dependencies
install_deps() {
    info "Installing dependencies..."
    
    # Check if jq is available for better JSON parsing
    if command -v jq &>/dev/null; then
        # Use jq for reliable JSON parsing
        local deps=$(jq -r '.dependencies[]' "$ENGINE_DIR/vcpkg.json" 2>/dev/null)
    else
        # Fallback to grep-based parsing
        warn "jq not found, using basic parsing. Install jq for better reliability"
        local deps=$(grep -A 20 '"dependencies"' "$ENGINE_DIR/vcpkg.json" | grep '"' | grep -v 'dependencies' | tr -d ' ",' | grep -v '^$')
    fi
    
    # Collect missing deps
    local missing_deps=()
    for dep in $deps; do
        # Check if package is installed (case-insensitive grep for robustness)
        if ! vcpkg list | grep -iq "^${dep}:${TRIPLET}"; then
            missing_deps+=("$dep:$TRIPLET")
        fi
    done
    
    # Install all missing deps in one command (parallel)
    if [ ${#missing_deps[@]} -gt 0 ]; then
        info "Installing ${#missing_deps[@]} missing dependencies..."
        vcpkg install "${missing_deps[@]}"
    fi
    
    success "Dependencies ready"
}

# Build engine
build_engine() {
    info "Building vayu-engine for production..."
    
    # Clean build directory
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    # Configure CMake for Release
    cmake -G "Visual Studio 17 2022" \
          -DCMAKE_BUILD_TYPE=Release \
          -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
          -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
          -DVCPKG_MANIFEST_MODE=OFF \
          -DVAYU_BUILD_TESTS=OFF \
          -DVAYU_BUILD_CLI=OFF \
          -DVAYU_BUILD_ENGINE=ON \
          ..
    
    # Build with all cores
    local cores=$(nproc 2>/dev/null || echo 4)
    cmake --build . --config Release -j "$cores"
    
    success "Engine built successfully"
}

# Copy binary to app resources
package_binary() {
    info "Packaging binary for Electron app..."
    
    # Create output directory
    mkdir -p "$OUTPUT_DIR"
    
    # Copy the binary (Windows .exe)
    cp "$BUILD_DIR/Release/vayu-engine.exe" "$OUTPUT_DIR/vayu-engine.exe"
    
    # Print binary info
    local size=$(du -h "$OUTPUT_DIR/vayu-engine.exe" | cut -f1)
    info "Binary size: $size"
    
    success "Binary packaged at: $OUTPUT_DIR/vayu-engine.exe"
}

# Main
main() {
    local start_time=$(date +%s)
    
    echo "Vayu Engine - Windows Production Build"
    echo "======================================="
    echo ""
    
    check_platform
    check_vcpkg
    install_deps
    build_engine
    package_binary
    
    local end_time=$(date +%s)
    local elapsed=$((end_time - start_time))
    
    echo ""
    success "Build completed in ${elapsed}s!"
    echo ""
    echo "Next steps:"
    echo "  1. cd app"
    echo "  2. pnpm run electron:build"
}

main
